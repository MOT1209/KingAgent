// Context is where "do not inject the repository" is either enforced or not.
// These tests check the enforcement: layers resolve narrow-first, selection
// drops the irrelevant, the budget trims and accounts rather than silently
// losing things, and a packet built twice from the same world is identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ContextManager, createLayerStack, LAYERS, select, classify, RELEVANCE,
  createBudget, trimText, createContextPacket, serializePacket, deserializePacket,
  packetDigest, summarizePacket, estimateTokens, PACKET_VERSION,
} = require('../src/core/context/index.js');
const { WorkspaceManager } = require('../src/core/workspace/index.js');
const { MemoryManager } = require('../src/core/memory/index.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

// --- layers ------------------------------------------------------------------

test('layers: the narrowest layer wins and says where the value came from', () => {
  const stack = createLayerStack();
  stack.set(LAYERS.GLOBAL, 'model', 'global-model');
  stack.set(LAYERS.PROJECT, 'model', 'project-model');
  stack.set(LAYERS.STEP, 'model', 'step-model');
  assert.equal(stack.get('model'), 'step-model');
  assert.equal(stack.origin('model'), LAYERS.STEP);

  stack.clear(LAYERS.STEP);
  assert.equal(stack.get('model'), 'project-model');
  assert.equal(stack.origin('model'), LAYERS.PROJECT);
});

test('layers: merge flattens broad-first so narrow overwrites', () => {
  const stack = createLayerStack({
    global: { a: 1, b: 1 },
    task: { b: 2, c: 2 },
  });
  assert.deepEqual(stack.merge(), { a: 1, b: 2, c: 2 });
  assert.deepEqual(stack.keys(), ['a', 'b', 'c']);
});

test('layers: an unknown layer is refused rather than silently created', () => {
  const stack = createLayerStack();
  assert.throws(() => stack.set('nonsense', 'k', 'v'), /unknown context layer/);
});

// --- selection ---------------------------------------------------------------

test('selector: the objective, step and agent instructions are always required', () => {
  for (const kind of ['task', 'step', 'agent']) {
    assert.equal(classify({ kind, id: 'x', content: 'unrelated text' }, { task: 'something else' }), RELEVANCE.REQUIRED);
  }
});

test('selector: irrelevant items are dropped before the budget ever sees them', () => {
  const { selected, dropped } = select([
    { kind: 'task', id: 'obj', content: 'fix the failing parser test' },
    { kind: 'file', id: 'parser.js', content: 'function parser() {}' },
    { kind: 'tool-result', id: 'empty', content: '' },
    { kind: 'memory', id: 'm1', content: 'unrelated thing from months ago', at: 0 },
  ], { task: 'fix the failing parser test' });

  assert.ok(selected.some((i) => i.id === 'parser.js'), 'a file matching the objective is relevant');
  assert.ok(dropped.some((i) => i.id === 'empty'), 'a blank, non-matching item is irrelevant');
  assert.ok(!selected.some((i) => i.id === 'empty'));
});

test('selector: a historical item is optional, kept only when the budget allows it', () => {
  const { selected, dropped } = select([
    { kind: 'task', id: 'obj', content: 'fix the parser' },
    { kind: 'history', id: 'old', content: '' },
  ], { task: 'fix the parser' });
  assert.ok(selected.some((i) => i.id === 'old'), 'history is optional, not dropped outright');
  assert.equal(selected.find((i) => i.id === 'old').relevance, RELEVANCE.OPTIONAL);
  assert.deepEqual(dropped, []);
});

test('selector: ordering follows the documented priority', () => {
  const { selected } = select([
    { kind: 'history', id: 'h', content: 'old news' },
    { kind: 'memory', id: 'm', content: 'parser convention', score: 0.9 },
    { kind: 'file', id: 'f', content: 'parser source', score: 0.9 },
    { kind: 'task', id: 't', content: 'fix the parser' },
    { kind: 'step', id: 's', content: 'run tests' },
  ], { task: 'fix the parser' });

  const kinds = selected.map((i) => i.kind);
  assert.equal(kinds[0], 'task', 'the objective comes first');
  assert.ok(kinds.indexOf('step') < kinds.indexOf('file'), 'the current step outranks files');
  assert.ok(kinds.indexOf('file') < kinds.indexOf('memory'), 'files outrank memories');
  assert.equal(kinds[kinds.length - 1], 'history', 'history is last');
});

test('selector: the same inputs always produce the same order', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ kind: 'file', id: `f${i}`, content: `parser ${i}` }));
  const a = select(items, { task: 'parser' }).selected.map((i) => i.id);
  const b = select(items, { task: 'parser' }).selected.map((i) => i.id);
  assert.deepEqual(a, b);
});

