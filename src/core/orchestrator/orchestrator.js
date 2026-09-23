// The Orchestrator: one entry point above the Agent Runtime.
//
// What it does *not* do is the important part. It does not plan, execute,
// evaluate or recover — the Phase 2 AgentRuntime owns all of that and is called,
// not replaced. The Orchestrator owns the layer above: deciding what shape a
// request takes, building the world it runs inside, and making sure the run
// leaves a record.
//
//   route      → router.js: single agent, several, a workflow, a tool, or ask
//   prepare    → workspace + project detection + context packet + trace
//   execute    → runtime / coordinator / workflow engine, through the scheduler
//   conclude   → artifacts, memory candidates, snapshot, trace completion
//
// Every one of those is a subsystem this module composes. That is deliberate:
// an orchestrator that grows its own planner is how "coordination" becomes a
// second runtime nobody can reconcile with the first.

const { TYPES } = require('../events/event-bus');
const { identityRefs, createIdentity } = require('../workspace/identity');
const { TRACE_EVENTS } = require('../trace/events');
const { EXECUTION_MODES, createPolicies } = require('./policies');
const { Router } = require('./router');
const { Scheduler, PRIORITY } = require('./scheduler');
const { planDelegations, readyDelegations, auditDelegations } = require('./delegation');
const { SNAPSHOT_REASONS } = require('../state/snapshot');
const { ARTIFACT_TYPES } = require('../artifacts/artifact');

class Orchestrator {
  constructor({
    runtime, coordinator, workspaces, contextManager, memory = null, traces = null,
    artifacts = null, approvals = null, projects = null, workflows = null,
    agents = null, tools = null, bus = null, logger = null, provider = null,
    policies = {}, scheduler = null,
    // Optional, additive. `runs` indexes each objective as a Run the human can
    // inspect afterwards; `modelRouter` picks the provider/model a kind of work
    // should run on. Neither is required, and neither is allowed to break a
    // run if it fails — see `_indexRun`.
    runs = null, modelRouter = null,
  } = {}) {
    if (!runtime) throw new Error('Orchestrator requires an AgentRuntime');
    if (!workspaces) throw new Error('Orchestrator requires a WorkspaceManager');
    if (!contextManager) throw new Error('Orchestrator requires a ContextManager');

    this._runtime = runtime;
    this._coordinator = coordinator;
    this._workspaces = workspaces;
    this._context = contextManager;
    this._memory = memory;
    this._traces = traces;
    this._artifacts = artifacts;
    this._approvals = approvals;
    this._projects = projects;
    this._workflows = workflows;
    this._agents = agents;
    this._tools = tools;
    this._bus = bus;
    this._logger = logger;

    this._policies = createPolicies(policies);
    this._router = new Router({ policies: this._policies, agents, workflows, provider, logger });
    this._scheduler = scheduler || new Scheduler({ maxConcurrent: this._policies.maxConcurrentTasks, logger });
    this._runs = new Map(); // runId -> run record
    this._runIndex = runs;   // the RunManager that indexes an objective
    this._modelRouter = modelRouter;
  }

  get policies() { return this._policies; }
  get scheduler() { return this._scheduler; }
  get router() { return this._router; }

  // Decide without executing. Exposed so a UI can show "this would run as…"
  // before anything starts, and so routing is testable without side effects.
  route(spec) {
    return this._router.route(spec);
  }

