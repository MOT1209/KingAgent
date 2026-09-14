// What the Smart Update Center remembers between launches.
//
// Small and boring on purpose: one JSON file, read-merge-write, same shape as
// settings.js next door. The fields are the ones the spec asks for —
// currentVersion, availableVersion, downloadState, postponedVersion,
// postponedAt, remindAt, installState, lastCheck — plus a short bounded
// history of past installs. Nothing here talks to electron-updater directly;
// that stays update-manager.js's job. This file only remembers what was
// decided, so a reminder or a postponed update survives a quit.
//
// The path is passed in rather than read from `app` at require time, same
// reasoning as settings.js: it lets tests point this at a scratch file
// without touching Electron at all.

const fs = require('fs');
const path = require('path');

const fsIo = {
  read: (f) => fs.readFileSync(f, 'utf8'),
  exists: (f) => fs.existsSync(f),
  write: (f, t) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', t);
    fs.renameSync(f + '.tmp', f);
  },
};

const MAX_HISTORY = 5;
// 24 hours, per the spec's default reminder — configurable per call via
// `reminderMs`, and again from Settings → Updates (main.js turns the hours
// field there into this same unit before calling postpone()).
const DEFAULT_REMINDER_MS = 24 * 60 * 60 * 1000;
// A postponed update nags at most this rarely once it has been reminded and
// waved off again — the backoff policy the spec asks for, so an update
// nobody wants yet does not turn into a once-a-day interruption forever.
const MAX_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;

function defaultState() {
  return {
    currentVersion: null,
    availableVersion: null,
    downloadState: 'IDLE',
    postponedVersion: null,
    postponedAt: null,
    remindAt: null,
    installState: 'IDLE',
    lastCheck: null,
    history: [],
  };
}

function readState({ file, io = fsIo }) {
  if (!io.exists(file)) return defaultState();
  try {
    const doc = JSON.parse(io.read(file));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return defaultState();
    return { ...defaultState(), ...doc };
  } catch (_) {
    // A corrupt state file must not brick the updater; the next write
    // replaces it, same contract as settings.js.
    return defaultState();
  }
}

function writeState({ file, io = fsIo, patch }) {
  const current = readState({ file, io });
  const next = { ...current, ...patch };
  if (Array.isArray(next.history)) next.history = next.history.slice(-MAX_HISTORY);
  try {
    io.write(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  } catch (_) {
    return current;
  }
}

// ---- postpone / reminder ----------------------------------------------------

function postpone({ file, io = fsIo, version, reminderMs = DEFAULT_REMINDER_MS, now = () => Date.now() }) {
  const t = now();
  return writeState({
    file, io,
    patch: {
      postponedVersion: version,
      postponedAt: new Date(t).toISOString(),
      remindAt: new Date(t + reminderMs).toISOString(),
    },
  });
}

function clearPostponed({ file, io = fsIo }) {
  return writeState({ file, io, patch: { postponedVersion: null, postponedAt: null, remindAt: null } });
}

// Is a stored postponement due to be shown again, right now?
function reminderDue({ state, now = Date.now() }) {
  if (!state || !state.postponedVersion || !state.remindAt) return false;
  return new Date(state.remindAt).getTime() <= now;
}

// Called after a reminder was shown and waved off again (not accepted, not
// re-postponed with a fresh interval): doubles the wait, capped at
// MAX_BACKOFF_MS, so the same update does not knock every single day.
function backOffReminder({ file, io = fsIo, reminderMs = DEFAULT_REMINDER_MS, now = () => Date.now() }) {
  const state = readState({ file, io });
  if (!state.postponedVersion) return state;
  const t = now();
  const priorGap = (state.postponedAt && state.remindAt)
    ? (new Date(state.remindAt).getTime() - new Date(state.postponedAt).getTime())
    : reminderMs;
  const nextGap = Math.min(Math.max(priorGap, reminderMs) * 2, MAX_BACKOFF_MS);
  return writeState({ file, io, patch: { postponedAt: new Date(t).toISOString(), remindAt: new Date(t + nextGap).toISOString() } });
}

// ---- install history ---------------------------------------------------------
// { previousVersion, installedVersion, installedAt, updateResult }

function recordHistory({ file, io = fsIo, entry }) {
  const state = readState({ file, io });
  const history = [...(state.history || []), entry].slice(-MAX_HISTORY);
  return writeState({ file, io, patch: { history } });
}

module.exports = {
  readState,
  writeState,
  postpone,
  clearPostponed,
  reminderDue,
  backOffReminder,
  recordHistory,
  defaultState,
  fsIo,
  DEFAULT_REMINDER_MS,
  MAX_BACKOFF_MS,
  MAX_HISTORY,
};
