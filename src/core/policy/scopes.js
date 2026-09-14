// Policy scopes: where a policy sits in the hierarchy and how the chain is read.
//
// The hierarchy exists so a narrow decision beats a broad one without anyone
// having to merge policy documents by hand. §14 asks for
//
//   Global → Project → Workspace → Agent → Task → Tool
//
// and §13 also names workflow and harness policies. This file places those two
// where they belong by *specificity*, not by convenience: a workflow and a
// harness are both narrower than a workspace and broader than a single agent,
// so they sit between them.
//
// Order matters and is declared once, ascending from broadest to narrowest.
// Evaluators and the UI both read SCOPE_ORDER, so there is exactly one answer
// to "which policy wins".

const POLICY_SCOPES = Object.freeze([
  'global',
  'project',
  'workspace',
  'workflow',
  'harness',
  'agent',
  'task',
  'tool',
]);

// broadest (0) → narrowest (n). Higher rank = more specific = consulted later
// and wins ties.
const SCOPE_RANK = Object.freeze(Object.fromEntries(POLICY_SCOPES.map((s, i) => [s, i])));

// Restrictiveness ladder, weakest → strongest. §14: "More restrictive policy
// should override less restrictive policy", and §16 forbids ambiguous results,
// so the merge is a total order rather than a heuristic.
const EFFECTS = Object.freeze(['allow', 'approval', 'deny']);
const EFFECT_RANK = Object.freeze(Object.fromEntries(EFFECTS.map((e, i) => [e, i])));

// The key a policy is stored under. A scope instance is identified by its id —
// a workspace path, an agent id, a tool id. `null` means the wildcard instance,
// which matches every instance of that scope, and is what a hand-written
// "global agent policy" uses.
function scopeKey(scope, id = null) {
  if (!POLICY_SCOPES.includes(scope)) throw new Error(`unknown policy scope: ${JSON.stringify(scope)}`);
  return `${scope}:${id === null || id === undefined ? '*' : String(id)}`;
}

function parseScopeKey(key) {
  const idx = String(key).indexOf(':');
  if (idx < 0) return null;
  const scope = key.slice(0, idx);
  if (!POLICY_SCOPES.includes(scope)) return null;
  const id = key.slice(idx + 1);
  return { scope, id: id === '*' ? null : id };
}

function isScope(scope) {
  return POLICY_SCOPES.includes(scope);
}

// Turn a loose "what happened" description into the ordered list of scope keys
// to consult, broadest first. Callers pass whatever they know:
//
//   scopeContext({ workspaceId: '/proj', agentId: 'developer', toolId: 'fs:read' })
//   -> ['global:*', 'project:*', 'workspace:/proj', 'agent:developer', 'tool:fs:read']
//
// Both the wildcard and the id-specific key are included for a scope that has
// an id, so `scopeKey('agent')` (a policy that applies to all agents) and
// `scopeKey('agent', 'developer')` (one that applies to just this agent) are
// both honoured — the specific one later, so it wins.
//
// `global` never has a wildcard sibling: it *is* the wildcard.
function scopeChain(context = {}) {
  const out = [];
  for (const scope of POLICY_SCOPES) {
    if (scope === 'global') {
      out.push(scopeKey('global'));
      continue;
    }
    const id = contextId(context, scope);
    if (id === null || id === undefined) continue;
    out.push(scopeKey(scope, null));
    out.push(scopeKey(scope, id));
  }
  return out;
}

const CONTEXT_KEYS = Object.freeze({
  project: ['projectId', 'project'],
  workspace: ['workspaceId', 'workspace'],
  workflow: ['workflowId'],
  harness: ['harnessId'],
  agent: ['agentId', 'agent'],
  task: ['taskId', 'task'],
  tool: ['toolId', 'tool'],
});

function contextId(context, scope) {
  for (const key of CONTEXT_KEYS[scope] || []) {
    const v = context[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function rankOf(scope) {
  return SCOPE_RANK[scope] === undefined ? -1 : SCOPE_RANK[scope];
}

function effectRank(effect) {
  return EFFECT_RANK[effect] === undefined ? -1 : EFFECT_RANK[effect];
}

// The more restrictive of two effects, or null when either is unknown.
function mostRestrictive(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return effectRank(a) >= effectRank(b) ? a : b;
}

// Human-readable path through the hierarchy, for the UI and for documentation.
function chainLabels(context = {}) {
  return scopeChain(context).map((key) => {
    const parsed = parseScopeKey(key);
    return parsed.id === null ? parsed.scope : `${parsed.scope}:${parsed.id}`;
  });
}

module.exports = {
  POLICY_SCOPES,
  SCOPE_RANK,
  EFFECTS,
  EFFECT_RANK,
  scopeKey,
  parseScopeKey,
  isScope,
  scopeChain,
  chainLabels,
  rankOf,
  effectRank,
  mostRestrictive,
};