  // The one call a host makes. Returns as soon as the run is queued, with the
  // record; `record.result` settles when it finishes, so a caller can either
  // poll (the IPC path) or await (a test).
  async handle({
    request,
    agentId = null,
    workflowId = null,
    mode = 'auto',
    workspace: workspaceSpec = null,
    sessionId = null,
    projectId = null,
    priority = PRIORITY.NORMAL,
    signal = null,
    options = {},
  } = {}) {
    if (!request || typeof request !== 'string') throw new Error('orchestrator.handle requires a request string');

    const decision = this._router.route({ request, agentId, workflowId, mode, capabilities: options.capabilities });
    const agent = this._pickAgent(decision, agentId);
    const root = normalizeRoot(workspaceSpec);

    // Model selection is routing too: which provider and model a *kind* of work
    // runs on is infrastructure, not a choice a person should have to make per
    // message. With no router (or no providers wired) this is null and the
    // deterministic path is unchanged.
    const modelSelection = this._modelRouter
      ? this._modelRouter.route({ kind: decision.mode })
      : null;

    const identity = createIdentity({
      sessionId: sessionId || undefined,
      agentId: agent ? agent.id : null,
      projectId: projectId || null,
    });

    const workspace = this._workspaces.create({
      identity,
      root,
      cwd: workspaceSpec && workspaceSpec.cwd ? workspaceSpec.cwd : root,
      policy: this._policies.workspacePolicy({
        ...(agent && agent.workspacePolicy ? agent.workspacePolicy : {}),
        ...(options.policy || {}),
      }),
      skills: agent ? agent.skills || [] : [],
      metadata: { requestedMode: mode, routedMode: decision.mode },
    });

    const trace = this._traces
      ? this._traces.createTrace({ identity: workspace.identity, label: request.slice(0, 80) })
      : null;
    if (trace) {
      this._traces.appendEvent(trace.traceId, TRACE_EVENTS.TASK_CREATED, {
        request: request.slice(0, 240), mode: decision.mode, agentId: agent ? agent.id : null,
      });
    }
    // Index the objective as a Run before work begins, so even a request that
    // fails immediately leaves something a person can open.
    const runEntry = this._runIndex
      ? await this._runIndex.start({
        objective: request,
        projectId: projectId || null,
        sessionId: identity.sessionId,
        traceId: trace ? trace.traceId : identity.traceId,
        agentId: agent ? agent.id : null,
        metadata: {
          mode: decision.mode,
          model: modelSelection ? { provider: modelSelection.provider, model: modelSelection.model } : null,
        },
      })
      : null;
    if (runEntry) {
      if (agent) await this._indexRun({ runId: runEntry.id }, (runs, id) => runs.addAgent(id, { id: agent.id, role: (agent.metadata && agent.metadata.role) || null }));
      if (modelSelection && modelSelection.provider) await this._indexRun({ runId: runEntry.id }, (runs, id) => runs.addProvider(id, { id: modelSelection.provider }));
      if (modelSelection && modelSelection.model) await this._indexRun({ runId: runEntry.id }, (runs, id) => runs.addModel(id, { id: modelSelection.model }));
    }

    const runId = runEntry ? runEntry.id : null;
    if (this._bus) {
      this._bus.emit(TYPES.ORCHESTRATION_ROUTED, { ...identityRefs(workspace.identity), runId }, {
        mode: decision.mode, reason: decision.reason, capabilities: decision.capabilities,
        agentId: agent ? agent.id : null,
        model: modelSelection ? { provider: modelSelection.provider, model: modelSelection.model } : null,
      });
    }

    const record = {
      id: workspace.workspaceId,
      runId,
      request,
      decision,
      identity: { ...workspace.identity },
      agentId: agent ? agent.id : null,
      model: modelSelection,
      status: 'queued',
      startedAt: Date.now(),
      completedAt: null,
      packetId: null,
      taskId: null,
      error: null,
      outcome: null,
    };
    this._runs.set(record.id, record);

    const job = this._scheduler.submit({
      taskId: workspace.taskId,
      label: request.slice(0, 60),
      priority,
      signal,
      run: ({ signal: jobSignal }) => this._execute({ record, workspace, agent, decision, request, trace, options, signal: jobSignal }),
    });
    record.jobId = job.id;
    record.result = job.result;
    return record;
  }

  get(runId) {
    const run = this._runs.get(runId);
    return run ? publicRun(run) : null;
  }

