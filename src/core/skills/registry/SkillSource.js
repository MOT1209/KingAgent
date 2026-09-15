// Where a skill came from, normalized and validated as inert data.
//
// Provenance is the first security control in this subsystem, not a label. The
// difference between "a skill KingAgent ships" and "a file a stranger published
// this morning" decides whether the content is scanned, whether execution is
// sandboxed, and what a person is asked to approve. So a source descriptor is
// parsed here into a fixed shape, and anything it cannot prove — a repository
// that is not `owner/repo`, a path that climbs out of its directory, a URL on a
// host this source type does not own — is a validation failure, not a default.
//
// Trust tiers, weakest first:
//
//   untrusted — anything remote that is not pinned to an immutable ref
//   community — remote, pinned to a commit sha or a released version
//   workspace — a local directory the user themselves pointed at
//   builtin   — shipped inside the KingAgent bundle and reviewed with it
//
// A tier is never taken from the payload. `SkillTrust` (security/SkillTrust.js)
// is what raises a skill above its source's tier, and only a human can do that.

const { isPlainObject, isString, nonEmptyString } = require('../../schema/validate');

const SOURCE_TYPES = Object.freeze(['builtin', 'local', 'github', 'skills.sh']);
const TRUST_TIERS = Object.freeze(['untrusted', 'community', 'workspace', 'builtin']);
const TRUST_RANK = Object.freeze(Object.fromEntries(TRUST_TIERS.map((t, i) => [t, i])));

// `owner/repo`, GitHub's own alphabet. No protocol, no path, and no segment
// that is `.` or `..` — `../evil` is two legal-looking segments to a naive
// character class, and it becomes a directory traversal the moment the value is
// interpolated into a URL or a path.
const GITHUB_SEGMENT = '[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}';
const GITHUB_REPO = new RegExp(`^${GITHUB_SEGMENT}/${GITHUB_SEGMENT}$`);
// A 40-hex commit sha is the only ref that is immutable; tags and branches move.
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9_./-]{1,200}$/;
// Skill ids and slugs on an external registry.
const SLUG = /^[a-z0-9][a-z0-9._-]{0,100}$/;

// A path *inside* a source: relative, forward-slashed, no traversal, no drive
// letter, no absolute root. This is checked here and again at read time by the
// source adapters — the second check is not redundant, it is where a symlink or
// an OS-specific separator would otherwise get through.
function isSafeRelativePath(value) {
  if (!isString(value) || value.length === 0 || value.length > 500) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.includes('\\')) return false;
  if (value.includes('\0')) return false;
  return value.split('/').every((seg) => seg !== '..' && seg !== '' && seg !== '.');
}

function validateSource(input) {
  if (input === undefined || input === null) {
    return { ok: true, source: normalize({ type: 'builtin' }) };
  }
  if (!isPlainObject(input)) return { ok: false, errors: ['skill source must be an object'] };
  const type = input.type || 'builtin';
  if (!SOURCE_TYPES.includes(type)) return { ok: false, errors: [`unknown skill source type: ${JSON.stringify(input.type)}`] };

  if (type === 'github') {
    if (!nonEmptyString(input.repository) || !GITHUB_REPO.test(input.repository)) {
      return { ok: false, errors: ['a github skill source requires repository as "owner/repo"'] };
    }
    if (input.ref !== undefined && !isSafeRef(input.ref)) {
      return { ok: false, errors: ['github source ref must be a branch, tag or commit sha'] };
    }
  }
  if (type === 'skills.sh') {
    if (!nonEmptyString(input.slug) && !nonEmptyString(input.repository)) {
      return { ok: false, errors: ['a skills.sh source requires a slug (or the repository it is published from)'] };
    }
    if (input.slug !== undefined && !(isString(input.slug) && SLUG.test(input.slug))) {
      return { ok: false, errors: [`invalid skills.sh slug: ${JSON.stringify(input.slug)}`] };
    }
  }
  if (type === 'local') {
    if (!nonEmptyString(input.directory)) return { ok: false, errors: ['a local skill source requires a directory'] };
  }
  if (input.path !== undefined && !isSafeRelativePath(input.path)) {
    return { ok: false, errors: [`skill source path must be a relative path inside the source: ${JSON.stringify(input.path)}`] };
  }
  if (input.url !== undefined && !isHttpsUrl(input.url)) {
    return { ok: false, errors: ['skill source url must be an https URL'] };
  }
  return { ok: true, source: normalize({ ...input, type }) };
}

// A git ref that cannot climb: no `..` segment, no leading dash (which would
// read as a flag if this ever reached a git argv), no control characters.
function isSafeRef(value) {
  if (!isString(value) || !REF.test(value)) return false;
  if (value.startsWith('-')) return false;
  return value.split('/').every((seg) => seg !== '..' && seg !== '.' && seg !== '');
}

function isHttpsUrl(value) {
  if (!isString(value) || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalize(input) {
  const type = input.type;
  return Object.freeze({
    type,
    repository: isString(input.repository) ? input.repository : null,
    slug: isString(input.slug) ? input.slug : null,
    directory: type === 'local' && isString(input.directory) ? input.directory : null,
    path: isString(input.path) ? input.path : null,
    ref: isString(input.ref) ? input.ref : null,
    url: isString(input.url) ? input.url : null,
    // Set by the installer from the bytes it actually read, never by the
    // publisher: an integrity claim a source makes about itself is worthless.
    digest: null,
    fetchedAt: null,
  });
}

// The tier a source starts at. Pinning to a commit sha (or an exact published
// version on skills.sh) is what separates `community` from `untrusted`: an
// unpinned ref means the content can change under a trust decision that was
// made about something else.
function baseTrust(source) {
  if (!source) return 'untrusted';
  switch (source.type) {
    case 'builtin': return 'builtin';
    case 'local': return 'workspace';
    case 'github': return source.ref && COMMIT_SHA.test(source.ref) ? 'community' : 'untrusted';
    case 'skills.sh': return source.digest ? 'community' : 'untrusted';
    default: return 'untrusted';
  }
}

function trustRank(tier) {
  return TRUST_RANK[tier] === undefined ? -1 : TRUST_RANK[tier];
}

function isRemote(source) {
  return Boolean(source) && (source.type === 'github' || source.type === 'skills.sh');
}

// A short, stable, human-readable origin for the UI and the audit trail.
function sourceLabel(source) {
  if (!source) return 'unknown';
  switch (source.type) {
    case 'builtin': return 'built-in';
    case 'local': return `local:${source.directory || '?'}`;
    case 'github': return `github:${source.repository}${source.ref ? `@${source.ref.slice(0, 12)}` : ''}`;
    case 'skills.sh': return `skills.sh:${source.slug || source.repository || '?'}`;
    default: return source.type;
  }
}

// Record what was actually fetched. Returns a new frozen source — the original
// descriptor is never mutated, so a cached manifest and a freshly fetched one
// can be compared field by field.
function withFetchResult(source, { digest = null, fetchedAt = Date.now(), ref = null } = {}) {
  return Object.freeze({ ...source, digest: digest || source.digest, fetchedAt, ref: ref || source.ref });
}

module.exports = {
  SOURCE_TYPES,
  TRUST_TIERS,
  TRUST_RANK,
  COMMIT_SHA,
  validateSource,
  normalize,
  baseTrust,
  trustRank,
  isRemote,
  isSafeRelativePath,
  isSafeRef,
  isHttpsUrl,
  sourceLabel,
  withFetchResult,
};
