// Delegation: handing a scoped piece of work to another agent.
//
// §27 lists the fields a delegation must carry — id, parentTaskId,
// parentAgentId, childAgentId, workspaceId, permissions, scope, timeout,
// resultSchema, traceId — and every one of them is here for the same reason:
// a delegated task has to be *auditable on its own*, without reading the
// parent's context.
//
// The security core of this file is `containment()`. A delegation is the one
// place one agent can increase another's reach, so it is the one place an
// escalation bug would live. The rule is a subset check, applied to both
// permission levels and paths:
//
//   child.permission levels ⊆ parent.permission levels
//   child.allowDestructive   → parent.allowDestructive
//   child.scope paths        ⊆ parent scope paths (when the parent declared any)
//
// A delegation that widens any of those is refused at construction, not at
// execution, and the refusal says exactly which dimension widened.

const crypto = require('node:crypto');
const { isPlainObject, isString, isArray, fail } = require('../schema/validate');
const { levelRank } = require('../tools/definition');

const DELEGATION_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const STATUS_EDGES = Object.freeze({
  [DELEGATION_STATUS.PENDING]: [DELEGATION_STATUS.RUNNING, DELEGATION_STATUS.CANCELLED, DELEGATION_STATUS.FAILED],
  [DELEGATION_STATUS.RUNNING]: [DELEGATION_STATUS.COMPLETED, DELEGATION_STATUS.FAILED, DELEGATION_STATUS.CANCELLED],
  [DELEGATION_STATUS.COMPLETED]: [],
  [DELEGATION_STATUS.FAILED]: [DELEGATION_STATUS.RUNNING, DELEGATION_STATUS.CANCELLED],
  [DELEGATION_STATUS.CANCELLED]: [],
});

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function createDelegation({
  id = null,
  role = 'worker', // lead | worker | reviewer | research | tester
  parentTaskId,
  parentAgentId,
  childAgentId,
  workspaceId = null,
  objective = '',
  permissions = null,
  scope = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  resultSchema = null,
  traceId = null,
  sessionId = null,
  harnessId = null,
  parentDelegationId = null,
  depth = 1,
} = {}) {
  const delegation = {
    id: id || `del-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    role,
    status: DELEGATION_STATUS.PENDING,
    parentTaskId: parentTaskId || null,
    parentDelegationId: parentDelegationId || null,
    parentAgentId: parentAgentId || null,
    childAgentId: childAgentId || null,
    workspaceId: workspaceId || null,
    harnessId: harnessId || null,
    objective,
    permissions,
    scope: scope || { paths: [], tools: [] },
    timeoutMs,
    resultSchema,
    traceId: traceId || null,
    sessionId: sessionId || null,
    depth,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    cancellation: null,
    error: null,
    artifactIds: [],
  };
  const { ok, errors } = validateDelegation(delegation);
  if (!ok) throw new Error(`invalid delegation: ${errors.join('; ')}`);
  return delegation;
}

function validateDelegation(d) {
  if (!isPlainObject(d)) return fail(['delegation must be an object']);
  if (!isString(d.id) || !d.id) return fail(['delegation requires an id']);
  if (!isString(d.childAgentId) || !d.childAgentId) return fail(['delegation requires a childAgentId']);
  if (!isString(d.objective) || d.objective.trim() === '') return fail(['delegation requires an objective']);
  if (!Number.isFinite(d.timeoutMs) || d.timeoutMs <= 0) return fail(['delegation timeoutMs must be a positive number']);
  if (!(d.status in STATUS_EDGES)) return fail([`unknown delegation status: ${JSON.stringify(d.status)}`]);
  if (d.scope !== null && d.scope !== undefined && !isPlainObject(d.scope)) return fail(['delegation scope must be an object']);
  return { ok: true, errors: [] };
}

function canTransition(from, to) {
  const edges = STATUS_EDGES[from];
  return Boolean(edges) && edges.includes(to);
}

function completeDelegation(d, { status, error = null, artifactIds = [] } = {}) {
  if (!canTransition(d.status, status)) {
    throw new Error(`delegation ${d.id} cannot move from ${d.status} to ${status}`);
  }
  d.status = status;
  d.completedAt = Date.now();
  d.error = error;
  d.artifactIds = [...artifactIds];
  return d;
}

// Is `child` a subset of `parent`? Returns `{ ok, reasons }` — never throws, so
// a router can report why it refused instead of exploding.
function containment(parent, child) {
  const reasons = [];
  const p = normalizePermissionSet(parent);
  const c = normalizePermissionSet(child);

  if (!p || !c) {
    // Without a declared permission set there is nothing to contain, and
    // pretending otherwise would be worse than saying so. The policy engine is
    // still the gate for every actual call.
    return { ok: true, reasons: ['no declared permission sets to compare'], compared: false };
  }

  const parentMax = Math.max(...p.levels.map(levelRank), -1);
  for (const level of c.levels) {
    if (levelRank(level) > parentMax) {
      reasons.push(`child grants "${level}" but the parent grants at most "${maxLevel(p.levels)}"`);
    }
  }
  if (c.allowDestructive && !p.allowDestructive) {
    reasons.push('child allows destructive tools but the parent does not');
  }

  const pScope = normalizeScope(parent.scope);
  const cScope = normalizeScope(child.scope);
  for (const path of cScope.paths) {
    if (!withinAny(pScope.paths, path)) reasons.push(`child scope path "${path}" is outside the parent scope`);
  }
  for (const toolId of cScope.tools) {
    if (pScope.tools.length && !pScope.tools.includes(toolId)) {
      reasons.push(`child may use tool "${toolId}" which the parent does not grant`);
    }
  }
  return { ok: reasons.length === 0, reasons, compared: true };
}

function normalizePermissionSet(input) {
  const perms = input && input.permissions ? input.permissions : (isPlainObject(input) && isArray(input.levels) ? input : null);
  if (!isPlainObject(perms)) return null;
  const levels = isArray(perms.levels) ? perms.levels.filter(isString) : [];
  return {
    levels,
    allowDestructive: perms.allowDestructive === true,
    scope: input.scope || perms.scope || null,
  };
}

function normalizeScope(scope) {
  if (!isPlainObject(scope)) return { paths: [], tools: [] };
  return {
    paths: isArray(scope.paths) ? scope.paths.filter(isString) : [],
    tools: isArray(scope.tools) ? scope.tools.filter(isString) : [],
  };
}

function withinAny(paths, candidate) {
  if (paths.length === 0) return true; // parent declared no path scope
  const normal = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const target = normal(candidate);
  return paths.some((p) => {
    const base = normal(p);
    return target === base || target.startsWith(`${base}/`);
  });
}

function maxLevel(levels) {
  return levels.slice().sort((a, b) => levelRank(b) - levelRank(a))[0] || 'none';
}

// Serializable view for IPC and the sub-agent list in the UI.
function delegationView(d) {
  return {
    id: d.id,
    role: d.role,
    status: d.status,
    parentTaskId: d.parentTaskId,
    parentDelegationId: d.parentDelegationId,
    parentAgentId: d.parentAgentId,
    childAgentId: d.childAgentId,
    workspaceId: d.workspaceId,
    harnessId: d.harnessId,
    objective: d.objective,
    depth: d.depth,
    timeoutMs: d.timeoutMs,
    resultSchema: d.resultSchema,
    permissions: d.permissions ? { levels: [...(d.permissions.levels || [])], allowDestructive: d.permissions.allowDestructive === true } : null,
    scope: { paths: [...((d.scope && d.scope.paths) || [])], tools: [...((d.scope && d.scope.tools) || [])] },
    traceId: d.traceId,
    sessionId: d.sessionId,
    artifactIds: [...d.artifactIds],
    createdAt: d.createdAt,
    startedAt: d.startedAt,
    completedAt: d.completedAt,
    error: d.error,
    cancelled: Boolean(d.cancellation),
  };
}

module.exports = {
  DELEGATION_STATUS,
  STATUS_EDGES,
  DEFAULT_TIMEOUT_MS,
  createDelegation,
  validateDelegation,
  canTransition,
  completeDelegation,
  containment,
  delegationView,
  withinAny,
};
