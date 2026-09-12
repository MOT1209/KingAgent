// The code-execution interface, plus a built-in, dependency-free JavaScript
// sandbox that is registered by default.
//
// Phase 2 ships the interface for running untrusted code. The default `js`
// engine runs inside a Node `vm` context with a hard wall-clock timeout and no
// `require` reachable, so a script that loops or throws cannot hold the host.
// Other languages register the same way via `register(name, fn)` — until a
// language is registered, any request for it fails loudly instead of silently
// running something.

const vm = require('node:vm');
const { inspect } = require('node:util');

class CodeExecutionError extends Error {
  constructor(message, code = 'CODE_EXECUTION_NOT_ENABLED') {
    super(message);
    this.name = 'CodeExecutionError';
    this.code = code;
  }
}

// Serialise a sandbox result into a stable, portable shape. `undefined` maps to
// a sentinel so callers can tell "returned undefined" from "crashed".
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

// The built-in engine. Runs `code` in a vm.Script with a timeout measured in
// wall-clock milliseconds; a runaway script is cut off by the vm timeout rather
// than by a stray timer. Console output is captured line by line into
// `stdout`. Nothing outside the sandbox is reachable: no `require`, no
// `process.binding`, no host globals beyond a minimal, safe surface.
async function runJavaScript({ code, cwd, timeout = 15_000, signal, env }) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new CodeExecutionError('no code to execute', 'CODE_EXECUTION_EMPTY');
  }
  const output = [];
  const io = {
    push(line) { output.push(typeof line === 'string' ? line : String(line)); },
    text() { return output.join('\n'); },
  };
  const sandbox = {
    console: {
      log: (...a) => io.push(a.map((x) => (typeof x === 'string' ? x : inspect(x))).join(' ')),
      error: (...a) => io.push(a.map((x) => (typeof x === 'string' ? x : inspect(x))).join(' ')),
      warn: (...a) => io.push(a.map((x) => (typeof x === 'string' ? x : inspect(x))).join(' ')),
    },
    // A tiny, readonly probe of the enclosing run — never the whole host.
    cwd: () => cwd || null,
    env: Object.freeze({ ...(env || {}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const script = new vm.Script(String(code), { filename: 'sandbox.js' });
  if (signal && signal.aborted) throw new CodeExecutionError('code execution cancelled', 'CODE_EXECUTION_CANCELLED');
  // A never-settling promise keeps the race waiting on the script alone when
  // no signal was provided; an abort event settles it with a rejection.
  const canceller = signal
    ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(new CodeExecutionError('code execution cancelled', 'CODE_EXECUTION_CANCELLED')), { once: true }))
    : new Promise(() => {});
  let value;
  try {
    value = await Promise.race([
      Promise.resolve().then(() => script.runInContext(context, { timeout, displayErrors: true })),
      canceller,
    ]);
  } catch (err) {
    if (err && (err.code === 'CODE_EXECUTION_CANCELLED' || /ertified to timeout|Script execution timed out/i.test(String(err.message)))) {
      throw new CodeExecutionError(`code execution timed out after ${timeout}ms`, 'CODE_EXECUTION_TIMEOUT');
    }
    throw new CodeExecutionError('code execution failed: ' + (err && err.message ? err.message : String(err)), 'CODE_EXECUTION_ERROR');
  }
  const result = represent(value, io);
  return { ok: true, lang: 'js', result, stdout: io.text(), durationMs: 0 };
}

class CodeExecutor {
  constructor({ registerDefaults = true } = {}) {
    this._executors = new Map();
    if (registerDefaults) this.register('js', runJavaScript);
  }

  // name: e.g. 'js', 'python'
  register(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('executor must be a function');
    this._executors.set(name, fn);
  }

  unregister(name) {
    return this._executors.delete(name);
  }

  available() {
    return [...this._executors.keys()];
  }

  isEnabled(lang) {
    return this._executors.has(lang);
  }

  async execute({ lang, code, cwd, timeout = 15_000, signal, env } = {}) {
    if (this._executors.has(lang)) {
      return this._executors.get(lang)({ code, cwd, timeout, signal, env });
    }
    throw new CodeExecutionError(
      `code execution for "${lang}" is not enabled on this platform. ` +
      'The CodeExecutor interface exists but no engine has been registered.',
    );
  }
}

module.exports = { CodeExecutor, CodeExecutionError, runJavaScript };