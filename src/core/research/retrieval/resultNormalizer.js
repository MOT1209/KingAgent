// Normalization (§12): make the pile of retrieval outcomes one clean, ordered,
// per-source view.
//
// schemas/researchResult.js already normalized each *row* at the adapter
// boundary. This is the second half: merging the same source found by several
// queries into one Source that remembers all of them, filling the derived
// fields (domain, freshness inputs, language) and dropping rows that are too
// thin to ever become evidence.
//
// The merge is the important part. Two queries finding the same page is a
// *strength* signal — it is more likely to be on-topic — and a system that kept
// both as separate sources would double-count it as two independent
// corroborations, which is the error §13 and §16 both care about.

const { normalizeSource } = require('../schemas/source');
const { withSource } = require('../schemas/researchResult');

// A row with no usable text can never yield a quotable span. Keeping it
// inflates the source count and the coverage score without adding anything.
const MIN_USABLE_CHARS = 24;

function usable(result) {
  const s = result.source;
  const text = `${s.snippet || ''}${s.content || ''}`.trim();
  return text.length >= MIN_USABLE_CHARS || Boolean(s.url || s.path);
}

// Merge results into a per-fingerprint source map.
//
// Returns:
//   sources   Source[]            one per distinct document, best content kept
//   results   ResearchResult[]    re-pointed at the merged sources
//   index     Map<sourceId, { source, queryIds, sourceTypes, adapterIds, hits }>
function normalizeResults(rawResults, { now = Date.now() } = {}) {
  const byFingerprint = new Map();
  const dropped = [];

  for (const result of rawResults) {
    if (!result || !result.source) continue;
    if (!usable(result)) { dropped.push({ reason: 'no usable text or address', title: result.source.title }); continue; }

    const fp = result.source.fingerprint;
    const existing = byFingerprint.get(fp);
    if (!existing) {
      byFingerprint.set(fp, {
        source: result.source,
        queryIds: new Set(result.queryId ? [result.queryId] : []),
        sourceTypes: new Set([result.source.type]),
        adapterIds: new Set(result.adapterId ? [result.adapterId] : []),
        bestRank: result.providerRank ?? 99,
        hits: 1,
        results: [result],
      });
      continue;
    }

    // Keep the richest version of the document: a full fetch beats a snippet,
    // and a snippet beats a title. Provenance fields come from whichever copy
    // actually has them.
    const keep = pickRicher(existing.source, result.source);
    existing.source = keep;
    if (result.queryId) existing.queryIds.add(result.queryId);
    existing.sourceTypes.add(result.source.type);
    if (result.adapterId) existing.adapterIds.add(result.adapterId);
    existing.bestRank = Math.min(existing.bestRank, result.providerRank ?? 99);
    existing.hits += 1;
    existing.results.push(result);
  }

  const index = new Map();
  const sources = [];
  const results = [];

  for (const entry of byFingerprint.values()) {
    const source = normalizeSource({
      ...entry.source,
      retrievedAt: entry.source.retrievedAt || now,
      metadata: {
        ...entry.source.metadata,
        // How many separate queries turned this up. Read by the reranker as a
        // corroboration signal and by the deduplicator as a merge record —
        // never as "N independent sources".
        queryHits: entry.hits,
        queryIds: [...entry.queryIds],
        foundVia: [...entry.adapterIds],
      },
    });
    sources.push(source);
    index.set(source.id, {
      source,
      queryIds: [...entry.queryIds],
      sourceTypes: [...entry.sourceTypes],
      adapterIds: [...entry.adapterIds],
      bestRank: entry.bestRank,
      hits: entry.hits,
    });
    for (const r of entry.results) results.push(withSource(r, source));
  }

  return { sources, results, index, dropped };
}

// Which of two copies of the same document do we keep?
function pickRicher(a, b) {
  const score = (s) => (s.content ? s.content.length : 0) + (s.snippet ? s.snippet.length / 4 : 0);
  const primary = score(b) > score(a) ? b : a;
  const other = primary === a ? b : a;
  // Provenance is unioned rather than taken from the winner: one copy may carry
  // the publication date and the other the author.
  return normalizeSource({
    ...primary,
    url: primary.url || other.url,
    canonicalUrl: primary.canonicalUrl || other.canonicalUrl,
    author: primary.author || other.author,
    publisher: primary.publisher || other.publisher,
    publishedAt: primary.publishedAt || other.publishedAt,
    updatedAt: primary.updatedAt || other.updatedAt,
    language: primary.language || other.language,
    // Safety is the *stricter* of the two records, never the more convenient.
    safety: mergeSafety(primary.safety, other.safety),
    metadata: { ...other.metadata, ...primary.metadata },
  });
}

function mergeSafety(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    safe: a.safe !== false && b.safe !== false,
    screenedAt: Math.max(a.screenedAt || 0, b.screenedAt || 0),
    injectionAttempts: Math.max(a.injectionAttempts || 0, b.injectionAttempts || 0),
    findings: [...(a.findings || []), ...(b.findings || [])],
    redactions: (a.redactions || 0) + (b.redactions || 0),
  };
}

module.exports = { normalizeResults, usable, pickRicher, MIN_USABLE_CHARS };
