// The disposable sandbox worker. Spawned by code-exec.js (child_process.fork)
// and owned by it: the parent scrubs the environment, caps the heap, and KILLS
// this process when the wall-clock timeout elapses.
//
// Security model (read code-exec.js for the full statement): this process IS
// the boundary. If sandboxed code breaks out of the `vm` context created here
// it only reaches THIS process — a stripped-env, memory-capped, ephemeral
// child — never the Electron main process. The child talks to its parent over
// a single JSON message channel and exits after one job.
//
// The `vm` context is a convenience for scoping the *language surface* the
// script sees by default (no require, no process, no timers). It is NOT the
// security boundary, so it is kept deliberately thin and is documented as such.

const vm = require('node:vm');
const { inspect } = require('node:util');

// Serialise a completed value into a stable, portable shape. `undefined` maps
// to a sentinel so the parent can tell "returned undefined" from "crashed".
function represent(value, io) {
  if (value === undefined) return { defined: false, text: 'undefined' };
  if (typeof value === 'string') return { defined: true, text: value };
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return { defined: true, text: String(value) };
  }
  let text;
  try { text = inspect(value, { depth: 3, breakLength: 120 }); }
  catch (_) { text = '[unserialisable]'; }
  io.push(String(text));
  return { defined: true, text };
}

process.on('message', (msg) => {
  const { id, code, timeout, cwd, env } = msg || {};
  if (!id) return;

  const output = [];
  const io = {
    push(line) { output.push(typeof line === 'string' ? line : String(line)); },
    text() { return output.join('\n'); },
  };

  // A minimal, readonly probe of the enclosing run — the scrubbed env passed
  // down by the parent. Deliberately NO setTimeout/setInterval: host timers
  // were the async-leak that kept sandboxed code alive in the old design.
  const sandbox = {
    console: {
      log: (...a) => io.push(a.map((x) => (typeof x === 'string' ? x : inspect(x))).join(' ')),
      error: (...a) => io.push(a.map((x) => (typeof x === 'string' ? x : inspect(x))).join(' ')),
      warn: (...a) => io.push(a.map((x) => (typeof x === 'string' ? x : inspect(x))).join(' ')),
    },
    cwd: () => cwd || null,
    env: Object.freeze({ ...(env || {}) }),
  };
  sandbox.globalThis = sandbox;

  try {
    const context = vm.createContext(sandbox);
    const script = new vm.Script(String(code), { filename: 'sandbox.js' });
    // The vm timeout is a fast-path courtesy; the parent's SIGKILL is the
    // guarantee. Wall-clock, so a synchronous runaway is cut off.
    const value = script.runInContext(context, { timeout, displayErrors: true });
    const result = represent(value, io);
    process.send({ id, ok: true, result, stdout: io.text() });
  } catch (err) {
    process.send({
      id,
      ok: false,
      error: {
        message: err && err.message ? String(err.message) : String(err),
        code: (err && err.code) || undefined,
      },
    });
  } finally {
    // The worker is single-use by design. Explicit exit also guarantees a
    // heap-escape cannot leave a timer or socket holding this process open.
    process.exit(0);
  }
});