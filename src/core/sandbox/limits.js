// Sandbox limits: the conceptual budget an execution runs under.
//
// §20 asks for a data model, not for enforcement — enforcement belongs to the
// backend (backend.js), because what is actually possible differs by platform.
// So the shape is defined once here, validated on the way in, and *clamped*
// against a ceiling: a caller can ask for less than the policy allows, never
// more. That clamp is the same "more restrictive wins" rule as the policy
// engine, applied to numbers and modes, and it is the reason an agent cannot
// raise its own memory cap by asking for one.

const { isPlainObject, fail } = require('../schema/validate');

const FILESYSTEM_MODES = Object.freeze(['none', 'readonly', 'workspace']);
const NETWORK_MODES = Object.freeze(['deny', 'loopback', 'allow']);
const ENVIRONMENT_MODES = Object.freeze(['minimal', 'allowlist', 'inherit']);

// Restrictiveness ladders, weakest → strongest.
const FILESYSTEM_RANK = Object.freeze({ none: 0, readonly: 1, workspace: 2 });
const NETWORK_RANK = Object.freeze({ deny: 0, loopback: 1, allow: 2 });
const ENVIRONMENT_RANK = Object.freeze({ minimal: 0, allowlist: 1, inherit: 2 });

const DEFAULT_LIMITS = Object.freeze({
  cpuTimeMs: null, // null = no declared CPU budget (wall-clock still applies)
  memoryMb: 512,
  maxProcesses: 8,
  timeoutMs: 5 * 60 * 1000,
  filesystemMode: 'workspace',
  networkMode: 'deny',
  environmentPolicy: 'minimal',
});

// The ceiling a default install will not go above, for any caller. A host that
// genuinely needs more raises it explicitly in its own ceiling; nothing in a
// task, an agent or a manifest can.
const DEFAULT_CEILING = Object.freeze({
  cpuTimeMs: 30 * 60 * 1000,
  memoryMb: 4096,
  maxProcesses: 32,
  timeoutMs: 30 * 60 * 1000,
  filesystemMode: 'workspace',
  networkMode: 'loopback',
  environmentPolicy: 'allowlist',
});

function validateLimits(input) {
  if (input === undefined) return { ok: true, limits: { ...DEFAULT_LIMITS } };
  if (!isPlainObject(input)) return fail(['sandbox limits must be an object']);
  const out = { ...DEFAULT_LIMITS };
  for (const key of ['cpuTimeMs', 'memoryMb', 'maxProcesses', 'timeoutMs']) {
    if (input[key] === undefined) continue;
    if (input[key] === null) { out[key] = null; continue; }
    if (!Number.isFinite(input[key]) || input[key] <= 0) return fail([`limits.${key} must be a positive number or null`]);
    out[key] = Math.floor(input[key]);
  }
  for (const [key, allowed] of [['filesystemMode', FILESYSTEM_MODES], ['networkMode', NETWORK_MODES], ['environmentPolicy', ENVIRONMENT_MODES]]) {
    if (input[key] === undefined) continue;
    if (!allowed.includes(input[key])) return fail([`limits.${key} must be one of ${allowed.join(', ')}`]);
    out[key] = input[key];
  }
  return { ok: true, limits: out };
}

function normalizeLimits(input) {
  const { ok, limits, errors } = validateLimits(input);
  if (!ok) throw new Error(`invalid sandbox limits: ${errors.join('; ')}`);
  return Object.freeze(limits);
}

// Never widen. Returns the effective limits given a ceiling and a request.
function clampLimits(requested, ceiling = DEFAULT_CEILING) {
  const req = { ...DEFAULT_LIMITS, ...(requested || {}) };
  const out = {};
  for (const key of ['cpuTimeMs', 'memoryMb', 'maxProcesses', 'timeoutMs']) {
    const ceil = ceiling[key];
    const value = req[key];
    if (value === null || value === undefined) out[key] = ceil === undefined ? null : ceil;
    else if (ceil === null || ceil === undefined) out[key] = value;
    else out[key] = Math.min(value, ceil);
  }
  out.filesystemMode = mostRestrictive(req.filesystemMode, ceiling.filesystemMode, FILESYSTEM_RANK, FILESYSTEM_MODES);
  out.networkMode = mostRestrictive(req.networkMode, ceiling.networkMode, NETWORK_RANK, NETWORK_MODES);
  out.environmentPolicy = mostRestrictive(req.environmentPolicy, ceiling.environmentPolicy, ENVIRONMENT_RANK, ENVIRONMENT_MODES);
  return Object.freeze(out);
}

function mostRestrictive(a, b, rank, allowed) {
  const fallback = allowed[0];
  if (!allowed.includes(a)) return allowed.includes(b) ? b : fallback;
  if (!allowed.includes(b)) return a;
  return rank[a] <= rank[b] ? a : b;
}

// What did the clamp actually change? Used by the sandbox snapshot so the UI
// can show a trimmed request honestly instead of showing what was asked for.
function describeClamp(requested, effective) {
  const notes = [];
  for (const key of ['cpuTimeMs', 'memoryMb', 'maxProcesses', 'timeoutMs']) {
    if (requested && requested[key] !== undefined && requested[key] !== effective[key]) {
      notes.push(`${key} lowered from ${requested[key]} to ${effective[key]}`);
    }
  }
  for (const key of ['filesystemMode', 'networkMode', 'environmentPolicy']) {
    if (requested && requested[key] !== undefined && requested[key] !== effective[key]) {
      notes.push(`${key} narrowed from ${requested[key]} to ${effective[key]}`);
    }
  }
  return notes;
}

// Human label for the sandbox UI (§39): "Workspace Restricted", and so on.
function labelFor(limits) {
  if (limits.filesystemMode === 'none' && limits.networkMode === 'deny') return 'Fully Restricted';
  if (limits.filesystemMode === 'readonly') return 'Read Only';
  if (limits.networkMode === 'deny') return 'Workspace Restricted';
  return 'Workspace + Network';
}

function rankOf(mode, table) {
  return table[mode] === undefined ? -1 : table[mode];
}

module.exports = {
  FILESYSTEM_MODES,
  NETWORK_MODES,
  ENVIRONMENT_MODES,
  FILESYSTEM_RANK,
  NETWORK_RANK,
  ENVIRONMENT_RANK,
  DEFAULT_LIMITS,
  DEFAULT_CEILING,
  validateLimits,
  normalizeLimits,
  clampLimits,
  describeClamp,
  labelFor,
  rankOf,
};
