// Source: one retrieved thing, with provenance.
//
// A source is not "a search result". A search result is a ranking row from some
// provider; a source is a *retrieved artifact* with an origin we can name, a
// time we saw it, and a set of scores that say how much weight it should carry.
// Provider-specific shapes never reach the rest of the engine — everything
// crosses into core through normalizeSource (§12).

const crypto = require('node:crypto');
const { isPlainObject, isString } = require('../../schema/validate');

const SOURCE_TYPES = Object.freeze({
  WEB: 'web',
  ACADEMIC: 'academic',
  GITHUB: 'github',
  DOCUMENTATION: 'documentation',
  DISCUSSION: 'discussion',
  NEWS: 'news',
  FILE: 'file',
  MCP: 'mcp',
  LOCAL: 'local',
});

const ALL_SOURCE_TYPES = Object.freeze(Object.values(SOURCE_TYPES));

// Primary sources carry more weight than commentary about them (§11). This is a
// property of the *type*, refined per-source by sourceQuality.js.
const PRIMARY_TYPES = Object.freeze([
  SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB, SOURCE_TYPES.ACADEMIC, SOURCE_TYPES.FILE,
]);

// Content is truncated at the boundary, not deep inside the pipeline, so every
// downstream stage sees the same bounded string and no single page can blow the
// task's memory budget.
const MAX_CONTENT_CHARS = 200_000;
const MAX_SNIPPET_CHARS = 2_000;

function newSourceId() {
  return `src-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

// A stable identity for the same document seen twice (§13). Built from the
// canonical URL when there is one, else from a digest of the content, so a
// retry or a second query cannot inflate the source count.
function sourceFingerprint({ canonicalUrl, url, content, title }) {
  const basis = canonicalUrl || url || `${title || ''}::${String(content || '').slice(0, 4000)}`;
  return crypto.createHash('sha256').update(String(basis)).digest('hex').slice(0, 24);
}

function clampText(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

function toEpoch(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

function domainOf(url) {
  if (!isString(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// The one door a provider payload comes through. Everything is coerced to a
// known primitive shape; unknown provider keys are kept only under `raw`, which
// nothing downstream reads for decisions (§31 — provider text is data).
function normalizeSource(def = {}) {
  const url = isString(def.url) && def.url ? def.url : null;
  const canonicalUrl = isString(def.canonicalUrl) && def.canonicalUrl ? def.canonicalUrl : canonicalize(url);
  const content = clampText(def.content, MAX_CONTENT_CHARS);
  const snippet = clampText(def.snippet || content.slice(0, MAX_SNIPPET_CHARS), MAX_SNIPPET_CHARS);
  const type = ALL_SOURCE_TYPES.includes(def.type) ? def.type : SOURCE_TYPES.WEB;
  return Object.freeze({
    id: isString(def.id) && def.id ? def.id : newSourceId(),
    type,
    url,
    canonicalUrl,
    path: isString(def.path) ? def.path : null,
    title: clampText(def.title || url || def.path || 'untitled', 400),
    domain: isString(def.domain) ? def.domain.toLowerCase() : domainOf(canonicalUrl || url),
    publisher: isString(def.publisher) ? clampText(def.publisher, 200) : null,
    author: isString(def.author) ? clampText(def.author, 200) : null,
    language: isString(def.language) ? def.language.slice(0, 16) : null,
    publishedAt: toEpoch(def.publishedAt),
    updatedAt: toEpoch(def.updatedAt),
    retrievedAt: toEpoch(def.retrievedAt) || Date.now(),
    content,
    snippet,
    contentChars: content.length,
    truncated: typeof def.content === 'string' && def.content.length > MAX_CONTENT_CHARS,
    // Provenance: which adapter produced this, answering which query.
    sourceAdapterId: isString(def.sourceAdapterId) ? def.sourceAdapterId : null,
    queryId: isString(def.queryId) ? def.queryId : null,
    query: isString(def.query) ? clampText(def.query, 500) : null,
    primary: def.primary === undefined ? PRIMARY_TYPES.includes(type) : Boolean(def.primary),
    // Scores start at null, not 0: "not scored yet" and "scored zero" are
    // different facts and the quality evaluator needs to tell them apart.
    trustScore: numOrNull(def.trustScore),
    authorityScore: numOrNull(def.authorityScore),
    freshnessScore: numOrNull(def.freshnessScore),
    relevanceScore: numOrNull(def.relevanceScore),
    qualityScore: numOrNull(def.qualityScore),
    fingerprint: isString(def.fingerprint) ? def.fingerprint : sourceFingerprint({ canonicalUrl, url, content, title: def.title }),
    // Security verdict, filled in by security/researchSecurity.js. A source
    // that was never screened reads as `null`, and the evidence extractor
    // refuses to work from one.
    safety: isPlainObject(def.safety) ? Object.freeze({ ...def.safety }) : null,
    metadata: isPlainObject(def.metadata) ? Object.freeze({ ...def.metadata }) : Object.freeze({}),
  });
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : null;
}

function clamp01(n) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Canonical form for deduplication: scheme+host+path, tracking parameters and
// fragments removed, trailing slash normalized. Sorting the surviving query
// parameters means `?a=1&b=2` and `?b=2&a=1` are one page, not two.
// `utm_*` is a family, so it is matched by prefix; the rest are exact names.
// Deliberately conservative: bare `ref` and `source` are left alone because
// plenty of real pages route on them, and dropping a meaningful parameter would
// merge two different documents into one "duplicate".
const TRACKING_PREFIX = /^utm_/i;
const TRACKING_PARAMS = /^(fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|ref_src|si|_ga)$/i;

function isTrackingParam(key) {
  return TRACKING_PREFIX.test(key) || TRACKING_PARAMS.test(key);
}

function canonicalize(url) {
  if (!isString(url) || !url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  // http and https of the same page are the same page for dedup purposes.
  if (u.protocol === 'http:') u.protocol = 'https:';
  const keep = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

// Renderer-safe view: never ships full page content over IPC.
function sourceView(source) {
  return {
    id: source.id,
    type: source.type,
    url: source.url,
    title: source.title,
    domain: source.domain,
    publisher: source.publisher,
    author: source.author,
    publishedAt: source.publishedAt,
    retrievedAt: source.retrievedAt,
    snippet: source.snippet,
    contentChars: source.contentChars,
    primary: source.primary,
    trustScore: source.trustScore,
    authorityScore: source.authorityScore,
    freshnessScore: source.freshnessScore,
    relevanceScore: source.relevanceScore,
    qualityScore: source.qualityScore,
    safety: source.safety ? { safe: source.safety.safe, findings: (source.safety.findings || []).length } : null,
  };
}

module.exports = {
  SOURCE_TYPES,
  ALL_SOURCE_TYPES,
  PRIMARY_TYPES,
  MAX_CONTENT_CHARS,
  MAX_SNIPPET_CHARS,
  newSourceId,
  sourceFingerprint,
  normalizeSource,
  canonicalize,
  isTrackingParam,
  domainOf,
  sourceView,
  clamp01,
};
