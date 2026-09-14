// ApprovalManager: requests, decisions, expiry — and the bridge to the Phase 2
// tool-authorization gate.
//
// One rule shapes the whole module: a pending approval must survive being
// *waited on*. A promise that resolves from a modal is fine until the task is
// paused, the app is closed, or two approvals are outstanding at once — then
// the only record of what was asked is a closure nobody can list.
//
// So every request is a record first. `requestApproval` returns the record and a
// promise; `approve`/`reject`/`expire` settle it by id, from anywhere — an IPC
// handler, a timeout, a recovered session.
//
// `toolAuthorizer()` returns the exact `authorize({ agent, tool, input, taskId })`
// callback ToolManager already takes, so the Phase 2 path is preserved and both
// converge on one auditable record rather than becoming two systems.

const { TYPES } = require('../events/event-bus');
const { identityRefs } = require('../workspace/identity');
const {
  APPROVAL_STATUS, RISK, DANGEROUS_ACTIONS, DEFAULT_TTL_MS,
  createApprovalRequest, requiresApproval, isExpired,
} = require('./request');

// Tool → the action name an approval is asked for. Anything not listed falls
// back to the tool's own permission level.
const TOOL_ACTIONS = Object.freeze({
  'fs:delete': 'file.delete',
  'terminal:run': 'command.run',
});

class ApprovalManager {
  constructor({ bus = null, logger = null, ttlMs = DEFAULT_TTL_MS, policy = null, autoDecide = null, clock = null } = {}) {
    this._bus = bus;
    this._logger = logger;
    this._ttlMs = ttlMs;
    this._policy = policy;
    // A host with no UI (tests, headless) can install a decision function.
    // Absent one, a request that nobody answers expires — it never auto-approves.
    this._autoDecide = typeof autoDecide === 'function' ? autoDecide : null;
    this._now = clock || (() => Date.now());
    this._requests = new Map(); // id -> record
    this._pending = new Map();  // id -> { resolve, timer }
  }

  get policy() { return this._policy; }
  setPolicy(policy) { this._policy = policy; return this._policy; }

  // Returns { request, decision } — `decision` is a promise for the outcome.
  // Callers that only want to record the ask can ignore it.
  requestApproval({ action, summary, reason, risk, toolId, parameters, identity = {}, ttlMs, metadata } = {}) {
    const now = this._now();
    const request = createApprovalRequest({
      action, summary, reason, risk, toolId, parameters, identity,
      ttlMs: ttlMs === undefined ? this._ttlMs : ttlMs,
      metadata, now,
    });
    this._requests.set(request.id, request);

    const decision = new Promise((resolve) => {
      let timer = null;
      if (request.expiresAt !== null) {
        // Deliberately not unref'd: a pending approval *is* outstanding work, so
        // the expiry has to fire even when nothing else is scheduled — an
        // unref'd timer in a bare node host lets the process exit with the
        // decision still hanging. It is bounded by ttlMs, cleared on every
        // settle, and `dispose()` clears the rest.
        timer = setTimeout(() => this.expire(request.id), Math.max(0, request.expiresAt - now));
      }
      this._pending.set(request.id, { resolve, timer });
    });

    if (this._bus) {
      const refs = identityRefs(identity);
      const payload = {
        requestId: request.id, action: request.action, risk: request.risk,
        summary: request.summary, tool: request.toolId, expiresAt: request.expiresAt,
      };
      this._bus.emit(TYPES.APPROVAL_REQUESTED, refs, payload);
      // The Phase 2 event the renderer's approval path already listens to.
      this._bus.emit(TYPES.APPROVAL_REQUIRED, { ...refs, toolId: request.toolId }, payload);
    }

    if (this._autoDecide) {
      // Resolved on a later turn so the caller always sees the pending record
      // first — otherwise a synchronous auto-decision makes the pending state
      // untestable and hides ordering bugs.
      Promise.resolve()
        .then(() => this._autoDecide(request))
        .then((verdict) => {
          if (verdict === true) this.approve(request.id, { decidedBy: 'policy' });
          else if (verdict === false) this.reject(request.id, { decidedBy: 'policy', note: 'auto-rejected' });
        })
        .catch((err) => this.reject(request.id, { decidedBy: 'policy', note: `auto-decide failed: ${err.message}` }));
    }

    return { request, decision };
  }

