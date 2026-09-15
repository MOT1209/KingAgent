// Persistence abstraction.
//
// Phase 2 deliberately does not pick a heavy database. Everything the platform
// remembers — agent definitions, workflow definitions, task metadata, execution
// history — goes through this interface so a future SQLite/Postgres/cloud
// implementation can swap in without touching a caller.

// In-memory store: the default for tests and for sessions that never persist.
function createMemoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    async get(key) {
      if (data.has(key)) return structuredClone(data.get(key));
      return null;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async delete(key) {
      return data.delete(key);
    },
    async keys(prefix = '') {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
    async clear() {
      data.clear();
    },
  };
}

// Single-file JSON store with atomic replace (write temp file, rename over the
// real one) so a crash mid-write cannot corrupt the previous state. All keys on
// one path means one file per concern (agents.json, workflows.json, tasks.json).
//
// The factory is deliberately synchronous. It used to be `async`, which meant
// `createPlatform({ storeDir })` handed every subsystem a *Promise* instead of a
// store — `store.set` was undefined and the whole persisted path threw on the
// first write. Directory creation is therefore lazy: it happens on the first
// persist, once, which is also the first moment it is actually needed.
// `await createJsonStore(...)` still works for existing callers, because
// awaiting a non-promise is a no-op.
function createJsonStore({ dir, name, fs }) {
  const { mkdir, readFile, writeFile, rename } = fs;
  const file = `${dir}/${name}`;
  const tmp = `${file}.tmp`;

  let cache = null;
  let dirReady = null;

  async function ensureDir() {
    if (!dirReady) dirReady = mkdir(dir, { recursive: true });
    return dirReady;
  }

  async function load() {
    if (cache !== null) return cache;
    try {
      cache = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      cache = {};
    }
    return cache;
  }

  async function persist() {
    await ensureDir();
    await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await rename(tmp, file);
  }

  return {
    async get(key) {
      const all = await load();
      return all[key] === undefined ? null : structuredClone(all[key]);
    },
    async set(key, value) {
      const all = await load();
      all[key] = structuredClone(value);
      await persist();
    },
    async delete(key) {
      const all = await load();
      delete all[key];
      await persist();
    },
    async keys(prefix = '') {
      const all = await load();
      return Object.keys(all).filter((k) => k.startsWith(prefix));
    },
    async clear() {
      cache = {};
      await persist();
    },
  };
}

module.exports = { createMemoryStore, createJsonStore };