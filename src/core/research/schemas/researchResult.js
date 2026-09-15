// ResearchResult: the normalized row every provider is reduced to (§12).
//
// This is the only shape the retrieval pipeline passes around. A provider that
// returns `{ items: [{ link, htmlSnippet }] }` and one that returns
// `{ hits: [{ url, abstract }] }` both arrive here as the same object, so
// dedup, reranking and evidence extraction never branch on provider identity.
//
// A result *carries* a Source rather than being one: the result is "this query,
// against this adapter, found this" — the same source found by two queries is
// two results and one source, which is exactly the distinction §13 needs.

const { isPlainObject, isString } = require('../../schema/validate');
const { normalizeSource } = require('./source');

function normalizeResult(def = {}, { query = null, adapterId = null } = {}) {
  const source = def.source && def.source.fingerprint
    ? def.source
    : normalizeSource({
      ...def,
      queryId: query ? query.id : def.queryId,
      query: query ? query.text : def.query,
      sourceAdapterId: adapterId || def.sourceAdapterId,
    });
  return Object.freeze({
    queryId: query ? query.id : (isString(def.queryId) ? def.queryId : null),
    query: query ? query.text : (isString(def.query) ? def.query : null),
    adapterId: adapterId || source.sourceAdapterId || null,
    source,
    // Where the provider put it in its own ranking. Kept for diagnostics and
    // as one weak reranking input — never trusted as the final order (§11).
    providerRank: Number.isInteger(def.providerRank) ? def.providerRank : null,
    relevanceScore: typeof def.relevanceScore === 'number' ? def.relevanceScore : null,
    qualityScore: typeof def.qualityScore === 'number' ? def.qualityScore : null,
    retrievedAt: source.retrievedAt,
    raw: isPlainObject(def.raw) ? Object.freeze({ ...def.raw }) : null,
  });
}

function withSource(result, source) {
  return Object.freeze({ ...result, source });
}

function resultView(result) {
  return {
    queryId: result.queryId,
    adapterId: result.adapterId,
    sourceId: result.source.id,
    title: result.source.title,
    url: result.source.url,
    relevanceScore: result.relevanceScore,
    qualityScore: result.qualityScore,
  };
}

module.exports = { normalizeResult, withSource, resultView };
