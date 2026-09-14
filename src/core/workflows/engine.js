// Workflow Engine: runs a validated workflow definition.
//
// Node execution is small and typed; the engine owns iteration, edge traversal,
// inputs/outputs and the runtime story of each instance. Approvals pause the
// instance until the injected authorize callback resolves.
//
// Three properties this engine is responsible for, and they are the ones a
// control plane is allowed to report on:
//
//   1. **Cancellation is real.** `cancel()` never reports success it did not
//      achieve. It finds the instance, records the request, interrupts what it
//      can interrupt (an approval wait, any node executor that accepts the
//      abort signal), stops the walk at the next node boundary, persists the
//      terminal state and emits `workflow.cancelled`. An unknown or already
//      finished instance is reported as *not* cancelled, with the reason.
//   2. **Instances are listable.** `list()` answers from the real instance
//      table, so a UI showing "running workflows" is showing running workflows.
//   3. **History survives a restart.** Given a collection, every status
//      transition is persisted, and `restore()` reloads them. An instance that
//      was mid-flight when the process died comes back as `interrupted` rather
//      than pretending to still be running — see §12.
//
// The honest limit on (1): a node executor that does not accept an abort signal
// (a tool call already in flight, a shell command on a host without signal
// support) runs to completion. What cancellation guarantees is that its output
// is discarded, no further node is entered, and the instance reaches
// `cancelled` — not that an already-started syscall is unwound.

const { validateWorkflow } = require('./definition');
const { TYPES } = require('../events/event-bus');
const { scrub } = require('../trace/serializer');

const INSTANCE_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  AWAITING_APPROVAL: 'awaiting_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  // Persisted as running, found not running. Set by restore(), never by a walk.
  INTERRUPTED: 'interrupted',
};

// Statuses a run can no longer leave. `cancel()` refuses these rather than
// reporting a cancellation that did not happen.
const TERMINAL = new Set([
  INSTANCE_STATUS.COMPLETED,
  INSTANCE_STATUS.FAILED,
  INSTANCE_STATUS.CANCELLED,
  INSTANCE_STATUS.INTERRUPTED,
]);

// Thrown to unwind the walk on cancellation. Distinct from a node failure so
// `run()` can tell "we stopped it" from "it broke", which are different
// outcomes for a user and for the trace.
class WorkflowCancelledError extends Error {
  constructor(reason) {
    super(`workflow cancelled: ${reason}`);
    this.name = 'WorkflowCancelledError';
    this.reason = reason;
  }
}

function createInstance(id, workflow, inputs, correlation = {}) {
  return {
    id,
    workflowId: workflow.id,
    status: INSTANCE_STATUS.PENDING,
    inputs: { ...inputs },
    outputs: {},
    nodes: new Map(workflow.nodes.map((n) => [n.id, { id: n.id, type: n.type, status: 'pending', output: null, error: null }])),
    events: [],
    error: null,
    // §27: every instance carries the ids that let a trace query find it.
    traceId: correlation.traceId || null,
    workspaceId: correlation.workspaceId || null,
    taskId: correlation.taskId || null,
    // The node the walk is inside right now — §12 wants "current node" persisted
    // so an interrupted run says where it stopped.
    currentNodeId: null,
    cancellation: null,
    startedAt: Date.now(),
    completedAt: null,
  };
}

class WorkflowEngine {
  constructor({ bus, toolManager, runtime, shellIo, execIo, logger, authorize, collection } = {}) {
    this._bus = bus;
    this._tools = toolManager;
    this._runtime = runtime;
    this._shellIo = shellIo; // { run(command,{cwd,timeoutMs,signal}) }  — adapter to existing terminal
    this._execIo = execIo;   // CodeExecutor
    this._logger = logger;
    this._authorize = authorize || (async () => false);
    this._collection = collection || null;
    this._instances = new Map();
    // Per-instance abort plumbing. Kept off the instance record so it never
    // reaches persistence or IPC.
    this._control = new Map();
  }

