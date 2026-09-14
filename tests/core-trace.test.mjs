// The execution trace is the one place "never expose chain-of-thought" has to
// be enforced mechanically, not just by convention — an emitter passing a
// `reasoning` field is a mistake anyone can make, so serializer.js has to catch
// it. The other half tested here is correlation: every event must be traceable
// back to the run, the workspace and the agent that produced it, in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ExecutionTrace, ExecutionTraceStore, TRACE_EVENTS, TRACE_STATUS,
  isCorrelated, serializeTrace, toActivityStream, scrub,
} = require('../src/core/trace/index.js');
const { createCollections } = require('../src/core/persistence/collections.js');
const { createMemoryStore } = require('../src/core/persistence/store.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

// --- trace -------------------------------------------------------------------

test('trace: every appended event is correlated', () => {
  const trace = new ExecutionTrace({ identity: { traceId: 'trace-1', taskId: 't1', workspaceId: 'ws-1', agentId: 'coder' } });
  const ev = trace.append(TRACE_EVENTS.STEP_STARTED, { title: 'scan' });
  assert.ok(isCorrelated(ev));
  assert.equal(ev.traceId, 'trace-1');
  assert.equal(ev.taskId, 't1');
  assert.equal(ev.workspaceId, 'ws-1');
  assert.equal(ev.agentId, 'coder');
});

test('trace: sequence numbers order events even within the same millisecond', () => {
  const trace = new ExecutionTrace({ traceId: 'trace-2' });
  const events = Array.from({ length: 20 }, () => trace.append(TRACE_EVENTS.OBSERVATION, {}));
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence is monotonic');
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicates');
});

test('trace: parentEventId reconstructs the delegation tree', () => {
  const trace = new ExecutionTrace({ traceId: 'trace-3' });
  const delegation = trace.append(TRACE_EVENTS.DELEGATION, { toAgent: 'analyst' });
  const child1 = trace.append(TRACE_EVENTS.STEP_STARTED, {}, { parentEventId: delegation.eventId });
  const child2 = trace.append(TRACE_EVENTS.STEP_COMPLETED, {}, { parentEventId: delegation.eventId });
  const unrelated = trace.append(TRACE_EVENTS.OBSERVATION, {});
  assert.deepEqual(trace.childrenOf(delegation.eventId).map((e) => e.eventId), [child1.eventId, child2.eventId]);
  assert.ok(!trace.childrenOf(delegation.eventId).includes(unrelated));
});

test('trace: bounded — the oldest events are dropped and the drop is counted', () => {
  const trace = new ExecutionTrace({ traceId: 'trace-4', maxEvents: 5 });
  for (let i = 0; i < 12; i += 1) trace.append(TRACE_EVENTS.OBSERVATION, { i });
  assert.equal(trace.events.length, 5);
  assert.equal(trace.droppedEvents, 7);
  assert.equal(trace.events[trace.events.length - 1].payload.i, 11, 'the most recent event survives');
});

test('trace: complete/fail/cancel are terminal and idempotent', () => {
  const trace = new ExecutionTrace({ traceId: 'trace-5' });
  trace.complete({ ok: true });
  assert.equal(trace.status, TRACE_STATUS.COMPLETED);
  const before = trace.events.length;
  trace.fail(new Error('too late'));
  assert.equal(trace.status, TRACE_STATUS.COMPLETED, 'a terminal trace cannot change status');
  assert.equal(trace.events.length, before, 'and does not record a second terminal event');
});

test('trace: round-trips through toJSON / fromJSON', () => {
  const trace = new ExecutionTrace({ identity: { traceId: 'trace-6', taskId: 't1' } });
  trace.append(TRACE_EVENTS.STEP_STARTED, { title: 'a' });
  trace.complete('done');
  const revived = ExecutionTrace.fromJSON(trace.toJSON());
  assert.equal(revived.traceId, trace.traceId);
  assert.equal(revived.status, TRACE_STATUS.COMPLETED);
  assert.equal(revived.events.length, trace.events.length);
});

// --- serializer ----------------------------------------------------------------

test('serializer: private reasoning is never traced, whatever key it rides in', () => {
  const scrubbed = scrub({ reasoning: 'because I think...', chain_of_thought: 'step by step', thoughts: 'hmm', toolId: 'fs:read' });
  assert.equal(scrubbed.reasoning, '[removed: private reasoning is never traced]');
  assert.equal(scrubbed.chain_of_thought, '[removed: private reasoning is never traced]');
  assert.equal(scrubbed.thoughts, '[removed: private reasoning is never traced]');
  assert.equal(scrubbed.toolId, 'fs:read', 'ordinary operational fields pass through');
});

test('serializer: a credential-shaped field is redacted at any depth', () => {
  const scrubbed = scrub({ input: { apiKey: 'sk-123', nested: { token: 'abc' } } });
  assert.equal(scrubbed.input.apiKey, '[redacted]');
  assert.equal(scrubbed.input.nested.token, '[redacted]');
});

test('serializer: serializeTrace scrubs every event\'s payload', () => {
  const trace = new ExecutionTrace({ traceId: 'trace-7' });
  trace.append(TRACE_EVENTS.TOOL_CALLED, { toolId: 'terminal:run', reasoning: 'because', password: 'hunter2' });
  const out = serializeTrace(trace);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('because'));
  assert.ok(!text.includes('hunter2'));
});

