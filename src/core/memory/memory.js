// Memory: in-process session + task-scoped stores.
//
// This is the *interface* foundation: actual persistence (to disk/cloud) is a
// later swap-in. For now every task shares one in-memory map so a task can
// reference prior tool outputs, reasons and plans without rescanning.

function createMemory() {
  const session = new Map();
  const tasks = new Map(); // taskId -> Map

  function sessionSet(key, value) { session.set(key, structuredClone(value)); }
  function sessionGet(key) { return session.has(key) ? structuredClone(session.get(key)) : null; }
  function sessionSearch(pattern) {
    const re = new RegExp(pattern, 'i');
    const hits = [];
    for (const [k, v] of session) { if (re.test(k)) hits.push({ key: k, value: structuredClone(v) }); }
    return hits;
  }
  function sessionClear() { session.clear(); }

  function taskScope(taskId) {
    if (!tasks.has(taskId)) tasks.set(taskId, new Map());
    const map = tasks.get(taskId);
    return {
      set(key, value) { map.set(key, structuredClone(value)); },
      get(key) { return map.has(key) ? structuredClone(map.get(key)) : null; },
      delete(key) { map.delete(key); },
      keys() { return [...map.keys()]; },
      all() {
        const out = {};
        for (const [k, v] of map) out[k] = structuredClone(v);
        return out;
      },
    };
  }

  return { session: { set: sessionSet, get: sessionGet, search: sessionSearch, clear: sessionClear }, tasks: taskScope };
}

module.exports = { createMemory };