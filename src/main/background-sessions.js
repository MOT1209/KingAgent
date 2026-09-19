// The opt-in "detach instead of kill" registry, inspired by herdr's persistent
// pty sessions — but deliberately smaller and safer.
//
// KingAgent's default is to kill every agent process it owns on tile close,
// window close and app quit (see the `deliberateKills` comment in main.js):
// "Sessions KingAgent is ending on purpose." That default stays. This module
// only changes the outcome for a session the user explicitly marked
// persistent: instead of being killed, its OS process is left running and a
// small record is written to disk so a later launch can tell you it exists.
//
// What this does NOT do, on purpose: it does not reattach to the process's
// terminal output. Doing that properly (a tmux/screen-style multiplexer) is
// a real project of its own — the reason herdr is a dedicated Rust binary
// rather than a small patch. Without it, a "reattached" pane would show a
// live terminal that isn't actually connected to anything, which is worse
// than being honest that it isn't supported yet. What you get instead: proof
// the process is still alive (or that it finished), when it detached, and a
// way to end it if you left it running by mistake.
//
// IO is injected (the codebase's own convention — see session-registry.js)
// so this is testable without touching a real userData directory or a real
// process table.

const path = require('node:path');

const fsIo = {
  read: (f) => require('node:fs').readFileSync(f, 'utf8'),
  write: (f, t) => { require('node:fs').mkdirSync(path.dirname(f), { recursive: true }); require('node:fs').writeFileSync(f, t); },
};

// Real liveness check, injected so tests never depend on a real pid. Signal 0
// sends nothing; it only asks the kernel "does this pid exist and can I see
// it," which is exactly what "still running" means here.
function realIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function registryFile(userDataDir) {
  return path.join(userDataDir, 'background-sessions.json');
}

function readAll(io, userDataDir) {
  try {
    const parsed = JSON.parse(io.read(registryFile(userDataDir)));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(io, userDataDir, records) {
  io.write(registryFile(userDataDir), JSON.stringify(records, null, 2));
}

// Called the moment a persistent session detaches (tile close, window close,
// or app quit finding it marked persistent). Replaces any existing record for
// the same id — a session cannot be detached twice without being re-created.
function recordDetach(io, userDataDir, record) {
  if (!record || typeof record.id !== 'string' || !record.id) throw new Error('recordDetach requires a session id');
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid)) throw new Error('recordDetach requires an integer pid');
  const clean = {
    id: record.id,
    pid: record.pid,
    name: typeof record.name === 'string' ? record.name : '',
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    kind: typeof record.kind === 'string' ? record.kind : '',
    command: typeof record.command === 'string' ? record.command : '',
    program: typeof record.program === 'string' ? record.program : '',
    args: Array.isArray(record.args) ? record.args.filter((a) => typeof a === 'string') : [],
    detachedAt: typeof record.detachedAt === 'number' ? record.detachedAt : Date.now(),
  };
  const rest = readAll(io, userDataDir).filter((r) => r.id !== clean.id);
  writeAll(io, userDataDir, [...rest, clean]);
  return clean;
}

function removeRecord(io, userDataDir, id) {
  const before = readAll(io, userDataDir);
  const after = before.filter((r) => r.id !== id);
  if (after.length !== before.length) writeAll(io, userDataDir, after);
  return after.length !== before.length;
}

// The list a UI actually wants: every recorded session plus whether it is
// still alive right now. A dead one is not removed automatically — that
// would erase the fact that it finished before anyone looked, which is
// exactly the information "detach and check back later" exists to preserve.
// The caller decides when to forget a finished record (background:forget).
function listBackgroundSessions(io, userDataDir, { isAlive = realIsAlive } = {}) {
  return readAll(io, userDataDir).map((r) => ({ ...r, alive: isAlive(r.pid) }));
}

module.exports = { fsIo, realIsAlive, registryFile, recordDetach, removeRecord, listBackgroundSessions, readAll };
