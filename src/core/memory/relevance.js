// Which memories are worth putting in front of the model for *this* task.
//
// The rule Phase 3 exists to enforce: never inject the memory database into a
// prompt. A task asks for what it needs, gets a ranked handful, and the rest
// stays on disk. Retrieval here is lexical on purpose — a vector store is a
// mandatory dependency and an embedding pipeline, and neither is justified
// before the shape of the queries is known. The scoring function is the seam: a
// provider that can rank semantically supplies its own `score` and everything
// above it is unchanged.
//
// Score = textual overlap + tag match + scope proximity + recency + importance.
// Each term is bounded so no single one can dominate.

const { weight: importanceWeight } = require('./importance');
const { SCOPE_BREADTH } = require('./scopes');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these', 'those',
  'i', 'we', 'you', 'they', 'my', 'our', 'your', 'their', 'from', 'at', 'by', 'as',
  'do', 'does', 'did', 'can', 'will', 'would', 'should', 'please',
]);

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // a fortnight

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function overlap(queryTokens, entryTokens) {
  if (queryTokens.size === 0 || entryTokens.size === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (entryTokens.has(t)) hits += 1;
  return hits / queryTokens.size; // 0..1, "how much of what I asked for is here"
}

function recencyFactor(entry, now) {
  const age = Math.max(0, now - (entry.updatedAt || entry.createdAt || now));
  return Math.pow(0.5, age / HALF_LIFE_MS); // 1 → 0.5 per half-life
}

// Narrower scopes are more likely to be about the task at hand.
function scopeFactor(entry, preferredScopes) {
  const breadth = SCOPE_BREADTH[entry.scope] ?? 3;
  const base = 0.6 + (breadth / 6) * 0.4; // 0.6 (global) .. 1.0 (task)
  if (Array.isArray(preferredScopes) && preferredScopes.length && preferredScopes.includes(entry.scope)) {
    return Math.min(1.2, base + 0.2);
  }
  return base;
}

function scoreEntry(entry, { queryTokens, tags = [], now = Date.now(), preferredScopes = [] }) {
  const entryTokens = new Set(tokenize(`${entry.content} ${(entry.tags || []).join(' ')}`));
  const text = overlap(queryTokens, entryTokens);
  const tagHit = tags.length
    ? tags.filter((t) => (entry.tags || []).includes(t)).length / tags.length
    : 0;
  const base = text * 0.6 + tagHit * 0.4;
  // A query with no usable tokens must not rank everything at zero — fall back
  // to importance + recency so "give me what matters here" still returns
  // something ordered.
  const textual = queryTokens.size === 0 && tags.length === 0 ? 0.35 : base;
  return textual * importanceWeight(entry.importance) * recencyFactor(entry, now) * scopeFactor(entry, preferredScopes);
}

// Returns [{ entry, score }] sorted best-first, above `minScore`, capped.
function rank(entries, { query = '', tags = [], limit = 10, minScore = 0.01, now = Date.now(), preferredScopes = [] } = {}) {
  const queryTokens = new Set(tokenize(query));
  const scored = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, { queryTokens, tags, now, preferredScopes });
    if (score >= minScore) scored.push({ entry, score });
  }
  scored.sort((a, b) => (b.score - a.score) || ((b.entry.updatedAt || 0) - (a.entry.updatedAt || 0)));
  return limit > 0 ? scored.slice(0, limit) : scored;
}

module.exports = { tokenize, rank, scoreEntry, overlap, recencyFactor, scopeFactor, STOP_WORDS, HALF_LIFE_MS };
