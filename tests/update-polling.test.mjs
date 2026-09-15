import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUpdatePolling, DEFAULT_INTERVAL_MS, DEFAULT_LAUNCH_DELAY_MS } = require('../src/main/update-polling.js');

// A manager that answers whatever the test tells it to, and counts what it was
// asked for. The real one talks to GitHub and to electron-updater.
function fakeManager({ status = { state: 'current' }, downloadFails = false, installFails = false, reminder = null } = {}) {
  const calls = { check: 0, download: 0, install: 0, checkReminder: 0 };
  return {
    calls,
    manager: () => ({
      check: async () => { calls.check += 1; return { status }; },
      download: () => { calls.download += 1; return downloadFails ? Promise.reject(new Error('offline')) : Promise.resolve(); },
      install: async () => { calls.install += 1; if (installFails) throw new Error('refused'); },
      checkReminder: () => { calls.checkReminder += 1; return reminder; },
    }),
  };
}

// The schedule, recorded rather than waited on: a test that slept six hours is
// not a test.
function fakeClock() {
  const timeouts = [];
  const intervals = [];
  return {
    timeouts,
    intervals,
    unrefd: [],
    scheduleTimeout(fn, ms) {
      const h = { fn, ms, unref() { this.unrefd = true; return this; } };
      timeouts.push(h);
      return h;
    },
    scheduleInterval(fn, ms) {
      const h = { fn, ms, unref() { this.unrefd = true; return this; } };
      intervals.push(h);
      return h;
    },
  };
}

function build({
  settings = {}, packaged = true, review = false, staged = false, clock = fakeClock(), managerOpts = {},
} = {}) {
  const { manager, calls } = fakeManager(managerOpts);
  const emitted = [];
  let current = settings;
  const polling = createUpdatePolling({
    manager,
    readSettings: () => current,
    isPackaged: () => packaged,
    review,
    emit: (channel, payload) => emitted.push([channel, payload]),
    hasStagedUpdate: () => staged,
    scheduleTimeout: clock.scheduleTimeout,
    scheduleInterval: clock.scheduleInterval,
  });
  return { polling, calls, emitted, clock, setSettings: (s) => { current = s; } };
}

// --- checking ---------------------------------------------------------------

test('a check the user switched off asks GitHub nothing at all', async () => {
  const { polling, calls, emitted } = build({ settings: { updatesAutoCheck: false } });
  assert.equal(await polling.poll(), null);
  assert.equal(calls.check, 0);
  assert.deepEqual(emitted, []);
});

test('the poll is on unless it was explicitly switched off', async () => {
  const { polling, calls } = build({ settings: {} });
  await polling.poll();
  assert.equal(calls.check, 1);
});

test('an available update is announced to the windows and remembered for a later boot', async () => {
  const { polling, emitted } = build({
    managerOpts: { status: { state: 'update', version: '0.6.0', url: 'https://example.test/k.exe' } },
  });
  const offered = await polling.poll();
  assert.deepEqual(offered, { version: '0.6.0', url: 'https://example.test/k.exe' });
  assert.deepEqual(emitted, [['update:available', { version: '0.6.0', url: 'https://example.test/k.exe' }]]);
  // what a window opened afterwards is told, rather than checking again
  assert.deepEqual(polling.lastOffered, { version: '0.6.0', url: 'https://example.test/k.exe' });
});

test('being up to date announces nothing and forgets nothing', async () => {
  const { polling, emitted } = build({ managerOpts: { status: { state: 'current' } } });
  assert.equal(await polling.poll(), null);
  assert.deepEqual(emitted, []);
  assert.equal(polling.lastOffered, null);
});

test('nothing is downloaded unless the user opened that door themselves', async () => {
  const { polling, calls } = build({
    settings: {},
    managerOpts: { status: { state: 'update', version: '0.6.0', url: 'u' } },
  });
  await polling.poll();
  assert.equal(calls.download, 0);
});

test('with automatic download on, the prefetch happens — and a failure stays silent', async () => {
  const { polling, calls } = build({
    settings: { updatesAutoDownload: true },
    managerOpts: { status: { state: 'update', version: '0.6.0', url: 'u' }, downloadFails: true },
  });
  await polling.poll();   // must not reject: a background prefetch is not an alarm
  assert.equal(calls.download, 1);
});

