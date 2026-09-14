// PolicyManager: the governance seam every sensitive operation passes through.
//
// §17's flow, implemented here in order:
//
//   Action → Policy Manager → Evaluate → Permission → Approval if required →
//   (Sandbox) → Execute
//
// Three properties this class is responsible for, in priority order:
//
//   1. **No self-grant.** A policy can only be registered with a source of
//      'system' or 'human' (see policy.js). There is no API that lets an agent
//      widen its own access, and `evaluate()` never mutates a document.
//   2. **Fail closed at the gate.** A decision that requires approval and has
//      no approver wired is *denied*, not allowed-with-a-note. Defaulting an
//      ungranted approval to yes is the classic way a governance layer becomes
//      decorative.
//   3. **Every decision is replayable.** Each evaluation lands in a bounded
//      audit ring with its trail, which is what the policy UI (§38) reads to
//      answer "why was this blocked?".

const { validatePolicy, policyView, baselinePolicies, POLICY_SOURCES } = require('./policy');
const { evaluateChain } = require('./evaluator');
const { scopeChain, parseScopeKey, scopeKey, POLICY_SCOPES } = require('./scopes');
const { actionForTool } = require('./rules');
const { TYPES } = require('../events/event-bus');

const AUDIT_LIMIT = 200;

class PolicyError extends Error {
  constructor(message, { code = 'POLICY_ERROR', action = null, policyId = null } = {}) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.action = action;
    this.policyId = policyId;
  }
}

class PolicyDeniedError extends PolicyError {
  constructor(decision) {
    super(`policy denied ${decision.action}: ${decision.reason}`, { code: 'POLICY_DENIED', action: decision.action, policyId: decision.policyId });
    this.name = 'PolicyDeniedError';
    this.decision = decision;
  }
}

class PolicyApprovalRequiredError extends PolicyError {
  constructor(decision) {
    super(`policy requires approval for ${decision.action}: ${decision.reason}`, { code: 'POLICY_APPROVAL_REQUIRED', action: decision.action, policyId: decision.policyId });
    this.name = 'PolicyApprovalRequiredError';
    this.decision = decision;
  }
}

class PolicyManager {
  constructor({ bus = null, logger = null, store = null, defaultEffect = 'allow', approver = null } = {}) {
    if (defaultEffect !== 'allow' && defaultEffect !== 'deny') {
      throw new PolicyError(`unknown defaultEffect: ${JSON.stringify(defaultEffect)}`);
    }
    this._bus = bus;
    this._logger = logger;
    this._store = store;
    this._defaultEffect = defaultEffect;
    this._approver = approver;
    this._policies = new Map(); // `${key}:${id}` -> policy
    this._audit = [];
    this._counts = { evaluated: 0, denied: 0, approvals: 0 };
  }

  get defaultEffect() {
    return this._defaultEffect;
  }

  setApprover(fn) {
    this._approver = typeof fn === 'function' ? fn : null;
  }

  // --- registration ---------------------------------------------------------

  // Register a policy. `source` is mandatory and audited; it is the only way a
  // policy's provenance is established, and it is never read from the payload.
  register(input, { source, replace = true } = {}) {
    if (!POLICY_SOURCES.includes(source)) {
      throw new PolicyError(
        `policy registration requires an explicit source of ${POLICY_SOURCES.join(' or ')} (got ${JSON.stringify(source)}); ` +
        'an agent may not author policies',
        { code: 'POLICY_SOURCE_REQUIRED', policyId: input && input.id },
      );
    }
    const { ok, policy, errors } = validatePolicy(input, { source });
    if (!ok) throw new PolicyError(`invalid policy: ${errors.join('; ')}`, { code: 'POLICY_INVALID', policyId: input && input.id });

    const mapKey = `${policy.key}:${policy.id}`;
    if (this._policies.has(mapKey) && !replace) {
      throw new PolicyError(`policy "${policy.id}" is already registered at ${policy.key}`, { code: 'POLICY_EXISTS', policyId: policy.id });
    }
    this._policies.set(mapKey, policy);
    if (this._store) this._store.set(`policy:${mapKey}`, policyView(policy)).catch(() => {});
    return policy;
  }

