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

module.exports = { createProviderRegistry, nullProvider, ModelError };