// --- installing on launch ---------------------------------------------------

test('install-on-launch installs only when the setting is on and a download is really sitting there', async () => {
  const cases = [
    [{ updatesInstallOnLaunch: true }, true, true, 1],
    [{ updatesInstallOnLaunch: true }, false, true, 0],
    [{ updatesInstallOnLaunch: false }, true, true, 0],
    [{}, true, true, 0],
    [{ updatesInstallOnLaunch: true }, true, false, 0],
  ];
  for (const [settings, packaged, staged, expected] of cases) {
    const { polling, calls } = build({ settings, packaged, staged });
    await polling.autoInstallOnLaunch();
    assert.equal(calls.install, expected, `${JSON.stringify({ settings, packaged, staged })} → ${expected}`);
  }
});

test('a review build never installs anything on launch', async () => {
  const { polling, calls } = build({ settings: { updatesInstallOnLaunch: true }, staged: true, review: true });
  await polling.autoInstallOnLaunch();
  assert.equal(calls.install, 0);
});

test('a refused install is swallowed — this runs eight seconds into a launch, unasked', async () => {
  const { polling } = build({
    settings: { updatesInstallOnLaunch: true },
    staged: true,
    managerOpts: { installFails: true },
  });
  assert.equal(await polling.autoInstallOnLaunch(), false);
});

// --- the postponed reminder -------------------------------------------------

test('a due reminder comes back, keeping the download url the earlier offer carried', async () => {
  const { polling, emitted } = build({
    managerOpts: { status: { state: 'update', version: '0.6.0', url: 'https://example.test/k.exe' }, reminder: { postponedVersion: '0.6.0' } },
  });
  await polling.poll();
  const again = polling.checkReminder();
  assert.deepEqual(again, { version: '0.6.0', url: 'https://example.test/k.exe' });
  assert.deepEqual(emitted.at(-1), ['update:reminder', { version: '0.6.0' }]);
});

test('nothing due means nothing said', () => {
  const { polling, emitted } = build();
  assert.equal(polling.checkReminder(), null);
  assert.deepEqual(emitted, []);
});

// --- the schedule -----------------------------------------------------------

test('development and review builds are never polled', () => {
  for (const [packaged, review] of [[false, false], [true, true]]) {
    const clock = fakeClock();
    const { polling } = build({ packaged, review, clock });
    assert.equal(polling.start(), false);
    assert.equal(clock.timeouts.length, 0, 'no launch beat');
    assert.equal(clock.intervals.length, 0, 'and no six-hourly poll');
  }
});

test('a packaged build checks once after launch and then every six hours, all unref\u2019d', () => {
  const clock = fakeClock();
  const { polling } = build({ clock });
  assert.equal(polling.start(), true);
  assert.deepEqual(clock.timeouts.map((t) => t.ms), [DEFAULT_LAUNCH_DELAY_MS, DEFAULT_LAUNCH_DELAY_MS, DEFAULT_LAUNCH_DELAY_MS]);
  assert.deepEqual(clock.intervals.map((t) => t.ms), [DEFAULT_INTERVAL_MS]);
  assert.equal(DEFAULT_INTERVAL_MS, 6 * 60 * 60 * 1000);
  for (const h of [...clock.timeouts, ...clock.intervals]) {
    assert.equal(h.unrefd, true, 'a timer that keeps the process alive would hold the app open');
  }
});

// --- the manual check -------------------------------------------------------

test('a manual check re-arms a version somebody once waved away', () => {
  const { polling } = build();
  assert.deepEqual(polling.note('0.6.0', 'https://example.test/k.exe'),
    { version: '0.6.0', url: 'https://example.test/k.exe' });
  assert.deepEqual(polling.lastOffered, { version: '0.6.0', url: 'https://example.test/k.exe' });
});

test('note() with no version leaves the previous answer alone', () => {
  const { polling } = build();
  polling.note('0.6.0', 'u');
  assert.equal(polling.note(undefined, 'u'), null);
  assert.deepEqual(polling.lastOffered, { version: '0.6.0', url: 'u' });
});
