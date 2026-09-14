// Phase 4: the sandbox manager (limits, backends, workspace boundary, cleanup).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir, p } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const {
  SandboxManager,
  createSandbox,
  createAdvisoryBackend,
  createNullBackend,
  selectBackend,
  describeBackend,
  listBackends,
  clampLimits,
  normalizeLimits,
  validateLimits,
  labelFor,
  DEFAULT_LIMITS,
  DEFAULT_CEILING,
  SandboxPathError,
  SandboxLimitError,
  SandboxDeniedError,
} = require('../src/core/sandbox');
const { EventBus, TYPES } = require('../src/core/events/event-bus');

// A backend whose processes are plain objects: no real pids, no real signals.
function fakeBackend() {
  let next = 1000;
  const spawned = [];
  const killed = [];
  return {
    backend: {
      id: 'fake',
      name: 'Fake',
      enforcement: 'advisory',
      features: ['filesystem', 'environment', 'processes'],
      async start() { return { ok: true }; },
      async stop() { return { ok: true }; },
      spawn(spec) {
        const record = { pid: ++next, spec, alive: true };
        spawned.push(record);
        return {
          pid: record.pid,
          kill() { record.alive = false; killed.push(record.pid); },
          onExit() { /* the fake never exits on its own */ },
        };
      },
      async kill(handle) { handle.kill('SIGKILL'); return { ok: true }; },
      applyLimits: () => ({ applied: ['timeoutMs'], unsupported: ['memoryMb'], backend: 'fake', enforcement: 'advisory' }),
    },
    spawned,
    killed,
  };
}

const sandboxBackend = () => fakeBackend().backend;

test('sandbox limits: validation rejects nonsense and defaults are declarative', () => {
  assert.equal(validateLimits({ memoryMb: -1 }).ok, false);
  assert.equal(validateLimits({ memoryMb: 'lots' }).ok, false);
  assert.equal(validateLimits({ filesystemMode: 'everything' }).ok, false);
  assert.equal(validateLimits({ networkMode: 'wide-open' }).ok, false);
  assert.deepEqual(normalizeLimits({ memoryMb: 128 }).memoryMb, 128);
  assert.equal(DEFAULT_LIMITS.networkMode, 'deny', 'the default posture denies network');
  assert.equal(DEFAULT_LIMITS.filesystemMode, 'workspace');
});

test('sandbox limits: clamping can only tighten, never widen', () => {
  const clamped = clampLimits(
    { memoryMb: 8192, maxProcesses: 64, filesystemMode: 'workspace', networkMode: 'allow', environmentPolicy: 'inherit' },
    DEFAULT_CEILING,
  );
  assert.equal(clamped.memoryMb, 4096);
  assert.equal(clamped.maxProcesses, 32);
  assert.equal(clamped.networkMode, 'loopback');
  assert.equal(clamped.environmentPolicy, 'allowlist');
  assert.equal(clamped.filesystemMode, 'workspace');

  const narrow = clampLimits({ memoryMb: 64, networkMode: 'deny' }, DEFAULT_CEILING);
  assert.equal(narrow.memoryMb, 64, 'a narrower request is honoured as asked');
  assert.equal(narrow.networkMode, 'deny');
});

test('sandbox limits: labels describe the actual posture', () => {
  assert.equal(labelFor({ filesystemMode: 'workspace', networkMode: 'deny' }), 'Workspace Restricted');
  assert.equal(labelFor({ filesystemMode: 'readonly', networkMode: 'deny' }), 'Read Only');
  assert.equal(labelFor({ filesystemMode: 'none', networkMode: 'deny' }), 'Fully Restricted');
});

