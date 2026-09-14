// MemoryManager: the only way in and out of memory.
//
// Everything that makes memory safe rather than just convenient lives here:
//
//   * **Scope isolation.** Every read and write is checked against the policy
//     the workspace handed down (memory/scopes.js). A denial is an error, not an
//     empty result — silence looks like "nothing remembered" and hides a bug.
//   * **No automatic persistence.** An observation becomes a *candidate*, is
//     scored, and is only written if a caller commits it. This is the difference
//     between an agent with memory and an agent that hoards.
//   * **Bounded retrieval.** `search` ranks and caps; nothing hands back the
//     whole store.
//
// The Phase 2 `createMemory()` session/task key-value store is untouched and
// still wired into the runtime; this sits alongside it as the durable, scoped,
// searchable half.

const { TYPES: EVENTS } = require('../events/event-bus');
const { validateMemoryEntry, updateMemoryEntry, TYPES } = require('./entry');
const { SCOPES, canAccess, ownerFor, readableKeys } = require('./scopes');
const { IMPORTANCE, atLeast, isExpired, scoreImportance, PERSIST_THRESHOLD } = require('./importance');
const { rank } = require('./relevance');
const { summarizeEntries, summaryEntry } = require('./summarizer');
const { assertProvider, createInMemoryProvider } = require('./provider');

class MemoryAccessError extends Error {
  constructor(message, { scope, scopeId } = {}) {
    super(message);
    this.name = 'MemoryAccessError';
    this.code = 'MEMORY_DENIED';
    this.scope = scope;
    this.scopeId = scopeId;
  }
}

class MemoryManager {
  constructor({ provider = null, bus = null, logger = null, searchLimit = 10, persistThreshold = PERSIST_THRESHOLD } = {}) {
    this._provider = assertProvider(provider || createInMemoryProvider());
    this._bus = bus;
    this._logger = logger;
    this._searchLimit = searchLimit;
    this._persistThreshold = persistThreshold;
  }

  get provider() { return this._provider; }

  _emit(type, refs, payload) {
    if (this._bus) this._bus.emit(type, refs || {}, payload);
  }

  _assert(policy, scope, scopeId) {
    const verdict = canAccess(policy, scope, scopeId);
    if (!verdict.ok) throw new MemoryAccessError(`memory access denied: ${verdict.reason}`, { scope, scopeId });
    return true;
  }

  // --- write ---------------------------------------------------------------

  // `policy` is required. There is no "trusted caller" shortcut: the platform
  // constructs the policy from the workspace, and a caller without one has not
  // decided what it is allowed to touch.
  async store(def, { policy, refs = {} } = {}) {
    const scope = def.scope || SCOPES.TASK;
    const scopeId = def.scopeId !== undefined && def.scopeId !== null ? def.scopeId : ownerFor(policy, scope);
    this._assert(policy, scope, scopeId);

    const { ok, entry, errors } = validateMemoryEntry({ ...def, scope, scopeId });
    if (!ok) throw new Error(`invalid memory entry: ${errors.join('; ')}`);
    await this._provider.put(entry);
    this._emit(EVENTS.MEMORY_WRITE, refs, { id: entry.id, scope: entry.scope, importance: entry.importance, type: entry.type });
    return entry;
  }

  async update(id, patch, { policy, refs = {} } = {}) {
    const existing = await this._provider.get(id);
    if (!existing) return null;
    this._assert(policy, existing.scope, existing.scopeId);
    if (patch.scope || patch.scopeId !== undefined) {
      this._assert(policy, patch.scope || existing.scope, patch.scopeId !== undefined ? patch.scopeId : existing.scopeId);
    }
    const { ok, entry, errors } = updateMemoryEntry(existing, patch);
    if (!ok) throw new Error(`invalid memory update: ${errors.join('; ')}`);
    await this._provider.put(entry);
    this._emit(EVENTS.MEMORY_UPDATED, refs, { id: entry.id, scope: entry.scope });
    return entry;
  }

  async delete(id, { policy, refs = {} } = {}) {
    const existing = await this._provider.get(id);
    if (!existing) return false;
    this._assert(policy, existing.scope, existing.scopeId);
    await this._provider.delete(id);
    this._emit(EVENTS.MEMORY_UPDATED, refs, { id, deleted: true });
    return true;
  }

  // Clearing is scoped like everything else: there is no "clear all".
  async clear({ scope, scopeId = undefined }, { policy, refs = {} } = {}) {
    const owner = scopeId === undefined ? ownerFor(policy, scope) : scopeId;
    this._assert(policy, scope, owner);
    const removed = await this._provider.clear({ scope, scopeId: owner });
    this._emit(EVENTS.MEMORY_UPDATED, refs, { scope, scopeId: owner, cleared: removed });
    return removed;
  }

