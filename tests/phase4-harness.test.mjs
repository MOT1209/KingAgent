// Phase 4: the harness layer (manifest, capabilities, registry, lifecycle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  validateManifest,
  createHarness,
  HarnessRegistry,
  HarnessManager,
  createCapabilities,
  normalizeCapabilities,
  satisfies,
  HARNESS_STATES,
  canTransition,
  HarnessError,
  HarnessCapabilityError,
  HarnessNotWiredError,
  builtinHarnesses,
} = require('../src/core/harness');
const { EventBus, TYPES } = require('../src/core/events/event-bus');

const CLAUDE = {
  id: 'claude-code',
  name: 'Claude Code',
  type: 'cli',
  platforms: ['windows', 'macos'],
  capabilities: ['coding', 'terminal', 'files', 'git', 'streaming', 'pause'],
  command: ['claude'],
};

test('harness capabilities: tags normalise, sort, dedupe and reject typos', () => {
  assert.deepEqual(normalizeCapabilities(['git', 'coding', 'git']), ['coding', 'git']);
  assert.throws(() => normalizeCapabilities(['codng']), /unknown harness capability/);
});

test('harness capabilities: supports* flags are derived from tags, not declared', () => {
  const caps = createCapabilities({ tags: ['streaming', 'files', 'terminal', 'pause', 'mcp', 'browser', 'model_selection', 'structured_events'] });
  assert.equal(caps.supports.supportsStreaming, true);
  assert.equal(caps.supports.supportsPause, true);
  assert.equal(caps.supports.supportsResume, true, 'the pause tag implies resume');
  assert.equal(caps.supports.supportsMCP, true);
  assert.equal(caps.supports.supportsFiles, true);
  assert.equal(caps.supports.supportsTerminal, true);
  const minimal = createCapabilities({ tags: ['coding'] });
  for (const flag of ['supportsPause', 'supportsStreaming', 'supportsFiles', 'supportsMCP']) {
    assert.equal(minimal.supports[flag], false, `${flag} must not be assumed`);
  }
  assert.equal(satisfies(caps, ['streaming', 'files']), true);
  assert.equal(satisfies(minimal, ['files']), false);
});

test('harness manifest: valid manifests normalise, unknown keys are dropped', () => {
  const { ok, manifest } = validateManifest({ ...CLAUDE, evil: 'rm -rf /' });
  assert.equal(ok, true);
  assert.equal(manifest.id, 'claude-code');
  assert.equal(Object.hasOwn(manifest, 'evil'), false);
  assert.deepEqual(manifest.command, ['claude']);
  assert.equal(manifest.environmentPolicy.mode, 'minimal', 'environment defaults to minimal');
  assert.equal(manifest.workspacePolicy.mode, 'workspace');
});

test('harness manifest: a manifest cannot declare env, secrets or a shell string', () => {
  assert.equal(validateManifest({ ...CLAUDE, env: { API_KEY: 'sk-x' } }).ok, false);
  assert.equal(validateManifest({ ...CLAUDE, command: 'claude; rm -rf /' }).ok, false);
  assert.equal(validateManifest({ ...CLAUDE, command: ['claude', '&&', 'sh'] }).ok, false);
  assert.equal(
    validateManifest({ ...CLAUDE, environmentPolicy: { mode: 'allowlist', allowlist: ['OPENAI_API_KEY'] } }).ok,
    false,
    'a credential-shaped allowlist entry is refused',
  );
  assert.equal(validateManifest({ ...CLAUDE, type: 'whatever' }).ok, false);
  assert.equal(validateManifest({ ...CLAUDE, platforms: ['plan9'] }).ok, false);
  assert.equal(validateManifest({ ...CLAUDE, capabilities: ['telepathy'] }).ok, false);
  assert.equal(validateManifest({ id: 'Bad Id', name: 'x' }).ok, false);
});

