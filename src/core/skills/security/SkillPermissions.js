// SkillPermissions: turning a manifest's permission list into decisions made by
// the policy engine that already exists.
//
// There is no second permission system here, and that is the entire design. A
// skill's `permissions` are mapped to the policy action strings
// core/policy/rules.js already defines, each one is evaluated through the
// platform's PolicyManager, and the verdicts are collected. A deployment that
// denies `filesystem.delete` blocks a skill that wants it without anyone having
// written a skill-specific rule, and the `explain()` output a user sees comes
// from the same audit trail as every other gated action.
//
// Fail-closed in two places:
//   1. a single `deny` denies the whole skill — permissions are not partially
//      satisfiable, because a skill that cannot do half of what it declared
//      will fail in the middle of a task instead of at the gate;
//   2. no policy manager wired means no grant. An absent gate is not an open one.

const { actionFor, actionsFor, describePermissions } = require('../schemas/SkillPermissionSchema');

class SkillPermissionError extends Error {
  constructor(message, { code = 'SKILL_PERMISSION_DENIED', skillId = null, permission = null } = {}) {
    super(message);
    this.name = 'SkillPermissionError';
    this.code = code;
    this.skillId = skillId;
    this.permission = permission;
  }
}

// Evaluate every permission a skill declares. `askApproval: false` gets the
// verdict without opening a human loop — that is what installation does, so a
// user is not prompted five times while a skill is being checked. The run path
// asks for real (SkillRuntime), once, with the whole skill described.
async function evaluatePermissions({
  policy,
  manifest,
  context = {},
  askApproval = false,
} = {}) {
  const permissions = manifest.permissions || [];
  const results = [];

  if (permissions.length === 0) {
    return { allowed: true, undetermined: false, denied: [], approvals: [], results, reason: 'the skill declares no permissions' };
  }
  if (!policy) {
    // Not the same as "denied", and the difference matters. At *validation*
    // time a missing policy engine means the question could not be asked, which
    // a caller reports as a warning; at *execution* time it means no grant
    // exists, and enforcePermissions below turns that into a refusal. Collapsing
    // the two would either block every install in a bare host or, far worse,
    // let an unevaluated skill run.
    return {
      allowed: false,
      undetermined: true,
      denied: [],
      approvals: [],
      results,
      reason: 'no policy engine is wired, so no permission can be granted',
    };
  }

  for (const permission of permissions) {
    const action = actionFor(permission);
    const decision = await policy.evaluate({
      action,
      askApproval,
      context: { ...context, skillId: manifest.id },
    });
    results.push({
      permission,
      action,
      effect: decision.effect,
      allowed: decision.allowed === true,
      requiresApproval: decision.requiresApproval === true,
      reason: decision.reason,
      policyId: decision.policyId || null,
    });
  }

  const denied = results.filter((r) => r.effect === 'deny').map((r) => r.permission);
  const approvals = results.filter((r) => r.requiresApproval && !r.allowed).map((r) => r.permission);
  const allowed = denied.length === 0 && (askApproval ? results.every((r) => r.allowed) : approvals.length === 0);

  return {
    allowed,
    undetermined: false,
    denied,
    approvals,
    results,
    reason: denied.length
      ? `policy denies ${denied.join(', ')}`
      : approvals.length
        ? `approval required for ${approvals.join(', ')}`
        : 'every declared permission is allowed',
  };
}

// The same evaluation, but it throws. Used at the point of execution so a
// caller cannot forget to check the returned object.
async function enforcePermissions(opts) {
  const verdict = await evaluatePermissions({ ...opts, askApproval: true });
  if (!verdict.allowed) {
    // `undetermined` reaches here as a refusal on purpose: an absent gate is
    // not an open one.
    throw new SkillPermissionError(
      `skill ${opts.manifest.id} cannot run: ${verdict.reason}`,
      { skillId: opts.manifest.id, permission: verdict.denied[0] || verdict.approvals[0] || null },
    );
  }
  return verdict;
}

// What a skill is asking for, in words, for the approval prompt. A person
// approving "mcp-builder" should see "runs commands, writes files, makes
// network requests" — not a list of enum values they have to decode.
function describeRequest(manifest) {
  const lines = describePermissions(manifest.permissions || []);
  return {
    skillId: manifest.id,
    name: manifest.name,
    version: manifest.version,
    riskLevel: manifest.riskLevel,
    origin: manifest.source.type,
    permissions: lines,
    actions: actionsFor(manifest.permissions || []),
    summary: lines.length
      ? `${manifest.name} requests: ${lines.map((l) => l.description.replace(/\.$/, '')).join('; ')}`
      : `${manifest.name} requests no special permissions`,
  };
}

// Does `granted` cover everything `manifest` asks for? Used when a skill is
// composed into a pipeline under an already-approved permission set, so a
// second skill cannot widen what the first was approved for.
function withinGrant(manifest, granted = []) {
  const grantedSet = new Set(granted);
  const missing = (manifest.permissions || []).filter((p) => !grantedSet.has(p));
  return { ok: missing.length === 0, missing };
}

module.exports = {
  SkillPermissionError,
  evaluatePermissions,
  enforcePermissions,
  describeRequest,
  withinGrant,
};
