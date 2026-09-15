// ArtifactStore: persistence for artifacts, behind the same replaceable seam.
//
// Records go through persistence/collections.js so the backing store can change
// without a caller noticing. Listing is a prefix scan plus an in-process filter,
// which is bounded here because artifacts are per-task and few.

const { artifactRef } = require('./artifact');

class ArtifactStore {
  constructor({ collection = null, maxArtifacts = 5000 } = {}) {
    this._collection = collection;
    this._max = maxArtifacts;
    this._cache = new Map(); // id -> artifact, for stores that are absent
  }

  async put(artifact) {
    this._cache.set(artifact.id, artifact);
    if (this._collection) {
      await this._collection.put(artifact.id, artifact);
      await this._prune();
    }
    return artifact;
  }

  async get(id) {
    if (this._cache.has(id)) return this._cache.get(id);
    if (!this._collection) return null;
    const rec = await this._collection.get(id);
    if (rec) this._cache.set(id, rec);
    return rec;
  }

  async delete(id) {
    this._cache.delete(id);
    if (this._collection) await this._collection.delete(id);
    return true;
  }

  async list({ workspaceId = null, taskId = null, agentId = null, type = null, limit = 0 } = {}) {
    const match = (a) => a
      && (!workspaceId || a.workspaceId === workspaceId)
      && (!taskId || a.taskId === taskId)
      && (!agentId || a.agentId === agentId)
      && (!type || a.type === type);

    const rows = this._collection
      ? await this._collection.list({ filter: match })
      : [...this._cache.values()].filter(match);
    const sorted = rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return limit ? sorted.slice(0, limit) : sorted;
  }

  async refs(filter) {
    return (await this.list(filter)).map(artifactRef);
  }

  async count() {
    if (this._collection) return (await this._collection.ids()).length;
    return this._cache.size;
  }

  async _prune() {
    const ids = await this._collection.ids();
    if (ids.length <= this._max) return 0;
    const all = await this._collection.list();
    const victims = all
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .slice(0, ids.length - this._max);
    for (const v of victims) { this._cache.delete(v.id); await this._collection.delete(v.id); }
    return victims.length;
  }
}

module.exports = { ArtifactStore };