  // --- read ----------------------------------------------------------------

  async retrieve(id, { policy, refs = {} } = {}) {
    const entry = await this._provider.get(id);
    if (!entry) return null;
    this._assert(policy, entry.scope, entry.scopeId);
    if (isExpired(entry)) { await this._provider.delete(id); return null; }
    this._emit(EVENTS.MEMORY_READ, refs, { id, scope: entry.scope });
    return entry;
  }

  // The retrieval a task actually uses: ranked, capped, and confined to the
  // (scope, owner) pairs the policy grants — a query can never walk outside it.
  async search({ query = '', tags = [], scopes = null, limit = null, minScore = 0.01, type = null } = {}, { policy, refs = {} } = {}) {
    const keys = readableKeys(policy);
    if (keys.length === 0) return [];
    const wanted = Array.isArray(scopes) && scopes.length
      ? keys.filter((k) => scopes.includes(k.split(':')[0]))
      : keys;
    if (wanted.length === 0) return [];

    const raw = await this._provider.list({ keys: wanted, ...(type ? { type } : {}) });
    const now = Date.now();
    const live = [];
    for (const entry of raw) {
      if (isExpired(entry, now)) { await this._provider.delete(entry.id); continue; }
      live.push(entry);
    }
    const ranked = rank(live, {
      query,
      tags,
      limit: limit || this._searchLimit,
      minScore,
      now,
      preferredScopes: scopes || [],
    });
    this._emit(EVENTS.MEMORY_SEARCH, refs, { query: String(query).slice(0, 120), scopes: wanted.length, hits: ranked.length });
    return ranked.map((r) => ({ ...r.entry, score: Number(r.score.toFixed(4)) }));
  }

  // Everything readable in one scope, newest first. Used by summarization and
  // by the UI's "what does this task remember?" view — not by context building,
  // which must go through search().
  async list({ scope, scopeId = undefined, limit = 50 }, { policy } = {}) {
    const owner = scopeId === undefined ? ownerFor(policy, scope) : scopeId;
    this._assert(policy, scope, owner);
    const all = await this._provider.list({ scope, scopeId: owner });
    return all.slice(0, limit);
  }

  // --- candidates ----------------------------------------------------------

  // An observation is scored, not stored. `shouldPersist` is advice for the
  // caller; `commitCandidate` is the only thing that writes.
  candidate(observation = {}, { policy, scope = SCOPES.TASK } = {}) {
    const importance = scoreImportance(observation);
    const scopeId = observation.scopeId !== undefined && observation.scopeId !== null
      ? observation.scopeId
      : ownerFor(policy, scope);
    return {
      def: {
        type: observation.type || TYPES.OBSERVATION,
        content: observation.content,
        source: observation.source || 'observation',
        scope,
        scopeId,
        importance,
        tags: observation.tags || [],
        metadata: observation.metadata || {},
      },
      importance,
      shouldPersist: atLeast(importance, this._persistThreshold),
      reason: atLeast(importance, this._persistThreshold)
        ? `importance ${importance} clears the ${this._persistThreshold} bar`
        : `importance ${importance} is below the ${this._persistThreshold} bar`,
    };
  }

  // Validates before persisting: a candidate below the bar is refused unless the
  // caller explicitly forces it, which keeps "remember this" an act rather than
  // a side effect.
  async commitCandidate(candidate, { policy, force = false, refs = {} } = {}) {
    if (!candidate || !candidate.def) throw new Error('commitCandidate requires a candidate');
    if (!candidate.shouldPersist && !force) return null;
    return this.store(candidate.def, { policy, refs });
  }

  // --- summarization -------------------------------------------------------

  // Summarizing never deletes: the summary is a new entry pointing back at the
  // raw entries, which stay exactly where they were.
  async summarize({ scope, scopeId = undefined, provider = null, maxChars, persist = false, tags = [] }, { policy, refs = {} } = {}) {
    const owner = scopeId === undefined ? ownerFor(policy, scope) : scopeId;
    this._assert(policy, scope, owner);
    const entries = await this._provider.list({ scope, scopeId: owner });
    const summary = await summarizeEntries(entries, { provider, maxChars });
    if (!persist || entries.length === 0) return summary;
    const stored = await this.store(summaryEntry(summary, { scope, scopeId: owner, tags }), { policy, refs });
    return { ...summary, entryId: stored.id };
  }

  async count(filter = {}) {
    return this._provider.count(filter);
  }
}

module.exports = { MemoryManager, MemoryAccessError, IMPORTANCE, SCOPES };
