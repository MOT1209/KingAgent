// The research cache (§29).
//
// The rule that makes a research cache safe rather than merely fast: the key
// includes the query, the source type, the provider and the *time sensitivity
// of the question*. A cached answer to "what is the MCP specification" is worth
// keeping for a day; a cached answer to "what was announced this week" is wrong
// within the hour, and serving it is worse than not caching at all.
//
// Storage is an injected collection (core/persistence/collections.js) when the
// host wants the cache to survive a restart, and an in-memory LRU otherwise —
// the same pattern every other subsystem uses.

const crypto = require('node:crypto');
const { queryKey } = require('../schemas/researchQuery');

// TTL by how fast the answer goes stale. `researchStrategy` picks the band from
// the query classification; nothing guesses here.
const FRESHNESS = Object.freeze({
  STATIC: 'static',       // definitions, specifications, history
  SLOW: 'slow',           // documentation, library capabilities
  MODERATE: 'moderate',   // product comparisons, ecosystem state
  FAST: 'fast',           // releases, versions, recent changes
  REALTIME: 'realtime',   // news, prices, "today"
});

const TTL_MS = Object.freeze({
  static: 7 * 24 * 60 * 60 * 1000,
  slow: 24 * 60 * 60 * 1000,
  moderate: 6 * 60 * 60 * 1000,
  fast: 30 * 60 * 1000,
  // Deliberately zero: a realtime question is never served from cache. Keeping
  // a one-minute window here would be a correctness bug disguised as a speed-up.
  realtime: 0,
});

const DEFAULT_MAX_ENTRIES = 500;

function cacheKey({ query, sourceType, providerId = 'any', params = null, freshness = FRESHNESS.MODERATE }) {
  const basis = JSON.stringify({
    q: queryKey(typeof query === 'string' ? query : (query && query.text) || ''),
    t: sourceType,
    p: providerId,
    f: freshness,
    x: params || null,
  });
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

function createRetrievalCache({ collection = null, maxEntries = DEFAULT_MAX_ENTRIES, enabled = true, clock = Date.now } = {}) {
  // Map preserves insertion order, which is all an LRU needs: re-set on read.
  const mem = new Map();
  const stats = { hits: 0, misses: 0, writes: 0, evictions: 0, expired: 0, bypassed: 0 };

  function evict() {
    while (mem.size > maxEntries) {
      const oldest = mem.keys().next().value;
      mem.delete(oldest);
      stats.evictions += 1;
    }
  }

  function live(entry, now) {
    return entry && typeof entry.expiresAt === 'number' && entry.expiresAt > now;
  }

  async function get(key, { freshness = FRESHNESS.MODERATE } = {}) {
    if (!enabled) return null;
    // A realtime question bypasses the cache entirely — both the read and,
    // below, the write. There is no stale window to tune.
    if (TTL_MS[freshness] === 0) { stats.bypassed += 1; return null; }
    const now = clock();
    let entry = mem.get(key) || null;
    if (entry && !live(entry, now)) { mem.delete(key); entry = null; stats.expired += 1; }
    if (!entry && collection) {
      const stored = await collection.get(key).catch(() => null);
      if (stored && live(stored, now)) {
        entry = stored;
        mem.set(key, entry);
        evict();
      } else if (stored) {
        stats.expired += 1;
        await collection.delete(key).catch(() => {});
      }
    }
    if (!entry) { stats.misses += 1; return null; }
    // Touch for LRU.
    mem.delete(key);
    mem.set(key, entry);
    stats.hits += 1;
    return entry.value;
  }

  async function set(key, value, { freshness = FRESHNESS.MODERATE, ttlMs = null } = {}) {
    if (!enabled) return false;
    const ttl = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : TTL_MS[freshness];
    if (!ttl) { stats.bypassed += 1; return false; }
    const entry = { key, value, freshness, storedAt: clock(), expiresAt: clock() + ttl };
    mem.set(key, entry);
    evict();
    stats.writes += 1;
    if (collection) await collection.set(key, entry).catch(() => {});
    return true;
  }

  async function invalidate(predicate) {
    let removed = 0;
    for (const [key, entry] of [...mem.entries()]) {
      if (predicate(entry)) { mem.delete(key); removed += 1; if (collection) await collection.delete(key).catch(() => {}); }
    }
    return removed;
  }

  async function clear() {
    const n = mem.size;
    mem.clear();
    if (collection && typeof collection.clear === 'function') await collection.clear().catch(() => {});
    return n;
  }

  return {
    get, set, invalidate, clear,
    key: cacheKey,
    get enabled() { return enabled; },
    setEnabled(v) { enabled = v !== false; },
    size: () => mem.size,
    stats: () => ({ ...stats, size: mem.size }),
  };
}

module.exports = { createRetrievalCache, cacheKey, FRESHNESS, TTL_MS, DEFAULT_MAX_ENTRIES };
