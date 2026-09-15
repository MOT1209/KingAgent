// AgentCoordinator: selection, delegation, handoff and lifecycle across agents.
//
// This is the foundation for multi-agent work, and deliberately *only* the
// foundation: there is no autonomous team here, no agents deciding to spawn
// agents, no emergent negotiation. There is a lead execution that may delegate
// a bounded sub-task to a named agent and get a structured result back.
//
// Four properties are what make that safe to build on:
//
//   * **Narrowing, never widening.** A delegate's workspace policy is the
//     intersection of its parent's and what was requested; its tool grant is
//     the intersection of both agents' definitions.
//   * **Bounded.** Every delegation has a timeout, a depth limit and a fan-out
//     limit, so a delegation loop cannot become a fork bomb.
//   * **Cancellable.** A parent's abort signal propagates to every child.
//   * **Traceable.** The delegation, its messages and its result are events on
//     the parent's trace, correlated by parent event id.
//
// The AgentRuntime is not replaced: `delegate` runs the sub-task *through* it.

const { TYPES } = require('../events/event-bus');
const { identityRefs } = require('../workspace/identity');
const { AgentLifecycle, AGENT_STATES } = require('./lifecycle');
const { MESSAGE_TYPES } = require('./messaging/message');
const { createHandoff, summarizeHandoff } = require('./handoff');
const { TRACE_EVENTS } = require('../trace/events');

const DEFAULTS = Object.freeze({
  timeoutMs: 5 * 60 * 1000,
  maxDepth: 3,
  maxFanout: 6,
  pollMs: 50,
});

class DelegationError extends Error {
  constructor(message, { code = 'DELEGATION_FAILED', agentId = null } = {}) {
    super(message);
    this.name = 'DelegationError';
    this.code = code;
    this.agentId = agentId;
  }
}

class AgentCoordinator {
  constructor({
    registry, runtime, workspaces, messageBus, traces = null, artifacts = null,
    bus = null, logger = null, options = {},
  } = {}) {
    if (!registry) throw new Error('AgentCoordinator requires an agent registry');
    if (!workspaces) throw new Error('AgentCoordinator requires a WorkspaceManager');
    this._registry = registry;
    this._runtime = runtime;
    this._workspaces = workspaces;
    this._messages = messageBus;
    this._traces = traces;
    this._artifacts = artifacts;
    this._bus = bus;
    this._logger = logger;
    this._opts = { ...DEFAULTS, ...options };
    this._lifecycles = new Map(); // `${agentId}@${workspaceId}` -> AgentLifecycle
    this._active = new Map();     // delegationId -> { controller, agentId }
  }

  // --- selection -----------------------------------------------------------

  // Deterministic: capability coverage first, then a declared role, then
  // registration order. A model may *suggest* an agent (`preferred`), but the
  // registry decides whether that agent exists and is enabled — a suggested id
  // is never trusted as a lookup.
  selectAgent({ capabilities = [], preferred = null, exclude = [] } = {}) {
    const enabled = this._registry.list({ enabled: true }).filter((a) => !exclude.includes(a.id));
    if (enabled.length === 0) return null;
    if (preferred) {
      const match = enabled.find((a) => a.id === preferred);
      if (match) return match;
    }
    if (capabilities.length === 0) return enabled[0];

    let best = null;
    let bestScore = -1;
    for (const agent of enabled) {
      const have = new Set(agent.capabilities || []);
      const covered = capabilities.filter((c) => have.has(c)).length;
      // Prefer full coverage; break ties toward the narrower agent, so a
      // read-only analyst wins a read-only job over a full coder.
      const score = covered * 100 - (agent.capabilities || []).length;
      if (covered > 0 && score > bestScore) { best = agent; bestScore = score; }
    }
    return best || enabled[0];
  }

  selectAgents({ capabilities = [], limit = 3 } = {}) {
    const picked = [];
    const exclude = [];
    for (let i = 0; i < limit; i += 1) {
      const agent = this.selectAgent({ capabilities, exclude });
      if (!agent) break;
      picked.push(agent);
      exclude.push(agent.id);
    }
    return picked;
  }

  // --- lifecycle -----------------------------------------------------------

  lifecycle(agentId, workspaceId) {
    const key = `${agentId}@${workspaceId}`;
    if (!this._lifecycles.has(key)) {
      this._lifecycles.set(key, new AgentLifecycle({ agentId, workspaceId }));
    }
    return this._lifecycles.get(key);
  }

