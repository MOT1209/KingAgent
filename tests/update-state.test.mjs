import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readState, writeState, postpone, clearPostponed, reminderDue, backOffReminder, recordHistory, defaultState,
} = require('../src/main/updater/update-state.js');

// An in-memory stand-in for fs, same shape as settings.js's own tests use —
// this file writes with read-merge-rename, and the stub mirrors that without
// touching a real disk.
function memIo(initial = {}) {
  const files = { ...initial };
  return {
    files,
    exists: (f) => f in files,
    read: (f) => { if (!(f in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[f]; },
    write: (f, t) => { files[f.replace(/\.tmp$/, '')] = t; },
  };
}

const FILE = '/state/update-state.json';

// --- reading -------------------------------------------------------------------

test('no file on disk reads as the default, empty state', () => {
  assert.deepEqual(readState({ file: FILE, io: memIo() }), defaultState());
});

test('a corrupt file reads as the default state rather than throwing', () => {
  assert.deepEqual(readState({ file: FILE, io: memIo({ [FILE]: 'not json{' }) }), defaultState());
});

test('an array on disk is not treated as valid state', () => {
  assert.deepEqual(readState({ file: FILE, io: memIo({ [FILE]: '[1,2,3]' }) }), defaultState());
});

test('a real file merges over the defaults, keeping fields it did not set', () => {
  const io = memIo({ [FILE]: JSON.stringify({ currentVersion: '0.5.4' }) });
  const st = readState({ file: FILE, io });
  assert.equal(st.currentVersion, '0.5.4');
  assert.equal(st.downloadState, 'IDLE');
});

// --- writing ---------------------------------------------------------------------

test('writeState merges a patch and persists it', () => {
  const io = memIo();
  writeState({ file: FILE, io, patch: { availableVersion: '0.6.0' } });
  assert.equal(readState({ file: FILE, io }).availableVersion, '0.6.0');
});

test('history is bounded to the last few entries', () => {
  const io = memIo();
  const history = Array.from({ length: 10 }, (_, i) => ({ installedVersion: String(i) }));
  const next = writeState({ file: FILE, io, patch: { history } });
  assert.equal(next.history.length, 5);
  assert.equal(next.history[next.history.length - 1].installedVersion, '9');
});

// --- postpone / reminder ----------------------------------------------------------

test('postpone stamps a version, a time, and a remindAt 24h out by default', () => {
  const io = memIo();
  const now = () => Date.parse('2026-01-01T00:00:00Z');
  const st = postpone({ file: FILE, io, version: '0.6.0', now });
  assert.equal(st.postponedVersion, '0.6.0');
  assert.equal(st.postponedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(st.remindAt, '2026-01-02T00:00:00.000Z');
});

test('the reminder interval is configurable', () => {
  const io = memIo();
  const now = () => Date.parse('2026-01-01T00:00:00Z');
  const st = postpone({ file: FILE, io, version: '0.6.0', reminderMs: 3600_000, now });
  assert.equal(st.remindAt, '2026-01-01T01:00:00.000Z');
});

test('clearPostponed removes the postponed fields entirely', () => {
  const io = memIo();
  postpone({ file: FILE, io, version: '0.6.0' });
  const st = clearPostponed({ file: FILE, io });
  assert.deepEqual([st.postponedVersion, st.postponedAt, st.remindAt], [null, null, null]);
});

test('reminderDue is false before remindAt and true at or after it', () => {
  const state = { postponedVersion: '0.6.0', remindAt: '2026-01-02T00:00:00.000Z' };
  assert.equal(reminderDue({ state, now: Date.parse('2026-01-01T23:59:59Z') }), false);
  assert.equal(reminderDue({ state, now: Date.parse('2026-01-02T00:00:00Z') }), true);
  assert.equal(reminderDue({ state, now: Date.parse('2026-01-03T00:00:00Z') }), true);
});

test('reminderDue is false with nothing postponed', () => {
  assert.equal(reminderDue({ state: defaultState(), now: Date.now() }), false);
});

test('backOffReminder doubles the gap, so an ignored update stops nagging daily', () => {
  const io = memIo();
  let now = Date.parse('2026-01-01T00:00:00Z');
  postpone({ file: FILE, io, version: '0.6.0', reminderMs: 24 * 3600_000, now: () => now });
  now = Date.parse('2026-01-02T00:00:00Z'); // the reminder fired
  const st = backOffReminder({ file: FILE, io, reminderMs: 24 * 3600_000, now: () => now });
  // gap was 24h, doubled to 48h from the new "now"
  assert.equal(st.remindAt, '2026-01-04T00:00:00.000Z');
});

test('backOffReminder is capped rather than growing forever', () => {
  const io = memIo();
  let now = Date.parse('2026-01-01T00:00:00Z');
  postpone({ file: FILE, io, version: '0.6.0', reminderMs: 6 * 24 * 3600_000, now: () => now });
  now = Date.parse('2026-01-07T00:00:00Z');
  const st = backOffReminder({ file: FILE, io, reminderMs: 6 * 24 * 3600_000, now: () => now });
  const gap = new Date(st.remindAt).getTime() - now;
  assert.ok(gap <= 7 * 24 * 3600_000);
});

test('backOffReminder does nothing when nothing is postponed', () => {
  const io = memIo();
  const st = backOffReminder({ file: FILE, io });
  assert.equal(st.postponedVersion, null);
});

// --- history -----------------------------------------------------------------------

test('recordHistory appends without clobbering the rest of the state', () => {
  const io = memIo();
  writeState({ file: FILE, io, patch: { currentVersion: '0.6.0' } });
  recordHistory({ file: FILE, io, entry: { previousVersion: '0.5.4', installedVersion: '0.6.0', installedAt: 'x', updateResult: 'ok' } });
  const st = readState({ file: FILE, io });
  assert.equal(st.currentVersion, '0.6.0');
  assert.equal(st.history.length, 1);
  assert.equal(st.history[0].installedVersion, '0.6.0');
});