  list({ status = null, limit = 50 } = {}) {
    return [...this._runs.values()]
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(publicRun);
  }

  cancel(runId, reason = 'user requested') {
    const run = this._runs.get(runId);
    if (!run) return false;
    this._scheduler.cancel(run.jobId, reason);
    if (run.taskId) this._runtime.cancel(run.taskId, reason);
    if (this._coordinator) this._coordinator.cancelDelegations({});
    const ws = this._workspaces.get(runId);
    if (ws) this._workspaces.close(runId);
    if (this._runIndex && run.runId) this._runIndex.cancel(run.runId, reason).catch(() => {});
    run.status = 'cancelled';
    run.completedAt = Date.now();
    return true;
  }

  // Run indexing is an observer, never a participant. A failure to record what
  // happened must not turn into a failure of what happened.
  async _indexRun(record, fn) {
    if (!this._runIndex || !record.runId) return null;
    try {
      return await fn(this._runIndex, record.runId);
    } catch (err) {
      if (this._logger) this._logger.warn('run indexing failed', { error: err.message });
      return null;
    }
  }

  // --- execution -----------------------------------------------------------

  async _execute({ record, workspace, agent, decision, request, trace, options, signal }) {
    record.status = 'running';
    try {
      // 1. the project this runs against
      const project = await this._detectProject(workspace);
      if (project) {
        workspace.metadata.projectId = project.projectId;
        workspace.identity = Object.freeze({ ...workspace.identity, projectId: project.projectId });
      }

      // 2. the context the agent gets — searched memory, selected files,
      //    budgeted. Never the repository.
      const packet = await this._context.build({
        request,
        agent,
        workspace,
        project,
        files: options.files || [],
        constraints: options.constraints || [],
        memoryLimit: this._policies.memory.maxRetrieved,
      });
      record.packetId = packet.id;
      if (trace) {
        this._traces.appendEvent(trace.traceId, TRACE_EVENTS.CONTEXT_CREATED, {
          packetId: packet.id, digest: packet.digest,
          items: packet.items.length, usedTokens: packet.budget.usedTokens,
        });
      }
      await this._indexRun(record, (runs, id) => runs.addEvent(id, {
        type: 'context.created', summary: `context packet ${packet.id} (${packet.items.length} items)`,
      }));

      // 3. run it in whatever shape routing chose
      let outcome;
      switch (decision.mode) {
        case EXECUTION_MODES.WORKFLOW:
          outcome = await this._runWorkflow({ decision, options, workspace, trace });
          break;
        case EXECUTION_MODES.MULTI_AGENT:
          outcome = await this._runMultiAgent({ request, decision, workspace, trace, signal });
          break;
        case EXECUTION_MODES.APPROVAL:
          outcome = await this._runWithApproval({ request, decision, agent, workspace, trace, signal, record });
          break;
        case EXECUTION_MODES.TOOL:
        case EXECUTION_MODES.SINGLE_AGENT:
        default:
          outcome = await this._runSingleAgent({ request, agent, workspace, trace, signal, record });
          break;
      }

      // 4. what the run leaves behind
      await this._conclude({ record, workspace, outcome, trace, agent });
      record.status = outcome.ok ? 'completed' : 'failed';
      record.outcome = outcome;
      record.error = outcome.ok ? null : outcome.error;
      record.completedAt = Date.now();

      if (record.taskId) await this._indexRun(record, (runs, id) => runs.addTask(id, { id: record.taskId }));
      await this._indexRun(record, (runs, id) => (outcome.ok
        ? runs.complete(id, { result: { ok: true, mode: decision.mode, summary: outcome.summary || null } })
        : runs.fail(id, { error: outcome.error || `run ended in ${decision.mode}` })));

      if (trace) await this._traces.completeTrace(trace.traceId, { ok: outcome.ok, mode: decision.mode });
      if (this._bus) {
        this._bus.emit(outcome.ok ? TYPES.ORCHESTRATION_COMPLETED : TYPES.ORCHESTRATION_FAILED,
          identityRefs(workspace.identity),
          { mode: decision.mode, ok: outcome.ok, error: outcome.error || null });
      }
      return outcome;
    } catch (err) {
      record.status = 'failed';
      record.error = err.message;
      record.completedAt = Date.now();
      if (trace) await this._traces.failTrace(trace.traceId, err);
      await this._indexRun(record, (runs, id) => runs.fail(id, { error: err.message }));
      if (this._bus) this._bus.emit(TYPES.ORCHESTRATION_FAILED, identityRefs(workspace.identity), { error: err.message });
      if (this._logger) this._logger.error('orchestration failed', { error: err.message });
      return { ok: false, error: err.message };
    } finally {
      this._workspaces.close(workspace.workspaceId);
    }
  }