test('harness adapter: detect reports honestly when no probe is wired', async () => {
  const harness = createHarness(CLAUDE);
  const verdict = await harness.detect();
  assert.equal(verdict.installed, false);
  assert.match(verdict.reason, /no probe|detection probe/i);
  assert.equal(harness.state, HARNESS_STATES.INSTALLABLE);

  const inProcess = createHarness({ ...CLAUDE, id: 'inline', type: 'in-process' });
  assert.equal((await inProcess.detect()).installed, true);
  assert.equal(inProcess.state, HARNESS_STATES.DETECTED);
});

test('harness adapter: install refuses without a wired installer', async () => {
  const harness = createHarness(CLAUDE);
  await assert.rejects(() => harness.install(), HarnessNotWiredError);
});

test('harness adapter: lifecycle runs registered → running → paused → stopped → disposed', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => seen.push(ev.type));
  const calls = [];
  const harness = createHarness(CLAUDE, {
    bus,
    transport: {
      start: async (ctx) => { calls.push(['start', ctx.runId]); return { pid: 42 }; },
      pause: async () => { calls.push(['pause']); },
      resume: async () => { calls.push(['resume']); },
      send: async (msg) => { calls.push(['send', msg.type]); return { queued: true }; },
      stop: async () => { calls.push(['stop']); },
      dispose: async () => { calls.push(['dispose']); },
    },
  });

  const status = await harness.start({ taskId: 'task-1', cwd: '/ws' });
  assert.equal(status.state, HARNESS_STATES.RUNNING);
  assert.equal(status.runs, 1);
  await harness.pause();
  assert.equal(harness.state, HARNESS_STATES.PAUSED);
  await harness.resume();
  assert.equal(harness.state, HARNESS_STATES.RUNNING);
  await harness.send({ type: 'REQUEST', payload: { objective: 'go' } });
  await harness.stop('done');
  assert.equal(harness.state, HARNESS_STATES.STOPPED);
  await harness.dispose();
  assert.equal(harness.state, HARNESS_STATES.DISPOSED);

  assert.deepEqual(calls.map((c) => c[0]), ['start', 'pause', 'resume', 'send', 'stop', 'dispose']);
  assert.ok(seen.includes(TYPES.HARNESS_STARTED));
  assert.ok(seen.includes(TYPES.HARNESS_STOPPED));
});

test('harness adapter: unsupported operations and unwired transports are typed refusals', async () => {
  const limited = createHarness({ ...CLAUDE, id: 'no-pause', capabilities: ['coding'] }, { transport: { start: async () => ({}) } });
  await limited.start({});
  await assert.rejects(() => limited.pause(), HarnessCapabilityError);
  await assert.rejects(() => limited.send({ type: 'REQUEST' }), HarnessCapabilityError);

  const claimButSilent = createHarness(CLAUDE);
  await assert.rejects(() => claimButSilent.start({}), HarnessNotWiredError);
});

test('harness adapter: send refuses a bare string, keeping prompts out of the protocol', async () => {
  const harness = createHarness(CLAUDE, { transport: { start: async () => ({}), send: async () => ({}) } });
  await harness.start({});
  await assert.rejects(() => harness.send('please do the thing'), /structured message/);
});

test('harness adapter: an illegal transition throws instead of guessing', async () => {
  const harness = createHarness(CLAUDE, { transport: { start: async () => ({}) } });
  assert.equal(canTransition(HARNESS_STATES.REGISTERED, HARNESS_STATES.PAUSED), false);
  await assert.rejects(() => harness.pause(), /cannot|Invalid harness state transition/, 'pause before start is refused');
  assert.ok(new HarnessCapabilityError('x', 'y') instanceof HarnessError);
  assert.equal(new HarnessCapabilityError('pause', 'x').code, 'HARNESS_UNSUPPORTED_OPERATION', 'the error carries a stable code for the UI');
});

test('harness registry: register, list, get, unregister and duplicate protection', () => {
  const registry = new HarnessRegistry();
  registry.register(CLAUDE);
  assert.equal(registry.count(), 1);
  assert.ok(registry.get('claude-code'));
  assert.throws(() => registry.register(CLAUDE), /already registered/);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list({ platform: 'windows' }).length, 1);
  assert.equal(registry.list({ capability: 'review' }).length, 0);
  assert.equal(registry.list({ type: 'cli' }).length, 1);
  assert.equal(registry.unregister('claude-code'), true);
  assert.equal(registry.get('claude-code'), null);
});

