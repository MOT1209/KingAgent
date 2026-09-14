// Sandbox backend capabilities: what each kind of isolation can actually do.
//
// The single most important field here is `enforcement`, because it is where
// this platform refuses to lie to itself:
//
//   'kernel'   — the OS enforces the limit (job object, sandbox profile,
//                container). A violation is stopped by the kernel.
//   'advisory' — *this platform* enforces it in process: paths are checked,
//                processes are tracked and killed, timeouts are timed. Code
//                that is already running inside the sandbox is not confined by
//                a boundary it cannot cross.
//
// An advisory sandbox is worth having — it is where workspace restriction,
// process ownership, timeouts and cleanup actually live — but calling it
// "isolated" would be false, so the snapshot says `advisory` out loud and the
// UI shows it. §39 asks only for real values; this is how they stay real.

const { isPlainObject, isString } = require('../schema/validate');

const SANDBOX_FEATURES = Object.freeze([
  'cpu',        // cpu time budget
  'memory',     // memory ceiling
  'processes',  // process count ceiling
  'filesystem', // path restriction
  'network',    // network restriction
  'environment',// environment scrubbing
  'kill_tree',  // killing the whole process tree
]);

const RECOMMENDED_BACKEND = Object.freeze({
  win32: 'windows-job-object',
  darwin: 'macos-sandbox',
  linux: 'linux-namespaces',
});

// Declared backend families. `implemented` records whether this fork ships one;
// an unimplemented family still appears in the plan (that is what §19 asks for:
// design for the future without building it now) and is never selected.
const BACKEND_FAMILIES = Object.freeze({
  advisory: {
    id: 'advisory',
    name: 'Advisory (in-process)',
    platforms: ['windows', 'macos', 'linux'],
    enforcement: 'advisory',
    implemented: true,
    // Deliberately no 'cpu' or 'memory': this backend counts processes, applies
    // timeouts and scrubs the environment, but it cannot bound CPU time or
    // memory — backend.applyLimits() reports exactly that. Declaring a feature
    // it cannot honour would make selectBackend() hand a caller a sandbox it
    // believes is bounded when it is not.
    features: ['filesystem', 'environment', 'processes'],
    note: 'Path checks, process ownership, timeouts and cleanup enforced by KingAgent. Not an OS guarantee.',
  },
  'windows-job-object': {
    id: 'windows-job-object',
    name: 'Windows Job Object',
    platforms: ['windows'],
    enforcement: 'advisory',
    implemented: false,
    features: ['cpu', 'memory', 'processes', 'kill_tree', 'environment'],
    note: 'Planned: Job Objects with process/memory/CPU limits and JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.',
  },
  'macos-sandbox': {
    id: 'macos-sandbox',
    name: 'macOS sandbox profile',
    platforms: ['macos'],
    enforcement: 'advisory',
    implemented: false,
    features: ['filesystem', 'network', 'environment', 'processes'],
    note: 'Planned: sandbox_init profiles around the spawned backend.',
  },
  'linux-namespaces': {
    id: 'linux-namespaces',
    name: 'Linux namespaces',
    platforms: ['linux'],
    enforcement: 'kernel',
    implemented: false,
    features: ['cpu', 'memory', 'processes', 'filesystem', 'network', 'environment', 'kill_tree'],
    note: 'Planned: bubblewrap/namespaces.',
  },
  remote: {
    id: 'remote',
    name: 'Remote sandbox',
    platforms: ['windows', 'macos', 'linux'],
    enforcement: 'kernel',
    implemented: false,
    features: ['cpu', 'memory', 'processes', 'filesystem', 'network', 'environment'],
    note: 'Planned: run the backend on another host.',
  },
});

function platformName(platform = process.platform) {
  if (platform === 'win32' || platform === 'windows') return 'windows';
  if (platform === 'darwin' || platform === 'macos') return 'macos';
  return 'linux';
}

function describeBackend(id) {
  const family = BACKEND_FAMILIES[id];
  if (!family) return null;
  return { ...family, platforms: [...family.platforms], features: [...family.features] };
}

function listBackends() {
  // `.map(describeBackend)` would pass the array index as the argument and
  // return null for every entry; look each family up by its own id.
  return Object.values(BACKEND_FAMILIES).map((family) => describeBackend(family.id));
}

// Which backend can be used here, given what the caller needs?
//
// Deterministic and honest: an unimplemented family is never returned as
// available, and a caller that requires a feature the advisory backend cannot
// give gets `satisfied: false` with the reason rather than a silent downgrade.
function selectBackend({ platform = process.platform, required = [], candidates = null, prefer = null } = {}) {
  const os = platformName(platform);
  const pool = candidates && candidates.length ? candidates : Object.keys(BACKEND_FAMILIES);

  const considered = pool
    .map((id) => BACKEND_FAMILIES[id])
    .filter(Boolean)
    .filter((b) => b.platforms.includes(os));

  const missingFeature = [];
  const usable = considered.filter((b) => {
    const missing = required.filter((f) => !b.features.includes(f));
    if (missing.length) { missingFeature.push({ id: b.id, missing }); return false; }
    return b.implemented;
  });

  if (usable.length === 0) {
    return {
      backend: null,
      available: false,
      satisfied: false,
      reasons: [
        ...missingFeature.map((m) => `${m.id} cannot provide ${m.missing.join(', ')}`),
        ...considered.filter((b) => !b.implemented).map((b) => `${b.id} is planned, not implemented`),
      ],
      considered: considered.map((b) => b.id),
    };
  }

  const ordered = prefer && usable.some((b) => b.id === prefer)
    ? [usable.find((b) => b.id === prefer), ...usable.filter((b) => b.id !== prefer)]
    : [...usable].sort((a, b) => featureCount(b) - featureCount(a) || (a.id < b.id ? -1 : 1));

  const chosen = ordered[0];
  return {
    backend: describeBackend(chosen.id),
    available: true,
    satisfied: true,
    reasons: [],
    considered: considered.map((b) => b.id),
    fallback: ordered.length > 1 ? ordered.slice(1).map((b) => b.id) : [],
  };
}

function featureCount(backend) {
  return backend.features.length;
}

// What can this sandbox actually promise? Used in the snapshot so the header
// reads "Workspace Restricted" rather than "Secure Sandbox".
function enforcementLabel(backend) {
  if (!backend || !backend.enforcement) return 'Unavailable';
  if (backend.enforcement === 'kernel') return 'OS-enforced';
  if (backend.enforcement === 'none') return 'Unavailable';
  return 'Platform-enforced';
}

function isBackendDescriptor(v) {
  return isPlainObject(v) && isString(v.id) && isString(v.enforcement);
}

module.exports = {
  SANDBOX_FEATURES,
  BACKEND_FAMILIES,
  RECOMMENDED_BACKEND,
  platformName,
  describeBackend,
  listBackends,
  selectBackend,
  enforcementLabel,
  isBackendDescriptor,
};
