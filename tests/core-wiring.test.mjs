// Phase 2 wiring: the preload -> main-process IPC contract must stay symmetric.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainWiring = require('../src/main/agent-platform.js');
const { EventBus } = require('../src/core/events/event-bus.js');
const { CHANNELS, PUSH_CHANNELS } = require('../src/core/security/ipc-guard.js');

// A fake ipcMain that records every channel a handler is registered on.
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    handlers,
  };
}

// A platform-shaped object; only what the handlers touch is implemented.
function minimalPlatform() {
  const task = () => ({
    id: 'task-1', request: 'scan', agentId: 'coder', state: 'completed', phase: 'complete',
    mode: 'auto', plan: null, steps: [], createdAt: Date.now(), startedAt: null,
    completedAt: Date.now(), updatedAt: Date.now(), cancellation: { requestedAt: null, reason: null },
    outcome: { status: 'completed' },
  });
  return {
    bus: new EventBus(),
    agents: {
      list: () => [{ id: 'coder', name: 'Coder', description: 'd', capabilities: ['code'], tools: [], model: { provider: 'p', id: 'm' } }],
      get: (id) => ({ id, name: 'C', description: 'd', capabilities: [], tools: [] }),
    },
    tools: { list: () => [{ id: 'fs:read', name: 'Read' }] },
    runtime: {
      listTasks: () => [],
      get: () => task(),
      history: () => ({ task: {}, trace: [], stepLog: [], outcome: null }),
      runAgentTask: async () => task(),
      pause: () => task(),
      resume: () => task(),
      cancel: () => task(),
    },
    workflows: { run: async () => ({ id: 'wf-1', status: 'completed', nodes: [] }), get: () => null },
    _pendingAuth: new Map(),
  };
}

test('wiring: every guarded channel gets an ipcMain.handle', () => {
  const ipc = fakeIpcMain();
  mainWiring.createIpcHandlers({ ipcMain: ipc, platform: minimalPlatform(), forward: () => {} });
  for (const channel of Object.keys(CHANNELS)) {
    assert.ok(ipc.handlers.has(channel), `missing handler for channel ${channel}`);
  }
});

test('wiring: the preload\'s agentPlatform surface is a subset of guarded channels', () => {
  // Kept in sync with src/main/preload.js and src/renderer/agent-platform.mjs.
  const preloadChannels = [
    'agent:listAgents', 'agent:get', 'agent:listTools', 'agent:runTask',
    'agent:listTasks', 'agent:task', 'agent:history', 'agent:pause',
    'agent:resume', 'agent:cancel', 'agent:authorizeResponse',
    'workflow:list', 'workflow:run', 'workflow:get', 'workflow:cancel',
    // Phase 3
    'orchestrator:run', 'orchestrator:route', 'orchestrator:get', 'orchestrator:list',
    'orchestrator:cancel', 'orchestrator:policies',
    'workspace:get', 'workspace:list', 'workspace:files',
    'trace:list', 'trace:get', 'trace:activity',
    'artifact:list', 'artifact:get',
    'memory:search', 'memory:list',
    'approval:pending', 'approval:decide',
    'state:interrupted', 'state:resume', 'state:snapshot',
    'project:detect',
    'agents:lifecycles', 'agents:messages',
    // Phase 4 control center
    'agent:controlCenter', 'agent:harnesses', 'agent:harnessDetect',
    'agent:sandboxes', 'agent:sandbox', 'agent:policies', 'agent:policyAudit',
    'agent:explainPolicy', 'agent:sessions', 'agent:session', 'agent:artifacts',
    'agent:artifact', 'agent:delegations', 'agent:route', 'agent:cancelTask',
    // Phase 7 research
    'research:start', 'research:status', 'research:cancel', 'research:get',
    'research:list', 'research:sources', 'research:evidence', 'research:report',
    'research:capabilities',
  ];
  for (const c of preloadChannels) assert.ok(c in CHANNELS, `unlisted preload channel ${c}`);
  assert.deepEqual(PUSH_CHANNELS, ['agent:event', 'workflow:event', 'approval:event', 'research:event']);
});

test('wiring: handlers validate payloads before touching the subsystem', async () => {
  const ipc = fakeIpcMain();
  const platform = minimalPlatform();
  mainWiring.createIpcHandlers({ ipcMain: ipc, platform, forward: () => {} });

  // agent:get with a valid id passes through.
  const fn = ipc.handlers.get('agent:get');
  const res = await fn({}, { id: 'coder' });
  assert.equal(res.ok, true);
  assert.equal(res.data.name, 'C');

  // agent:get with a bad id surfaces a validation error, not a hand to the registry.
  const bad = await fn({}, { id: 'NOT-A-VALID-ID' }).then(() => ({})).catch((e) => e);
  assert.ok(bad instanceof Error);
  assert.match(bad.message, /invalid "id"/);
});

test('wiring (Phase 4): control-center handlers degrade gracefully on a platform without them', async () => {
  const ipc = fakeIpcMain();
  // minimalPlatform deliberately has none of the Phase 4 subsystems, which is
  // what a host that disables them looks like.
  mainWiring.createIpcHandlers({ ipcMain: ipc, platform: minimalPlatform(), forward: () => {} });

  const harnesses = await ipc.handlers.get('agent:harnesses')({}, {});
  assert.deepEqual(harnesses.data, { harnesses: [], backends: null });
  const policies = await ipc.handlers.get('agent:policies')({}, {});
  assert.deepEqual(policies.data, { policies: [], stats: null, recent: [] });
  assert.equal((await ipc.handlers.get('agent:controlCenter')({}, {})).data, null);
  assert.deepEqual((await ipc.handlers.get('agent:sessions')({}, {})).data, []);
});

test('wiring: runAgentTask returns a taskView-shaped result', async () => {
  const ipc = fakeIpcMain();
  const platform = minimalPlatform();
  mainWiring.createIpcHandlers({ ipcMain: ipc, platform, forward: () => {} });
  const fn = ipc.handlers.get('agent:runTask');
  const res = await fn({}, { request: 'scan the codebase', agentId: 'coder' });
  assert.equal(res.ok, true);
  assert.equal(res.data.id, 'task-1');
  assert.equal(res.data.request, 'scan');
  assert.equal(res.data.state, 'completed');
});