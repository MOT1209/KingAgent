// MemoryProvider: the storage seam under the MemoryManager.
//
// Phase 3 deliberately does not choose a database. The manager owns policy —
// scopes, importance, relevance, candidates — and a provider owns nothing but
// bytes, behind six methods. That is what lets SQLite, a vector store or a
// remote service arrive later as a *provider*, with no caller changing.
//
// Two ship here:
//   * in-memory — the default, and what tests use.
//   * store-backed — persists through persistence/collections.js, so it works
//     over the same atomic JSON store the rest of the platform already has.
//
// Both are async, because the interesting implementations will be.

const REQUIRED_METHODS = Object.freeze(['put', 'get', 'delete', 'list', 'clear', 'count']);

function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new Error('memory provider must be an object');
  for (const m of REQUIRED_METHODS) {
    if (typeof provider[m] !== 'function') throw new Error(`memory provider is missing ${m}()`);
  }
  return provider;
}

function matchesFilter(entry, filter = {}) {
  if (!entry) return false;
  if (filter.scope && entry.scope !== filter.scope) return false;
  if (filter.scopeId !== undefined && filter.scopeId !== null && entry.scopeId !== filter.scopeId) return false;
  if (Array.isArray(filter.keys) && filter.keys.length && !filter.keys.includes(entry.key)) return false;
  if (filter.type && entry.type !== filter.type) return false;
  if (Array.isArray(filter.tags) && filter.tags.length
    && !filter.tags.every((t) => (entry.tags || []).includes(t))) return false;
  if (filter.since && (entry.updatedAt || 0) < filter.since) return false;
  return true;
}

// Entries are cloned on the way in and out so a caller mutating what it got
// back cannot reach into the store — the same contract persistence/store.js
// already keeps.
function createInMemoryProvider({ maxEntries = 5000 } = {}) {
  const data = new Map();
  return {
    name: 'in-memory',
    async put(entry) {
      data.set(entry.id, structuredClone(entry));
      if (data.size > maxEntries) {
        // Oldest-updated first; importance is the manager's concern, but a
        // provider still must not grow without bound.
        const victim = [...data.values()].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))[0];
        if (victim) data.delete(victim.id);
      }
      return structuredClone(entry);
    },
    async get(id) {
      return data.has(id) ? structuredClone(data.get(id)) : null;
    },
    async delete(id) {
      return data.delete(id);
    },
    async list(filter = {}) {
      const out = [];
      for (const entry of data.values()) if (matchesFilter(entry, filter)) out.push(structuredClone(entry));
      return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async clear(filter = null) {
      if (!filter) { const n = data.size; data.clear(); return n; }
      let n = 0;
      for (const [id, entry] of [...data]) if (matchesFilter(entry, filter)) { data.delete(id); n += 1; }
      return n;
    },
    async count(filter = {}) {
      return (await this.list(filter)).length;
    },
  };
}

// Persists every entry as one record in the memory collection. `list` reads the
// collection and filters in process: the store contract has no query language,
// and that is the price of keeping the backend swappable. A provider backed by
// something that *can* query pushes the filter down instead.
function createStoreProvider({ collection, maxEntries = 20000 } = {}) {
  if (!collection) throw new Error('store memory provider requires a collection');
  return {
    name: 'store',
    async put(entry) {
      await collection.put(entry.id, entry);
      const ids = await collection.ids();
      if (ids.length > maxEntries) {
        const all = await collection.list();
        const victims = all.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).slice(0, ids.length - maxEntries);
        for (const v of victims) await collection.delete(v.id);
      }
      return entry;
    },
    async get(id) {
      return collection.get(id);
    },
    async delete(id) {
      await collection.delete(id);
      return true;
    },
    async list(filter = {}) {
      const all = await collection.list({ filter: (rec) => matchesFilter(rec, filter) });
      return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    async clear(filter = null) {
      if (!filter) { const ids = await collection.ids(); await collection.clear(); return ids.length; }
      const victims = await this.list(filter);
      for (const v of victims) await collection.delete(v.id);
      return victims.length;
    },
    async count(filter = {}) {
      return (await this.list(filter)).length;
    },
  };
}

module.exports = { REQUIRED_METHODS, assertProvider, createInMemoryProvider, createStoreProvider, matchesFilter };
