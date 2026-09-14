// The Smart Update Center's event bus.
//
// Every state transition the update manager makes — checked, found, started
// downloading, failed, postponed — turns into one of these events. main.js
// (or a test) listens and does what it wants with them: broadcast to windows,
// write a log line, assert on them. This file only shapes the envelope and
// hands events out; it has no opinion about what happens next.
//
// The envelope is deliberately small: eventId, version, currentVersion,
// platform, timestamp, plus whatever the caller adds. Nothing here ever
// carries a download URL, a token, or a file path — the spec's "do not log
// secrets" is satisfied by never having a secret to log in the first place,
// not by scrubbing one at the last second.

const { EventEmitter } = require('events');
const crypto = require('crypto');

const EVENTS = Object.freeze({
  CHECK_STARTED: 'update.check.started',
  AVAILABLE: 'update.available',
  NOT_AVAILABLE: 'update.not_available',
  DOWNLOAD_STARTED: 'update.download.started',
  DOWNLOAD_PROGRESS: 'update.download.progress',
  DOWNLOAD_COMPLETED: 'update.download.completed',
  INSTALL_STARTED: 'update.install.started',
  INSTALL_COMPLETED: 'update.install.completed',
  POSTPONED: 'update.postponed',
  REMINDER: 'update.reminder',
  FAILED: 'update.failed',
});

const EVENT_NAMES = new Set(Object.values(EVENTS));

// randomUUID landed in Node 14.17 / every Electron KingAgent ships on; no fallback
// needed. Kept behind a function so a test can stub it without touching crypto.
function newEventId() { return crypto.randomUUID(); }

function createEventBus({ platform = process.platform, nowIso = () => new Date().toISOString(), id = newEventId } = {}) {
  const emitter = new EventEmitter();
  // Ten windows times a handful of subscribers each is still well under the
  // default cap, but the default warning is a red herring here — nothing is
  // leaking, there are just several legitimate listeners (main's broadcaster,
  // the state writer, a test). Raised once, not disabled.
  emitter.setMaxListeners(50);

  function emit(type, payload = {}) {
    if (!EVENT_NAMES.has(type)) throw new Error(`unknown update event: ${type}`);
    const { currentVersion = null, version = null, ...rest } = payload;
    const envelope = Object.freeze({
      eventId: id(),
      type,
      version,
      currentVersion,
      platform,
      timestamp: nowIso(),
      ...rest,
    });
    emitter.emit(type, envelope);
    emitter.emit('*', envelope);
    return envelope;
  }

  return {
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.removeListener.bind(emitter),
    emit,
  };
}

module.exports = { EVENTS, createEventBus };