  lifecycles({ taskId = null } = {}) {
    return [...this._lifecycles.values()]
      .filter((l) => !taskId || (this._workspaces.get(l.workspaceId) || {}).taskId === taskId)
      .map((l) => l.toJSON());
  }

  // --- delegation ----------------------------------------------------------

  // Runs `request` as a sub-task on `toAgent`, inside a child workspace, and
  // returns a structured result. Never throws for an agent-level failure — the
  // failure is the result — so a lead agent can decide what to do about it.
  async delegate({
    from,              // parent workspace
    toAgentId = null,
    capabilities = [],
    request,
    policy = {},
    timeoutMs = null,
    signal = null,
    resultSchema = null,
    parentEventId = null,
    depth = 0,
  } = {}) {
    if (!from) throw new DelegationError('delegate requires a parent workspace', { code: 'DELEGATION_INVALID' });
    if (!request) throw new DelegationError('delegate requires a request', { code: 'DELEGATION_INVALID' });
    if (depth >= this._opts.maxDepth) {
      throw new DelegationError(`delegation depth ${depth} exceeds the limit of ${this._opts.maxDepth}`, { code: 'DELEGATION_TOO_DEEP' });
    }
    const siblings = this._workspaces.children(from.workspaceId).length;
    if (siblings >= this._opts.maxFanout) {
      throw new DelegationError(`fan-out ${siblings} exceeds the limit of ${this._opts.maxFanout}`, { code: 'DELEGATION_TOO_WIDE' });
    }

    const agent = this.selectAgent({ capabilities, preferred: toAgentId });
    if (!agent) throw new DelegationError('no enabled agent can take this delegation', { code: 'DELEGATION_NO_AGENT' });

    // The child's reach: the parent's policy, narrowed by what was asked for
    // and by the agent's own declared workspace policy. Three-way intersection,
    // so neither the caller nor the agent definition can widen anything.
    const child = this._workspaces.createChild(from, {
      agentId: agent.id,
      policy: {
        ...policy,
        ...(agent.workspacePolicy || {}),
        tools: intersect(policy.tools, agent.tools),
        memoryScopes: intersect(policy.memoryScopes, (agent.memoryPolicy && agent.memoryPolicy.scopes) || null),
      },
      metadata: { delegatedFrom: from.agentId, depth: depth + 1 },
    });

    const lifecycle = this.lifecycle(agent.id, child.workspaceId);
    lifecycle.go(AGENT_STATES.INITIALIZING, 'delegated');

    if (this._messages && from.taskId) {
      this._messages.join(from.taskId, agent.id);
      if (from.agentId) this._messages.join(from.taskId, from.agentId);
    }

    const delegationId = child.workspaceId;
    const controller = new AbortController();
    this._active.set(delegationId, { controller, agentId: agent.id });
    // A parent's cancellation reaches every child it started.
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const refs = identityRefs(from.identity);
    let delegationEvent = null;
    if (this._traces) {
      delegationEvent = this._traces.appendEvent(from.traceId, TRACE_EVENTS.DELEGATION, {
        toAgent: agent.id, request: String(request).slice(0, 240), childWorkspaceId: child.workspaceId, depth: depth + 1,
      }, { parentEventId });
    }
    if (this._bus) {
      this._bus.emit(TYPES.AGENT_DELEGATED, refs, {
        from: from.agentId, to: agent.id, childWorkspaceId: child.workspaceId, depth: depth + 1,
      });
    }
    if (this._messages && from.agentId && from.taskId) {
      this._messages.send({
        fromAgent: from.agentId, toAgent: agent.id, taskId: from.taskId,
        workspaceId: child.workspaceId, traceId: from.traceId,
        type: MESSAGE_TYPES.DELEGATION, content: String(request).slice(0, 2000),
      });
    }

    const limit = timeoutMs || this._opts.timeoutMs;
    let result;
    try {
      lifecycle.go(AGENT_STATES.READY, 'ready');
      lifecycle.go(AGENT_STATES.RUNNING, 'running');
      result = await this._runDelegated({ agent, child, request, signal: controller.signal, timeoutMs: limit });
      lifecycle.go(result.ok ? AGENT_STATES.COMPLETED : AGENT_STATES.FAILED, result.ok ? 'completed' : 'failed');
    } catch (err) {
      if (lifecycle.can(AGENT_STATES.FAILED)) lifecycle.go(AGENT_STATES.FAILED, err.message);
      result = { ok: false, error: err.message, code: err.code || 'DELEGATION_FAILED' };
    } finally {
      this._active.delete(delegationId);
      this._workspaces.close(child.workspaceId);
    }

    // A declared result schema is checked, not hoped for: a delegate that
    // returns the wrong shape is a failed delegation, not a surprise upstream.
    if (result.ok && resultSchema) {
      const problem = checkSchema(result.data, resultSchema);
      if (problem) result = { ...result, ok: false, error: `delegate result does not match schema: ${problem}`, code: 'DELEGATION_BAD_RESULT' };
    }

    const artifactRefs = this._artifacts ? await this._artifacts.refs({ workspace: child }) : [];
    const payload = {
      ok: result.ok,
      agentId: agent.id,
      workspaceId: child.workspaceId,
      taskId: result.taskId || null,
      data: result.ok ? result.data : null,
      error: result.ok ? null : result.error,
      code: result.code || null,
      artifacts: artifactRefs,
      files: child.files.summary(),
    };

    if (this._traces) {
      this._traces.appendEvent(from.traceId, TRACE_EVENTS.OBSERVATION, {
        summary: `delegation to ${agent.id} ${result.ok ? 'succeeded' : 'failed'}`,
        toAgent: agent.id, ok: result.ok, artifacts: artifactRefs.length,
      }, { parentEventId: delegationEvent ? delegationEvent.eventId : parentEventId });
    }
    if (this._messages && from.agentId && from.taskId) {
      this._messages.send({
        fromAgent: agent.id, toAgent: from.agentId, taskId: from.taskId,
        workspaceId: child.workspaceId, traceId: from.traceId,
        type: result.ok ? MESSAGE_TYPES.RESULT : MESSAGE_TYPES.ERROR,
        content: result.ok ? payload.data : payload.error,
        attachments: artifactRefs,
      });
    }
    return payload;
  }