  async _runSingleAgent({ request, agent, workspace, trace, signal, record }) {
    const started = await this._runtime.runAgentTask({
      request,
      agentId: agent ? agent.id : undefined,
      workspace: { root: workspace.root, cwd: workspace.cwd },
      options: { workspaceId: workspace.workspaceId },
    }, { mode: 'auto' });
    record.taskId = started.id;
    return this._awaitTask(started.id, { workspace, trace, signal, timeoutMs: this._policies.taskTimeoutMs });
  }

  // Approval-gated: the human decides before an agent touches anything.
  async _runWithApproval({ request, decision, agent, workspace, trace, signal, record }) {
    if (!this._approvals) {
      return { ok: false, error: 'this request requires approval but no ApprovalManager is wired' };
    }
    const { request: approvalRequest, decision: verdict } = this._approvals.requestApproval({
      action: 'command.destructive',
      summary: request.slice(0, 200),
      reason: decision.reason,
      identity: workspace.identity,
    });
    if (trace) {
      this._traces.appendEvent(trace.traceId, TRACE_EVENTS.APPROVAL_REQUESTED, {
        requestId: approvalRequest.id, action: approvalRequest.action, risk: approvalRequest.risk,
      });
    }
    const resolved = await verdict;
    if (trace) {
      this._traces.appendEvent(trace.traceId, TRACE_EVENTS.APPROVAL_RESOLVED, {
        requestId: resolved.id, status: resolved.status, decidedBy: resolved.decidedBy,
      });
    }
    if (resolved.status !== 'approved') {
      return { ok: false, error: `not approved (${resolved.status})`, approval: resolved.status };
    }
    return this._runSingleAgent({ request, agent, workspace, trace, signal, record });
  }

  async _runMultiAgent({ request, decision, workspace, trace, signal }) {
    if (!this._coordinator) return { ok: false, error: 'multi-agent routing needs an AgentCoordinator' };

    const specs = planDelegations({
      request,
      decision,
      parentPolicy: workspace.policy,
      maxDelegations: this._policies.maxDelegationsPerTask,
      timeoutMs: this._policies.delegationTimeoutMs,
    });
    if (specs.length === 0) return { ok: false, error: 'multi-agent routing produced no delegations' };

    // Refuse loudly rather than silently dropping an over-reaching spec: a
    // dropped permission looks like a bug in the delegate, not in the plan.
    const problems = auditDelegations(specs, workspace.policy);
    if (problems.length) return { ok: false, error: `delegation plan rejected: ${problems.join('; ')}` };

    const results = [];
    const completed = [];
    let guard = 0;
    while (completed.length < specs.length && guard++ < specs.length + 2) {
      const ready = readyDelegations(specs, completed);
      if (ready.length === 0) break;
      const batch = await Promise.all(ready.map((spec) => this._coordinator.delegate({
        from: workspace,
        capabilities: spec.capabilities,
        request: spec.request,
        policy: spec.policy,
        timeoutMs: spec.timeoutMs,
        resultSchema: spec.resultSchema,
        signal,
        depth: 0,
      })));
      results.push(...batch);
      completed.push(...ready.map((s) => s.id));
      // A failed phase stops the chain: running "test" after "implement" failed
      // produces a confusing result rather than a useful one.
      if (batch.some((b) => !b.ok)) break;
    }

    const aggregate = this._coordinator.aggregate(results);
    if (trace) {
      this._traces.appendEvent(trace.traceId, TRACE_EVENTS.EVALUATION, {
        summary: `${aggregate.completed}/${specs.length} delegations completed`,
        ok: aggregate.ok, partial: aggregate.partial,
      });
    }
    return {
      ok: aggregate.ok,
      partial: aggregate.partial,
      error: aggregate.ok ? null : aggregate.errors.map((e) => `${e.agentId}: ${e.error}`).join('; '),
      delegations: aggregate.results,
      artifacts: aggregate.artifacts,
    };
  }

