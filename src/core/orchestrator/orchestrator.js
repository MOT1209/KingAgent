// The Orchestrator: the control plane.
//
// §49's pipeline, wired end to end:
//
//   User → Orchestrator → Router → Agent → Harness → Policy → Sandbox →
//   Workspace → Context + Memory → Planning → Tools → Execution → Observation →
//   Evaluation → Recovery/Replan → Artifacts → Trace → Result
//
// Two deliberate constraints that keep this from becoming a second runtime:
//
//   1. **It does not execute.** When the route picks the built-in backend it
//      hands the task to the existing AgentRuntime — the same Phase 2 object
//      with its planner, executor, evaluator and recovery manager — and waits
//      for the result. Nothing about plan/execute/evaluate is reimplemented
//      here. When the route picks an external harness, the host's
//      `harnessRunner` drives the conversation; the orchestrator owns the
//      bookkeeping around it, not the conversation.
//   2. **Every step is bracketed by governance.** Routing emits a decision,
//      policy is consulted before the sandbox exists, the sandbox is created
//      from the authorized workspace only, and the session is the container all
//      of it is attached to. There is no path that runs work outside those
//      brackets, which is what makes "the agent cannot grant itself
//      permissions" checkable rather than aspirational.

const { randomUUID } = require('node:crypto');
const { TYPES } = require('../events/event-bus');
const { isPlainObject } = require('../schema/validate');

const TRACE_LIMIT = 500;
const POLL_INTERVAL_MS = 25;

class OrchestratorError extends Error {
  constructor(message, { code = 'ORCHESTRATOR_ERROR', decision = null } = {}) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.decision = decision;
  }
}

class Orchestrator {
  constructor({
    bus,
    logger = null,
    agents = null,
    runtime,
    router,
    harnesses = null,
    policy = null,
    sandboxes = null,
    sessions = null,
    coordinator = null,
    artifacts = null,
    memory = null,
    harnessRunner = null,
    evaluate = null,
    config = {},
  } = {}) {
    if (!bus) throw new Error('Orchestrator requires an EventBus');
    if (!runtime) throw new Error('Orchestrator requires the AgentRuntime');
    if (!router) throw new Error('Orchestrator requires an AgentRouter');
    this._bus = bus;
    this._logger = logger;
    this._agents = agents;
    this._runtime = runtime;
    this._router = router;
    this._harnesses = harnesses;
    this._policy = policy;
    this._sandboxes = sandboxes;
    this._sessions = sessions;
    this._coordinator = coordinator;
    this._artifacts = artifacts;
    this._memory = memory;
    this._harnessRunner = harnessRunner;
    this._evaluate = evaluate;
    this._config = { taskTimeoutMs: 10 * 60 * 1000, ...config };
    this._traces = new Map(); // taskId -> ring of trace entries
    this._runs = new Map();   // taskId -> run record
  }

  // --- the main entry point -------------------------------------------------

