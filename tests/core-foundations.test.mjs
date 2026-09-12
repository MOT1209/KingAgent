// Phase 2 core: foundations (events, logger, persistence, memory, context).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeTempDir } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { EventBus, makeEvent, TYPES } = require('../src/core/events/event-bus.js');
const { createLogger, redacted } = require('../src/core/logging/logger.js');
const { createMemoryStore, createJsonStore } = require('../src/core/persistence/store.js');
const { createMemory } = require('../src/core/memory/memory.js');
const { buildTaskContext, summarizeContext } = require('../src/core/context/context.js');

test('event-bus: emits and delivers frozen events, star subscribers see everything', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on(TYPES.TASK_QUEUED, (ev) => seen.push(ev));
  bus.on('*', (ev) => seen.push(ev));
  const ev = bus.emit(TYPES.TASK_QUEUED, { taskId: 'task-1', agentId: 'coder' }, { mode: 'auto' });
  assert.equal(bus.listenerCount(TYPES.TASK_QUEUED), 1);
  assert.equal(Object.isFrozen(ev), true);
  assert.equal(ev.type, 'task.queued');
  assert.equal(ev.taskId, 'task-1');
  assert.equal(seen.length, 2);
});

test('event-bus: unsubscribe is idempotent and a throwing handler does not kill others', () => {
  const bus = new EventBus();
  const order = [];
  const off = bus.on(TYPES.TASK_CREATED, () => { throw new Error('boom'); });
  bus.on(TYPES.TASK_CREATED, () => order.push('second'));
  bus.emit(TYPES.TASK_CREATED, {}, null);
  off();
  off();
  assert.deepEqual(order, ['second']);
});

test('event-bus: makeEvent fills refs and payload', () => {
  const ev = makeEvent('test.type', { taskId: 't', toolId: 'fs:read' }, { x: 1 });
  assert.equal(ev.type, 'test.type');
  assert.equal(ev.toolId, 'fs:read');
  assert.deepEqual(ev.payload, { x: 1 });
  assert.ok(ev.id.startsWith('evt-'));
  assert.ok(ev.timestamp > 0);
});

test('event-bus: TYPES covers the lifecycle the UI listens for', () => {
  for (const k of ['TASK_CREATED', 'TASK_QUEUED', 'TASK_STARTED', 'STEP_STARTED',
    'STEP_COMPLETED', 'TASK_COMPLETED', 'TASK_FAILED', 'TASK_CANCELLED',
    'WORKFLOW_STARTED', 'WORKFLOW_COMPLETED', 'APPROVAL_REQUIRED', 'APPROVAL_GRANTED']) {
    assert.ok(typeof TYPES[k] === 'string', `missing TYPES.${k}`);
  }
});

test('logger: redacts secret-shaped keys at every depth', () => {
  const out = redacted({ apiKey: 'sk-abc', nested: { token: 'xyz', fine: 'ok', list: [{ secret: 's' }] } });
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.nested.fine, 'ok');
  assert.equal(out.nested.list[0].secret, '[redacted]');
});

test('logger: redacts payload fields on write and survives circular references', () => {
  const lines = [];
  const sink = { info: (line) => lines.push(line) };
  const log = createLogger({ level: 'info', sink, scope: 'test' });
  const circular = {};
  circular.self = circular;
  log.info('ping', { payload: { apiKey: 'hush', circular } });
  const row = JSON.parse(lines[0]);
  assert.equal(row.msg, 'ping');
  assert.equal(row.scope, 'test');
  assert.equal(row.payload.apiKey, '[redacted]');
  assert.equal(row.payload.circular.self, '[circular]');
});

test('logger: child() scopes namespaces and obeys level thresholds', () => {
  const lines = [];
  const sink = { info: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
  const log = createLogger({ level: 'warn', sink, scope: 'root' });
  log.info('dropped');
  const child = log.child('tools');
  child.error('kept');
  assert.deepEqual(lines.map(JSON.parse).map((r) => r.scope), ['root:tools']);
});

test('memory-store: clones on the way in and out', async () => {
  const store = createMemoryStore();
  await store.set('task:1', { id: 'task-1', nested: { a: 1 } });
  const v = await store.get('task:1');
  v.nested.a = 99;
  const v2 = await store.get('task:1');
  assert.equal(v2.nested.a, 1);
  assert.deepEqual(await store.keys('task:'), ['task:1']);
  await store.delete('task:1');
  assert.equal(await store.get('task:1'), null);
});

test('json-store: persists atomically and reloads from disk', async () => {
  const t = makeTempDir();
  try {
    const fs = require('node:fs/promises');
    const store = await createJsonStore({ dir: t.root, name: 'platform.json', fs });
    await store.set('agent:coder', { id: 'coder' });
    const store2 = await createJsonStore({ dir: t.root, name: 'platform.json', fs });
    assert.deepEqual(await store2.get('agent:coder'), { id: 'coder' });
    const raw = await fs.readFile(`${t.root}/platform.json`, 'utf8');
    assert.ok(!raw.includes('.tmp'), 'temp files must not be left behind');
  } finally {
    t.dispose();
  }
});

test('memory: session and per-task scopes are isolated and cloned', () => {
  const mem = createMemory();
  mem.session.set('workspace', { root: '/ws' });
  const ws = mem.session.get('workspace');
  ws.root = '/evil';
  assert.equal(mem.session.get('workspace').root, '/ws');
  const scopeA = mem.tasks('task-a');
  scopeA.set('note', { n: 1 });
  assert.deepEqual(mem.tasks('task-b').all(), {});
  assert.deepEqual(scopeA.all(), { note: { n: 1 } });
});

test('context: builds an immutable-snapshot view of the task world', () => {
  const task = { request: 'do the thing', phase: 'analyzing', options: { constraints: ['x'] } };
  const agent = { id: 'coder', name: 'Coder', capabilities: ['read', 'code'], model: { provider: 'p', id: 'm' } };
  const toolManager = { list: () => [{ id: 'fs:read' }] };
  const ctx = buildTaskContext({ task, agent, workspace: { root: '/ws', cwd: '/ws' }, toolManager });
  assert.equal(ctx.request, 'do the thing');
  assert.equal(ctx.workspace.root, '/ws');
  assert.deepEqual(ctx.agent.capabilities, ['read', 'code']);
  assert.equal(ctx.availableTools.length, 1);
  assert.equal(ctx.project.hasGit, false);
  const summary = summarizeContext(ctx);
  assert.equal(summary.request, 'do the thing');
  assert.equal(summary.toolCount, 1);
});