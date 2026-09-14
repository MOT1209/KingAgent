// Memory is the subsystem most likely to leak one task's data into another's,
// or to turn into an agent that hoards. These tests check both directions:
// scope isolation is a hard denial (never a silent empty result), and
// persistence requires clearing an importance bar rather than happening by
// default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MemoryManager, MemoryAccessError, IMPORTANCE, scoreImportance,
  canAccess, readableKeys, validateMemoryEntry, rank, summarizeEntries,
  createInMemoryProvider,
} = require('../src/core/memory/index.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

// --- entry ---------------------------------------------------------------

test('entry: requires content and a known scope', () => {
  assert.equal(validateMemoryEntry({ content: 'x', scope: 'task' }).ok, true);
  assert.equal(validateMemoryEntry({ content: '', scope: 'task' }).ok, false);
  assert.equal(validateMemoryEntry({ content: 'x', scope: 'nonsense' }).ok, false);
});

// --- scopes ----------------------------------------------------------------

test('scopes: canAccess denies rather than returning empty for an ungranted scope', () => {
  const policy = { scopes: ['task'], ids: { task: 't1' } };
  assert.equal(canAccess(policy, 'task', 't1').ok, true);
  assert.equal(canAccess(policy, 'project', 'p1').ok, false);
  assert.equal(canAccess(policy, 'task', 'other-task').ok, false, 'a granted scope still checks the owner id');
});

test('scopes: global is shared by grant alone; every other scope needs a matching owner', () => {
  const policy = { scopes: ['global', 'agent'], ids: { agent: 'coder' } };
  assert.equal(canAccess(policy, 'global', 'anything').ok, true);
  assert.equal(canAccess(policy, 'agent', 'coder').ok, true);
  assert.equal(canAccess(policy, 'agent', 'analyst').ok, false);
});

test('scopes: readableKeys is exactly what a search may touch', () => {
  const policy = { scopes: ['task', 'global', 'project'], ids: { task: 't1' } };
  const keys = readableKeys(policy);
  assert.ok(keys.includes('task:t1'));
  assert.ok(keys.includes('global:*'));
  assert.ok(!keys.some((k) => k.startsWith('project:')), 'project is granted but has no owner id, so it grants nothing');
});

// --- importance --------------------------------------------------------------

test('importance: a high-volume observation scores low or temporary; an instruction scores critical', () => {
  assert.equal(scoreImportance({ content: 'listed 40 files', source: 'fs:list' }), IMPORTANCE.LOW);
  assert.equal(scoreImportance({ content: '3 matches found', source: 'search:grep' }), IMPORTANCE.TEMPORARY);
  assert.equal(scoreImportance({ content: 'never push directly to main', source: 'user' }), IMPORTANCE.CRITICAL);
  assert.equal(scoreImportance({ type: 'decision', content: 'anything' }), IMPORTANCE.HIGH);
});

// --- relevance ---------------------------------------------------------------

test('relevance: rank favors textual overlap and importance over raw recency', () => {
  const now = Date.now();
  const entries = [
    { id: 'a', content: 'the parser uses recursive descent', importance: 'high', scope: 'task', updatedAt: now - 1000 },
    { id: 'b', content: 'unrelated deployment note', importance: 'normal', scope: 'task', updatedAt: now },
  ];
  const [top] = rank(entries, { query: 'how does the parser work', now });
  assert.equal(top.entry.id, 'a');
});

// --- manager: access control --------------------------------------------------

test('manager: store and retrieve are denied outside the granted scope', async () => {
  const mem = new MemoryManager({});
  const policy = { scopes: ['task'], ids: { task: 't1' } };
  await assert.rejects(
    () => mem.store({ content: 'x', scope: 'project' }, { policy }),
    (err) => err instanceof MemoryAccessError && err.code === 'MEMORY_DENIED',
  );
});

test('manager: search never crosses into an ungranted scope', async () => {
  const mem = new MemoryManager({});
  const ownerPolicy = { scopes: ['project'], ids: { project: 'proj-a' } };
  await mem.store({ content: 'project A secret roadmap', scope: 'project' }, { policy: ownerPolicy });

  const otherPolicy = { scopes: ['project'], ids: { project: 'proj-b' } };
  const hits = await mem.search({ query: 'roadmap' }, { policy: otherPolicy });
  assert.deepEqual(hits, [], 'a different project cannot see this memory even with matching scope name');
});

test('manager: update and delete require write access to the entry\'s own scope', async () => {
  const mem = new MemoryManager({});
  const policy = { scopes: ['task'], ids: { task: 't1' } };
  const entry = await mem.store({ content: 'first', scope: 'task' }, { policy });
  const otherPolicy = { scopes: ['task'], ids: { task: 't2' } };
  await assert.rejects(() => mem.update(entry.id, { content: 'hacked' }, { policy: otherPolicy }), MemoryAccessError);
  const updated = await mem.update(entry.id, { content: 'second' }, { policy });
  assert.equal(updated.content, 'second');
  assert.equal(await mem.delete(entry.id, { policy: otherPolicy }).catch((e) => e.code), 'MEMORY_DENIED');
});

// --- manager: candidates / persistence ---------------------------------------

test('manager: an observation is scored, not stored', async () => {
  const mem = new MemoryManager({});
  const policy = { scopes: ['task'], ids: { task: 't1' } };
  const candidate = mem.candidate({ content: 'scanned the directory', source: 'fs:list' }, { policy });
  assert.equal(candidate.shouldPersist, false);
  const stored = await mem.commitCandidate(candidate, { policy });
  assert.equal(stored, null, 'a low-importance candidate is refused without force');
});

test('manager: commitCandidate persists a candidate that clears the bar', async () => {
  const mem = new MemoryManager({});
  const policy = { scopes: ['task'], ids: { task: 't1' } };
  const candidate = mem.candidate({ content: 'we must never delete the migrations table', source: 'user' }, { policy });
  assert.equal(candidate.shouldPersist, true);
  const stored = await mem.commitCandidate(candidate, { policy });
  assert.ok(stored);
  assert.equal(stored.importance, IMPORTANCE.CRITICAL);
});

test('manager: force persists a candidate below the bar', async () => {
  const mem = new MemoryManager({});
  const policy = { scopes: ['task'], ids: { task: 't1' } };
  const candidate = mem.candidate({ content: 'scanned the directory', source: 'fs:list' }, { policy });
  const stored = await mem.commitCandidate(candidate, { policy, force: true });
  assert.ok(stored, 'force is an explicit override, not a default');
});

// --- manager: summarization ---------------------------------------------------

test('manager: summarize never deletes the raw entries', async () => {
  const mem = new MemoryManager({});
  const policy = { scopes: ['project'], ids: { project: 'p1' } };
  await mem.store({ content: 'We decided to use SQLite for local storage.', scope: 'project', type: 'decision' }, { policy });
  await mem.store({ content: 'The build failed on Windows once.', scope: 'project', type: 'observation' }, { policy });

  const before = await mem.count({ scope: 'project' });
  const summary = await mem.summarize({ scope: 'project', persist: true }, { policy });
  const after = await mem.count({ scope: 'project' });

  assert.ok(summary.summary.length > 0);
  assert.ok(summary.entryId, 'the summary itself is a new stored entry');
  assert.equal(after, before + 1, 'raw entries are untouched; one summary entry was added');
});

test('summarizeEntries falls back to a deterministic summary when a provider fails', async () => {
  const entries = [{ id: '1', content: 'we decided to use node:test', importance: 'high', type: 'decision' }];
  const brokenProvider = { generate: async () => { throw new Error('down'); } };
  const summary = await summarizeEntries(entries, { provider: brokenProvider });
  assert.ok(summary.summary.includes('1 entries'));
  assert.deepEqual(summary.sources, ['1']);
});

// --- events --------------------------------------------------------------------

test('manager: every write emits a correlated memory event', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('memory.')) seen.push(ev); });
  const mem = new MemoryManager({ bus });
  const policy = { scopes: ['task'], ids: { task: 't1' } };
  await mem.store({ content: 'hello', scope: 'task' }, { policy, refs: { taskId: 't1', traceId: 'trace-1' } });
  await mem.search({ query: 'hello' }, { policy, refs: { taskId: 't1' } });
  assert.ok(seen.some((e) => e.type === TYPES.MEMORY_WRITE));
  assert.ok(seen.some((e) => e.type === TYPES.MEMORY_SEARCH));
  assert.equal(seen[0].traceId, 'trace-1');
});

// --- provider ------------------------------------------------------------------

test('in-memory provider round-trips and filters', async () => {
  const provider = createInMemoryProvider();
  const { entry } = validateMemoryEntry({ content: 'x', scope: 'task', scopeId: 't1' });
  await provider.put(entry);
  const got = await provider.get(entry.id);
  assert.equal(got.content, 'x');
  const list = await provider.list({ scope: 'task', scopeId: 't1' });
  assert.equal(list.length, 1);
  assert.equal(await provider.count({ scope: 'task', scopeId: 't1' }), 1);
});