  unregister(scope, scopeId, id) {
    return this._policies.delete(`${scopeKey(scope, scopeId)}:${id}`);
  }

  get(scope, scopeId, id) {
    return this._policies.get(`${scopeKey(scope, scopeId)}:${id}`) || null;
  }

  list({ scope = null } = {}) {
    let all = [...this._policies.values()];
    if (scope) all = all.filter((p) => p.scope === scope);
    return all.map(policyView).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1));
  }

  count() {
    return this._policies.size;
  }

  // Every policy that applies to this context, broadest scope first. Disabled
  // policies are skipped here rather than in the evaluator, so `list()` can
  // still show a disabled document to the UI.
  policiesFor(context = {}) {
    const out = [];
    for (const key of scopeChain(context)) {
      for (const policy of this._policies.values()) {
        if (policy.key !== key || policy.enabled === false) continue;
        out.push({ key, policy });
      }
    }
    return out;
  }

  // --- evaluation -----------------------------------------------------------

  async evaluate({ action, context = {}, askApproval = true } = {}) {
    const policies = this.policiesFor(context);
    let decision = evaluateChain({ policies, action, defaultEffect: this._defaultEffect });

    if (decision.requiresApproval && askApproval) {
      decision = await this._askApproval(decision, context);
    } else if (decision.requiresApproval && !askApproval) {
      // The caller only wants the verdict, not the human loop. Report the gate
      // honestly: still not allowed.
      decision = Object.freeze({ ...decision, allowed: false, approved: false, reason: `${decision.reason} (approval not requested)` });
    }

    this._record(decision, context);
    return decision;
  }

  // Same as evaluate, but throws instead of returning a denial. Use this at the
  // point of action so a caller cannot forget to check.
  async enforce({ action, context = {} } = {}) {
    const decision = await this.evaluate({ action, context });
    if (decision.effect === 'deny') throw new PolicyDeniedError(decision);
    if (decision.requiresApproval && !decision.approved) throw new PolicyApprovalRequiredError(decision);
    return decision;
  }

  // The bridge the existing ToolManager already supports: its `authorize`
  // callback is consulted for DESTRUCTIVE / requiresAuth tools. Wiring this in
  // means every such call now has a policy verdict and an approval route, with
  // the existing permission levels still underneath.
  async authorizeTool({ agent, tool, input: _input, taskId = null, sessionId = null, workspaceId = null, harnessId = null } = {}) {
    const action = actionForTool(tool);
    const decision = await this.evaluate({
      action,
      context: {
        agentId: agent && agent.id,
        toolId: tool && tool.id,
        taskId,
        sessionId,
        workspaceId,
        harnessId,
        // Deliberately no `input` in the context: policy matching must not
        // depend on file contents or command strings, or the trail would leak
        // them into the audit ring.
      },
    });
    if (this._logger) {
      this._logger.debug(`policy ${decision.effect} for ${action}`, { toolId: tool && tool.id, policyId: decision.policyId });
    }
    return decision.allowed;
  }

  async _askApproval(decision, context) {
    if (!this._approver) {
      return Object.freeze({
        ...decision,
        allowed: false,
        approved: false,
        reason: `${decision.reason}; no approver is wired, so approval cannot be granted`,
      });
    }
    let granted;
    try {
      granted = (await this._approver({ action: decision.action, decision, context })) === true;
    } catch (err) {
      return Object.freeze({ ...decision, allowed: false, approved: false, reason: `approval lookup failed: ${err.message}` });
    }
    return Object.freeze({
      ...decision,
      allowed: granted,
      approved: granted,
      reason: granted ? `approved: ${decision.reason}` : `approval denied: ${decision.reason}`,
    });
  }

  // --- audit ----------------------------------------------------------------

  _record(decision, context) {
    this._counts.evaluated += 1;
    const entry = Object.freeze({
      at: Date.now(),
      action: decision.action,
      effect: decision.effect,
      allowed: decision.allowed,
      approved: decision.approved === true,
      reason: decision.reason,
      policyId: decision.policyId,
      scope: decision.scope,
      scopeId: decision.scopeId,
      ruleId: decision.ruleId,
      agentId: context.agentId || null,
      taskId: context.taskId || null,
      sessionId: context.sessionId || null,
      workspaceId: context.workspaceId || null,
      harnessId: context.harnessId || null,
    });
    this._audit.push(entry);
    if (this._audit.length > AUDIT_LIMIT) this._audit.splice(0, this._audit.length - AUDIT_LIMIT);

    if (decision.effect === 'deny') this._counts.denied += 1;
    if (decision.requiresApproval) this._counts.approvals += 1;

    if (this._bus) {
      const refs = {
        agentId: entry.agentId,
        taskId: entry.taskId,
        sessionId: entry.sessionId,
        workspaceId: entry.workspaceId,
        harnessId: entry.harnessId,
        policyId: decision.policyId,
      };
      this._bus.emit(TYPES.POLICY_EVALUATED, refs, {
        action: decision.action,
        effect: decision.effect,
        allowed: decision.allowed,
        reason: decision.reason,
        policyId: decision.policyId,
        scope: decision.scope,
      });
      if (decision.effect === 'deny') {
        this._bus.emit(TYPES.POLICY_DENIED, refs, { action: decision.action, reason: decision.reason, policyId: decision.policyId });
      } else if (decision.requiresApproval && !decision.approved) {
        this._bus.emit(TYPES.POLICY_APPROVAL_REQUIRED, refs, { action: decision.action, reason: decision.reason, policyId: decision.policyId });
      }
    }
  }

  // Why-answers for the UI: the most recent decisions, newest first.
  audit({ limit = 50, action = null } = {}) {
    let rows = [...this._audit].reverse();
    if (action) rows = rows.filter((r) => r.action === action);
    return rows.slice(0, Math.max(0, limit));
  }

  explain({ action, context = {} } = {}) {
    const decision = evaluateChain({
      policies: this.policiesFor(context),
      action,
      defaultEffect: this._defaultEffect,
    });
    return {
      action,
      effect: decision.effect,
      allowed: decision.allowed,
      requiresApproval: decision.requiresApproval,
      reason: decision.reason,
      policyId: decision.policyId,
      scope: decision.scope,
      scopeId: decision.scopeId,
      ruleId: decision.ruleId,
      constraints: decision.constraints ? { ...decision.constraints } : null,
      chain: scopeChain(context),
      trail: decision.trail.map((t) => ({ ...t })),
    };
  }

  stats() {
    return {
      policies: this._policies.size,
      scopes: POLICY_SCOPES.reduce((acc, s) => {
        const n = [...this._policies.values()].filter((p) => p.scope === s).length;
        if (n) acc[s] = n;
        return acc;
      }, {}),
      evaluated: this._counts.evaluated,
      denied: this._counts.denied,
      approvals: this._counts.approvals,
      defaultEffect: this._defaultEffect,
      approverWired: Boolean(this._approver),
    };
  }

  // Seed the built-in baseline. Called by the platform factory; separate so a
  // host can decide its own starting documents.
  loadBaseline() {
    let n = 0;
    for (const doc of baselinePolicies()) {
      this.register(doc, { source: doc.source });
      n += 1;
    }
    return n;
  }
}

// A policy manager with no documents and no default: everything is denied. This
// is what a host gets if it asks for a locked-down install — useful in tests
// that must prove the gate is real.
function createClosedPolicyManager(opts = {}) {
  return new PolicyManager({ ...opts, defaultEffect: 'deny' });
}

module.exports = {
  PolicyManager,
  createClosedPolicyManager,
  PolicyError,
  PolicyDeniedError,
  PolicyApprovalRequiredError,
  policyView,
  parseScopeKey,
  POLICY_SCOPES,
};