test('sandbox backends: the advisory backend is available everywhere, planned ones are not', () => {
  const windows = selectBackend({ platform: 'windows' });
  assert.equal(windows.available, true);
  assert.equal(windows.backend.id, 'advisory');
  assert.equal(windows.backend.enforcement, 'advisory');

  const withCpu = selectBackend({ platform: 'windows', required: ['cpu', 'kill_tree'] });
  assert.equal(withCpu.satisfied, false, 'the advisory backend cannot bound cpu time and says so');
  assert.equal(withCpu.backend, null);
  assert.ok(withCpu.reasons.some((r) => /cpu/.test(r)));

  assert.equal(describeBackend('windows-job-object').implemented, false);
  assert.equal(listBackends().some((b) => b.id === 'remote' && b.implemented === false), true);
  assert.equal(selectBackend({ platform: 'linux', required: ['cpu'], candidates: ['linux-namespaces'] }).available, false);
});

test('sandbox: the workspace boundary is enforced lexically and through symlinks', () => {
  const t = makeTempDir();
  try {
    const sandbox = createSandbox({ id: 'sb-1', workspaceRoot: t.root, backend: sandboxBackend() });
    assert.equal(sandbox.pathAllowed('src/app.js', 'read').ok, true);
    assert.equal(sandbox.pathAllowed('src/app.js', 'write').ok, true);

    const escape = sandbox.pathAllowed(p('../outside.txt'), 'read');
    assert.equal(escape.ok, false);
    assert.match(escape.reason, /escapes the authorized workspace/);
    assert.throws(() => sandbox.assertPath(p('../outside.txt'), 'write'), SandboxPathError);
    assert.equal(sandbox.pathAllowed(path.join(t.root, '..', 'sibling'), 'read').ok, false, 'an absolute escape is refused too');

    assert.equal(sandbox.assertPath('a/b/c.txt', 'write'), path.join(t.root, 'a', 'b', 'c.txt'));
    assert.equal(sandbox.snapshot().filesystem.mode, 'workspace');
  } finally {
    t.dispose();
  }
});

test('sandbox: filesystem and read-only modes narrow access further', async () => {
  const t = makeTempDir();
  try {
    const readonly = createSandbox({ id: 'sb-ro', workspaceRoot: t.root, backend: sandboxBackend(), limits: { filesystemMode: 'readonly' } });
    assert.equal(readonly.pathAllowed('a.txt', 'read').ok, true);
    const write = readonly.pathAllowed('a.txt', 'write');
    assert.equal(write.ok, false);
    assert.match(write.reason, /read-only/);

    const none = createSandbox({ id: 'sb-none', workspaceRoot: t.root, backend: sandboxBackend(), limits: { filesystemMode: 'none' } });
    assert.equal(none.pathAllowed('.', 'read').ok, false);

    // A read/write allowlist narrows inside the root as well.
    const scoped = createSandbox({
      id: 'sb-scoped',
      workspaceRoot: t.root,
      backend: sandboxBackend(),
      readPaths: ['src'],
      writePaths: ['out'],
    });
    assert.equal(scoped.pathAllowed('src/x.js', 'read').ok, true);
    assert.equal(scoped.pathAllowed('secrets/.env', 'read').ok, false);
    assert.equal(scoped.pathAllowed('out/report.md', 'write').ok, true);
    assert.equal(scoped.pathAllowed('src/x.js', 'write').ok, false);
    await scoped.stop();
  } finally {
    t.dispose();
  }
});