  async run(request, {
    taskId = null,
    sessionId = null,
    agentId = null,
    harnessId = null,
    workspace = null,
    workspaceId = null,
    mode = 'auto',
    strategy = 'capability',
    limits = {},
    timeoutMs = null,
    model = null,
  } = {}) {
    if (typeof request !== 'string' || request.trim() === '') {
      throw new OrchestratorError('a request is required', { code: 'ORCHESTRATOR_EMPTY_REQUEST' });
    }
    const workspaceRoot = workspaceRootOf(workspace);
    if (!workspaceRoot) {
      throw new OrchestratorError('an authorized workspace is required; the orchestrator never runs outside one', { code: 'ORCHESTRATOR_NO_WORKSPACE' });
    }

    const session = this._openSession({ sessionId, workspaceRoot, workspaceId, agentId });
    const traceOf = (entry) => this._trace(session.id, taskId, entry);

    // 1. Route.
    const decision = await this._router.route({
      request,
      taskId,
      sessionId: session.id,
      workspaceId: workspaceId || workspaceRoot,
      strategy,
      agentId,
      harnessId,
      model,
    });
    traceOf({ step: 'route', agentId: decision.agentId, harnessId: decision.harnessId, strategy: decision.strategy, score: decision.score });
    // Record the chosen backend on the session as soon as it is chosen, so the
    // control center can name it even if the run never gets as far as starting.
    if (this._sessions && decision.harnessId) this._sessions.attachHarness(session.id, decision.harnessId);

    if (!decision.agentId || !decision.harnessId) {
      this._sessions && this._sessions.fail(session.id, 'no compatible agent and harness');
      return {
        ok: false,
        sessionId: session.id,
        taskId: null,
        decision,
        reasons: decision.reasons,
        artifacts: [],
      };
    }

    // 2. Policy, before any execution resource exists.
    if (this._policy) {
      const verdict = await this._policy.evaluate({
        action: 'agent.run',
        context: {
          agentId: decision.agentId,
          harnessId: decision.harnessId,
          sessionId: session.id,
          workspaceId: workspaceId || workspaceRoot,
          taskId,
        },
      });
      traceOf({ step: 'policy', effect: verdict.effect, policyId: verdict.policyId, reason: verdict.reason });
      if (!verdict.allowed) {
        if (this._sessions) this._sessions.fail(session.id, `policy denied: ${verdict.reason}`);
        return { ok: false, sessionId: session.id, taskId: null, decision, artifacts: [], denied: verdict };
      }
      // A policy may attach limit-shaped constraints, which are folded into the
      // sandbox request. They cannot widen anything: the sandbox clamps against
      // its own ceiling regardless of where the numbers came from.
      if (verdict.constraints) limits = { ...(isPlainObject(limits) ? limits : {}), ...pickLimitConstraints(verdict.constraints) };
    }

    // 3. Sandbox. Nothing runs before this, and it is created from the
    // authorized workspace only.
    let sandbox = null;
    if (this._sandboxes) {
      sandbox = await this._sandboxes.create({
        taskId: taskId || undefined,
        workspaceId: workspaceId || workspaceRoot,
        agentId: decision.agentId,
        harnessId: decision.harnessId,
        sessionId: session.id,
        traceId: session.traceId,
        workspaceRoot,
        limits,
      });
      if (this._sessions) this._sessions.attachSandbox(session.id, sandbox.id);
      traceOf({ step: 'sandbox', sandboxId: sandbox.id, backend: sandbox.backendId, limits: sandbox.limits });
    }

    // 4. Execute — on the built-in backend or through an external harness.
    let outcome;
    try {
      outcome = decision.harnessId === 'kingagent-runtime'
        ? await this._runInternal({ request, decision, workspaceRoot, mode, timeoutMs, session, traceOf })
        : await this._runHarness({ request, decision, workspaceRoot, session, taskId, sandbox, timeoutMs, traceOf });
    } catch (err) {
      if (sandbox && this._sandboxes) await this._sandboxes.stop(sandbox.id, 'run failed').catch(() => {});
      if (this._sessions) this._sessions.fail(session.id, err.message);
      traceOf({ step: 'failed', error: err.message });
      this._finish(session.id, null);
      return { ok: false, sessionId: session.id, taskId: taskId || null, decision, artifacts: [], error: err.message };
    }

    // 5. Artifacts.
    const artifacts = this._collectArtifacts(outcome, {
      taskId: outcome.taskId || taskId,
      workspaceId: workspaceId || workspaceRoot,
      agentId: decision.agentId,
      harnessId: decision.harnessId,
      sessionId: session.id,
      traceId: session.traceId,
    });
    traceOf({ step: 'artifacts', count: artifacts.length });

    // 6. Evaluation.
    const evaluation = await this._judge(outcome, { request, decision, artifacts });
    traceOf({ step: 'evaluate', passed: evaluation.passed, summary: evaluation.summary });

    // 7. Recovery / replan is owned by the runtime for internal runs (it has a
    // RecoveryManager) and reported here for external ones. The orchestrator
    // never silently retries an external harness: a retry there can cost real
    // money and needs the same reasoning a plan does.
    if (!evaluation.passed && decision.harnessId === 'kingagent-runtime' && outcome.state === 'failed') {
      traceOf({ step: 'recovery', note: 'runtime recovery already applied; not replanning at the orchestrator level' });
    }

    // 8. Session outcome + cleanup.
    if (evaluation.passed) {
      this._sessions && this._sessions.complete(session.id, evaluation.summary);
    } else {
      this._sessions && this._sessions.fail(session.id, evaluation.summary);
    }
    if (sandbox && this._sandboxes) {
      await this._sandboxes.stop(sandbox.id, 'run complete').catch(() => {});
      traceOf({ step: 'sandbox.stopped', sandboxId: sandbox.id });
    }
    this._finish(session.id, outcome.taskId || taskId);

    return {
      ok: evaluation.passed,
      sessionId: session.id,
      taskId: outcome.taskId || taskId || null,
      decision,
      evaluation,
      artifacts,
      harness: outcome.harness || decision.harnessId,
      taskState: outcome.state || null,
      result: outcome.result || null,
      trace: this.trace(session.id, outcome.taskId || taskId),
    };
  }

