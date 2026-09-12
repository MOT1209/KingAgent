// Registered-but-not-*enabled* executor interface.
//
// Phase 2 ships the *interface* for running untrusted code — no real engine is
// wired by default. KingAgent already has a shell and a terminal; a Pythong/JS
// sandbox executor is a future swap-in via `register(name, fn)`. Until one is
// registered, any code_execution request fails loudly instead of silently
// running something.

class CodeExecutionError extends Error {
  constructor(message, code = 'CODE_EXECUTION_NOT_ENABLED') {
    super(message);
    this.name = 'CodeExecutionError';
    this.code = code;
  }
}

class CodeExecutor {
  constructor() {
    this._executors = new Map();
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

  async execute({ lang, code, cwd, timeout = 15_000, signal, env }) {
    if (this._executors.has(lang)) {
      return this._executors.get(lang)({ code, cwd, timeout, signal, env });
    }
    throw new CodeExecutionError(
      `code execution for "${lang}" is not enabled on this platform. ` +
      'The CodeExecutor interface exists but no engine has been registered.',
    );
  }
}

module.exports = { CodeExecutor, CodeExecutionError };