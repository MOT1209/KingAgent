// Barrel for the memory subsystem.
//
// `createMemory` (the Phase 2 in-process session/task key-value store) is
// re-exported unchanged: the runtime still uses it for within-run scratch, and
// nothing about Phase 3 replaces it. The MemoryManager is the durable, scoped,
// searchable half that sits alongside it.

const { createMemory } = require('./memory');
const { MemoryManager, MemoryAccessError } = require('./manager');
const provider = require('./provider');
const scopes = require('./scopes');
const importance = require('./importance');
const entry = require('./entry');
const relevance = require('./relevance');
const summarizer = require('./summarizer');

module.exports = {
  createMemory,
  MemoryManager,
  MemoryAccessError,
  createInMemoryProvider: provider.createInMemoryProvider,
  createStoreProvider: provider.createStoreProvider,
  assertProvider: provider.assertProvider,
  SCOPES: scopes.SCOPES,
  ALL_SCOPES: scopes.ALL_SCOPES,
  canAccess: scopes.canAccess,
  readableKeys: scopes.readableKeys,
  IMPORTANCE: importance.IMPORTANCE,
  scoreImportance: importance.scoreImportance,
  MEMORY_TYPES: entry.TYPES,
  validateMemoryEntry: entry.validateMemoryEntry,
  rank: relevance.rank,
  summarizeEntries: summarizer.summarizeEntries,
};
