// The code-execution interface, plus a built-in JavaScript engine that is NOT
// registered by default.
//
// Since 0.6.0 the default `js` engine runs untrusted code in a *disposable
// child process* (sandbox-worker.cjs) rather than a Node `vm` context inside
// the host. That is the whole point and it is stated honestly: node:vm is not
// a security boundary — Node's own docs say scripts can break out of a context
// via widely-available internals. Containing a breakout requires confining the
// *process* the code runs in, which is what this fork does:
//
//   - the child runs with a scrubbed environment (a whitelist of safe keys,
//     never secrets, never NODE_OPTIONS/ELECTRON_*) and a hard memory cap
//   - the parent enforces a wall-clock timeout and kills the child process
//     (SIGKILL fallback) — a synchronous or asynchronous runaway cannot survive
//     it; nothing is left running in the host's event loop
//   - user code talks to the host only over one JSON message channel; on
//     completion or error the child exits
//
// This raises the bar from "featured sandbox" to "isolated process", but it is
// NOT a full sandbox: code running in the child still executes as this OS user,
// so network exfiltration from an escaped context remains possible in
// principle. A true capability sandbox (QuickJS-WASM or isolated-vm) is the
// documented replacement. Because even the isolated-process engine is not a
// transitive-allowed capability, the engine is disabled by default: create the
// executor with `{ registerDefaults: true }` only once a consumer has accepted
// that model.

const path = require('node:path');
const { fork } = require('node:child_process');

const SANDBOX_WORKER = path.join(__dirname, 'sandbox-worker.cjs');
// Hard cap on the child heap: a runaway or memory-hungry script dies on its
// own instead of starving the host, and even a successful escape cannot lean on
// unbounded memory.
const SANDBOX_MEMORY_MB = 96;
// Grace given to the child to notice a kill before the parent escalates to
// SIGKILL. Kept small so the wall-clock timeout stays honest.
const KILL_GRACE_MS = 500;

// Keys the child may inherit from the host environment. Deliberate exclude:
// anything that could steer the Node runtime (NODE_OPTIONS, NODE_DEBUG,
// NODE_PATH, ELECTRON_RUN_AS_NODE) and anything that could carry secrets
// (API keys, config values). A caller may add its own keys via `env`, but the
// dangerous ones are stripped after the merge, so a caller cannot re-enable
// them either.
const SANDBOX_ENV_WHITELIST = [
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TEMP', 'TMP', 'TMPDIR', 'SYSTEMROOT', 'SystemRoot', 'windir', 'WinDir',
  'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  'USER', 'USERNAME', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'SHELL',
  'COMSPEC', 'ComSpec', 'ComSpecPath', 'NUMBER_OF_PROCESSORS',
];

const SANDBOX_ENV_DENYLIST = [
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE',
  'ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_OVERRIDE_DIST_PATH',
  'NODE_OPTIONS_WARN', 'NODE_REPL_EXTERNAL_MODULE', 'NODE_V8_COVERAGE',
];

function buildSandboxEnv(env) {
  const out = {};
  for (const key of SANDBOX_ENV_WHITELIST) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) out[key] = String(value);
    }
  }
  for (const key of SANDBOX_ENV_DENYLIST) delete out[key];
  return out;
}

// The env handed to the sandboxed script itself: only what the caller
// explicitly injected, with the runtime-steering keys stripped so even a caller
// cannot re-expose NODE_OPTIONS-style leverage into the child.
function buildSandboxEnvView(env) {
  if (!env || typeof env !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SANDBOX_ENV_DENYLIST.includes(key)) continue;
    out[key] = String(value);
  }
  return out;
}

class CodeExecutionError extends Error {
  constructor(message, code = 'CODE_EXECUTION_NOT_ENABLED') {
    super(message);
    this.name = 'CodeExecutionError';
    this.code = code;
  }
}