test('harness registry: detect probes each harness once and caches until refreshed', async () => {
  let probes = 0;
  const registry = new HarnessRegistry({ probe: async ({ id }) => { probes += 1; return { installed: id === 'a', version: '1.2.3' }; } });
  registry.register({ ...CLAUDE, id: 'a', command: ['a'] });
  registry.register({ ...CLAUDE, id: 'b', command: ['b'] });

  const first = await registry.detect();
  assert.equal(first.a.installed, true);
  assert.equal(first.a.version, '1.2.3');
  assert.equal(first.b.installed, false);
  assert.equal(probes, 2);
  await registry.detect();
  assert.equal(probes, 2, 'a second detect reuses the cached verdict');
  await registry.detect({ refresh: true });
  assert.equal(probes, 4);
});

test('harness registry: resolve prefers the most specific compatible backend and is deterministic', () => {
  const registry = new HarnessRegistry();
  registry.register({ ...CLAUDE, id: 'broad', capabilities: ['coding', 'terminal', 'files', 'git', 'streaming', 'review'] });
  registry.register({ ...CLAUDE, id: 'narrow', capabilities: ['coding', 'files'] });

  const picked = registry.resolve({ capabilities: ['coding', 'files'], platform: 'windows' });
  assert.equal(picked.harness.id, 'narrow', 'the backend with the fewest surplus capabilities wins');
  assert.deepEqual(registry.resolve({ capabilities: ['coding', 'files'], platform: 'windows' }).harness.id, 'narrow');
  assert.deepEqual(picked.candidates, ['narrow', 'broad']);
});

test('harness registry: resolve rejects by platform, capability and model with reasons', () => {
  const registry = new HarnessRegistry();
  registry.register({ ...CLAUDE, id: 'mac-only', platforms: ['macos'], capabilities: ['coding'] });
  registry.register({ ...CLAUDE, id: 'model-bound', capabilities: ['coding'], supportedModels: ['sonnet'] });

  const wrongPlatform = registry.resolve({ capabilities: ['coding'], platform: 'windows' });
  assert.equal(wrongPlatform.harness.id, 'model-bound');
  assert.match(wrongPlatform.rejected.map((r) => r.id).join(','), /mac-only/);

  const wrongModel = registry.resolve({ capabilities: ['coding'], platform: 'windows', model: 'gpt' });
  assert.equal(wrongModel.harness, null);
  assert.ok(wrongModel.reasons.length > 0);

  const byId = registry.resolve({ id: 'mac-only', capabilities: ['terminal'] });
  assert.equal(byId.harness.id, 'mac-only', 'an explicit id still reports its capability gap');
  assert.match(byId.reasons.join(' '), /missing capabilities/);
});

test('harness manager: select reports a policy veto instead of falling back', async () => {
  const bus = new EventBus();
  const events = [];
  bus.on(TYPES.HARNESS_SELECTED, (ev) => events.push(ev));
  const registry = new HarnessRegistry();
  registry.register({ ...CLAUDE, id: 'claude-code', capabilities: ['coding', 'files'] });
  const policy = {
    async evaluate() { return { allowed: false, reason: 'harness use denied by policy' }; },
  };
  const manager = new HarnessManager({ registry, bus, policy });

  // An explicit platform: select() defaults to the host, and this fixture
  // declares windows/macos, so leaving it out made the test assert a policy
  // veto on two runners and a platform rejection on the third.
  const decision = await manager.select({ capabilities: ['coding'], platform: 'windows', context: { taskId: 't1' } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.harness, null);
  assert.match(decision.reasons.join(' '), /denied by policy/);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.allowed, false);
});

