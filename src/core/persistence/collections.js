// Typed collections over the Phase 2 key-value store.
//
// Phase 3 adds seven things worth persisting — memory, tasks, traces,
// workspaces, agent state, projects, artifacts — plus workflow instances since
// Phase 5 (§12: a restart must not lose workflow history) — and the rule from Phase 2
// still holds: business logic must not know whether the bytes land in a JSON
// file, SQLite or a remote service. So none of those subsystems takes a store
// directly. They take a *collection*: a namespaced put/get/delete/list built on
// the same `{ get, set, delete, keys, clear }` contract persistence/store.js
// already defines, which means swapping the backing store is still a one-line
// change in createPlatform.
//
// Namespacing is a key prefix rather than separate stores so a single JSON file
// keeps working, and `list()` over a prefix stays a cheap key scan.

const NAMESPACES = Object.freeze({
  MEMORY: 'memory',
  TASK: 'task',
  TRACE: 'trace',
  WORKSPACE: 'workspace',
  AGENT_STATE: 'agentstate',
  PROJECT: 'project',
  ARTIFACT: 'artifact',
  WORKFLOW: 'workflow',
  // Phase 6. Skills are keyed `<id>@<version>` so two versions of one skill can
  // be installed side by side while a dependency range is resolved.
  SKILL: 'skill',
  MCP_SERVER: 'mcpserver',
});

function assertStore(store) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function'
    || typeof store.keys !== 'function' || typeof store.delete !== 'function') {
    throw new Error('collection requires a store with get/set/delete/keys');
  }
  return store;
}

// `createCollection(store, 'trace')` owns every key `trace:*`. Records are
// plain data; the caller decides the shape. `index` lets a collection answer
// "everything for this workspace" without reading every record: the id carries
// the owner, so listing is prefix arithmetic, not a table scan.
function createCollection(store, namespace) {
  assertStore(store);
  if (typeof namespace !== 'string' || !namespace) throw new Error('collection requires a namespace');
  const prefix = `${namespace}:`;

  return {
    namespace,
    key(id) {
      return `${prefix}${id}`;
    },
    async put(id, record) {
      if (!id) throw new Error(`${namespace}.put requires an id`);
      await store.set(`${prefix}${id}`, record);
      return record;
    },
    async get(id) {
      if (!id) return null;
      return store.get(`${prefix}${id}`);
    },
    async has(id) {
      return (await store.get(`${prefix}${id}`)) !== null;
    },
    async delete(id) {
      await store.delete(`${prefix}${id}`);
      return true;
    },
    async ids() {
      const keys = await store.keys(prefix);
      return keys.map((k) => k.slice(prefix.length));
    },
    // Reads every record in the namespace. `filter` runs in-process because the
    // store contract has no query language — that is the price of keeping the
    // backend swappable, and these collections are bounded by design.
    async list({ filter = null, limit = 0 } = {}) {
      const out = [];
      for (const id of await this.ids()) {
        const rec = await this.get(id);
        if (rec === null || rec === undefined) continue;
        if (filter && !filter(rec, id)) continue;
        out.push(rec);
        if (limit && out.length >= limit) break;
      }
      return out;
    },
    async clear() {
      for (const key of await store.keys(prefix)) await store.delete(key);
    },
  };
}

// One call in createPlatform gets every Phase 3 collection off one store.
function createCollections(store) {
  assertStore(store);
  return {
    memory: createCollection(store, NAMESPACES.MEMORY),
    tasks: createCollection(store, NAMESPACES.TASK),
    traces: createCollection(store, NAMESPACES.TRACE),
    workspaces: createCollection(store, NAMESPACES.WORKSPACE),
    agentState: createCollection(store, NAMESPACES.AGENT_STATE),
    projects: createCollection(store, NAMESPACES.PROJECT),
    artifacts: createCollection(store, NAMESPACES.ARTIFACT),
    workflows: createCollection(store, NAMESPACES.WORKFLOW),
    skills: createCollection(store, NAMESPACES.SKILL),
    mcpServers: createCollection(store, NAMESPACES.MCP_SERVER),
  };
}

module.exports = { NAMESPACES, createCollection, createCollections, assertStore };