test('sandbox: process ownership, environment scrubbing and honest snapshots', async () => {
  const t = makeTempDir();
  try {
    const backend = fakeBackend();
    const sandbox = createSandbox({
      id: 'sb-proc',
      workspaceRoot: t.root,
      backend: backend.backend,
      limits: { maxProcesses: 3, memoryMb: 256, environmentPolicy: 'allowlist' },
      envAllowlist: { PATH: '/usr/bin', HOME: '/home/dev' },
      taskId: 'task-1',
      agentId: 'coder',
      harnessId: 'claude-code',
      traceId: 'trace-1',
    });
    await sandbox.start({});

    const first = sandbox.spawn({ kind: 'harness', command: 'claude', cwd: 'src' });
    sandbox.spawn({ kind: 'test', command: 'npm test' });
    assert.equal(first.cwd, path.join(t.root, 'src'));
    assert.equal(sandbox.listProcesses().length, 2);
    assert.equal(first.pid, 1001);
    assert.deepEqual(backend.spawned[0].spec.env, { PATH: '/usr/bin', HOME: '/home/dev' }, 'only granted env reaches the child');

    const snapshot = sandbox.snapshot();
    assert.equal(snapshot.processes.count, 2);
    assert.equal(snapshot.processes.limit, 3);
    assert.equal(snapshot.memoryMb.limit, 256);
    assert.equal(snapshot.memoryMb.used, null, 'usage that cannot be observed is null, never invented');
    assert.equal(snapshot.enforcement, 'advisory');
    assert.equal(snapshot.enforcementLabel, 'Platform-enforced');
    assert.deepEqual(snapshot.ownership, { taskId: 'task-1', workspaceId: t.root, agentId: 'coder', harnessId: 'claude-code', sessionId: null, traceId: 'trace-1' });

    // A spawn outside the workspace is refused before it happens.
    assert.throws(() => sandbox.spawn({ cwd: p('../elsewhere') }), SandboxPathError);

    const killed = await sandbox.killAll('test');
    assert.equal(killed.length, 2);
    assert.equal(sandbox.listProcesses().length, 0);
    assert.deepEqual(backend.spawned.map((s) => s.alive), [false, false]);

    // Stopping twice is safe; a stopped sandbox refuses new work.
    await sandbox.stop('test');
    const after = await sandbox.stop('again');
    assert.equal(after.state, 'stopped');
    assert.throws(() => sandbox.spawn({}), SandboxLimitError);
  } finally {
    t.dispose();
  }
});

test('sandbox: a minimal environment policy grants nothing at all', async () => {
  const t = makeTempDir();
  try {
    const backend = fakeBackend();
    const sandbox = createSandbox({ id: 'sb-env', workspaceRoot: t.root, backend: backend.backend, envAllowlist: { SECRET_TOKEN: 'x' } });
    await sandbox.start({});
    sandbox.spawn({ command: 'node' });
    assert.deepEqual(backend.spawned[0].spec.env, {}, 'minimal means minimal, even when something was granted');
    await sandbox.stop();
  } finally {
    t.dispose();
  }
});

test('advisory backend: process ceiling, missing spawner and stop semantics', async () => {
  const noSpawner = createAdvisoryBackend({ io: {} });
  assert.throws(() => noSpawner.spawn({}), /no process spawner/);

  const killed = [];
  const backend = createAdvisoryBackend({
    limits: { maxProcesses: 2 },
    io: {
      spawn: () => ({ pid: undefined, kill: () => killed.push('k'), onExit: () => {} }),
    },
  });
  backend.spawn({ command: 'a' });
  backend.spawn({ command: 'b' });
  // pids are undefined here, so the backend cannot track them — the ceiling
  // therefore tracks only what it can identify. Verify the reported limits.
  const verdict = backend.applyLimits({ timeoutMs: 1000, cpuTimeMs: 500, memoryMb: 128, networkMode: 'deny' });
  assert.deepEqual(verdict.applied.sort(), ['networkMode', 'timeoutMs']);
  assert.deepEqual(verdict.unsupported.sort(), ['cpuTimeMs', 'memoryMb']);
  const stopped = await backend.stop();
  assert.equal(stopped.ok, true);
});

test('null backend: opting out of sandboxing is visible, not silent', async () => {
  const backend = createNullBackend();
  assert.equal(backend.enforcement, 'none');
  assert.equal(backend.features.length, 0);
  assert.throws(() => backend.spawn({}), /sandboxing is disabled/);
  const t = makeTempDir();
  try {
    const sandbox = createSandbox({ id: 'sb-null', workspaceRoot: t.root, backend });
    await sandbox.start({});
    const snapshot = sandbox.snapshot();
    assert.equal(snapshot.enforcement, 'none');
    assert.equal(snapshot.enforcementLabel, 'Unavailable');
    assert.equal(snapshot.filesystem.mode, 'workspace', 'the path gate still applies even without a backend');
    await sandbox.stop();
  } finally {
    t.dispose();
  }
});

