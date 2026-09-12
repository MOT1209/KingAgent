// Phase 2 core: planner modes and plan validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');
const { Planner, TEMPLATES } = require('../src/core/planning/planner.js');
const { createPlan, createStep, validatePlan } = require('../src/core/planning/plan.js');
const { buildTaskContext } = require('../src/core/context/context.js');

const bus = new EventBus();
const coder = { id: 'coder', name: 'Coder', capabilities: ['read', 'code', 'write', 'git', 'run_tests'], permissions: { levels: ['read_only', 'safe', 'moderate'], allowDestructive: false } };
const analyst = { id: 'analyst', name: 'Analyst', capabilities: ['read', 'code_search', 'repository_analysis'], permissions: { levels: ['read_only', 'safe', 'moderate'], allowDestructive: false } };
const taskShape = (request, agent) => ({ id: 'task-1', request, agentId: agent.id, options: {}, _signal: undefined });

function makePlanner(provider) {
  return new Planner({ bus, toolManager: null, provider: provider || null, reasoner: null, logger: null });
}

test('plan: createPlan validates empty/duplicate/invalid steps', () => {
  assert.throws(() => createPlan({}), /an id/);
  assert.throws(() => createPlan({ id: 'p', objective: 'x', steps: [] }), /at least one step/);
  assert.throws(() => createStep({ id: 's', title: 't' }), /tool or an action function/);
  // validatePlan accepts raw (un-normalized) step objects; it must flag structural
  // problems (missing ids, duplicates, unknown dependencies) without crashing.
  assert.equal(validatePlan({ steps: [{ name: 'nolabel' }] }).ok, false);
  assert.equal(validatePlan({ steps: [{ id: 'a' }, { id: 'a' }] }).ok, false);
  assert.equal(validatePlan({ steps: [{ id: 'b', dependsOn: ['ghost'] }] }).ok, false);
  assert.equal(validatePlan({ steps: [{ id: 'a' }] }).ok, true);
});

test('planner: mode "simple" builds the deterministic repository analysis skeleton', async () => {
  const ctx = buildTaskContext({ task: taskShape('scan it', analyst), agent: analyst, workspace: null });
  const plan = await makePlanner().buildPlan({ request: 'scan it', context: ctx, agent: analyst, mode: 'simple' });
  assert.equal(plan.mode, 'deterministic');
  assert.deepEqual(plan.steps.map((s) => s.id), ['scan', 'read', 'search', 'report']);
  // Narrative and tool steps never claim to write code offline.
  assert.ok(plan.steps.every((s) => ['scan', 'read', 'search', 'report'].includes(s.id)));
  assert.equal(plan.steps[0].tool.id, 'fs:list');
});

test('planner: the code template only fires for write+code agents', async () => {
  const ctx = buildTaskContext({ task: taskShape('build feature', coder), agent: coder, workspace: null });
  const plan = await makePlanner().buildPlan({ request: 'build feature', context: ctx, agent: coder, mode: 'simple' });
  assert.deepEqual(plan.steps.map((s) => s.id), ['analyze', 'read', 'plan', 'report']);
});

test('planner: mode "auto" without a provider degrades to deterministic', async () => {
  const ctx = buildTaskContext({ task: taskShape('x', analyst), agent: analyst, workspace: null });
  const plan = await makePlanner().buildPlan({ request: 'x', context: ctx, agent: analyst, mode: 'auto' });
  assert.equal(plan.mode, 'deterministic');
});

test('planner: structured mode uses the provider plan and falls back on refusal', async () => {
  const provider = {
    async generate({ system }) {
      if (!system.includes('steps')) return { structured: null };
      return {
        structured: [
          { id: 's1', title: 'Read the readme', tool: { id: 'fs:read', input: { path: 'README.md' } }, verify: { pattern: 'hello' } },
          { id: 's2', title: 'Grep TODOs', tool: { id: 'search:grep', input: { pattern: 'TODO' } } },
        ],
      };
    },
  };
  const ctx = buildTaskContext({ task: taskShape('x', coder), agent: coder, workspace: null });
  const plan = await makePlanner(provider).buildPlan({ request: 'x', context: ctx, agent: coder, mode: 'structured' });
  assert.equal(plan.mode, 'structured');
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].tool.id, 'fs:read');
  assert.ok(plan.steps[0].verify && plan.steps[0].verify.pattern instanceof RegExp);
});

test('planner: a provider that throws still yields a deterministic plan', async () => {
  const provider = { async generate() { throw new Error('model down'); } };
  const ctx = buildTaskContext({ task: taskShape('x', analyst), agent: analyst, workspace: null });
  const plan = await makePlanner(provider).buildPlan({ request: 'x', context: ctx, agent: analyst, mode: 'structured' });
  assert.equal(plan.mode, 'deterministic');
});

test('planner: autonomous mode returns one self-driving step', async () => {
  const plan = await makePlanner().buildPlan({ request: 'do something', context: null, agent: coder, mode: 'autonomous' });
  assert.equal(plan.mode, 'autonomous');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].id, 'autonomous');
  assert.equal(typeof plan.steps[0].action, 'function');
  assert.ok(plan.steps[0].dependsOn.length === 0);
});

test('planner: replan drops completed steps and always yields a plan', async () => {
  const p = makePlanner();
  const task = { id: 'task-1', request: 'x', agentId: 'analyst', agent: analyst, plan: null, steps: [] };
  task.plan = await p.buildPlan({ request: 'x', context: null, agent: analyst, mode: 'auto' });
  task.plan.steps[0].status = 'completed';
  task.steps = task.plan.steps;
  const replanned = await p.replan(task, 'read failed');
  assert.ok(replanned.steps.length > 0);
  assert.ok(!replanned.steps.some((s) => s.id === 'scan'), 'completed scan must not be re-run');
});

test('planner: creates plans that validate', async () => {
  const ctx = buildTaskContext({ task: taskShape('x', analyst), agent: analyst, workspace: null });
  const plan = await makePlanner().buildPlan({ request: 'x', context: ctx, agent: analyst, mode: 'simple' });
  assert.equal(validatePlan(plan).ok, true);
});

test('planner: emits a PLAN_CREATED event so observers track progress', async () => {
  const events = [];
  bus.on(TYPES.PLAN_CREATED, (ev) => events.push(ev));
  const ctx = buildTaskContext({ task: taskShape('x', analyst), agent: analyst, workspace: null });
  await makePlanner().buildPlan({ request: 'x', context: ctx, agent: analyst, mode: 'simple' });
  assert.ok(events.some((e) => e.payload.mode === 'deterministic'));
});

test('planner: templates stay analysis skeletons across calls (non-mutating)', () => {
  const snap = JSON.stringify(TEMPLATES);
  const planner = makePlanner();
  const ctx = buildTaskContext({ task: taskShape('mem', analyst), agent: analyst, workspace: null });
  for (let i = 0; i < 3; i++) {
    planner.buildPlan({ request: 'scan the repo', context: ctx, agent: analyst, mode: 'simple' });
  }
  assert.equal(JSON.stringify(TEMPLATES), snap);
  for (const steps of Object.values(TEMPLATES)) {
    assert.ok(Array.isArray(steps) && steps.length >= 4);
  }
});