  async _runWorkflow({ decision: _decision, options, workspace: _workspace, trace }) {
    if (!this._workflows) return { ok: false, error: 'workflow routing needs a WorkflowEngine' };
    const definition = options.workflow || null;
    if (!definition) return { ok: false, error: 'workflow routing requires a workflow definition in options.workflow' };
    const instance = await this._workflows.run(definition, { inputs: options.inputs || {} });
    if (trace) {
      this._traces.appendEvent(trace.traceId, TRACE_EVENTS.EVALUATION, {
        summary: `workflow ${instance.workflowId} ${instance.status}`, status: instance.status,
      });
    }
    return { ok: instance.status === 'completed', error: instance.error || null, workflow: instance };
  }

  // Waits for the runtime to reach a terminal state, mirroring step transitions
  // into the trace as it goes. The runtime stays the source of truth; this only
  // observes it.
  async _awaitTask(taskId, { workspace, trace, signal, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    let lastStepStatus = new Map();
    for (;;) {
      const task = this._runtime.get(taskId);
      if (!task) return { ok: false, error: 'the task disappeared from the runtime', taskId };

      if (trace) this._mirrorSteps(trace, task, lastStepStatus, workspace);

      if (['completed', 'failed', 'cancelled'].includes(task.state)) {
        const ok = task.state === 'completed';
        return {
          ok,
          taskId,
          state: task.state,
          error: ok ? null : (task.outcome && task.outcome.error) || `task ended in ${task.state}`,
          summary: task.outcome ? task.outcome.summary : null,
          steps: (task.steps || []).map((s) => ({ id: s.id, title: s.title, status: s.status, toolId: s.tool ? s.tool.id : null })),
        };
      }
      if (signal && signal.aborted) {
        this._runtime.cancel(taskId, 'orchestration cancelled');
        return { ok: false, error: 'cancelled', taskId };
      }
      if (Date.now() > deadline) {
        this._runtime.cancel(taskId, 'orchestration timed out');
        return { ok: false, error: `task timed out after ${timeoutMs}ms`, taskId };
      }
      await sleep(40);
    }
  }

  _mirrorSteps(trace, task, lastStepStatus, workspace) {
    for (const step of task.steps || []) {
      if (lastStepStatus.get(step.id) === step.status) continue;
      lastStepStatus.set(step.id, step.status);
      const type = step.status === 'completed' ? TRACE_EVENTS.STEP_COMPLETED
        : step.status === 'failed' ? TRACE_EVENTS.STEP_FAILED
          : step.status === 'executing' ? TRACE_EVENTS.STEP_STARTED
            : null;
      if (!type) continue;
      this._traces.appendEvent(trace.traceId, type, {
        stepId: step.id, title: step.title, toolId: step.tool ? step.tool.id : null,
        summary: `${step.title} — ${step.status}`,
        error: step.output && step.output.error ? step.output.error : null,
      }, { identity: identityRefs(workspace.identity) });
    }
  }

  // --- conclusion ----------------------------------------------------------

  // Artifacts for what changed, a memory candidate for what is worth keeping,
  // and a snapshot. Memory is proposed and scored, never written wholesale —
  // that is the difference between remembering and hoarding.
  async _conclude({ record, workspace, outcome, trace, agent }) {
    const diff = workspace.files.diff();
    if (this._artifacts && diff.length > 0) {
      const artifact = await this._artifacts.recordDiff(diff, { workspace, name: `changes-${workspace.taskId}` });
      if (trace) this._traces.appendEvent(trace.traceId, TRACE_EVENTS.ARTIFACT_CREATED, { id: artifact.id, type: ARTIFACT_TYPES.DIFF, name: artifact.name });
      await this._indexRun(record, (runs, id) => runs.addArtifact(id, { id: artifact.id, name: artifact.name, type: artifact.type }));
    }

    if (this._memory && agent && (agent.memoryPolicy ? agent.memoryPolicy.write : true) && this._policies.memory.write) {
      const candidate = this._memory.candidate({
        type: outcome.ok ? 'result' : 'observation',
        content: outcome.ok
          ? `Completed: ${record.request}. ${outcome.summary ? JSON.stringify(outcome.summary).slice(0, 400) : ''}`.trim()
          : `Failed: ${record.request}. ${outcome.error || ''}`.trim(),
        source: 'orchestrator',
        failed: !outcome.ok,
        tags: ['task-outcome'],
      }, { policy: workspace.memoryPolicy(), scope: 'session' });

      const stored = await this._memory.commitCandidate(candidate, {
        policy: workspace.memoryPolicy(),
        refs: identityRefs(workspace.identity),
      });
      if (stored) {
        workspace.attachMemory(stored.id);
        if (trace) this._traces.appendEvent(trace.traceId, TRACE_EVENTS.MEMORY_WRITTEN, { id: stored.id, importance: stored.importance });
      }
    }

    if (this._recovery) {
      await this._recovery.capture({
        workspace,
        task: record.taskId ? this._runtime.get(record.taskId) : null,
        reason: outcome.ok ? SNAPSHOT_REASONS.COMPLETION : SNAPSHOT_REASONS.FAILURE,
      });
    }
  }

  // Lets the platform wire the recovery manager after construction (it needs the
  // orchestrator's workspaces, so the two would otherwise be circular).
  attachRecovery(recovery) {
    this._recovery = recovery;
    return this;
  }

  async _detectProject(workspace) {
    if (!this._projects || !workspace.root) return null;
    try {
      return await this._projects.detect(workspace.root);
    } catch (err) {
      if (this._logger) this._logger.warn('project detection failed', { error: err.message });
      return null;
    }
  }

  _pickAgent(decision, requestedId) {
    if (!this._agents) return null;
    if (this._coordinator) {
      return this._coordinator.selectAgent({ capabilities: decision.capabilities, preferred: requestedId || decision.agentId });
    }
    const wanted = requestedId || decision.agentId;
    return (wanted && this._agents.get(wanted)) || this._agents.list({ enabled: true })[0] || null;
  }
}

function normalizeRoot(spec) {
  if (!spec) return null;
  if (typeof spec === 'string') return spec;
  return spec.root || spec.cwd || null;
}

function publicRun(run) {
  return {
    id: run.id, runId: run.runId || null, request: run.request, status: run.status,
    mode: run.decision.mode, reason: run.decision.reason, agentId: run.agentId,
    taskId: run.taskId, packetId: run.packetId, identity: run.identity, error: run.error,
    model: run.model || null,
    startedAt: run.startedAt, completedAt: run.completedAt,
    outcome: run.outcome ? { ok: run.outcome.ok, error: run.outcome.error || null } : null,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Orchestrator, EXECUTION_MODES, PRIORITY };
