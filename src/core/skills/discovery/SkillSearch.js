// SkillSearch: find a skill by words, across what is installed and what is
// published.
//
// Two searches with one shape. Local search is exact and synchronous — it reads
// the registry's indexes. Remote search asks each configured source adapter and
// is async, best-effort and always attributed: a row from skills.sh is labelled
// as such and arrives `installed: false, trust: untrusted`, because a search
// result is an advertisement, not a vetting. Nothing here installs anything.
//
// A remote source that errors or times out degrades the result set rather than
// failing the search; the error is reported per source so the UI can say "GitHub
// results are unavailable" instead of silently showing fewer.

const { compareVersions } = require('../registry/SkillVersion');

const FIELD_WEIGHTS = Object.freeze({
  id: 5,
  name: 3,
  capability: 2.5,
  category: 2,
  tag: 2,
  description: 1,
});

const DEFAULT_LIMIT = 25;
const REMOTE_TIMEOUT_MS = 8000;

function normalize(q) {
  return String(q || '').toLowerCase().trim();
}

function terms(query) {
  return normalize(query).split(/[^a-z0-9.+#-]+/).filter((t) => t.length > 1);
}

// Score one installed record against the query terms, returning the matched
// fields so the UI can highlight *why* a row is in the list.
function scoreRecord(record, queryTerms) {
  const m = record.manifest;
  let score = 0;
  const matched = [];
  for (const term of queryTerms) {
    if (m.id.includes(term)) { score += FIELD_WEIGHTS.id; matched.push({ field: 'id', term }); }
    if (m.name.toLowerCase().includes(term)) { score += FIELD_WEIGHTS.name; matched.push({ field: 'name', term }); }
    for (const c of m.capabilities) if (c.includes(term)) { score += FIELD_WEIGHTS.capability; matched.push({ field: 'capability', term, value: c }); break; }
    for (const c of m.categories) if (c.includes(term)) { score += FIELD_WEIGHTS.category; matched.push({ field: 'category', term, value: c }); break; }
    for (const t of m.tags) if (t.includes(term)) { score += FIELD_WEIGHTS.tag; matched.push({ field: 'tag', term, value: t }); break; }
    if (m.description.toLowerCase().includes(term)) { score += FIELD_WEIGHTS.description; matched.push({ field: 'description', term }); }
  }
  // Every term matching something beats one term matching loudly: a search for
  // "mcp security" should prefer a skill about both over a skill that says
  // "mcp" five times.
  const covered = new Set(matched.map((x) => x.term)).size;
  const coverage = queryTerms.length ? covered / queryTerms.length : 0;
  return { score: score * (0.5 + 0.5 * coverage), matched, coverage };
}

function searchInstalled(registry, query, { limit = DEFAULT_LIMIT, category = null, includeDisabled = true } = {}) {
  const queryTerms = terms(query);
  const pool = registry.list({ category, ...(includeDisabled ? {} : { usable: true }) });
  if (queryTerms.length === 0) {
    return pool.slice(0, limit).map((record) => row(record, { score: 0, matched: [] }));
  }
  return pool
    .map((record) => ({ record, ...scoreRecord(record, queryTerms) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : 1))
    .slice(0, limit)
    .map((r) => row(r.record, r));
}

function row(record, { score, matched }) {
  return {
    id: record.id,
    version: record.version,
    name: record.manifest.name,
    description: record.manifest.description,
    categories: [...record.manifest.categories],
    tags: [...record.manifest.tags],
    riskLevel: record.manifest.riskLevel,
    permissions: [...record.manifest.permissions],
    source: record.manifest.source.type,
    installed: true,
    state: record.state,
    trust: record.trust.tier,
    score: Math.round(score * 100) / 100,
    matched,
  };
}

// Search installed skills and every configured source at once.
//
// `sources` is an array of source adapters (sources/*.js); each exposes
// `search({ query, limit })`. A source that has no search capability is skipped
// rather than treated as an error — a local directory legitimately has none.
async function search({
  registry,
  sources = [],
  query,
  limit = DEFAULT_LIMIT,
  category = null,
  includeRemote = true,
  timeoutMs = REMOTE_TIMEOUT_MS,
} = {}) {
  const installed = registry ? searchInstalled(registry, query, { limit, category }) : [];
  const installedIds = new Set(installed.map((r) => r.id));
  const errors = [];
  const remote = [];

  if (includeRemote) {
    const searchable = sources.filter((s) => s && typeof s.search === 'function');
    const results = await Promise.allSettled(
      searchable.map((source) => withTimeout(source.search({ query, limit }), timeoutMs, source.id)),
    );
    results.forEach((result, i) => {
      const source = searchable[i];
      if (result.status === 'rejected') {
        errors.push({ source: source.id, error: String(result.reason && result.reason.message ? result.reason.message : result.reason) });
        return;
      }
      for (const entry of result.value || []) {
        remote.push({
          id: entry.id,
          version: entry.version || null,
          name: entry.name || entry.id,
          description: entry.description || '',
          categories: entry.categories || [],
          tags: entry.tags || [],
          riskLevel: entry.riskLevel || null,
          permissions: entry.permissions || [],
          source: source.id,
          installed: installedIds.has(entry.id),
          // Never inferred from the listing. A published skill is untrusted
          // until it has been fetched, scanned and validated locally.
          trust: 'untrusted',
          state: installedIds.has(entry.id) ? 'installed' : 'available',
          score: 0,
          installs: Number.isFinite(entry.installs) ? entry.installs : null,
          updatedAt: entry.updatedAt || null,
          matched: [],
        });
      }
    });
  }

  return {
    query: String(query || ''),
    installed,
    available: dedupeRemote(remote).slice(0, limit),
    errors,
  };
}

// The same skill can be published in two places; prefer the higher version and
// keep one row per id+source so the UI is not a list of near-duplicates.
function dedupeRemote(rows) {
  const best = new Map();
  for (const r of rows) {
    const key = `${r.source}:${r.id}`;
    const seen = best.get(key);
    if (!seen || (r.version && seen.version && compareVersions(r.version, seen.version) > 0)) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => (b.installs || 0) - (a.installs || 0) || (a.id < b.id ? -1 : 1));
}

function withTimeout(promise, ms, sourceId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`source ${sourceId} did not answer within ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

module.exports = { FIELD_WEIGHTS, DEFAULT_LIMIT, terms, scoreRecord, searchInstalled, search };