// --- budget ------------------------------------------------------------------

test('budget: trimming keeps the head and the tail of a long output', () => {
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const { text, trimmed, originalChars } = trimText(lines, 800);
  assert.equal(trimmed, true);
  assert.ok(text.startsWith('line 0'), 'the command that ran is at the top');
  assert.ok(text.includes('line 499'), 'the failure that ended it is at the bottom');
  assert.match(text, /lines omitted/);
  assert.equal(originalChars, lines.length);
});

test('budget: identical content is carried once, and the drop is reported', () => {
  const budget = createBudget({ maxChars: 10_000, reserveChars: 0 });
  const fit = budget.fit([
    { kind: 'file', id: 'a.js', content: 'same bytes', relevance: 'relevant' },
    { kind: 'file', id: 'copy.js', content: 'same bytes', relevance: 'relevant' },
  ]);
  assert.equal(fit.items.length, 1);
  assert.equal(fit.dropped[0].reason, 'duplicate');
  assert.equal(fit.dropped[0].duplicateOf, 'a.js');
});

test('budget: a required item survives the ceiling; optional ones are dropped and counted', () => {
  const budget = createBudget({ maxChars: 1000, reserveChars: 0, maxItemChars: 400 });
  const fit = budget.fit([
    { kind: 'task', id: 'objective', content: 'x'.repeat(600), relevance: 'required' },
    { kind: 'file', id: 'big1', content: 'y'.repeat(900), relevance: 'relevant' },
    { kind: 'file', id: 'big2', content: 'z'.repeat(900), relevance: 'relevant' },
    { kind: 'file', id: 'big3', content: 'w'.repeat(900), relevance: 'relevant' },
  ]);
  assert.ok(fit.items.some((i) => i.id === 'objective'), 'the objective is never dropped');
  assert.ok(fit.dropped.some((d) => d.reason === 'budget'), 'over-budget items are reported, not silently lost');
  assert.ok(fit.usedChars <= 1000 + 600, 'the ceiling holds apart from required overflow');
});

test('budget: the item limit is enforced', () => {
  const budget = createBudget({ maxChars: 100_000, maxItems: 3 });
  const fit = budget.fit(Array.from({ length: 10 }, (_, i) => ({ kind: 'file', id: `f${i}`, content: `body ${i}` })));
  assert.equal(fit.items.length, 3);
  assert.equal(fit.dropped.filter((d) => d.reason === 'item-limit').length, 7);
});

test('budget: token estimate is chars/4 in exactly one place', () => {
  assert.equal(estimateTokens('a'.repeat(400)), 100);
});

// --- packet ------------------------------------------------------------------

test('packet: the digest ignores id and timestamp so identical worlds compare equal', () => {
  const base = { objective: 'do the thing', files: [{ path: 'a.js' }], items: [{ kind: 'task', content: 'do the thing' }] };
  const a = createContextPacket(base);
  const b = createContextPacket(base);
  assert.notEqual(a.id, b.id);
  assert.equal(a.digest, b.digest, 'a packet is deterministic');

  const c = createContextPacket({ ...base, objective: 'do a different thing' });
  assert.notEqual(a.digest, c.digest);
});

test('packet: key order does not change the digest', () => {
  const a = createContextPacket({ objective: 'x', workspace: { workspaceId: 'w', root: '/r' } });
  const b = createContextPacket({ objective: 'x', workspace: { root: '/r', workspaceId: 'w' } });
  assert.equal(a.digest, b.digest);
});

test('packet: serialize / deserialize round-trips and refuses a foreign version', () => {
  const packet = createContextPacket({ objective: 'round trip', constraints: ['be careful'] });
  const back = deserializePacket(serializePacket(packet));
  assert.equal(back.digest, packet.digest);
  assert.equal(packetDigest(back), packet.digest);
  assert.throws(() => deserializePacket(JSON.stringify({ ...packet, version: 99 })), /unsupported context packet version/);
  assert.equal(PACKET_VERSION, 1);
});

test('packet: a packet is frozen', () => {
  const packet = createContextPacket({ objective: 'immutable' });
  assert.throws(() => { packet.objective = 'changed'; }, TypeError);
});

