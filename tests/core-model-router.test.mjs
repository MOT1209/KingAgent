// Models are infrastructure, not the interface. The properties under test are
// that a kind of work maps to requirements (not to a model name), that provider
// choice respects capability, cost, latency and privacy constraints, and that
// with nothing wired it still returns a usable deterministic decision instead of
// throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createModelRouter, TASK_KINDS } = require('../src/core/ai/model-router.js');

const CATALOG = {
  premium: {
    capabilities: ['reasoning', 'tools', 'vision', 'fast'],
    models: [{ id: 'big', capabilities: ['reasoning', 'tools', 'vision'] }],
    cost: 10, latencyMs: 5000, quality: 3,
  },
  cheap: {
    capabilities: ['fast', 'tools'],
    models: [{ id: 'mini', capabilities: ['fast', 'tools'] }],
    cost: 0.1, latencyMs: 200, quality: 1,
  },
  seer: {
    capabilities: ['vision'],
    models: ['see-1'],
    cost: 2, latencyMs: 800, quality: 2,
  },
};

test('router: with no providers wired it still decides, deterministically', () => {
  const router = createModelRouter({});
  const decision = router.route({ kind: TASK_KINDS.PLANNING });
  assert.equal(decision.provider, null);
  assert.equal(decision.model, 'default');
  assert.equal(decision.reasoning, 'high', 'planning is high-reasoning by default');
  assert.equal(decision.deterministic, true);
  assert.match(decision.reason, /no provider configured/);
});

test('router: a kind maps to requirements, not to a model name', () => {
  const router = createModelRouter({ catalog: CATALOG });
  assert.deepEqual(router.route({ kind: TASK_KINDS.PLANNING }).requires, ['reasoning']);
  assert.deepEqual(router.route({ kind: TASK_KINDS.CODING }).requires, ['tools']);
  assert.deepEqual(router.route({ kind: TASK_KINDS.VISION }).requires, ['vision']);
  assert.deepEqual(router.route({ kind: TASK_KINDS.CLASSIFICATION }).requires, ['fast']);
});

test('router: planning picks a reasoning provider; classification can pick a light one', () => {
  const balanced = createModelRouter({ catalog: CATALOG });
  const plan = balanced.route({ kind: TASK_KINDS.PLANNING });
  assert.equal(plan.provider, 'premium');
  assert.equal(plan.model, 'big');

  const fast = createModelRouter({ catalog: CATALOG, policy: { costPolicy: 'cost' } });
  const classify = fast.route({ kind: TASK_KINDS.CLASSIFICATION });
  assert.equal(classify.provider, 'cheap', 'cost policy prefers the cheap provider that has fast');
  assert.equal(classify.model, 'mini');
});

test('router: vision routes to a provider that actually has vision', () => {
  const router = createModelRouter({ catalog: CATALOG, policy: { costPolicy: 'cost' } });
  const decision = router.route({ kind: TASK_KINDS.VISION });
  assert.equal(decision.provider, 'seer');
  assert.equal(decision.model, 'see-1');
});

test('router: performance policy prefers the lowest latency', () => {
  const router = createModelRouter({ catalog: CATALOG, policy: { costPolicy: 'performance' } });
  const decision = router.route({ kind: TASK_KINDS.CLASSIFICATION });
  assert.equal(decision.provider, 'cheap', 'mini is the fastest that has fast');
});

test('router: an unsatisfiable constraint falls back with a reason naming it', () => {
  const router = createModelRouter({ catalog: CATALOG });
  const decision = router.route({ kind: TASK_KINDS.PLANNING, requirements: { maxCost: 1 } });
  assert.equal(decision.provider, null);
  assert.equal(decision.deterministic, true);
  assert.match(decision.reason, /no configured provider satisfies/);
  assert.match(decision.reason, /cost <= 1/);
});

test('router: privacy requirements exclude providers that cannot honour them', () => {
  const catalog = {
    cloud: { capabilities: ['reasoning'], cost: 1, privacy: 'standard' },
    local: { capabilities: ['reasoning'], cost: 5, privacy: 'local' },
  };
  const router = createModelRouter({ catalog });
  const decision = router.route({ kind: TASK_KINDS.PLANNING, requirements: { privacy: 'local' } });
  assert.equal(decision.provider, 'local');
});

test('router: explicit capability requirements are added to the kind defaults', () => {
  const router = createModelRouter({ catalog: CATALOG });
  const decision = router.route({ kind: TASK_KINDS.CODING, requirements: { requiresVision: true } });
  assert.deepEqual(decision.requires.sort(), ['tools', 'vision']);
  assert.equal(decision.provider, 'premium');
});

test('router: complexity and an explicit override can raise reasoning', () => {
  const router = createModelRouter({ catalog: CATALOG });
  assert.equal(router.route({ kind: TASK_KINDS.CODING, complexity: 'high' }).reasoning, 'high');
  router.setRoute(TASK_KINDS.CODING, { reasoning: 'low' });
  assert.equal(router.route({ kind: TASK_KINDS.CODING }).reasoning, 'low');
});

test('router: describe reports the table and the configured providers', () => {
  const router = createModelRouter({ catalog: CATALOG });
  const info = router.describe();
  assert.ok(info.kinds.includes(TASK_KINDS.PLANNING));
  assert.equal(info.providers.length, 3);
  assert.ok(info.routes.planning.requires.includes('reasoning'));
});

test('router: an unknown kind resolves to the default route rather than failing', () => {
  const router = createModelRouter({ catalog: CATALOG });
  const decision = router.route({ kind: 'something-nobody-defined' });
  assert.equal(decision.kind, TASK_KINDS.DEFAULT);
});