  async run(workflowDef, { inputs = {}, id, runAgent, traceId, workspaceId, taskId } = {}) {
    const { ok, workflow, errors } = validateWorkflow(workflowDef);
    if (!ok) throw new Error(`invalid workflow: ${errors.join('; ')}`);
    const instance = createInstance(
      id || `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      workflow,
      inputs,
      { traceId, workspaceId, taskId },
    );
    this._instances.set(instance.id, instance);

    const controller = new AbortController();
    this._control.set(instance.id, { controller, workflow });

    instance.status = INSTANCE_STATUS.RUNNING;
    await this._persist(instance);
    this._bus.emit(
      TYPES.WORKFLOW_STARTED,
      { workflowId: workflow.id, taskId: instance.taskId, workspaceId: instance.workspaceId, traceId: instance.traceId },
      { instanceId: instance.id },
    );

    const exec = {
      toolManager: this._tools,
      runtime: this._runtime,
      shellIo: this._shellIo,
      execIo: this._execIo,
      runAgent: runAgent || null,
      logger: this._logger,
      bus: this._bus,
      signal: controller.signal,
    };

    try {
      await this._walk(instance, workflow, exec);
      if (instance.status === INSTANCE_STATUS.RUNNING) {
        instance.status = INSTANCE_STATUS.COMPLETED;
        instance.completedAt = Date.now();
        instance.currentNodeId = null;
        await this._persist(instance);
        this._bus.emit(
          TYPES.WORKFLOW_COMPLETED,
          { workflowId: workflow.id, taskId: instance.taskId, traceId: instance.traceId },
          { instanceId: instance.id, outputs: instance.outputs },
        );
      }
    } catch (err) {
      if (err instanceof WorkflowCancelledError) {
        await this._finishCancelled(instance, workflow, err.reason);
      } else {
        instance.status = INSTANCE_STATUS.FAILED;
        instance.error = err.message;
        instance.completedAt = Date.now();
        await this._persist(instance);
        this._bus.emit(
          TYPES.WORKFLOW_FAILED,
          { workflowId: workflow.id, taskId: instance.taskId, traceId: instance.traceId },
          { instanceId: instance.id, error: err.message },
        );
      }
    } finally {
      this._control.delete(instance.id);
    }
    return this.get(instance.id);
  }

  // Cancel a running instance.
  //
  // Returns what actually happened — never a bare `{ cancelled: true }`. The
  // caller (and the IPC layer above it) reports this verbatim, so a UI cannot
  // show "cancelled" for an instance that was already finished or never existed.
  cancel(id, reason = 'cancelled') {
    const instance = this._instances.get(id);
    if (!instance) return { cancelled: false, id, status: null, reason: 'unknown instance' };
    if (TERMINAL.has(instance.status)) {
      return { cancelled: false, id, status: instance.status, reason: `already ${instance.status}` };
    }
    if (instance.cancellation && instance.cancellation.requested) {
      return { cancelled: false, id, status: instance.status, reason: 'cancellation already requested' };
    }

    instance.cancellation = { requested: true, reason, requestedAt: Date.now() };
    const control = this._control.get(id);
    if (control) {
      // Interrupts an approval wait and any executor that took the signal.
      control.controller.abort(new WorkflowCancelledError(reason));
    }

    // A run() that is still walking reaches the checkpoint and finishes the
    // transition itself. Nothing is walking when there is no control record
    // (a restored instance, or one awaiting a caller that went away), so the
    // transition happens here instead.
    if (!control) {
      const workflow = { id: instance.workflowId };
      this._finishCancelled(instance, workflow, reason).catch((err) => this._warn('persist cancellation', err));
    }

    return { cancelled: true, id, status: INSTANCE_STATUS.CANCELLED, reason, requestedAt: instance.cancellation.requestedAt };
  }

  async _finishCancelled(instance, workflow, reason) {
    instance.status = INSTANCE_STATUS.CANCELLED;
    instance.completedAt = Date.now();
    instance.error = null;
    for (const node of instance.nodes.values()) {
      if (node.status === 'pending' || node.status === 'running') node.status = 'cancelled';
    }
    await this._persist(instance);
    this._bus.emit(
      TYPES.WORKFLOW_CANCELLED,
      { workflowId: workflow.id || instance.workflowId, taskId: instance.taskId, traceId: instance.traceId },
      { instanceId: instance.id, reason },
    );
  }

  async _walk(instance, workflow, exec) {
    const start = workflow.nodes.find((n) => n.type === 'start');
    await this._visit(instance, workflow, start, exec, []);
  }

  _checkpoint(instance) {
    if (instance.cancellation && instance.cancellation.requested) {
      throw new WorkflowCancelledError(instance.cancellation.reason);
    }
  }

  async _visit(instance, workflow, node, exec, path) {
    // Before entering a node at all: a cancellation requested while the previous
    // node ran stops the walk here, so no new work is started after the request.
    this._checkpoint(instance);
    if (path.includes(node.id)) throw new Error(`cycle detected at node ${node.id}`);
    const keyPath = [...path, node.id];
    const nState = instance.nodes.get(node.id);
    nState.status = 'running';
    instance.currentNodeId = node.id;
    // Persisted on entry, not only on completion: a process that dies inside a
    // node must leave a record saying *that* node, otherwise §12's "current
    // node" points at the last one that finished and an interrupted run lies
    // about where it stopped.
    await this._persist(instance);
    try {
      const output = await executorFor(node, exec, this._authorize, instance);
      // And again on the way out: whatever this node produced is discarded when
      // cancellation arrived while it was in flight.
      this._checkpoint(instance);
      nState.status = 'completed';
      nState.output = output;
      instance.outputs[node.id] = output;
      await this._persist(instance);

      // Route to next node(s).
      const outgoing = workflow.edges.filter((e) => e.from === node.id);
      const next = outgoing.map((e) => ({ edge: e, to: workflow.nodes.find((n) => n.id === e.to) }));
      for (const { edge, to } of next) {
        const when = edge.when;
        const keep = when ? matchesCondition(when, instance.outputs, node.id) : true;
        if (!keep) continue;
        if (!to) continue;
        await this._visit(instance, workflow, to, exec, keyPath);
      }
    } catch (err) {
      if (err instanceof WorkflowCancelledError) throw err;
      nState.status = 'failed';
      nState.error = err.message;
      throw err;
    }
  }

  get(id) {
    const inst = this._instances.get(id);
    if (!inst) return null;
    return instanceView(inst);
  }

  // Every instance this engine knows about, newest first. Optionally filtered by
  // status or workflow so a UI can ask for "running" without reading the world.
  list({ status = null, workflowId = null, limit = 0 } = {}) {
    let out = [...this._instances.values()];
    if (status) {
      const wanted = new Set(Array.isArray(status) ? status : [status]);
      out = out.filter((i) => wanted.has(i.status));
    }
    if (workflowId) out = out.filter((i) => i.workflowId === workflowId);
    out.sort((a, b) => b.startedAt - a.startedAt);
    if (limit > 0) out = out.slice(0, limit);
    return out.map(instanceView);
  }

  // Reload persisted instances after a restart.
  //
  // §12: a completed run must still be there; a run that was mid-flight when the
  // process died must be *identified as interrupted*, not left claiming to run.
  // Instances already in memory win — restore never clobbers a live run.
  async restore() {
    if (!this._collection) return { restored: 0, interrupted: 0 };
    let records;
    try {
      records = await this._collection.list();
    } catch (err) {
      this._warn('restore workflow instances', err);
      return { restored: 0, interrupted: 0 };
    }
    let restored = 0;
    let interrupted = 0;
    for (const rec of records) {
      if (!rec || !rec.id || this._instances.has(rec.id)) continue;
      const inst = hydrate(rec);
      if (!TERMINAL.has(inst.status)) {
        inst.status = INSTANCE_STATUS.INTERRUPTED;
        inst.completedAt = inst.completedAt || Date.now();
        for (const node of inst.nodes.values()) {
          if (node.status === 'running' || node.status === 'pending') node.status = 'interrupted';
        }
        interrupted += 1;
        await this._persist(inst);
      }
      this._instances.set(inst.id, inst);
      restored += 1;
    }
    return { restored, interrupted };
  }

  async _persist(instance) {
    if (!this._collection) return;
    try {
      await this._collection.put(instance.id, serializeInstance(instance));
    } catch (err) {
      // Not swallowed: a host that cannot persist workflow history should see
      // it in the log rather than discover it after a restart.
      this._warn('persist workflow instance', err);
    }
  }

  _warn(what, err) {
    if (this._logger && typeof this._logger.warn === 'function') {
      this._logger.warn(`${what} failed`, { error: err && err.message });
    }
  }
}

// The renderer-safe view. No Maps, no functions, no abort controllers.
function instanceView(inst) {
  return {
    id: inst.id,
    workflowId: inst.workflowId,
    status: inst.status,
    error: inst.error || null,
    outputs: inst.outputs,
    nodes: [...inst.nodes.entries()].map(([id, n]) => ({ id, type: n.type, status: n.status, error: n.error, output: n.output })),
    currentNodeId: inst.currentNodeId || null,
    cancellation: inst.cancellation ? { ...inst.cancellation } : null,
    traceId: inst.traceId || null,
    workspaceId: inst.workspaceId || null,
    taskId: inst.taskId || null,
    startedAt: inst.startedAt,
    completedAt: inst.completedAt,
  };
}

// What lands in the store. Same shape as the view, plus the inputs the run was
// given so a restored instance is readable on its own.
//
// Node inputs and outputs are whatever a tool, a shell command or an agent
// returned, so they are exactly where a credential rides along — and unlike the
// in-memory view this copy is written to the user's disk and outlives the
// session. It goes through the same `scrub` the execution trace uses (§20: never
// persist credentials or private reasoning), which also bounds strings, arrays
// and depth so one enormous command output cannot balloon the store.
//
// Deliberately *not* applied to the in-memory view: a running workflow's
// conditions and its caller still see the real values.
function serializeInstance(inst) {
  const view = instanceView(inst);
  return {
    ...view,
    inputs: scrub(inst.inputs || {}),
    outputs: scrub(view.outputs || {}),
    nodes: view.nodes.map((n) => ({ ...n, output: scrub(n.output) })),
  };
}

// Store record -> live instance. The inverse of serializeInstance.
function hydrate(rec) {
  return {
    id: rec.id,
    workflowId: rec.workflowId,
    status: rec.status,
    inputs: rec.inputs || {},
    outputs: rec.outputs || {},
    nodes: new Map((rec.nodes || []).map((n) => [n.id, { id: n.id, type: n.type, status: n.status, output: n.output ?? null, error: n.error ?? null }])),
    events: [],
    error: rec.error || null,
    traceId: rec.traceId || null,
    workspaceId: rec.workspaceId || null,
    taskId: rec.taskId || null,
    currentNodeId: rec.currentNodeId || null,
    cancellation: rec.cancellation || null,
    startedAt: rec.startedAt,
    completedAt: rec.completedAt ?? null,
  };
}

async function executorFor(node, exec, authorize, instance) {
  switch (node.type) {
    case 'start':
    case 'end':
      return { ok: true };
    case 'input':
      return { ok: true, data: instance.inputs[node.config.key || (node.inputs[0] || 'input')] ?? instance.inputs };
    case 'output':
      return { ok: true };
    case 'tool':
      return execTool(exec, node, authorize);
    case 'command':
      return execCommand(exec, node);
    case 'code':
      return execCode(exec, node);
    case 'agent':
      return execAgent(exec, node, instance);
    case 'condition':
      return { ok: true, value: matchesCondition(node.config.when || {}, instance.outputs, node.id) };
    case 'loop': {
      const items = Array.isArray(node.config.items) ? node.config.items : [];
      const results = [];
      for (const item of items) {
        // A long loop is the easiest place for a cancelled workflow to keep
        // burning work, so the request is honoured between iterations too.
        if (instance.cancellation && instance.cancellation.requested) {
          throw new WorkflowCancelledError(instance.cancellation.reason);
        }
        // loops re-run the target edge node once per item; item passed as context
        const out = node.config.onId && exec.toolManager
          ? await execTool(exec, { config: { toolId: node.config.onId, input: { ...(node.config.input || {}), item } } }, authorize)
          : { ok: true, item };
        results.push(out);
      }
      return { ok: true, results };
    }
    case 'parallel': {
      const branches = node.config.branches || [];
      const results = await Promise.all(branches.map((b) => execTool(exec, { config: { toolId: b.toolId, input: b.input || {} } }, authorize)));
      return { ok: true, results };
    }
    case 'approval': {
      let decision = true;
      if (exec.bus) decision = await requestApproval(exec, node, authorize, instance);
      if (decision !== true) throw new Error(`workflow blocked: approval denied at ${node.id}`);
      return { ok: true, approved: true };
    }
    default:
      throw new Error(`unsupported node type: ${node.type}`);
  }
}

async function execTool(exec, node, authorize) {
  if (!exec.toolManager) throw new Error('toolManager not provided to workflow engine');
  const toolId = node.config.toolId || (node.tool && node.tool.id);
  if (!toolId) throw new Error(`node ${node.id} is a tool node but has no toolId`);
  const agent = { id: 'workflow', name: 'workflow', capabilities: [], model: { provider: 'unset' }, permissions: { levels: ['read_only', 'safe', 'moderate'], allowDestructive: false } };
  // Workflow tools: same permission gate as runtime tools.
  return exec.toolManager.execute({ id: toolId, input: node.config.input || {}, agent, authorize, signal: exec.signal });
}

async function execCommand(exec, node) {
  if (!exec.shellIo || typeof exec.shellIo.run !== 'function') throw new Error('shellIo not provided to workflow engine');
  // The signal is offered, not required: a shell adapter that ignores it still
  // works, and cancellation still stops the walk at the next node boundary.
  return exec.shellIo.run(node.config.command, { cwd: node.config.cwd, timeoutMs: node.config.timeoutMs, signal: exec.signal });
}

async function execCode(exec, node) {
  if (!exec.execIo || typeof exec.execIo.execute !== 'function') throw new Error('execIo (CodeExecutor) not provided to workflow engine');
  return exec.execIo.execute({ lang: node.config.lang || 'js', code: node.config.code || '', timeout: node.config.timeoutMs, signal: exec.signal });
}

async function execAgent(exec, node, instance) {
  if (!exec.runAgent) throw new Error('runAgent callback not provided — cannot run agent nodes');
  const result = await exec.runAgent({ request: node.config.request || node.config.prompt, agentId: node.config.agentId, workspace: instance.inputs.workspace, signal: exec.signal });
  return { ok: true, agent: result };
}

async function requestApproval(exec, node, authorize, instance) {
  instance.status = INSTANCE_STATUS.AWAITING_APPROVAL;
  if (exec.bus) exec.bus.emit('approval.required', { workflowId: instance.workflowId }, { nodeId: node.id });

  // An instance parked on a human decision is the one place a cancel would
  // otherwise hang forever, so the wait races the abort signal.
  const decision = await raceAbort(authorize({ node, instance }), exec.signal);

  if (exec.bus) exec.bus.emit(decision ? 'approval.granted' : 'approval.denied', { workflowId: instance.workflowId }, { nodeId: node.id });
  if (decision === true) instance.status = INSTANCE_STATUS.RUNNING;
  return decision;
}

// Resolve with `promise`, or reject as soon as `signal` aborts — whichever
// happens first. The listener is always removed so a long-lived engine does not
// accumulate them.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new WorkflowCancelledError('cancelled'));
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason || new WorkflowCancelledError('cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

// matchesCondition: minimal safe condition DSL — no eval().
// { "key": "/regex/" } -> instance.outputs["<key>"].text or .stdout matches
// { "key": "literal" } -> equals
function matchesCondition(when, outputs, nodeId) {
  if (when === true || !when) return true;
  if (typeof when === 'string') return Boolean(outputs[nodeId]);
  for (const [key, val] of Object.entries(when)) {
    if (typeof val === 'string' && val.startsWith('/') && val.endsWith('/')) {
      try {
        if (!new RegExp(val.slice(1, -1), 'i').test(String(outputs[key] ? outputs[key].stdout || JSON.stringify(outputs[key]) : ''))) return false;
      } catch { return false; }
    } else if (String(outputs[key] ?? '') !== String(val)) {
      return false;
    }
  }
  return true;
}

module.exports = { WorkflowEngine, INSTANCE_STATUS, TERMINAL, WorkflowCancelledError };
