// The agent registry: who the runtime is allowed to run as.
//
// Definitions come from presets and user config, and the registry is the
// single source of truth for the set at any moment. Storing happens through the
// injected store so a definition can survive restart without the registry
// caring where the bytes land.

const { validateAgentDefinition } = require('./definition');

class AgentRegistry {
  constructor({ store } = {}) {
    this._agents = new Map();
    this._store = store || null;
  }

  register(def) {
    const { ok, agent, errors } = validateAgentDefinition(def);
    if (!ok) throw new Error(`Invalid agent definition: ${errors.join('; ')}`);
    if (this._agents.has(agent.id)) throw new Error(`Agent "${agent.id}" is already registered`);
    this._agents.set(agent.id, agent);
    if (this._store) this._store.set(`agent:${agent.id}`, agent).catch(() => {});
    return this.get(agent.id);
  }

  update(id, patch) {
    const existing = this._agents.get(id);
    if (!existing) throw new Error(`No agent "${id}" to update`);
    const merged = {
      ...existing,
      ...patch,
      id: existing.id,
      permissions: { ...existing.permissions, ...(patch.permissions || {}) },
      model: { ...existing.model, ...(patch.model || {}) },
      metadata: { ...existing.metadata, ...(patch.metadata || {}) },
    };
    const { ok, agent, errors } = validateAgentDefinition(merged);
    if (!ok) throw new Error(`Invalid agent update: ${errors.join('; ')}`);
    this._agents.set(id, agent);
    if (this._store) this._store.set(`agent:${agent.id}`, agent).catch(() => {});
    return this.get(id);
  }

  unregister(id) {
    if (!this._agents.delete(id)) return false;
    if (this._store) this._store.delete(`agent:${id}`).catch(() => {});
    return true;
  }

  get(id) {
    const a = this._agents.get(id);
    return a ? { ...a } : undefined;
  }

  list(filter = {}) {
    let all = [...this._agents.values()];
    if (filter.enabled !== undefined) all = all.filter((a) => a.enabled === filter.enabled);
    if (filter.capability) all = all.filter((a) => a.capabilities.includes(filter.capability));
    return all.map((a) => ({ ...a }));
  }

  enable(id) {
    return this.update(id, { enabled: true });
  }

  disable(id) {
    return this.update(id, { enabled: false });
  }

  count() {
    return this._agents.size;
  }

  async loadPersisted() {
    if (!this._store) return 0;
    for (const key of await this._store.keys('agent:')) {
      const id = key.slice('agent:'.length);
      if (this._agents.has(id)) continue;
      const def = await this._store.get(key);
      if (def) {
        try { this.register(def); } catch (err) { /* skip corrupt definition */ }
      }
    }
    return this._agents.size;
  }

  // Used by the state inspector / diagnostics.
  _dump() {
    return this.list();
  }
}

module.exports = { AgentRegistry };