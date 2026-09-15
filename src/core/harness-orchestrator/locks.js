// File locks: the safety rail that makes parallel agents safe.
//
// §30 allows parallel sub-agents but forbids unsafe simultaneous writes to the
// same file, and that is a genuinely hard property to get right with processes
// instead of threads — two agents are two OS processes that each believe they
// may write. So the guard is cooperative and *advisory by design*, stated here
// rather than discovered later: it protects agents that go through the
// coordinator, which is every agent this platform starts.
//
// The model is the familiar one:
//
//   read  × read  → allowed (two readers cannot corrupt each other)
//   read  × write → conflict
//   write × write → conflict
//
// The table is `key -> Map<ownerId, holder>` rather than `key -> holder`,
// because several readers legitimately hold the same path at once and a single
// slot would silently evict the first one. Paths are normalized before
// comparison (separators folded, case folded on Windows) because `/ws/a.ts` and
// `\ws\A.ts` are the same file and a lock manager that misses that is
// decorative. `withLocks` is the API to actually use: it releases in a
// `finally`, so a throwing agent cannot leave a lock behind and deadlock the
// next one.

const path = require('node:path');

function normalizeKey(p) {
  const resolved = path.resolve(String(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function modeRank(mode) {
  return mode === 'write' ? 2 : 1;
}

function createFileLockManager({ logger = null, bus = null } = {}) {
  const locks = new Map(); // key -> Map<ownerId, holder>
  const byOwner = new Map(); // ownerId -> Set<key>

  function holdersFor(key) {
    const map = locks.get(key);
    return map ? [...map.values()] : [];
  }

  // Would this request conflict with what is already held? One entry per holder
  // that stands in the way, so a caller can name every agent it is waiting on.
  function conflictsFor(paths, mode, ownerId) {
    const conflicts = [];
    for (const p of paths) {
      const key = normalizeKey(p);
      for (const holder of holdersFor(key)) {
        if (holder.ownerId === ownerId) continue; // re-entrant for the same owner
        if (mode === 'read' && holder.mode === 'read') continue;
        conflicts.push({ path: p, key, ownerId: holder.ownerId, taskId: holder.taskId, mode: holder.mode });
      }
    }
    return conflicts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.ownerId < b.ownerId ? -1 : 1));
  }

  function acquire({ ownerId, taskId = null, paths = [], mode = 'write' } = {}) {
    if (!ownerId) throw new Error('file lock acquisition requires an ownerId');
    if (mode !== 'read' && mode !== 'write') throw new Error(`unknown lock mode: ${mode}`);
    const wanted = [...new Set((paths || []).filter(Boolean).map(String))];
    const conflicts = conflictsFor(wanted, mode, ownerId);
    if (conflicts.length > 0) {
      if (logger) logger.info(`lock refused for ${ownerId}`, { conflicts: conflicts.map((c) => c.path) });
      if (bus) bus.emit('delegation.lock.refused', { taskId, agentId: ownerId }, { conflicts: conflicts.length, paths: conflicts.map((c) => c.path).slice(0, 8) });
      return { ok: false, granted: [], conflicts };
    }
    const granted = [];
    for (const p of wanted) {
      const key = normalizeKey(p);
      if (!locks.has(key)) locks.set(key, new Map());
      const holders = locks.get(key);
      const existing = holders.get(ownerId);
      if (existing) {
        // Widening an existing read lock to a write is allowed: re-entrancy,
        // not escalation (the owner already held the path).
        existing.mode = mode === 'write' ? 'write' : existing.mode;
        granted.push(p);
        continue;
      }
      holders.set(ownerId, { path: p, ownerId, taskId, mode, at: Date.now() });
      if (!byOwner.has(ownerId)) byOwner.set(ownerId, new Set());
      byOwner.get(ownerId).add(key);
      granted.push(p);
    }
    return { ok: true, granted, conflicts: [] };
  }

  function release(ownerId, paths = null) {
    const owned = byOwner.get(ownerId);
    if (!owned) return [];
    const released = [];
    for (const key of [...owned]) {
      const holders = locks.get(key);
      if (!holders || !holders.has(ownerId)) {
        owned.delete(key);
        continue;
      }
      if (paths && !paths.some((p) => normalizeKey(p) === key)) continue;
      const holder = holders.get(ownerId);
      holders.delete(ownerId);
      owned.delete(key);
      released.push(holder.path);
      if (holders.size === 0) locks.delete(key);
    }
    if (owned.size === 0) byOwner.delete(ownerId);
    return released;
  }

  // Run `fn` under the locks, always releasing. Returns
  // `{ ok: false, conflicts }` without calling `fn` when the paths are taken —
  // the caller decides whether to wait, queue or skip, because only the caller
  // knows whether the work is optional.
  async function withLocks({ ownerId, taskId = null, paths = [], mode = 'write' } = {}, fn) {
    const acquired = acquire({ ownerId, taskId, paths, mode });
    if (!acquired.ok) return { ok: false, conflicts: acquired.conflicts, result: null };
    try {
      const result = await fn();
      return { ok: true, conflicts: [], result };
    } finally {
      release(ownerId);
    }
  }

  function holders() {
    return [...locks.values()]
      .flatMap((map) => [...map.values()])
      .map((l) => ({ ...l }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.ownerId < b.ownerId ? -1 : 1));
  }

  function ownerLocks(ownerId) {
    const owned = byOwner.get(ownerId);
    return owned ? [...owned] : [];
  }

  function keyCount() {
    return locks.size;
  }

  function clear() {
    locks.clear();
    byOwner.clear();
  }

  return {
    acquire,
    release,
    withLocks,
    conflictsFor,
    holders,
    holdersFor,
    ownerLocks,
    keyCount,
    clear,
    // Total holder entries: two readers on one file are two locks, one path.
    size: () => [...locks.values()].reduce((n, map) => n + map.size, 0),
    normalizeKey,
    modeRank,
  };
}

module.exports = { createFileLockManager, normalizeKey, modeRank };