test('serializer: toActivityStream is compact and ordered for a UI', () => {
  const trace = new ExecutionTrace({ traceId: 'trace-8' });
  trace.append(TRACE_EVENTS.STEP_STARTED, { title: 'Scan' });
  trace.append(TRACE_EVENTS.STEP_COMPLETED, { title: 'Scan' });
  const stream = toActivityStream(trace);
  assert.equal(stream.length, 2);
  assert.equal(stream[0].summary, 'Scan');
  assert.ok(stream[0].seq < stream[1].seq);
});

// --- store -----------------------------------------------------------------

test('store: createTrace / appendEvent / getTrace / listTraces / deleteTrace', async () => {
  const bus = new EventBus();
  const collections = createCollections(createMemoryStore());
  const store = new ExecutionTraceStore({ collection: collections.traces, bus });

  store.createTrace({ identity: { traceId: 'trace-9', taskId: 't1' }, label: 'demo' });
  store.appendEvent('trace-9', TRACE_EVENTS.STEP_STARTED, { title: 'go' });
  assert.equal(store.getTrace('trace-9').events.length, 1, 'the appended event is recorded');
  assert.equal(store.listTraces()[0].traceId, 'trace-9');

  await store.completeTrace('trace-9', { ok: true });
  const persisted = await collections.traces.get('trace-9');
  assert.equal(persisted.status, TRACE_STATUS.COMPLETED, 'completion is always flushed');

  await store.deleteTrace('trace-9');
  assert.equal(store.getTrace('trace-9'), null);
  assert.equal(await collections.traces.get('trace-9'), null);
});

test('store: emits trace.started and trace.completed, correlated', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('trace.')) seen.push(ev); });
  const store = new ExecutionTraceStore({ bus });
  store.createTrace({ identity: { traceId: 'trace-10', workspaceId: 'ws-1' } });
  await store.completeTrace('trace-10');
  assert.deepEqual(seen.map((e) => e.type), [TYPES.TRACE_STARTED, TYPES.TRACE_COMPLETED]);
  assert.ok(seen.every((e) => e.workspaceId === 'ws-1'));
});

test('store: pruning drops the oldest completed traces, never a running one', async () => {
  const collections = createCollections(createMemoryStore());
  const store = new ExecutionTraceStore({ collection: collections.traces, options: { maxStoredTraces: 2, maxLiveTraces: 100 } });

  store.createTrace({ identity: { traceId: 'keep-running' } });
  for (let i = 0; i < 4; i += 1) {
    const t = store.createTrace({ identity: { traceId: `done-${i}` } });
    await new Promise((r) => setTimeout(r, 2));
    await store.completeTrace(t.traceId);
  }
  const ids = await collections.traces.ids();
  assert.ok(ids.includes('keep-running'), 'a running trace is never pruned');
  assert.ok(ids.length <= 3, 'completed traces are pruned toward the cap (+1 for the running one)');
});
