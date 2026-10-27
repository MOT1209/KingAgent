// Model provider abstraction.
//
// Everything the runtime knows about "the AI model" is this interface: a
// provider is a function (generate) that takes a list of messages and returns
// structured output. Providers are registered by name and picked per-task.
//
// This is the ONLY place where external model APIs are referenced. The core
// imports no SDK — a concrete adapter is swapped in at the platform layer
// (src/main) where the API keys live. Tests and the deterministic planner use a
// simple stub.

class ModelError extends Error {
  constructor(message, { code = 'MODEL_FAILURE', provider } = {}) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.provider = provider;
  }
}

// Minimal provider stub for tests and deterministic-only mode.
const nullProvider = {
  id: 'null',
  label: 'No provider configured',
  async generate() {
    throw new ModelError('no model provider configured', { provider: 'null' });
  },
};

function createProviderRegistry() {
  const providers = new Map();

  function register(id, adapter) {
    if (!id || typeof adapter?.generate !== 'function') throw new TypeError('provider must have an id and a generate()');
    providers.set(id, adapter);
    return adapter;
  }

  function get(id) {
    return providers.get(id) || nullProvider;
  }

  function list() {
    return [...providers.entries()].map(([id, a]) => ({ id, label: a.label || id }));
  }

  // Resolve from agent.model.provider, fallback to the first registered
  // non-null provider.
  function resolve(agent) {
    const providerId = agent && agent.model && agent.model.provider;
    if (providerId && providers.has(providerId)) return providers.get(providerId);
    for (const [id, a] of providers) {
      if (id !== 'null') return a;
    }
    return nullProvider;
  }

  return { register, get, list, resolve };
}

// One bounded model call. A provider's generate() is an arbitrary network
// request with no deadline of its own, and the runtime loop awaits it: a call
// that never answers stopped the loop for good, and cancelling the task could
// not help because the request had not been told. This races the call against
// a timer and against the caller's AbortSignal, whichever comes first, and
// passes the signal on so a well-behaved adapter can also stop its work.
const DEFAULT_GENERATE_TIMEOUT_MS = 60_000;

function generateWithin(provider, args = {}, { timeoutMs = DEFAULT_GENERATE_TIMEOUT_MS } = {}) {
  const outer = args.signal;
  if (outer && outer.aborted) return Promise.reject(new ModelError('model call was cancelled', { code: 'MODEL_CANCELLED', provider: provider && provider.id }));
  const controller = new AbortController();
  let timer = null, onAbort = null;
  const bounded = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ModelError(`model call timed out after ${timeoutMs} ms`, { code: 'MODEL_TIMEOUT', provider: provider && provider.id }));
      controller.abort();
    }, timeoutMs);
    if (outer) {
      onAbort = () => {
        reject(new ModelError('model call was cancelled', { code: 'MODEL_CANCELLED', provider: provider && provider.id }));
        controller.abort();
      };
      outer.addEventListener('abort', onAbort, { once: true });
    }
  });
  const call = Promise.resolve().then(() => provider.generate({ ...args, signal: controller.signal }));
  call.catch(() => {}); // a late rejection after the race is decided is not unhandled
  return Promise.race([call, bounded]).finally(() => {
    clearTimeout(timer);
    if (outer && onAbort) outer.removeEventListener('abort', onAbort);
  });
}

module.exports = { createProviderRegistry, nullProvider, ModelError, generateWithin, DEFAULT_GENERATE_TIMEOUT_MS };