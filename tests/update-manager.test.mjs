import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdateManager } = require('../src/main/updater/update-manager.js');
const { EVENTS } = require('../src/main/updater/update-events.js');
const updateCheckReal = require('../src/main/update-check.js');

// An in-memory stand-in for update-state.js's io, same shape the other
// updater test files use.
function memIo(initial = {}) {
  const files = { ...initial };
  return {
    exists: (f) => f in files,
    read: (f) => { if (!(f in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[f]; },
    write: (f, t) => { files[f] = t; },
  };
}

const STATE_FILE = '/state/update-state.json';

const release = (over = {}) => ({
  tag_name: 'v0.6.0',
  draft: false, prerelease: false,
  html_url: 'https://example.test/releases/tag/v0.6.0',
  body: '```kingagent-update\n' + JSON.stringify({
    summary: 'Major Agent Runtime improvements',
    features: ['Faster tool execution'],
    bugFixes: ['Fixed a crash'],
    securityFixes: [],
  }) + '\n```',
  assets: [],
  ...over,
});

function makeManager(extra = {}) {
  const events = [];
  const rendererEvents = [];
  const io = memIo();
  const manager = createUpdateManager({
    isPackaged: true,
    appVersion: '0.5.4',
    stateFile: STATE_FILE,
    io,
    checkImpl: updateCheckReal,
    fetchJson: async () => release(),
    updaterImpl: {
      updaterState: () => ({ state: 'idle', version: null }),
      downloadUpdate: async ({ emit }) => { emit('update:progress', { percent: 50, version: '0.6.0' }); emit('update:ready', { version: '0.6.0' }); return { state: 'ready', version: '0.6.0' }; },
      installNow: async ({ emit }) => { emit('update:ready', { version: '0.6.0' }); return { state: 'ready', version: '0.6.0' }; },
    },
    emitToRenderer: (ch, payload) => rendererEvents.push([ch, payload]),
    getActiveWork: () => 0,
    ...extra,
  });
  manager.bus.on('*', (ev) => events.push(ev));
  return { manager, events, rendererEvents, io };
}

// --- check ---------------------------------------------------------------------

test('check() finds a release and produces analysis, importance and stats', async () => {
  const { manager, events } = makeManager();
  const res = await manager.check();
  assert.equal(res.state, 'AVAILABLE');
  assert.equal(res.releaseInfo.metadata.version, '0.6.0');
  assert.equal(res.releaseInfo.analysis.stats.features, 1);
  assert.equal(res.releaseInfo.importance, 'NORMAL');
  assert.deepEqual(events.map((e) => e.type), [EVENTS.CHECK_STARTED, EVENTS.AVAILABLE]);
});

test('check() with nothing newer goes to IDLE and clears any prior offer', async () => {
  const { manager, events } = makeManager({ fetchJson: async () => release({ tag_name: 'v0.1.0' }) });
  const res = await manager.check();
  assert.equal(res.state, 'IDLE');
  assert.equal(res.releaseInfo, null);
  assert.deepEqual(events.map((e) => e.type), [EVENTS.CHECK_STARTED, EVENTS.NOT_AVAILABLE]);
});

test('check() with a security fix reports CRITICAL', async () => {
  const { manager } = makeManager({
    fetchJson: async () => release({ body: '```kingagent-update\n' + JSON.stringify({ securityFixes: ['Patched a bug'] }) + '\n```' }),
  });
  const res = await manager.check();
  assert.equal(res.releaseInfo.importance, 'CRITICAL');
});

test('a downgrade is never reported as an update', async () => {
  const { manager } = makeManager({ fetchJson: async () => release({ tag_name: 'v0.1.0' }) });
  const res = await manager.check();
  assert.equal(res.status.state, 'current');
});

// --- download --------------------------------------------------------------------

test('download() moves to READY and forwards progress + completion events', async () => {
  const { manager, events, rendererEvents } = makeManager();
  await manager.check();
  const res = await manager.download();
  assert.equal(res.state, 'READY');
  assert.deepEqual(events.map((e) => e.type).slice(-3), [EVENTS.DOWNLOAD_STARTED, EVENTS.DOWNLOAD_PROGRESS, EVENTS.DOWNLOAD_COMPLETED]);
  assert.deepEqual(rendererEvents.map((e) => e[0]), ['update:progress', 'update:ready']);
});

test('download() a second time while already READY does not start another download', async () => {
  let calls = 0;
  const { manager } = makeManager({
    updaterImpl: {
      updaterState: () => ({ state: 'ready', version: '0.6.0' }),
      downloadUpdate: async ({ emit }) => { calls += 1; emit('update:ready', { version: '0.6.0' }); return { state: 'ready', version: '0.6.0' }; },
      installNow: async () => ({ state: 'ready' }),
    },
  });
  await manager.check();
  await manager.download();
  await manager.download();
  assert.equal(calls, 1);
});

test('a failed download reports FAILED and a failed event', async () => {
  const { manager, events } = makeManager({
    updaterImpl: {
      updaterState: () => ({ state: 'failed', version: null }),
      downloadUpdate: async ({ emit }) => { emit('update:failed', {}); return { state: 'failed', version: null }; },
      installNow: async () => ({ state: 'ready' }),
    },
  });
  await manager.check();
  const res = await manager.download();
  assert.equal(res.state, 'FAILED');
  assert.ok(events.some((e) => e.type === EVENTS.FAILED && e.phase === 'download'));
});

// --- install / active-task safety --------------------------------------------------

test('install() is blocked while active work is running, unless forced', async () => {
  const { manager } = makeManager({ getActiveWork: () => 2 });
  await manager.check();
  await manager.download();
  const blocked = await manager.install();
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.activeWork, 2);
  const forced = await manager.install({ force: true });
  assert.equal(forced.blocked, false);
});

test('a successful install records install history and emits completion', async () => {
  const { manager, events, io } = makeManager();
  await manager.check();
  await manager.download();
  await manager.install();
  assert.ok(events.some((e) => e.type === EVENTS.INSTALL_COMPLETED));
  const persisted = JSON.parse(io.read(STATE_FILE));
  assert.equal(persisted.history.length, 1);
  assert.equal(persisted.history[0].installedVersion, '0.6.0');
  assert.equal(persisted.history[0].previousVersion, '0.5.4');
});

test('a failed install reports FAILED without touching history', async () => {
  const { manager, io } = makeManager({
    updaterImpl: {
      updaterState: () => ({ state: 'failed', version: null }),
      downloadUpdate: async ({ emit }) => { emit('update:ready', { version: '0.6.0' }); return { state: 'ready', version: '0.6.0' }; },
      installNow: async () => ({ state: 'failed' }),
    },
  });
  await manager.check();
  await manager.download();
  const res = await manager.install();
  assert.equal(res.blocked, false);
  assert.equal(res.state, 'FAILED');
  assert.equal(io.exists(STATE_FILE) ? JSON.parse(io.read(STATE_FILE)).history.length : 0, 0);
});

// --- postpone / retry / reminder ----------------------------------------------------

test('postpone() persists the offered version with a default 24h reminder', async () => {
  const { manager, events } = makeManager();
  await manager.check();
  const res = manager.postpone();
  assert.equal(res.state, 'POSTPONED');
  assert.equal(res.persisted.postponedVersion, '0.6.0');
  assert.ok(res.persisted.remindAt);
  assert.ok(events.some((e) => e.type === EVENTS.POSTPONED));
});

test('postpone() honors a configurable number of hours', async () => {
  const { manager } = makeManager();
  await manager.check();
  const res = manager.postpone({ hours: 1 });
  const gap = new Date(res.persisted.remindAt) - new Date(res.persisted.postponedAt);
  assert.equal(gap, 3600_000);
});

test('checkReminder() fires only once remindAt has passed', async () => {
  const { manager } = makeManager();
  await manager.check();
  manager.postpone({ hours: 1 });
  assert.equal(manager.checkReminder(Date.now()), null);
  const state = manager.getState().persisted;
  const due = manager.checkReminder(new Date(state.remindAt).getTime() + 1);
  assert.equal(due.postponedVersion, '0.6.0');
});

test('retry() re-downloads after a failure', async () => {
  let attempts = 0;
  const { manager } = makeManager({
    updaterImpl: {
      updaterState: () => ({ state: attempts < 1 ? 'failed' : 'ready', version: '0.6.0' }),
      downloadUpdate: async ({ emit }) => {
        attempts += 1;
        if (attempts === 1) { emit('update:failed', {}); return { state: 'failed', version: null }; }
        emit('update:ready', { version: '0.6.0' });
        return { state: 'ready', version: '0.6.0' };
      },
      installNow: async () => ({ state: 'ready' }),
    },
  });
  await manager.check();
  await manager.download();
  const res = await manager.retry();
  assert.equal(res.state, 'READY');
  assert.equal(attempts, 2);
});

// --- packaging guard passthrough ----------------------------------------------------

test('an unpackaged build never leaves AVAILABLE, mirroring updater.js\'s own guard', async () => {
  const { manager } = makeManager({
    isPackaged: false,
    updaterImpl: require('../src/main/updater/updater.js'),
  });
  await manager.check();
  const res = await manager.download();
  assert.equal(res.state, 'AVAILABLE');
});