// The built-in engine. Spawns a throwaway child process, runs `code` inside it
// with a wall-clock timeout enforced by the *parent*, and returns a structured
// result. Console output is captured line by line into `stdout`.
async function runJavaScript({ code, cwd, timeout = 15_000, signal, env }) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new CodeExecutionError('no code to execute', 'CODE_EXECUTION_EMPTY');
  }

  const startedAt = Date.now();
  const childEnv = buildSandboxEnv(env);

  return new Promise((resolve, reject) => {
    const child = fork(SANDBOX_WORKER, {
      cwd: cwd || undefined,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: [`--max-old-space-size=${SANDBOX_MEMORY_MB}`],
      env: childEnv,
      serialization: 'json',
    });

    // Attached before any early-return path so a spawn failure can never
    // surface as an unhandled 'error'.
    child.on('error', (err) => {
      settle(() => reject(new CodeExecutionError(`code execution failed to start: ${err.message}`, 'CODE_EXECUTION_ERROR')));
    });

    let settled = false;
    let whyKilled = null;
    let stderr = '';
    const cleanup = () => {
      clearTimeout(overdue);
      if (signal) signal.removeEventListener('abort', onAbort);
      child.removeAllListeners();
    };

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const terminate = (reason) => {
      whyKilled = reason;
      try {
        if (child.connected) child.disconnect();
      } catch (_) { /* already gone */ }
      try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
      // Escalate: SIGTERM may not stop a blocked sync loop on every platform.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      }, KILL_GRACE_MS).unref();
    };

    // The only timeout that matters is enforced here, in the host: after
    // `timeout` the child is killed outright. The worker's own vm timeout is a
    // fast-path courtesy, not the guarantee.
    const overdue = setTimeout(() => {
      terminate('timeout');
      settle(() => reject(new CodeExecutionError(`code execution timed out after ${timeout}ms`, 'CODE_EXECUTION_TIMEOUT')));
    }, timeout);
    overdue.unref();

    const onAbort = () => {
      terminate('cancelled');
      settle(() => reject(new CodeExecutionError('code execution cancelled', 'CODE_EXECUTION_CANCELLED')));
    };
    if (signal) {
      if (signal.aborted) {
        settle(() => reject(new CodeExecutionError('code execution cancelled', 'CODE_EXECUTION_CANCELLED')));
        terminate('cancelled');
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('spawn', () => {
      child.send({ id: 1, code: String(code), timeout, env: buildSandboxEnvView(env) });
    });

    child.on('message', (msg) => {
      if (!msg || msg.id !== 1) return;
      const durationMs = Date.now() - startedAt;
      if (msg.ok) {
        settle(() => resolve({ ok: true, lang: 'js', result: msg.result, stdout: msg.stdout || '', durationMs }));
        return;
      }
      const { message, code: errCode } = msg.error || {};
      if (errCode === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /timed out/i.test(message || '')) {
        settle(() => reject(new CodeExecutionError(`code execution timed out after ${timeout}ms`, 'CODE_EXECUTION_TIMEOUT')));
      } else {
        settle(() => reject(new CodeExecutionError(`code execution failed: ${message || 'unknown sandbox error'}`, 'CODE_EXECUTION_ERROR')));
      }
    });

    child.stderr.on('data', (buf) => { stderr += buf.toString(); });

    child.on('exit', () => {
      if (settled) return;
      if (whyKilled === 'timeout') {
        settle(() => reject(new CodeExecutionError(`code execution timed out after ${timeout}ms`, 'CODE_EXECUTION_TIMEOUT')));
        return;
      }
      if (whyKilled === 'cancelled') {
        settle(() => reject(new CodeExecutionError('code execution cancelled', 'CODE_EXECUTION_CANCELLED')));
        return;
      }
      const detail = stderr ? ` (${stderr.trim().split(/\r?\n/).slice(-3).join('; ')})` : '';
      settle(() => reject(new CodeExecutionError(`code execution failed without result${detail}`, 'CODE_EXECUTION_ERROR')));
    });
  });
}

class CodeExecutor {
  constructor({ registerDefaults = false } = {}) {
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
      'The CodeExecutor interface exists but no engine has been registered — ' +
      'engines are off by default for security.',
    );
  }
}

module.exports = { CodeExecutor, CodeExecutionError, runJavaScript, buildSandboxEnv, buildSandboxEnvView };