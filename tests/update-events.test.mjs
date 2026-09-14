import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EVENTS, createEventBus } = require('../src/main/updater/update-events.js');

test('every documented event type is a distinct string', () => {
  const values = Object.values(EVENTS);
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.includes('update.available'));
  assert.ok(values.includes('update.download.progress'));
  assert.ok(values.includes('update.failed'));
});

test('emit rejects an unknown event type', () => {
  const bus = createEventBus();
  assert.throws(() => bus.emit('update.made_up', {}));
});

test('the envelope carries eventId, version, currentVersion, platform and timestamp', () => {
  const bus = createEventBus({ platform: 'darwin', nowIso: () => '2026-01-01T00:00:00.000Z', id: () => 'evt-1' });
  let seen = null;
  bus.on(EVENTS.AVAILABLE, (ev) => { seen = ev; });
  bus.emit(EVENTS.AVAILABLE, { currentVersion: '0.5.4', version: '0.6.0' });
  assert.deepEqual(seen, {
    eventId: 'evt-1',
    type: EVENTS.AVAILABLE,
    version: '0.6.0',
    currentVersion: '0.5.4',
    platform: 'darwin',
    timestamp: '2026-01-01T00:00:00.000Z',
  });
});

test('extra payload fields pass through, but never a url or token key by accident of this test', () => {
  const bus = createEventBus();
  let seen = null;
  bus.on(EVENTS.DOWNLOAD_PROGRESS, (ev) => { seen = ev; });
  bus.emit(EVENTS.DOWNLOAD_PROGRESS, { currentVersion: '0.5.4', version: '0.6.0', percent: 42 });
  assert.equal(seen.percent, 42);
  assert.equal('url' in seen, false);
  assert.equal('token' in seen, false);
});

test('a wildcard listener hears every event type', () => {
  const bus = createEventBus();
  const seen = [];
  bus.on('*', (ev) => seen.push(ev.type));
  bus.emit(EVENTS.CHECK_STARTED, {});
  bus.emit(EVENTS.NOT_AVAILABLE, {});
  assert.deepEqual(seen, [EVENTS.CHECK_STARTED, EVENTS.NOT_AVAILABLE]);
});

test('missing version/currentVersion default to null rather than undefined', () => {
  const bus = createEventBus();
  let seen = null;
  bus.on(EVENTS.FAILED, (ev) => { seen = ev; });
  bus.emit(EVENTS.FAILED, {});
  assert.equal(seen.version, null);
  assert.equal(seen.currentVersion, null);
});

test('off stops a listener from hearing further events', () => {
  const bus = createEventBus();
  let count = 0;
  const handler = () => { count += 1; };
  bus.on(EVENTS.REMINDER, handler);
  bus.emit(EVENTS.REMINDER, {});
  bus.off(EVENTS.REMINDER, handler);
  bus.emit(EVENTS.REMINDER, {});
  assert.equal(count, 1);
});