// --- manager -----------------------------------------------------------------

function fixture({ bus = new EventBus() } = {}) {
  const workspaces = new WorkspaceManager({ bus });
  const memory = new MemoryManager({ bus });
  const context = new ContextManager({ bus, memory });
  const workspace = workspaces.create({ root: process.cwd(), identity: { agentId: 'coder' } });
  return { bus, workspaces, memory, context, workspace };
}

test('manager: build produces a packet and attaches it to the workspace', async () => {
  const { context, workspace } = fixture();
  const packet = await context.build({
    request: 'analyze the parser',
    workspace,
    agent: { id: 'coder', name: 'Coder', capabilities: ['code'], systemPrompt: 'work carefully' },
    files: [{ path: 'src/parser.js', content: 'export function parse() {}' }],
  });
  assert.equal(packet.objective, 'analyze the parser');
  assert.equal(packet.identity.workspaceId, workspace.workspaceId);
  assert.ok(packet.items.some((i) => i.kind === 'file'));
  assert.ok(workspace.contextRefs.includes(packet.id));
  assert.equal(context.get(packet.id).digest, packet.digest);
});

test('manager: memory reaches context through a ranked search, never a dump', async () => {
  const { context, memory, workspace } = fixture();
  const policy = workspace.memoryPolicy();
  await memory.store({ content: 'the parser uses a recursive descent strategy', scope: 'task', type: 'fact' }, { policy });
  for (let i = 0; i < 30; i += 1) {
    await memory.store({ content: `unrelated note number ${i} about deployment`, scope: 'task' }, { policy });
  }

  const packet = await context.build({ request: 'how does the parser work', workspace, memoryLimit: 5 });
  assert.ok(packet.memories.length <= 5, 'the search is capped');
  assert.ok(packet.memories.length >= 1);
  assert.ok(packet.items.some((i) => i.kind === 'memory' && /recursive descent/.test(i.content)),
    'the relevant memory is the one that came back');
});

test('manager: a memory failure degrades the packet instead of failing the task', async () => {
  const bus = new EventBus();
  const workspaces = new WorkspaceManager({ bus });
  const broken = { search: async () => { throw new Error('provider exploded'); } };
  const context = new ContextManager({ bus, memory: broken, logger: { warn() {} } });
  const workspace = workspaces.create({ root: process.cwd(), identity: { agentId: 'coder' } });

  const packet = await context.build({ request: 'carry on regardless', workspace });
  assert.deepEqual(packet.memories, []);
  assert.equal(packet.objective, 'carry on regardless');
});

test('manager: tools are filtered by the workspace policy', async () => {
  const bus = new EventBus();
  const workspaces = new WorkspaceManager({ bus });
  const tools = {
    list: () => [{ id: 'fs:read' }, { id: 'fs:delete' }],
    peek: (id) => ({ id, name: id, description: '', permissions: { level: 'moderate' } }),
  };
  const context = new ContextManager({ bus, toolManager: tools });
  const workspace = workspaces.create({ root: process.cwd(), policy: { tools: ['fs:read'] } });
  const packet = await context.build({ request: 'read something', workspace });
  assert.deepEqual(packet.tools.map((t) => t.id), ['fs:read']);
});

test('manager: building emits a correlated context.created event', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on(TYPES.CONTEXT_CREATED, (ev) => seen.push(ev));
  const { context, workspace } = fixture({ bus });
  const packet = await context.build({ request: 'watch me', workspace });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].workspaceId, workspace.workspaceId);
  assert.equal(seen[0].traceId, workspace.traceId);
  assert.equal(seen[0].payload.id, packet.id);
});

test('manager: update produces a successor rather than mutating the original', async () => {
  const { context, workspace } = fixture();
  const first = await context.build({ request: 'original', workspace });
  const second = context.update(first, { objective: 'revised' });
  assert.notEqual(second.id, first.id);
  assert.equal(first.objective, 'original', 'the packet the earlier step ran against is untouched');
  assert.equal(second.objective, 'revised');
});

test('manager: summarizePacket is small enough for a list view', async () => {
  const { context, workspace } = fixture();
  const packet = await context.build({
    request: 'summarize me',
    workspace,
    files: [{ path: 'a.js', content: 'x'.repeat(5000) }],
  });
  const summary = summarizePacket(packet);
  assert.ok(JSON.stringify(summary).length < 500);
  assert.equal(summary.id, packet.id);
  assert.equal(typeof summary.usedTokens, 'number');
});