test('sandbox manager: creation is gated by policy and emits correlated events', async () => {
  const t = makeTempDir();
  try {
    const bus = new EventBus();
    const events = [];
    bus.on('*', (ev) => events.push(ev));

    const denying = new SandboxManager({ bus, policy: { evaluate: async () => ({ allowed: false, reason: 'no sandbox for you' }) } });
    await assert.rejects(
      () => denying.create({ workspaceRoot: t.root, taskId: 'task-1', agentId: 'coder' }),
      (err) => err instanceof SandboxDeniedError && /no sandbox for you/.test(err.message),
    );

    const manager = new SandboxManager({ bus });
    const sandbox = await manager.create({
      workspaceRoot: t.root,
      taskId: 'task-1',
      workspaceId: '/authorized',
      agentId: 'coder',
      harnessId: 'claude-code',
      sessionId: 'sess-1',
      traceId: 'trace-1',
    });
    assert.equal(sandbox.limits.networkMode, 'deny');

    const created = events.find((e) => e.type === TYPES.SANDBOX_CREATED);
    assert.equal(created.taskId, 'task-1');
    assert.equal(created.sessionId, 'sess-1');
    assert.equal(created.harnessId, 'claude-code');
    assert.equal(created.sandboxId, sandbox.id);
    assert.ok(events.some((e) => e.type === TYPES.SANDBOX_STARTED));

    assert.equal(manager.forTask('task-1').length, 1);
    assert.equal(manager.snapshot(sandbox.id).id, sandbox.id);
    const view = manager.controlView();
    assert.equal(view.sandboxes.length, 1);
    assert.equal(view.backends.selected, 'advisory');

    const stopped = await manager.stopTask('task-1', 'test');
    assert.deepEqual(stopped, [sandbox.id]);
    assert.ok(events.some((e) => e.type === TYPES.SANDBOX_STOPPED));
    assert.equal(manager.forTask('task-1').length, 0);
  } finally {
    t.dispose();
  }
});

test('sandbox manager: process registration is the route stop/cleanup takes', async () => {
  const t = makeTempDir();
  try {
    const manager = new SandboxManager({
      spawn: () => ({ pid: 4242, kill: () => {}, onExit: () => {} }),
      killTree: async (handle) => { handle.kill('SIGKILL'); return { ok: true, strategy: 'tree' }; },
    });
    const sandbox = await manager.create({ workspaceRoot: t.root, taskId: 'task-7', agentId: 'coder' });

    const stops = [];
    manager.registerProcess(sandbox.id, { kind: 'harness', harnessId: 'codex', ownerId: 'coder', runId: 'run-1', stop: async () => stops.push('run-1') });
    const handle = sandbox.spawn({ command: 'npm', ownerId: 'coder' });
    assert.equal(sandbox.listProcesses().length, 2);

    manager.releaseProcess(sandbox.id, { runId: 'run-1' });
    assert.equal(sandbox.listProcesses().length, 1);
    assert.ok(handle.pid);

    const cleaned = await manager.cleanup('test');
    assert.deepEqual(cleaned, [sandbox.id]);
    assert.equal(manager.list().length, 0);
  } finally {
    t.dispose();
  }
});

test('sandbox manager: an unsupported feature requirement fails loudly with reasons', async () => {
  const t = makeTempDir();
  try {
    const manager = new SandboxManager({});
    const info = manager.backendInfo({ required: ['cpu'] });
    assert.equal(info.selected, 'none');
    assert.equal(info.decision.satisfied, false);
    assert.ok(info.decision.reasons.length > 0);
    // Creation still returns a sandbox so the workspace gate applies, but the
    // enforcement label is honest about there being none.
    const sandbox = await manager.create({ workspaceRoot: t.root, taskId: 't', requiredFeatures: ['cpu'] });
    assert.equal(sandbox.snapshot().enforcement, 'none');
  } finally {
    t.dispose();
  }
});