  approve(id, { decidedBy = 'user', note = null } = {}) {
    return this._settle(id, APPROVAL_STATUS.APPROVED, { decidedBy, note });
  }

  reject(id, { decidedBy = 'user', note = null } = {}) {
    return this._settle(id, APPROVAL_STATUS.REJECTED, { decidedBy, note });
  }

  expire(id) {
    return this._settle(id, APPROVAL_STATUS.EXPIRED, { decidedBy: 'timeout', note: 'no decision before expiry' });
  }

  // Expire anything past its deadline. Called on resume, so a task that was
  // paused across an expiry does not wake up believing it is still waiting.
  sweep() {
    const now = this._now();
    let n = 0;
    for (const request of this._requests.values()) {
      if (isExpired(request, now)) { this.expire(request.id); n += 1; }
    }
    return n;
  }

  get(id) {
    return this._requests.get(id) || null;
  }

  getPendingApprovals({ taskId = null, workspaceId = null } = {}) {
    const now = this._now();
    return [...this._requests.values()]
      .filter((r) => r.status === APPROVAL_STATUS.PENDING && !isExpired(r, now))
      .filter((r) => (!taskId || r.taskId === taskId) && (!workspaceId || r.workspaceId === workspaceId))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  list({ taskId = null, status = null, limit = 100 } = {}) {
    return [...this._requests.values()]
      .filter((r) => (!taskId || r.taskId === taskId) && (!status || r.status === status))
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .slice(0, limit);
  }

  requiresApproval(action) {
    return requiresApproval(action, this._policy);
  }

  // The ToolManager-shaped callback. A tool that maps to a dangerous action (or
  // is DESTRUCTIVE / requiresAuth by its own definition) becomes a request and
  // the call waits on the decision.
  toolAuthorizer({ identity = null } = {}) {
    return async ({ agent, tool, input, taskId }) => {
      const action = TOOL_ACTIONS[tool.id]
        || (tool.permissions.level === 'destructive' ? 'command.destructive' : `tool.${tool.id}`);
      if (!this.requiresApproval(action) && !tool.permissions.requiresAuth && tool.permissions.level !== 'destructive') {
        return true;
      }
      const refs = identity || {};
      const { decision } = this.requestApproval({
        action,
        toolId: tool.id,
        summary: `${agent ? agent.id : 'agent'} wants to run ${tool.id}`,
        reason: tool.permissions.note || '',
        risk: DANGEROUS_ACTIONS[action] || RISK.HIGH,
        parameters: input,
        identity: { ...refs, taskId: taskId || refs.taskId || null, agentId: agent ? agent.id : refs.agentId || null },
      });
      const outcome = await decision;
      return outcome.status === APPROVAL_STATUS.APPROVED;
    };
  }

  // Settle everything outstanding as expired and drop the timers. A host
  // shutting down calls this so a pending approval cannot keep the loop alive.
  dispose() {
    for (const id of [...this._pending.keys()]) this.expire(id);
    for (const { timer } of this._pending.values()) if (timer) clearTimeout(timer);
    this._pending.clear();
    return true;
  }

  _settle(id, status, { decidedBy, note }) {
    const request = this._requests.get(id);
    if (!request) return null;
    if (request.status !== APPROVAL_STATUS.PENDING) return request; // idempotent
    request.status = status;
    request.resolvedAt = this._now();
    request.decidedBy = decidedBy;
    request.decisionNote = note;

    const waiter = this._pending.get(id);
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      this._pending.delete(id);
      waiter.resolve(request);
    }

    if (this._bus) {
      const refs = identityRefs(request);
      const payload = { requestId: id, action: request.action, status, decidedBy, note };
      const type = status === APPROVAL_STATUS.APPROVED ? TYPES.APPROVAL_APPROVED
        : status === APPROVAL_STATUS.REJECTED ? TYPES.APPROVAL_REJECTED
          : TYPES.APPROVAL_EXPIRED;
      this._bus.emit(type, refs, payload);
      // Phase 2 events the existing renderer already understands.
      this._bus.emit(
        status === APPROVAL_STATUS.APPROVED ? TYPES.APPROVAL_GRANTED : TYPES.APPROVAL_DENIED,
        { ...refs, toolId: request.toolId },
        payload,
      );
    }
    return request;
  }
}

module.exports = { ApprovalManager, TOOL_ACTIONS };
