// SkillCache: content that has already been fetched and checked, kept for the
// life of the process (and optionally on disk through a collection).
//
// Caching skill content is not only about speed. A cache entry is keyed by
// *content digest* as well as by location, which turns it into the mechanism
// that detects a skill changing underneath a trust decision: the loader asks
// for `id@version` and compares the digest it gets back with the one recorded
// when the skill was installed. Same digest, same bytes, same verdict. Different
// digest means the content changed since it was validated — and that is a
// quarantine, not a cache miss.
//
// Because that comparison is a security decision, what the digest *covers*
// matters as much as the hash does. `digestOfSkill` is the one this system
// pins: the entry document and every resource it points at (see `digestOf`
// below for why a resource is not a detail).
//
// Bounded by entry count and total bytes, because skill content arrives from
// remote sources and an unbounded cache is a memory-exhaustion primitive.

const crypto = require('node:crypto');

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024; // 32MB of skill text is already generous
const DEFAULT_TTL_MS = 60 * 60 * 1000;

// The hash of a single document, and no longer what a skill is pinned to — that
// is `digestOfSkill` below. It stays because "did this one file change" is a
// fair question about a string a caller already holds, and because the two must
// not be confused: a digest of the instructions alone is precisely the pin that
// left every resource unmeasured.
function digestOf(content) {
  return crypto.createHash('sha256').update(String(content), 'utf8').digest('hex');
}

// The digest of a whole skill: the instructions a person read and approved, and
// every resource those instructions can point the model at.
//
// A skill is not one file. `entry.resources` names further documents that are
// fetched alongside the instructions and reach the model as prompt text in
// exactly the same way the entry document does. Pinning only the entry document
// leaves the resources an approved-but-unmeasured side channel: leave a skill's
// instructions untouched, rewrite one resource it references into an instruction
// the scanner would have refused, and the recorded digest still matches — so the
// load is treated as the skill that was approved, and the new text is handed to
// the model under the old verdict.
//
// The hash is therefore over both, in a canonical order and with every part
// length-framed:
//
//   * resources are visited in sorted name order, so the order a source happens
//     to read them in is not part of the value;
//   * each part carries its name and byte length, so no two different sets of
//     resources can concatenate into the same byte string, and an added or
//     removed resource is a change even when its body is empty.
//
// The scheme version is hashed in first, which is what keeps a change to *what a
// digest covers* from being a silent change of meaning. A digest recorded under
// an older scheme can never compare equal to one produced here, so widening the
// coverage costs one re-scan per installed skill instead of leaving the newly
// covered bytes unmeasured behind a matching old digest.
const DIGEST_SCHEME = 'kingagent-skill-digest/v2';

function digestOfSkill({ content = '', resources = {} } = {}) {
  const entry = typeof content === 'string' ? content : '';
  const hash = crypto.createHash('sha256');
  hash.update(`${DIGEST_SCHEME}\u0000${Buffer.byteLength(entry, 'utf8')}\u0000`, 'utf8');
  hash.update(entry, 'utf8');
  for (const name of Object.keys(resources || {}).sort()) {
    const body = typeof resources[name] === 'string' ? resources[name] : '';
    hash.update(`\u0000r\u0000${name}\u0000${Buffer.byteLength(body, 'utf8')}\u0000`, 'utf8');
    hash.update(body, 'utf8');
  }
  return hash.digest('hex');
}

class SkillCache {
  constructor({
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxBytes = DEFAULT_MAX_BYTES,
    ttlMs = DEFAULT_TTL_MS,
    clock = null,
    logger = null,
  } = {}) {
    this._entries = new Map(); // key -> { content, resources, digest, bytes, storedAt, hits }
    this._maxEntries = maxEntries;
    this._maxBytes = maxBytes;
    this._ttlMs = ttlMs;
    this._now = clock || (() => Date.now());
    this._logger = logger;
    this._bytes = 0;
    this._stats = { hits: 0, misses: 0, evictions: 0, expired: 0 };
  }

  static key(id, version, sourceType = '') {
    return `${id}@${version}${sourceType ? `#${sourceType}` : ''}`;
  }

  get(key) {
    const entry = this._entries.get(key);
    if (!entry) { this._stats.misses += 1; return null; }
    if (this._ttlMs > 0 && this._now() - entry.storedAt > this._ttlMs) {
      this._drop(key);
      this._stats.expired += 1;
      this._stats.misses += 1;
      return null;
    }
    entry.hits += 1;
    this._stats.hits += 1;
    // Re-insert to make the Map's own ordering an LRU list.
    this._entries.delete(key);
    this._entries.set(key, entry);
    return { content: entry.content, resources: { ...entry.resources }, digest: entry.digest, storedAt: entry.storedAt };
  }

  set(key, { content, resources = {}, digest = null }) {
    const bytes = byteLength(content) + Object.values(resources).reduce((n, r) => n + byteLength(r), 0);
    if (bytes > this._maxBytes) {
      if (this._logger) this._logger.warn('skill content too large to cache', { key, bytes });
      return null;
    }
    if (this._entries.has(key)) this._drop(key);
    const entry = {
      content,
      resources: { ...resources },
      digest: digest || digestOfSkill({ content, resources }),
      bytes,
      storedAt: this._now(),
      hits: 0,
    };
    this._entries.set(key, entry);
    this._bytes += bytes;
    this._evictIfNeeded();
    return entry.digest;
  }

  has(key) {
    return this.get(key) !== null;
  }

  invalidate(key) {
    return this._drop(key);
  }

  // Every entry for a skill id, whatever its version — what an update or a
  // removal clears, so stale content can never be loaded after either.
  invalidateSkill(id) {
    let n = 0;
    for (const key of [...this._entries.keys()]) {
      if (key === id || key.startsWith(`${id}@`)) { this._drop(key); n += 1; }
    }
    return n;
  }

  clear() {
    this._entries.clear();
    this._bytes = 0;
  }

  _drop(key) {
    const entry = this._entries.get(key);
    if (!entry) return false;
    this._bytes -= entry.bytes;
    return this._entries.delete(key);
  }

  _evictIfNeeded() {
    while (this._entries.size > this._maxEntries || this._bytes > this._maxBytes) {
      const oldest = this._entries.keys().next();
      if (oldest.done) break;
      this._drop(oldest.value);
      this._stats.evictions += 1;
    }
  }

  stats() {
    return { ...this._stats, entries: this._entries.size, bytes: this._bytes, maxEntries: this._maxEntries, maxBytes: this._maxBytes };
  }
}

function byteLength(text) {
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
}

module.exports = { SkillCache, digestOf, digestOfSkill, DIGEST_SCHEME, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BYTES };