  // Several delegations at once, bounded by maxFanout. Results come back in
  // input order; one failure does not cancel the others — the caller decides.
  async delegateAll(specs, { from, signal = null, depth = 0 } = {}) {
    const bounded = specs.slice(0, this._opts.maxFanout);
    return Promise.all(bounded.map((spec) => this.delegate({ ...spec, from, signal, depth })));
  }

  cancelDelegations({ agentId = null } = {}) {
    let n = 0;
    for (const [id, entry] of this._active) {
      if (agentId && entry.agentId !== agentId) continue;
      entry.controller.abort();
      this._active.delete(id);
      n += 1;
    }
    return n;
  }

  // --- handoff -------------------------------------------------------------

  // A handoff transfers *responsibility*, not history: the package is a brief
  // (agents/handoff.js), and the receiving agent gets a child workspace.
  handoff({ from, toAgentId, objective, openIssues = [], constraints = [], results = [], memories = [], artifacts = [], policy = {} }) {
    const agent = this.selectAgent({ preferred: toAgentId });
    if (!agent) throw new DelegationError(`no agent "${toAgentId}" to hand off to`, { code: 'HANDOFF_NO_AGENT' });

    const pkg = createHandoff({
      fromAgent: from.agentId,
      toAgent: agent.id,
      objective,
      currentState: JSON.stringify(from.files.summary()),
      files: [...from.files.diff().map((d) => ({ path: d.path, reason: d.operation })), ...from.files.activeFiles().map((p) => ({ path: p, reason: 'active' }))],
      results,
      constraints,
      memories,
      artifacts: artifacts.length ? artifacts : from.artifactIds.map((id) => ({ id })),
      openIssues,
      identity: from.identity,
    });

    const child = this._workspaces.createChild(from, {
      agentId: agent.id,
      policy: { ...policy, ...(agent.workspacePolicy || {}) },
      metadata: { handoffFrom: from.agentId, handoffId: pkg.id },
    });

    if (this._messages && from.taskId && from.agentId) {
      this._messages.join(from.taskId, agent.id);
      this._messages.join(from.taskId, from.agentId);
      this._messages.send({
        fromAgent: from.agentId, toAgent: agent.id, taskId: from.taskId,
        workspaceId: child.workspaceId, traceId: from.traceId,
        type: MESSAGE_TYPES.HANDOFF, content: pkg,
        attachments: pkg.artifacts,
      });
    }
    if (this._traces) this._traces.appendEvent(from.traceId, TRACE_EVENTS.HANDOFF, summarizeHandoff(pkg));
    if (this._bus) this._bus.emit(TYPES.AGENT_HANDOFF, identityRefs(from.identity), summarizeHandoff(pkg));

    return { handoff: pkg, workspace: child, agent };
  }