  // --- execution backends ---------------------------------------------------

  // The built-in path: hand the task to the existing AgentRuntime and await its
  // terminal state. No planning, execution or evaluation logic is duplicated.
  async _runInternal({ request, decision, workspaceRoot, mode, timeoutMs, session, traceOf }) {
    const task = await this._runtime.runAgentTask({
      request,
      agentId: decision.agentId,
      workspace: { root: workspaceRoot, cwd: workspaceRoot },
      mode,
    }, { mode: mode || 'auto' });

    if (this._sessions) this._sessions.attachTask(session.id, task.id);
    if (this._sessions) this._sessions.attachAgent(session.id, decision.agentId);
    traceOf({ step: 'runtime.started', taskId: task.id, state: task.state });

    const finalTask = await this._awaitTask(task.id, timeoutMs || this._config.taskTimeoutMs);
    traceOf({ step: 'runtime.settled', taskId: task.id, state: finalTask ? finalTask.state : 'unknown' });
    return { taskId: task.id, state: finalTask ? finalTask.state : 'unknown', task: finalTask, harness: 'kingagent-runtime' };
  }

  // The external path: start the harness run inside the sandbox and let the
  // host's runner drive it. Without a runner this is an explicit failure, not a
  // silent pretend-success.
  async _runHarness({ request, decision, workspaceRoot, session, taskId, sandbox, timeoutMs, traceOf }) {
    if (typeof this._harnessRunner !== 'function') {
      throw new OrchestratorError(
        `harness "${decision.harnessId}" has no runner wired on this host`,
        { code: 'ORCHESTRATOR_NO_HARNESS_RUNNER', decision },
      );
    }
    const start = await this._harnesses.start({
      harnessId: decision.harnessId,
      ctx: {
        taskId: taskId || `task-${randomUUID().slice(0, 8)}`,
        sessionId: session.id,
        workspaceId: workspaceRoot,
        agentId: decision.agentId,
        sandboxId: sandbox ? sandbox.id : null,
        cwd: workspaceRoot,
        traceId: session.traceId,
        request,
      },
    });
    traceOf({ step: 'harness.started', harnessId: decision.harnessId, runId: start.runId });

    try {
      const result = await this._harnessRunner({
        harness: this._harnesses.registry.get(decision.harnessId),
        runId: start.runId,
        request,
        agentId: decision.agentId,
        sessionId: session.id,
        taskId: start.taskId,
        sandbox,
        workspaceRoot,
        timeoutMs: timeoutMs || this._config.taskTimeoutMs,
      });
      if (this._sessions && start.taskId) this._sessions.attachTask(session.id, start.taskId);
      return {
        taskId: start.taskId,
        runId: start.runId,
        state: result && result.ok === false ? 'failed' : 'completed',
        result: result ? result.result || result : null,
        artifacts: (result && result.artifacts) || [],
        testResults: result && result.testResults,
        diff: result && result.diff,
        error: result && result.error,
        harness: decision.harnessId,
      };
    } finally {
      await this._harnesses.stop(start.runId, 'run finished').catch(() => {});
      traceOf({ step: 'harness.stopped', runId: start.runId });
    }
  }

