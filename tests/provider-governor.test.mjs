import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateWithin, usageOf } = require('../src/core/ai/provider');
const { AgentGovernor } = require('../src/core/agents/governor');

const provider = (usage) => ({ id: 'p', generate: async () => ({ text: 'ok', usage }) });

test('usageOf reads the common usage spellings and never throws', () => {
  assert.deepEqual(usageOf({ usage: { totalTokens: 10, cost: 0.5 } }), { tokens: 10, cost: 0.5 });
  assert.deepEqual(usageOf({ usage: { inputTokens: 3, outputTokens: 4 } }), { tokens: 7, cost: 0 });
  assert.deepEqual(usageOf({ usage: { tokens: -5 } }), { tokens: 0, cost: 0 });
  assert.deepEqual(usageOf(null), { tokens: 0, cost: 0 });
  assert.deepEqual(usageOf({ usage: 'x' }), { tokens: 0, cost: 0 });
});

test('a 600k-token run charged through generateWithin makes governor.sweep() non-empty', async () => {
  const governor = new AgentGovernor();
  governor.register({ agentId: 'a1', role: 'worker' });
  assert.deepEqual(governor.sweep(), []);
  await generateWithin(provider({ totalTokens: 600_000 }), { agentId: 'a1' }, { governor });
  const swept = governor.sweep();
  assert.equal(swept.length, 1);
  assert.equal(swept[0].agentId, 'a1');
});

test('without a governor or agentId nothing is charged and the result is unchanged', async () => {
  const governor = new AgentGovernor();
  governor.register({ agentId: 'a1', role: 'worker' });
  const r = await generateWithin(provider({ totalTokens: 600_000 }), {}, { governor });
  assert.equal(r.text, 'ok');
  assert.deepEqual(governor.sweep(), []);
});

test('a failed call charges nothing', async () => {
  const governor = new AgentGovernor();
  governor.register({ agentId: 'a1', role: 'worker' });
  const bad = { id: 'b', generate: async () => { throw new Error('boom'); } };
  await assert.rejects(generateWithin(bad, { agentId: 'a1' }, { governor }));
  assert.deepEqual(governor.sweep(), []);
});
