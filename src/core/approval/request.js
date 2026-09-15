// The approval request: a dangerous action, paused, with a decision pending.
//
// Phase 2 already gated DESTRUCTIVE tools behind a per-call `authorize`
// callback. That callback is a promise and nothing else: it cannot be listed,
// it cannot be audited, and it cannot survive a pause. An ApprovalRequest is
// the same decision made into a record — so a UI can list what is waiting, a
// trace can show what was asked and answered, and a paused task can be resumed
// with the answer that arrives later.
//
// This does not replace the Phase 2 gate; the manager *supplies* it (see
// `toolAuthorizer`), so both paths converge on one record.

const crypto = require('node:crypto');

const APPROVAL_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
});

const RISK = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
});

// The operations that require a human by default. Every one is either
// irreversible, reaches outside the workspace, or changes what runs next time.
// A host narrows or widens this deliberately via policy, never by accident.
const DANGEROUS_ACTIONS = Object.freeze({
  'file.delete': RISK.HIGH,
  'file.write.outside-workspace': RISK.CRITICAL,
  'command.destructive': RISK.CRITICAL,
  'command.run': RISK.HIGH,
  'git.push': RISK.HIGH,
  'system.modify': RISK.CRITICAL,
  'package.install': RISK.HIGH,
  'network.external': RISK.MEDIUM,
  'secret.access': RISK.CRITICAL,
  'agent.delegate': RISK.LOW,
});

const DEFAULT_TTL_MS = 5 * 60 * 1000;

function newApprovalId() {
  return `apr-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function createApprovalRequest({
  id = null,
  action,
  summary = '',
  reason = '',
  risk = null,
  toolId = null,
  parameters = {},
  identity = {},
  ttlMs = DEFAULT_TTL_MS,
  metadata = {},
  now = Date.now(),
} = {}) {
  if (!action) throw new Error('an approval request requires an action');
  return {
    id: id || newApprovalId(),
    action,
    summary: String(summary || action).slice(0, 240),
    reason: String(reason).slice(0, 400),
    risk: risk || DANGEROUS_ACTIONS[action] || RISK.MEDIUM,
    toolId,
    // Parameters are shown to a human, so they are bounded and stringified
    // shallowly; the full input stays with the caller.
    parameters: describeParameters(parameters),
    status: APPROVAL_STATUS.PENDING,
    taskId: identity.taskId || null,
    workspaceId: identity.workspaceId || null,
    agentId: identity.agentId || null,
    traceId: identity.traceId || null,
    sessionId: identity.sessionId || null,
    requestedAt: now,
    resolvedAt: null,
    expiresAt: ttlMs === null ? null : now + ttlMs,
    decidedBy: null,
    decisionNote: null,
    metadata: { ...metadata },
  };
}

function describeParameters(params) {
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(params).slice(0, 12)) {
    if (typeof v === 'string') out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    else if (v === null || ['number', 'boolean'].includes(typeof v)) out[k] = v;
    else out[k] = Array.isArray(v) ? `[${v.length} items]` : '[object]';
  }
  return out;
}

function isPending(request, now = Date.now()) {
  if (!request || request.status !== APPROVAL_STATUS.PENDING) return false;
  return request.expiresAt === null || request.expiresAt > now;
}

function isExpired(request, now = Date.now()) {
  return Boolean(request
    && request.status === APPROVAL_STATUS.PENDING
    && request.expiresAt !== null
    && request.expiresAt <= now);
}

// `policy` is `{ require: [...], allow: [...], requireAll?: boolean }`. Anything
// on `allow` is pre-authorized by the host; anything on `require` — or in
// DANGEROUS_ACTIONS when no policy names it — needs a human.
function requiresApproval(action, policy = null) {
  if (!action) return false;
  if (policy) {
    if (Array.isArray(policy.allow) && policy.allow.includes(action)) return false;
    if (policy.requireAll === true) return true;
    if (Array.isArray(policy.require) && policy.require.includes(action)) return true;
    if (Array.isArray(policy.require)) return false; // an explicit list is exhaustive
  }
  return action in DANGEROUS_ACTIONS;
}

module.exports = {
  APPROVAL_STATUS, RISK, DANGEROUS_ACTIONS, DEFAULT_TTL_MS,
  createApprovalRequest, requiresApproval, isPending, isExpired, newApprovalId, describeParameters,
};
