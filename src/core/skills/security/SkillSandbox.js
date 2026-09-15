// SkillSandbox: the bridge from "this skill should be confined" to the
// SandboxManager the platform already owns.
//
// No sandbox is implemented here. Phase 4 built one — process ownership, path
// restriction, limits, cleanup, and an honest `enforcement: advisory|kernel`
// flag (core/sandbox/) — and building a second one for skills would produce two
// half-enforced boundaries instead of one real one. This module decides
// *whether* a skill run needs confinement, asks that manager for it, and makes
// the failure mode loud:
//
//   a skill whose posture says "sandbox" and a platform with no sandbox manager
//   is a refusal, not a warning and not an unconfined run.
//
// It also passes the skill's declared permissions through as the requested
// feature set, so a skill that asks for nothing but `filesystem.read` gets a
// sandbox with no network feature requested rather than a blanket one.

const { postureFor } = require('./SkillTrust');

class SkillSandboxError extends Error {
  constructor(message, { code = 'SKILL_SANDBOX_REQUIRED', skillId = null } = {}) {
    super(message);
    this.name = 'SkillSandboxError';
    this.code = code;
    this.skillId = skillId;
  }
}

// Which sandbox features the declared permissions imply. Requesting only what
// is needed matters: SandboxManager refuses a feature no available backend can
// provide, and asking for `network` on a skill that never touches the network
// would turn an honest refusal into a false one.
const FEATURE_FOR_PERMISSION = Object.freeze({
  'filesystem.read': 'filesystem',
  'filesystem.write': 'filesystem',
  'filesystem.delete': 'filesystem',
  'process.execute': 'processes',
  'sandbox.exec': 'processes',
  'network.request': 'network',
  'system.modify': 'processes',
});

function requiredFeatures(manifest) {
  const out = new Set(['environment']); // always: a skill never inherits the host env
  for (const permission of manifest.permissions || []) {
    const feature = FEATURE_FOR_PERMISSION[permission];
    if (feature) out.add(feature);
  }
  return [...out].sort();
}

function decide(record, { findings = null } = {}) {
  const posture = postureFor(record, { findings });
  return {
    required: posture.sandbox,
    reasons: posture.reasons,
    features: requiredFeatures(record.manifest),
    trust: posture.tier,
    risk: posture.risk,
  };
}

// Create the sandbox a run needs, or return null when the posture does not call
// for one. Never returns a "pretend" sandbox: the caller can rely on a non-null
// result being a real, tracked sandbox from the platform's own manager.
async function createFor(record, {
  sandboxes,
  workspaceRoot,
  taskId = null,
  workspaceId = null,
  agentId = null,
  sessionId = null,
  traceId = null,
  findings = null,
  limits = {},
} = {}) {
  const verdict = decide(record, { findings });
  if (!verdict.required) return { sandbox: null, verdict };

  if (!sandboxes) {
    throw new SkillSandboxError(
      `skill ${record.id} must run sandboxed (${verdict.reasons.join(', ')}) but no sandbox manager is available`,
      { skillId: record.id },
    );
  }
  if (!workspaceRoot) {
    throw new SkillSandboxError(
      `skill ${record.id} must run sandboxed but no authorized workspace root was supplied`,
      { code: 'SKILL_SANDBOX_NO_ROOT', skillId: record.id },
    );
  }

  const sandbox = await sandboxes.create({
    taskId,
    workspaceId,
    agentId,
    sessionId,
    traceId,
    workspaceRoot,
    limits,
    requiredFeatures: verdict.features,
  });
  return { sandbox, verdict };
}

// What the UI shows on a skill's detail pane: whether it will be confined, by
// what, and how honest that confinement is. `enforcement` comes straight from
// the sandbox layer so "advisory" is never hidden behind the word "sandboxed".
function describe(record, { sandboxes = null } = {}) {
  const verdict = decide(record);
  const info = sandboxes ? sandboxes.backendInfo({ required: verdict.features }) : null;
  return {
    required: verdict.required,
    reasons: verdict.reasons,
    features: verdict.features,
    backend: info ? info.selected : null,
    enforcement: info ? info.enforcement : null,
    available: Boolean(info),
  };
}

module.exports = { SkillSandboxError, FEATURE_FOR_PERMISSION, requiredFeatures, decide, createFor, describe };
