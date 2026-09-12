// Workflow Engine: runs a validated workflow definition.
//
// Node execution is small and typed; the engine owns iteration, edge traversal,
// inputs/outputs and the runtime story of each instance. Approvals pause the
// instance until the injected authorize callback resolves.

const { validateWorkflow } = require('./definition');
const { TYPES } = require('../events/event-bus');

const INSTANCE_STATUS = { PENDING: 'pending', RUNNING: 'running', AWAITING_APPROVAL: 'awaiting_approval', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' };

function createInstance(id, workflow, inputs) {
  return {
    id,
    workflowId: workflow.id,
    status: INSTANCE_STATUS.PENDING,
    inputs: { ...inputs },
    outputs: {},
    nodes: new Map(workflow.nodes.map((n) => [n.id, { id: n.id, type: n.type, status: 'pending', output: null, error: null }])),
    events: [],
    startedAt: Date.now(),
    completedAt: null,
  };
}

class WorkflowEngine {
  constructor({ bus, toolManager, runtime, shellIo, execIo, logger, authorize } = {}) {
    this._bus = bus;
    this._tools = toolManager;
    this._runtime = runtime;
    this._shellIo = shellIo; // { run(command,{cwd,timeoutMs}) }  — adapter to existing terminal
    this._execIo = execIo;   // CodeExecutor
    this._logger = logger;
    this._authorize = authorize || (async () => false);
    this._instances = new Map();
  }

  async run(workflowDef, { inputs = {}, id, runAgent } = {}) {
    const { ok, workflow, errors } = validateWorkflow(workflowDef);
    if (!ok) throw new Error(`invalid workflow: ${errors.join('; ')}`);
    const instance = createInstance(id || `wf-${Date.now().toString(36)}`, workflow, inputs);
    this._instances.set(instance.id, instance);
    instance.status = INSTANCE_STATUS.RUNNING;
    this._bus.emit(TYPES.WORKFLOW_STARTED, { workflowId: workflow.id, taskId: null }, { instanceId: instance.id });

    const exec = { toolManager: this._tools, runtime: this._runtime, shellIo: this._shellIo, execIo: this._execIo, runAgent: runAgent || null, logger: this._logger, bus: this._bus };

    try {
      await this._walk(instance, workflow, exec);
      if (instance.status === INSTANCE_STATUS.RUNNING) {
        instance.status = INSTANCE_STATUS.COMPLETED;
        instance.completedAt = Date.now();
        this._bus.emit(TYPES.WORKFLOW_COMPLETED, { workflowId: workflow.id }, { instanceId: instance.id, outputs: instance.outputs });
      }
    } catch (err) {
      instance.status = INSTANCE_STATUS.FAILED;
      instance.error = err.message;
      this._bus.emit(TYPES.WORKFLOW_FAILED, { workflowId: workflow.id }, { instanceId: instance.id, error: err.message });
    }
    return this.get(instance.id);
  }

  async _walk(instance, workflow, exec) {
    const start = workflow.nodes.find((n) => n.type === 'start');
    await this._visit(instance, workflow, start, exec, []);
  }

  async _visit(instance, workflow, node, exec, path) {
    if (path.includes(node.id)) throw new Error(`cycle detected at node ${node.id}`);
    const keyPath = [...path, node.id];
    const nState = instance.nodes.get(node.id);
    nState.status = 'running';
    try {
      const output = await executorFor(node, exec, this._authorize, instance);
      nState.status = 'completed';
      nState.output = output;
      instance.outputs[node.id] = output;

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
      nState.status = 'failed';
      nState.error = err.message;
      throw err;
    }
  }

  get(id) {
    const inst = this._instances.get(id);
    if (!inst) return null;
    return {
      id: inst.id,
      workflowId: inst.workflowId,
      status: inst.status,
      error: inst.error || null,
      outputs: inst.outputs,
      nodes: [...inst.nodes.entries()].map(([id, n]) => ({ id, type: n.type, status: n.status, error: n.error, output: n.output })),
      startedAt: inst.startedAt,
      completedAt: inst.completedAt,
    };
  }
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
  return exec.toolManager.execute({ id: toolId, input: node.config.input || {}, agent, authorize });
}

async function execCommand(exec, node) {
  if (!exec.shellIo || typeof exec.shellIo.run !== 'function') throw new Error('shellIo not provided to workflow engine');
  return exec.shellIo.run(node.config.command, { cwd: node.config.cwd, timeoutMs: node.config.timeoutMs });
}

async function execCode(exec, node) {
  if (!exec.execIo || typeof exec.execIo.execute !== 'function') throw new Error('execIo (CodeExecutor) not provided to workflow engine');
  return exec.execIo.execute({ lang: node.config.lang || 'js', code: node.config.code || '', timeout: node.config.timeoutMs });
}

async function execAgent(exec, node, instance) {
  if (!exec.runAgent) throw new Error('runAgent callback not provided — cannot run agent nodes');
  const result = await exec.runAgent({ request: node.config.request || node.config.prompt, agentId: node.config.agentId, workspace: instance.inputs.workspace });
  return { ok: true, agent: result };
}

async function requestApproval(exec, node, authorize, instance) {
  instance.status = INSTANCE_STATUS.AWAITING_APPROVAL;
  if (exec.bus) exec.bus.emit('approval.required', { workflowId: instance.workflowId }, { nodeId: node.id });
  const decision = await authorize({ node, instance });
  if (exec.bus) exec.bus.emit(decision ? 'approval.granted' : 'approval.denied', { workflowId: instance.workflowId }, { nodeId: node.id });
  if (decision === true) instance.status = INSTANCE_STATUS.RUNNING;
  return decision;
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

module.exports = { WorkflowEngine, INSTANCE_STATUS };