// Semantic versions and ranges, implemented in-house and deliberately small.
//
// The platform has no dependency on a semver package and this is not the place
// to add one: version strings arrive from untrusted manifests, and the parsing
// surface should be something a reviewer can read in one sitting. So this
// supports the subset a skill manifest actually needs —
//
//   exact      1.2.3
//   caret      ^1.2.3   >=1.2.3 <2.0.0   (and ^0.2.3 -> >=0.2.3 <0.3.0)
//   tilde      ~1.2.3   >=1.2.3 <1.3.0
//   comparator >=1.2.3, >1.2.3, <=2.0.0, <2.0.0
//   wildcard   *  or  x
//
// — and refuses everything else rather than guessing. Pre-release tags parse
// and compare (1.0.0-beta < 1.0.0); build metadata is ignored for ordering, as
// semver requires.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const RANGE = /^(\^|~|>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = SEMVER.exec(input.trim());
  if (!m) return null;
  return Object.freeze({
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? Object.freeze(m[4].split('.')) : null,
    build: m[5] || null,
    raw: input.trim(),
  });
}

function isVersion(input) {
  return parseVersion(input) !== null;
}

// -1 / 0 / 1, semver precedence. A version with a pre-release tag sorts below
// the same version without one.
function compareVersions(a, b) {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va || !vb) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] < vb[key] ? -1 : 1;
  }
  if (!va.prerelease && !vb.prerelease) return 0;
  if (!va.prerelease) return 1;
  if (!vb.prerelease) return -1;
  const len = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const pa = va.prerelease[i];
    const pb = vb.prerelease[i];
    if (pa === undefined) return -1;
    if (pb === undefined) return 1;
    const na = /^\d+$/.test(pa) ? Number(pa) : null;
    const nb = /^\d+$/.test(pb) ? Number(pb) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (pa !== pb) {
      return pa < pb ? -1 : 1;
    }
  }
  return 0;
}

function parseRange(input) {
  if (input === undefined || input === null || input === '*' || input === 'x' || input === '') {
    return Object.freeze({ operator: '*', version: null, raw: '*' });
  }
  if (typeof input !== 'string') return null;
  const m = RANGE.exec(input.trim());
  if (!m) return null;
  const version = parseVersion(`${m[2]}.${m[3]}.${m[4]}${m[5] ? `-${m[5]}` : ''}`);
  if (!version) return null;
  return Object.freeze({ operator: m[1] || '=', version, raw: input.trim() });
}

function isRange(input) {
  return parseRange(input) !== null;
}

function satisfies(version, range) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  const r = typeof range === 'string' || range === undefined || range === null ? parseRange(range) : range;
  if (!v || !r) return false;
  if (r.operator === '*') return true;
  const cmp = compareVersions(v, r.version);
  switch (r.operator) {
    case '=': return cmp === 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '^': {
      if (cmp < 0) return false;
      // ^0.x.y is pinned to the minor, as npm does: a 0.x release may break.
      if (r.version.major === 0 && r.version.minor === 0) return v.major === 0 && v.minor === 0 && v.patch === r.version.patch;
      if (r.version.major === 0) return v.major === 0 && v.minor === r.version.minor;
      return v.major === r.version.major;
    }
    case '~': {
      if (cmp < 0) return false;
      return v.major === r.version.major && v.minor === r.version.minor;
    }
    default: return false;
  }
}

// The highest version in `versions` that satisfies `range`, or null. Used by
// the resolver to pick one installed version out of several.
function maxSatisfying(versions, range) {
  const ok = (versions || []).filter((v) => satisfies(v, range));
  if (ok.length === 0) return null;
  return ok.sort(compareVersions)[ok.length - 1];
}

// Which part of the version changed — what an update notification says out
// loud, because "an update is available" and "a major update is available" mean
// very different things for a capability with permissions.
function diffKind(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return null;
  const cmp = compareVersions(a, b);
  if (cmp === 0) return 'none';
  if (cmp > 0) return 'downgrade';
  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  return 'prerelease';
}

module.exports = {
  parseVersion,
  isVersion,
  compareVersions,
  parseRange,
  isRange,
  satisfies,
  maxSatisfying,
  diffKind,
};