  // Poll the runtime until the task settles. Pause is respected: a paused task
  // keeps this loop waiting rather than failing the run.
  async _awaitTask(taskId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = this._runtime.get(taskId);
      if (!task) return null;
      if (['completed', 'failed', 'cancelled'].includes(task.state)) return task;
      if (Date.now() > deadline) {
        await this._runtime.cancel(taskId, 'orchestrator timeout').catch(() => {});
        return this._runtime.get(taskId);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  // --- artifacts + evaluation ------------------------------------------------

  _collectArtifacts(outcome, refs) {
    if (!this._artifacts) return [];
    const saved = [];
    const candidates = [];
    if (Array.isArray(outcome.artifacts)) candidates.push(...outcome.artifacts);
    if (outcome.diff) candidates.push({ type: 'diff', name: 'task diff', content: typeof outcome.diff === 'string' ? outcome.diff : JSON.stringify(outcome.diff, null, 2) });
    if (outcome.testResults) {
      candidates.push({
        type: 'test-result',
        name: 'test results',
        content: typeof outcome.testResults === 'string' ? outcome.testResults : JSON.stringify(outcome.testResults, null, 2),
        summary: outcome.testResults.summary || '',
      });
    }
    // The built-in runtime's final report step is an artifact in all but name.
    const task = outcome.task;
    if (task && task.outcome && task.outcome.summary) {
      candidates.push({
        type: 'report',
        name: 'task report',
        content: typeof task.outcome.summary === 'string' ? task.outcome.summary : JSON.stringify(task.outcome.summary, null, 2),
      });
    }

    for (const candidate of candidates) {
      try {
        const summary = this._artifacts.add({
          type: candidate.type || 'report',
          name: candidate.name || 'artifact',
          summary: candidate.summary || '',
          content: typeof candidate.content === 'string' ? candidate.content : JSON.stringify(candidate.content, null, 2),
          ref: candidate.ref || null,
          ...refs,
          taskId: refs.taskId || null,
        });
        saved.push(summary);
        if (this._sessions && refs.sessionId) this._sessions.attachArtifact(refs.sessionId, summary.id);
      } catch (err) {
        if (this._logger) this._logger.warn('artifact could not be stored', { error: err.message, type: candidate.type });
      }
    }
    return saved;
  }

  async _judge(outcome, context) {
    if (typeof this._evaluate === 'function') {
      const verdict = await this._evaluate(outcome, context);
      if (isPlainObject(verdict) && typeof verdict.passed === 'boolean') return verdict;
    }
    // Default: the backend's own verdict, made explicit. For an internal run
    // that is the runtime's terminal state; for an external one it is the
    // runner's `ok`.
    if (outcome.harness === 'kingagent-runtime') {
      const passed = outcome.state === 'completed';
      return {
        passed,
        summary: passed
          ? `task ${outcome.taskId} completed`
          : `task ${outcome.taskId} ended in state "${outcome.state}"`,
        source: 'runtime',
      };
    }
    const passed = outcome.state !== 'failed';
    return {
      passed,
      summary: passed ? `${outcome.harness} run completed` : `${outcome.harness} run failed: ${outcome.error || 'unknown error'}`,
      source: 'harness',
    };
  }

  // --- sessions, tracing, control --------------------------------------------

  _openSession({ sessionId, workspaceRoot, workspaceId, agentId }) {
    if (!this._sessions) {
      // A host without sessions still gets a stable id so the trace works.
      return { id: sessionId || `session-${randomUUID().slice(0, 8)}`, traceId: null };
    }
    if (sessionId) {
      const existing = this._sessions.get(sessionId);
      if (existing) {
        if (existing.state === 'paused') this._sessions.resume(sessionId);
        else if (existing.state === 'ready') this._sessions.start(sessionId);
        if (agentId) this._sessions.attachAgent(sessionId, agentId);
        return this._sessions.get(sessionId);
      }
    }
    const created = this._sessions.create({
      id: sessionId || undefined,
      workspaceId: workspaceId || workspaceRoot,
      workspaceRoot,
      agentIds: agentId ? [agentId] : [],
    });
    this._sessions.start(created.id);
    return this._sessions.get(created.id);
  }

  // One trace per run, keyed by the session. Keying by taskId would split the
  // trace the moment a runtime task is created — the routing and policy steps
  // happen before a task exists, and they belong to the same run.
  _trace(sessionId, taskId, entry) {
    const key = sessionId;
    if (!key) return;
    if (!this._traces.has(key)) this._traces.set(key, []);
    const ring = this._traces.get(key);
    ring.push({ ...entry, at: Date.now(), taskId: taskId || null, sessionId });
    if (ring.length > TRACE_LIMIT) ring.splice(0, ring.length - TRACE_LIMIT);
    if (entry.step) {
      this._bus.emit(TYPES.ORCHESTRATOR_STEP, { taskId: taskId || null, sessionId }, { step: entry.step, detail: summarizeEntry(entry) });
    }
  }

  trace(sessionId, _taskId = null) {
    const ring = this._traces.get(sessionId);
    return ring ? ring.map((e) => ({ ...e })) : [];
  }

  _finish(sessionId, taskId) {
    this._runs.set(sessionId, { sessionId, taskId, at: Date.now() });
  }

  // Pause/resume/cancel delegate to whichever backend is running the work.
  async pause({ sessionId, taskId = null }) {
    if (taskId && this._runtime.get(taskId)) return this._runtime.pause(taskId);
    if (this._sessions && sessionId) return this._sessions.pause(sessionId);
    return null;
  }

  async resume({ sessionId, taskId = null }) {
    if (taskId && this._runtime.get(taskId)) return this._runtime.resume(taskId);
    if (this._sessions && sessionId) return this._sessions.resume(sessionId);
    return null;
  }

  // Cancellation reaches every layer, and reports what it actually stopped.
  //
  // The ownership of the *resource* teardown is deliberately single: when a
  // coordinator is wired it owns stopping the task's harness runs and sandboxes
  // (via coordinator.cancelTask), so the orchestrator records what was running
  // before cancelling rather than stopping everything twice.
  async cancel({ sessionId, taskId = null, reason = 'cancelled' }) {
    const runningRuns = this._harnesses && taskId ? this._harnesses.runsForTask(taskId) : [];
    const runningSandboxes = this._sandboxes && taskId ? this._sandboxes.forTask(taskId).map((s) => s.id) : [];

    if (taskId && this._runtime.get(taskId)) this._runtime.cancel(taskId, reason);

    const delegations = this._coordinator && taskId
      ? await this._coordinator.cancelTask(taskId, reason)
      : [];
    if (!this._coordinator) {
      if (this._harnesses && taskId) await this._harnesses.stopTask(taskId, reason);
      if (this._sandboxes && taskId) await this._sandboxes.stopTask(taskId, reason);
    }

    if (this._sessions && sessionId) this._sessions.stop(sessionId, reason);
    return {
      task: taskId && this._runtime.get(taskId) ? taskId : null,
      delegations,
      harnessRuns: runningRuns,
      sandboxes: runningSandboxes,
    };
  }

  // §36's control center, assembled from what each subsystem actually knows.
  controlCenter({ sessionId = null, taskId = null } = {}) {
    const session = this._sessions && sessionId ? this._sessions.controlView(sessionId) : null;
    const task = taskId ? this._runtime.get(taskId) : null;
    const view = {
      session,
      task: task ? {
        id: task.id,
        state: task.state,
        phase: task.phase,
        request: task.request.slice(0, 200),
        agentId: task.agentId,
        steps: (task.steps || []).map((s) => ({ id: s.id, title: s.title, status: s.status })),
        currentStep: (task.steps || []).find((s) => s.status === 'executing')?.title || null,
      } : null,
      harness: session && session.harnessIds.length ? session.harnessIds[session.harnessIds.length - 1] : null,
      sandboxes: session
        ? (this._sandboxes ? session.sandboxIds.map((id) => this._sandboxes.snapshot(id)).filter(Boolean) : [])
        : [],
      artifacts: this._artifacts && taskId ? this._artifacts.list({ taskId }) : [],
      subAgents: this._coordinator && taskId ? this._coordinator.controlView(taskId).subAgents : [],
      policy: this._policy ? this._policy.audit({ limit: 10 }) : [],
      trace: this.trace(sessionId, taskId),
    };
    return view;
  }
}

module.exports = { Orchestrator, OrchestratorError };

function workspaceRootOf(workspace) {
  if (!workspace) return null;
  if (typeof workspace === 'string') return workspace;
  return workspace.root || workspace.cwd || null;
}

// Policy constraints are advisory data; only the limit-shaped ones are applied,
// and only to make the sandbox stricter (limits.clampLimits re-clamps anyway).
function pickLimitConstraints(constraints) {
  const out = {};
  for (const key of ['cpuTimeMs', 'memoryMb', 'maxProcesses', 'timeoutMs', 'filesystemMode', 'networkMode', 'environmentPolicy']) {
    if (constraints[key] !== undefined) out[key] = constraints[key];
  }
  return out;
}

// Only scalars ride along with the step event: a leaked object here would put a
// plan or a sandbox snapshot on the wire on every step.
function summarizeEntry(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (k === 'step') continue;
    if (v === null || v === undefined) continue;
    if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = `${v.length} item(s)`;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
