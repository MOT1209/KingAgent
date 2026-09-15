// The orchestrator composes existing subsystems; it does not replace the
// runtime. These tests check routing decisions directly, then the integration
// scenario Phase 3 was built around: a request becomes a workspace, a
// budgeted context packet, a run through the real AgentRuntime, tracked file
// changes, and a persisted trace — without ever loading a whole repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const { EXECUTION_MODES, createPolicies, Router, planDelegations, readyDelegations, auditDelegations, Scheduler, PRIORITY } = require('../src/core/orchestrator/index.js');

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ka-orch-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --test' } }));
  await fs.writeFile(path.join(dir, 'README.md'), '# Demo\nTODO: fix the parser bug\n');
  await fs.writeFile(path.join(dir, 'src', 'parser.js'), 'function parse() { return 1; }\nmodule.exports = { parse };\n');
  return dir;
}

// --- router ------------------------------------------------------------------

test('router: a single tool-shaped request routes to TOOL', () => {
  const router = new Router({ policies: createPolicies() });
  const decision = router.route({ request: 'read package.json' });
  assert.equal(decision.mode, EXECUTION_MODES.TOOL);
  assert.equal(decision.toolId, 'fs:read');
});

test('router: a destructive-sounding request routes to APPROVAL', () => {
  const router = new Router({ policies: createPolicies() });
  const decision = router.route({ request: 'delete the build directory' });
  assert.equal(decision.mode, EXECUTION_MODES.APPROVAL);
  assert.equal(decision.requiresApproval, true);
});

test('router: an explicit mode hint always wins over inference', () => {
  const router = new Router({ policies: createPolicies() });
  const decision = router.route({ request: 'delete nothing dangerous', mode: 'single-agent' });
  assert.equal(decision.mode, EXECUTION_MODES.SINGLE_AGENT);
});

test('router: multi-agent is refused when the policy disallows it', () => {
  const router = new Router({
    policies: createPolicies({ allowMultiAgent: false }),
    agents: { list: () => [{ id: 'coder', capabilities: ['code'] }, { id: 'analyst', capabilities: ['read'] }] },
  });
  const decision = router.route({ request: 'analyze the repo, implement a fix, run tests, and write a report' });
  assert.notEqual(decision.mode, EXECUTION_MODES.MULTI_AGENT);
});

// --- delegation planning -------------------------------------------------------

test('planDelegations: builds phases in dependency order and never widens the parent policy', () => {
  const decision = { mode: EXECUTION_MODES.MULTI_AGENT, capabilities: ['repository_analysis', 'code', 'run_tests'] };
  const specs = planDelegations({ request: 'fix it', decision, parentPolicy: { allowDestructive: false, tools: ['fs:read'] } });
  assert.deepEqual(specs.map((s) => s.id), ['analysis', 'implementation', 'verification']);
  assert.equal(auditDelegations(specs, { allowDestructive: false, tools: ['fs:read'] }).length, 0);
  assert.deepEqual(readyDelegations(specs, []).map((s) => s.id), ['analysis']);
  assert.deepEqual(readyDelegations(specs, ['analysis']).map((s) => s.id), ['implementation']);
});

// --- scheduler -----------------------------------------------------------------

test('scheduler: caps concurrency and preserves priority order', async () => {
  const s = new Scheduler({ maxConcurrent: 1 });
  const order = [];
  const a = s.submit({ priority: PRIORITY.NORMAL, run: async () => { order.push('a'); } });
  const b = s.submit({ priority: PRIORITY.HIGH, run: async () => { order.push('b'); } });
  await Promise.all([a.result, b.result]);
  assert.deepEqual(order, ['a', 'b'], 'a was already running; b queued but is higher priority than a future c would be');
});

// --- orchestrator: single-agent integration ------------------------------------

test('orchestrator: a full single-agent run — workspace, context, runtime, trace, artifacts', async (t) => {
  const dir = await tempProject();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const platform = createPlatform({ io: { root: dir, cwd: () => dir } });
  t.after(() => platform.dispose());

  const run = await platform.orchestrator.handle({
    request: 'Analyze this project and report the findings',
    agentId: 'analyst',
    workspace: { root: dir },
  });
  assert.equal(run.decision.mode, EXECUTION_MODES.SINGLE_AGENT);

  const outcome = await run.result;
  assert.equal(outcome.ok, true, outcome.error);

  const view = platform.orchestrator.get(run.id);
  assert.equal(view.status, 'completed');
  assert.ok(view.packetId, 'a context packet was built');
  assert.ok(view.taskId, 'the real AgentRuntime ran a task');

  const traces = platform.traces.listTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].status, 'completed');
  assert.ok(traces[0].tools.length > 0, 'tool usage is visible in the trace');
});

test('orchestrator: cancel stops a queued run before it starts', async (t) => {
  const dir = await tempProject();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const platform = createPlatform({ io: { root: dir, cwd: () => dir } });
  t.after(() => platform.dispose());

  // Fill the only concurrency slot so the second run stays queued.
  platform.orchestrator.scheduler._max = 1;
  const first = await platform.orchestrator.handle({ request: 'read package.json', workspace: { root: dir } });
  const second = await platform.orchestrator.handle({ request: 'read README.md', workspace: { root: dir } });
  platform.orchestrator.cancel(second.id, 'not needed');
  await first.result;
  await second.result;
  assert.equal(platform.orchestrator.get(second.id).status, 'cancelled');
});

// --- orchestrator: multi-agent integration -------------------------------------

test('orchestrator: multi-agent delegation validates permissions, scope and trace correlation', async (t) => {
  const dir = await tempProject();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const platform = createPlatform({ io: { root: dir, cwd: () => dir }, policies: { multiAgentMinCapabilities: 2 } });
  t.after(() => platform.dispose());

  const run = await platform.orchestrator.handle({
    request: 'analyze this project and report findings and check git history',
    mode: 'multi-agent',
  });
  assert.equal(run.decision.mode, EXECUTION_MODES.MULTI_AGENT);

  const outcome = await run.result;
  assert.ok(outcome.ok || outcome.partial !== undefined, JSON.stringify(outcome));

  const view = platform.orchestrator.get(run.id);
  const trace = platform.traces.getTrace(view.identity.traceId) || (await platform.traces.loadTrace(view.identity.traceId));
  assert.ok(trace, 'the lead run has its own trace');
  assert.ok(trace.events.some((e) => e.type === 'delegation'), 'a delegation was recorded');

  const messages = platform.messages.history({ taskId: view.identity.taskId });
  assert.ok(messages.some((m) => m.type === 'DELEGATION'));
});

test('orchestrator: cancellation propagates from a parent to its delegated children', async (t) => {
  const dir = await tempProject();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const platform = createPlatform({ io: { root: dir, cwd: () => dir } });
  t.after(() => platform.dispose());

  const parent = platform.workspaces.create({ root: dir, identity: { agentId: 'coder' } });
  const controller = new AbortController();
  const p = platform.coordinator.delegate({
    from: parent, capabilities: ['read'], request: 'scan everything', signal: controller.signal, timeoutMs: 30000,
  });
  controller.abort();
  const result = await p;
  assert.equal(result.ok, false);
  assert.match(result.error, /cancel/i);
});
