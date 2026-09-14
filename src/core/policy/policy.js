// Policy document: a named, scoped, ordered list of rules.
//
// The one field this file guards hardest is `source`. §40 is explicit that an
// agent cannot grant itself permissions, so a policy document carries who
// authored it and only two answers are accepted:
//
//   'system' — the platform itself, at wiring time
//   'human'  — a person, through an approval or a settings screen
//
// There is no 'agent' source, and no code path that records one. An agent that
// wants more access has exactly one move available: ask, through the approval
// flow, and have a human answer.
//
// Policies are immutable once created. Editing produces a new document with a
// later `createdAt`, which is what makes the evaluation trail replayable.

const { isPlainObject, isString, nonEmptyString, validId, pickKnown, fail } = require('../schema/validate');
const { isScope, scopeKey, POLICY_SCOPES } = require('./scopes');
const { validateRule } = require('./rules');

const POLICY_SOURCES = Object.freeze(['system', 'human']);
const POLICY_FIELDS = ['id', 'name', 'description', 'scope', 'scopeId', 'rules', 'enabled', 'metadata', 'version'];

function validatePolicy(input, { source } = {}) {
  if (!isPlainObject(input)) return fail(['policy must be an object']);
  if (!validId(input.id)) return fail([`invalid policy id: ${JSON.stringify(input.id)}`]);
  if (!isScope(input.scope)) return fail([`invalid policy scope: ${JSON.stringify(input.scope)} (expected one of ${POLICY_SCOPES.join(', ')})`]);
  if (input.scopeId !== undefined && input.scopeId !== null && !isString(input.scopeId)) {
    return fail(['policy scopeId must be a string or null']);
  }
  if (!Array.isArray(input.rules) || input.rules.length === 0) return fail(['policy requires at least one rule']);
  if (!nonEmptyString(source)) {
    return fail(['policy requires a source ("system" or "human"); an agent may not author a policy']);
  }
  if (!POLICY_SOURCES.includes(source)) {
    return fail([`unknown policy source: ${JSON.stringify(source)} (expected ${POLICY_SOURCES.join(' or ')})`]);
  }

  const rules = [];
  for (const raw of input.rules) {
    const { ok, rule, errors } = validateRule(raw);
    if (!ok) return fail([`policy ${input.id}: ${errors.join('; ')}`]);
    rules.push(rule);
  }
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.id)) return fail([`policy ${input.id} has duplicate rule id: ${rule.id}`]);
    ids.add(rule.id);
  }

  return { ok: true, policy: normalizePolicy(input, { rules, source }) };
}

function normalizePolicy(input, { rules, source }) {
  const base = pickKnown(input, POLICY_FIELDS);
  return Object.freeze({
    id: base.id,
    name: base.name || base.id,
    description: base.description || '',
    scope: base.scope,
    scopeId: base.scopeId === undefined ? null : base.scopeId,
    key: scopeKey(base.scope, base.scopeId === undefined ? null : base.scopeId),
    version: base.version || 1,
    rules: Object.freeze(rules),
    enabled: base.enabled !== false,
    // Provenance. Not settable by a caller's payload: validatePolicy takes it
    // from the manager's explicit argument.
    source,
    metadata: isPlainObject(base.metadata) ? Object.freeze({ ...base.metadata }) : Object.freeze({}),
    createdAt: Date.now(),
  });
}

// A serializable description for IPC / the policy UI (§38).
function policyView(policy) {
  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    scope: policy.scope,
    scopeId: policy.scopeId,
    key: policy.key,
    source: policy.source,
    enabled: policy.enabled,
    version: policy.version,
    rules: policy.rules.map((r) => ({
      id: r.id,
      action: r.action,
      effect: r.effect,
      reason: r.reason,
      description: r.description,
      constraints: r.constraints ? { ...r.constraints } : null,
    })),
  };
}

// The default document set a fresh install runs with. It grants nothing new —
// every rule here either allows what the platform already allowed before Phase
// 4, or gates a new Phase 4 capability behind approval. Hosts replace it by
// registering their own policies at the same scopes; because the merge is
// most-restrictive-wins, an added policy can only tighten these, never loosen
// them.
function baselinePolicies() {
  return [
    {
      id: 'baseline-global',
      name: 'Baseline (global)',
      description: 'Platform defaults. Cannot be loosened by a narrower policy.',
      scope: 'global',
      source: 'system',
      rules: [
        { id: 'deny-system-paths', action: 'filesystem.system', effect: 'deny', reason: 'system paths are never an agent workspace' },
        { id: 'deny-privilege', action: 'privilege.grant', effect: 'deny', reason: 'agents cannot grant themselves permissions' },
        { id: 'gate-credential', action: 'credential.**', effect: 'approval', reason: 'credentials are provided only with explicit human approval' },
        { id: 'gate-network', action: 'network.request', effect: 'approval', reason: 'network access needs approval' },
        { id: 'allow-read', action: 'filesystem.read', effect: 'allow', reason: 'reading inside the workspace is allowed' },
        { id: 'allow-write', action: 'filesystem.write', effect: 'allow', reason: 'writing inside the workspace is allowed' },
        { id: 'gate-delete', action: 'filesystem.delete', effect: 'approval', reason: 'deletes are irreversible' },
      ],
    },
    {
      id: 'baseline-workspace',
      name: 'Workspace sandbox',
      description: 'A workspace-scoped policy template; the host binds it to a real workspace.',
      scope: 'workspace',
      scopeId: null,
      enabled: false,
      source: 'system',
      rules: [
        { id: 'deny-outside', action: 'filesystem.**', effect: 'deny', reason: 'outside the authorized workspace' },
      ],
    },
  ];
}

module.exports = { POLICY_SOURCES, POLICY_FIELDS, validatePolicy, normalizePolicy, policyView, baselinePolicies };
