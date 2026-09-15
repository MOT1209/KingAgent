// The adapter registry: which source types this install can research, and with
// what. Separate from the *provider* registry (searchProvider.js) because the
// two answer different questions — "is there a GitHub adapter?" versus "is any
// provider wired that can serve it?" — and a task needs both answers to explain
// why a source type produced nothing.

const { ALL_SOURCE_TYPES } = require('../schemas/source');

function createSourceRegistry() {
  const byId = new Map();
  const byType = new Map();

  function register(adapter) {
    if (!adapter || !adapter.id || !adapter.type) throw new TypeError('a source adapter needs an id and a type');
    if (!ALL_SOURCE_TYPES.includes(adapter.type)) throw new TypeError(`unknown source type "${adapter.type}"`);
    if (byId.has(adapter.id)) throw new Error(`source adapter "${adapter.id}" is already registered`);
    byId.set(adapter.id, adapter);
    if (!byType.has(adapter.type)) byType.set(adapter.type, []);
    byType.get(adapter.type).push(adapter);
    return adapter;
  }

  function unregister(id) {
    const adapter = byId.get(id);
    if (!adapter) return false;
    const list = byType.get(adapter.type) || [];
    const i = list.indexOf(adapter);
    if (i >= 0) list.splice(i, 1);
    return byId.delete(id);
  }

  function get(id) { return byId.get(id) || null; }
  function forType(type) { return [...(byType.get(type) || [])]; }
  function types() { return [...byType.keys()].filter((t) => (byType.get(t) || []).length > 0); }

  // The capability report §55 and the UI both read. For each adapter: is it
  // registered, and is anything actually behind it? An adapter with no provider
  // is the difference between "we cannot do academic research" and "nobody has
  // configured an academic provider", and users deserve to be told which.
  function describe(providerRegistry) {
    return [...byId.values()].map((a) => {
      const providers = typeof a.providersFrom === 'function' ? a.providersFrom(providerRegistry) : [];
      const available = typeof a.available === 'function' ? a.available(providerRegistry) : providers.length > 0;
      return {
        id: a.id,
        type: a.type,
        label: a.label,
        description: a.description,
        available,
        providers: providers.map((p) => p.id),
        reason: available ? '' : `no provider is configured for ${a.providerTypes.join(' or ')}`,
      };
    }).sort((x, y) => (x.id < y.id ? -1 : 1));
  }

  return { register, unregister, get, forType, types, describe, size: () => byId.size, list: () => [...byId.values()] };
}

module.exports = { createSourceRegistry };
