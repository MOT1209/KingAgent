// The shared shape every source adapter has, so the seven adapters differ only
// where they actually differ: which provider types they resolve, how a provider
// row maps onto a Source, and what their type implies about authority.
//
// An adapter is deliberately *thin*. It does not know about policy, security
// screening, budgets, caching or errors — sourceManager.js owns all of those,
// once, for every adapter. An adapter that owned its own policy check would be
// seven places to forget one.

const { normalizeResult } = require('../schemas/researchResult');
const { SOURCE_TYPES } = require('../schemas/source');
const { SourceUnavailableError } = require('../errors/researchErrors');
const { callProvider } = require('./searchProvider');

// Build an adapter from the three things that vary.
//
//   type       the SOURCE_TYPES value rows are stamped with
//   map        (row, ctx) -> a source-shaped plain object
//   providerTypes  which provider sourceTypes can serve this adapter, in
//                  preference order (a documentation adapter happily falls back
//                  to a general web provider)
function createAdapter({
  id, type, label, description, providerTypes, map,
  // Some adapters rewrite the query before it reaches a provider — a
  // documentation search is a web search with a site bias. Identity by default.
  shapeQuery = (text) => text,
  defaultAuthority = 0.5,
  supportsFetch = true,
} = {}) {
  if (!id || !type) throw new TypeError('a source adapter needs an id and a type');
  const order = providerTypes && providerTypes.length ? [...providerTypes] : [type];

  return Object.freeze({
    id,
    type,
    label: label || id,
    description: description || '',
    providerTypes: Object.freeze(order),
    defaultAuthority,
    supportsFetch,

    // Which providers could serve this adapter right now, best first.
    providersFrom(registry) {
      if (!registry) return [];
      const seen = new Set();
      const out = [];
      for (const pt of order) {
        for (const p of registry.resolveAll(pt)) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          out.push(p);
        }
      }
      return out;
    },

    available(registry) {
      return this.providersFrom(registry).length > 0;
    },

    // One provider call. Returns normalized results; throws a research error.
    // The retry/fallback loop across providers lives in sourceManager.
    async searchWith(provider, { query, limit, signal, timeoutMs }) {
      const text = shapeQuery(query.text, query);
      const rows = await callProvider(provider, 'search', {
        query: text,
        originalQuery: query.text,
        intent: query.intent,
        sourceType: type,
        limit,
      }, { signal, timeoutMs });
      if (!Array.isArray(rows)) {
        throw new SourceUnavailableError(provider.id, 'provider returned a non-array from search()');
      }
      return rows.slice(0, limit).map((row, i) => normalizeResult(
        { ...map(row, { query, provider, type }), providerRank: i, raw: null },
        { query, adapterId: id },
      ));
    },

    async fetchWith(provider, { url, signal, timeoutMs }) {
      if (!supportsFetch) throw new SourceUnavailableError(provider.id, `${id} does not support direct fetch`);
      if (!provider.fetch) throw new SourceUnavailableError(provider.id, 'provider cannot fetch full content');
      const doc = await callProvider(provider, 'fetch', { url, sourceType: type }, { signal, timeoutMs });
      if (!doc || typeof doc !== 'object') {
        throw new SourceUnavailableError(provider.id, 'provider returned no document from fetch()');
      }
      return doc;
    },
  });
}

// Shared field plucking. Providers name the same three things a dozen ways;
// this is the only place that list lives.
function pick(row, names, fallback = null) {
  for (const n of names) {
    const v = row && row[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

const URL_KEYS = ['url', 'link', 'href', 'permalink', 'html_url', 'htmlUrl', 'webUrl'];
const TITLE_KEYS = ['title', 'name', 'heading', 'headline', 'full_name'];
const SNIPPET_KEYS = ['snippet', 'description', 'abstract', 'summary', 'excerpt', 'htmlSnippet', 'body'];
const CONTENT_KEYS = ['content', 'text', 'markdown', 'fullText', 'raw_content', 'page'];
const DATE_KEYS = ['publishedAt', 'published_at', 'published', 'date', 'created_at', 'createdAt', 'pubDate'];
const AUTHOR_KEYS = ['author', 'authors', 'byline', 'creator'];

function baseMap(row, { type = SOURCE_TYPES.WEB } = {}) {
  const authors = row && row.authors;
  return {
    type,
    url: pick(row, URL_KEYS),
    title: pick(row, TITLE_KEYS),
    snippet: pick(row, SNIPPET_KEYS, ''),
    content: pick(row, CONTENT_KEYS, ''),
    publishedAt: pick(row, DATE_KEYS),
    author: Array.isArray(authors) ? authors.filter((a) => typeof a === 'string').join(', ') : pick(row, AUTHOR_KEYS),
    publisher: pick(row, ['publisher', 'site', 'siteName', 'source', 'journal', 'venue']),
    language: pick(row, ['language', 'lang']),
  };
}

module.exports = { createAdapter, baseMap, pick, URL_KEYS, TITLE_KEYS, SNIPPET_KEYS, CONTENT_KEYS };