  // --- aggregation ---------------------------------------------------------

  // Collapse several delegation payloads into one result a lead agent can act
  // on. Partial success is reported as partial, never rounded to success.
  aggregate(results) {
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    return {
      ok: failed.length === 0,
      partial: ok.length > 0 && failed.length > 0,
      completed: ok.length,
      failed: failed.length,
      results: results.map((r) => ({ agentId: r.agentId, ok: r.ok, error: r.error, artifacts: (r.artifacts || []).length })),
      artifacts: results.flatMap((r) => r.artifacts || []),
      errors: failed.map((r) => ({ agentId: r.agentId, error: r.error, code: r.code })),
    };
  }

  // --- internals -----------------------------------------------------------

  // Runs the sub-task on the real AgentRuntime and waits for a terminal state.
  // Nothing here re-implements the runtime loop; it observes it.
  async _runDelegated({ agent, child, request, signal, timeoutMs }) {
    if (!this._runtime) {
      return { ok: false, error: 'no AgentRuntime is wired into the coordinator', code: 'DELEGATION_NO_RUNTIME' };
    }
    const started = await this._runtime.runAgentTask({
      request,
      agentId: agent.id,
      workspace: { root: child.root, cwd: child.cwd },
      options: { workspaceId: child.workspaceId, delegated: true },
    }, { mode: 'auto' });

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = this._runtime.get(started.id);
      if (!task) return { ok: false, error: 'delegated task vanished', code: 'DELEGATION_LOST', taskId: started.id };
      if (isTerminalTask(task)) {
        const ok = task.state === 'completed';
        return {
          ok,
          taskId: task.id,
          data: ok ? summarizeTaskResult(task) : null,
          error: ok ? null : (task.outcome && task.outcome.error) || `delegate ended in ${task.state}`,
          code: ok ? null : 'DELEGATION_FAILED',
        };
      }
      if (signal && signal.aborted) {
        this._runtime.cancel(started.id, 'parent cancelled');
        return { ok: false, error: 'delegation cancelled', code: 'DELEGATION_CANCELLED', taskId: started.id };
      }
      if (Date.now() > deadline) {
        this._runtime.cancel(started.id, 'delegation timed out');
        return { ok: false, error: `delegation timed out after ${timeoutMs}ms`, code: 'DELEGATION_TIMEOUT', taskId: started.id };
      }
      await sleep(this._opts.pollMs);
    }
  }
}

// null on either side means "no restriction from that side"; two lists
// intersect. Never a union — that would widen.
function intersect(a, b) {
  if (!Array.isArray(a) && !Array.isArray(b)) return null;
  if (!Array.isArray(a)) return [...b];
  if (!Array.isArray(b)) return [...a];
  return a.filter((v) => b.includes(v));
}

function isTerminalTask(task) {
  return ['completed', 'failed', 'cancelled'].includes(task.state);
}

function summarizeTaskResult(task) {
  return {
    taskId: task.id,
    summary: (task.outcome && task.outcome.summary) || null,
    steps: (task.steps || []).map((s) => ({ id: s.id, title: s.title, status: s.status, toolId: s.tool ? s.tool.id : null })),
    completedSteps: (task.steps || []).filter((s) => s.status === 'completed').length,
  };
}

// Structural check only — the same philosophy as schema/validate.js. It answers
// "is this the shape we agreed on?", which is what a delegation contract needs.
function checkSchema(value, schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'expected an object';
    for (const [key, rule] of Object.entries(schema.properties || {})) {
      if (rule.required && value[key] === undefined) return `missing required field "${key}"`;
      if (value[key] !== undefined && rule.type === 'array' && !Array.isArray(value[key])) return `"${key}" must be an array`;
      if (value[key] !== undefined && rule.type === 'string' && typeof value[key] !== 'string') return `"${key}" must be a string`;
      if (value[key] !== undefined && rule.type === 'number' && typeof value[key] !== 'number') return `"${key}" must be a number`;
      if (value[key] !== undefined && rule.type === 'boolean' && typeof value[key] !== 'boolean') return `"${key}" must be a boolean`;
    }
    return null;
  }
  if (schema.type === 'array' && !Array.isArray(value)) return 'expected an array';
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { AgentCoordinator, DelegationError, DEFAULTS, intersect, checkSchema };
