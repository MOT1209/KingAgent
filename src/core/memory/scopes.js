// Memory scopes: who is allowed to remember what, and read whose memory.
//
// A single flat memory store is the fastest way to leak one project's contents
// into another's context. Every entry therefore carries a scope *and* the id of
// the thing that owns it (`task:task-123`, `project:/Users/x/repo`), and every
// read and write is checked against the policy the workspace handed down.
//
// Two shared scopes exist on purpose — `global` (platform-level preferences)
// and `project` (what we know about this repository) — and both have to be
// granted explicitly; nothing is shared by default.

const SCOPES = Object.freeze({
  GLOBAL: 'global',
  PROJECT: 'project',
  WORKSPACE: 'workspace',
  AGENT: 'agent',
  TASK: 'task',
  SESSION: 'session',
  WORKFLOW: 'workflow',
});

const ALL_SCOPES = Object.freeze(Object.values(SCOPES));

// Broad → narrow. Used for ordering search results, never for granting: a
// broader scope is not implied by a narrower one.
const SCOPE_BREADTH = Object.freeze({
  [SCOPES.GLOBAL]: 0,
  [SCOPES.PROJECT]: 1,
  [SCOPES.WORKFLOW]: 2,
  [SCOPES.SESSION]: 3,
  [SCOPES.AGENT]: 4,
  [SCOPES.WORKSPACE]: 5,
  [SCOPES.TASK]: 6,
});

function isScope(scope) {
  return typeof scope === 'string' && ALL_SCOPES.includes(scope);
}

function scopeKey(scope, scopeId) {
  if (!isScope(scope)) throw new Error(`unknown memory scope "${scope}"`);
  return `${scope}:${scopeId || '*'}`;
}

// `policy` is what a workspace produces: { scopes: [...], ids: { task: 'task-1', ... } }.
// Returns { ok, reason? } so a denial can be reported rather than silently
// returning nothing — a silent empty result looks like "no memories" and hides
// a misconfiguration.
function canAccess(policy, scope, scopeId) {
  if (!policy) return { ok: false, reason: 'no memory policy' };
  if (!isScope(scope)) return { ok: false, reason: `unknown scope "${scope}"` };
  const scopes = Array.isArray(policy.scopes) ? policy.scopes : [];
  if (!scopes.includes(scope)) return { ok: false, reason: `scope "${scope}" is not granted` };

  // `global` is shared by definition, so a grant is the whole check. Every
  // other scope is owned: the policy must name the *same* owner id.
  if (scope === SCOPES.GLOBAL) return { ok: true };
  const owned = policy.ids ? policy.ids[scope] : undefined;
  if (owned === undefined || owned === null) {
    return { ok: false, reason: `policy grants scope "${scope}" but names no owner id` };
  }
  if (scopeId !== undefined && scopeId !== null && scopeId !== owned) {
    return { ok: false, reason: `scope "${scope}" is owned by ${owned}, not ${scopeId}` };
  }
  return { ok: true };
}

// The owner id this policy would write under for a scope.
function ownerFor(policy, scope) {
  if (scope === SCOPES.GLOBAL) return '*';
  return policy && policy.ids ? (policy.ids[scope] ?? null) : null;
}

// Every (scope, owner) pair a policy can read. The MemoryManager turns this into
// the filter for a search so a query can never walk outside the grant.
function readableKeys(policy) {
  if (!policy || !Array.isArray(policy.scopes)) return [];
  const out = [];
  for (const scope of policy.scopes) {
    if (!isScope(scope)) continue;
    if (scope === SCOPES.GLOBAL) { out.push(scopeKey(scope, '*')); continue; }
    const owner = ownerFor(policy, scope);
    if (owner === null || owner === undefined) continue;
    out.push(scopeKey(scope, owner));
  }
  return out;
}

module.exports = { SCOPES, ALL_SCOPES, SCOPE_BREADTH, isScope, scopeKey, canAccess, ownerFor, readableKeys };