test('harness manager: start records the ownership chain and registers the process with the sandbox', async () => {
  const registry = new HarnessRegistry();
  registry.register(CLAUDE, { transport: { start: async () => ({ pid: 7 }), stop: async () => ({}) } });
  const registered = [];
  const released = [];
  const sandbox = {
    registerProcess: (sandboxId, ref) => { registered.push({ sandboxId, ref }); return ref; },
    releaseProcess: (sandboxId, ref) => { released.push({ sandboxId, ref }); return [ref.runId]; },
  };
  const manager = new HarnessManager({ registry, sandbox });

  const run = await manager.start({
    harnessId: 'claude-code',
    ctx: { taskId: 'task-9', workspaceId: '/ws', agentId: 'coder', traceId: 'trace-1', sessionId: 'sess-1', sandboxId: 'sandbox-9' },
  });
  assert.equal(run.status, 'running');
  assert.equal(run.taskId, 'task-9');
  assert.equal(run.sandboxId, 'sandbox-9');
  assert.equal(run.traceId, 'trace-1');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].sandboxId, 'sandbox-9');
  assert.equal(registered[0].ref.harnessId, 'claude-code');

  const stopped = await manager.stop(run.runId, 'test');
  assert.equal(stopped.status, 'stopped');
  assert.equal(manager.runsForTask('task-9').length, 0);
  assert.equal(released.length, 1);
});

test('harness manager: environment is granted by mode, never inherited by default', async () => {
  const registry = new HarnessRegistry();
  registry.register({ ...CLAUDE, id: 'minimal' });
  registry.register({ ...CLAUDE, id: 'allow', environmentPolicy: { mode: 'allowlist', allowlist: ['PATH'] } });
  registry.register({ ...CLAUDE, id: 'inherit', environmentPolicy: { mode: 'inherit' } });
  const manager = new HarnessManager({ registry });

  const minimal = await manager.resolveEnvironment(registry.get('minimal'));
  assert.deepEqual(minimal.env, {});
  assert.deepEqual(minimal.secrets, []);

  const allow = await manager.resolveEnvironment(registry.get('allow'), { granted: { PATH: '/usr/bin' } });
  assert.deepEqual(allow.env, { PATH: '/usr/bin' });

  const inherited = await manager.resolveEnvironment(registry.get('inherit'), { hostEnv: { PATH: '/usr/bin', HOME: '/home/x' } });
  assert.deepEqual(Object.keys(inherited.env).sort(), ['HOME', 'PATH']);
});

test('harness manager: secret names are only granted through the policy engine', async () => {
  const registry = new HarnessRegistry();
  registry.register({ ...CLAUDE, id: 'claude-code', secretEnv: ['ANTHROPIC_API_KEY'] });

  const denyAll = new HarnessManager({ registry, policy: { evaluate: async () => ({ allowed: false, reason: 'no' }) } });
  const denied = await denyAll.resolveEnvironment(registry.get('claude-code'));
  assert.deepEqual(denied.secrets, [], 'a denied credential grants nothing');
  assert.ok(denied.denied.includes('ANTHROPIC_API_KEY'));

  const allowAll = new HarnessManager({ registry, policy: { evaluate: async () => ({ allowed: true }) } });
  const allowed = await allowAll.resolveEnvironment(registry.get('claude-code'));
  assert.deepEqual(allowed.secrets, ['ANTHROPIC_API_KEY'], 'only the name is granted; no value flows through the manager');
  assert.deepEqual(allowed.env, {});
});

test('harness presets: the built-in runtime is always present as a peer backend', () => {
  const ids = builtinHarnesses().map((h) => h.id);
  assert.ok(ids.includes('kingagent-runtime'));
  assert.ok(ids.includes('claude-code'));
  assert.ok(ids.includes('codex'));
  assert.ok(ids.includes('acp-agent'));
  const runtime = builtinHarnesses().find((h) => h.id === 'kingagent-runtime');
  assert.equal(runtime.type, 'in-process');
  assert.equal(runtime.capabilities.includes('coding'), true);
  for (const manifest of builtinHarnesses()) {
    assert.equal(validateManifest(manifest).ok, true, `${manifest.id} must validate`);
  }
});
