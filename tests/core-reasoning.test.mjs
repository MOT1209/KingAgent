// Phase 2 core: reasoner behavior with and without an AI provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EventBus } = require('../src/core/events/event-bus.js');
const { Reasoner } = require('../src/core/reasoning/reasoning.js');

const task = { id: 'task-1', request: 'summarize the workspace', agentId: 'analyst', _signal: undefined };

test('reasoner: deterministic analyze works with no provider', async () => {
  const r = new Reasoner({ provider: null, bus: new EventBus() });
  const a = await r.analyze(task, {});
  assert.equal(a.goal, 'summarize the workspace');
  assert.ok(a.interpretation.startsWith('The user wants:'));
  assert.equal(a.constraints.length, 0);
});

test('reasoner: analyze uses provider-structured output when available', async () => {
  const provider = {
    async generate() {
      return { structured: { interpretation: 'brief', goal: 'g', constraints: ['c1'], risks: ['r1'] } };
    },
  };
  const r = new Reasoner({ provider, bus: new EventBus() });
  const a = await r.analyze(task, {});
  assert.equal(a.goal, 'g');
  assert.deepEqual(a.constraints, ['c1']);
});

test('reasoner: analyze survives a provider failure', async () => {
  const provider = { async generate() { throw new Error('overloaded'); } };
  const r = new Reasoner({ provider, bus: new EventBus() });
  const a = await r.analyze(task, {});
  assert.equal(a.goal, 'summarize the workspace');
});

test('reasoner: deterministic decide picks the first option', async () => {
  const r = new Reasoner({ provider: null, bus: new EventBus() });
  const d = await r.decide(task, [{ id: 'fs:read', name: 'Read' }, { id: 'search:grep', name: 'Grep' }]);
  assert.equal(d.decision, 'fs:read');
  assert.equal(typeof d.rationale, 'string');
  assert.ok(Array.isArray(d.actions));
});

test('reasoner: decide with provider returns decision + capped rationale (no CoT)', async () => {
  const provider = {
    async generate() {
      return { structured: { decision: 'search:grep', rationale: 'ok'.repeat(500), actions: [{ id: 'search:grep', confidence: 0.9 }] } };
    },
  };
  const r = new Reasoner({ provider, bus: new EventBus() });
  const d = await r.decide(task, [{ id: 'search:grep', name: 'Grep' }]);
  assert.equal(d.decision, 'search:grep');
  assert.ok(d.rationale.length <= 200, 'rationale must be capped');
});

test('reasoner: evaluateStep passes on tool success by default', async () => {
  const r = new Reasoner({ provider: null, bus: new EventBus() });
  const j = await r.evaluateStep(task, { id: 's', title: 'S' }, { ok: true, data: {} });
  assert.equal(j.passed, true);
  assert.equal(j.next, 'continue');
});

test('reasoner: diagnose classifies a timeout', async () => {
  const r = new Reasoner({ provider: null, bus: new EventBus() });
  const d = await r.diagnose(task, new Error('timeout exceeded'));
  assert.equal(d.category, 'timeout');
  assert.ok(d.proposedFix.length > 0);
});

test('reasoner: diagnose classifies permission problems', async () => {
  const r = new Reasoner({ provider: null, bus: new EventBus() });
  const d = await r.diagnose(task, Object.assign(new Error('EACCES denied'), { code: 'EACCES' }));
  assert.equal(d.category, 'permission');
});

test('reasoner: events are emitted for analysis start (observability)', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('task.analyzing', (ev) => seen.push(ev));
  const r = new Reasoner({ provider: null, bus });
  await r.analyze(task, {});
  assert.equal(seen[0].taskId, 'task-1');
});