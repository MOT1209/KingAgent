// AgentStateStore: snapshots, keyed by task, bounded per task.
//
// A snapshot per step would be unbounded history of a kind nobody reads, so the
// store keeps the most recent `keepPerTask` for each task plus, always, the
// latest. "Latest for this task" is the hot query — that is what a crash
// recovery run asks for every interrupted task — so it is indexed rather than
// derived by scanning.

const { summarizeSnapshot, isInterrupted } = require('./snapshot');

const DEFAULTS = Object.freeze({ keepPerTask: 10, maxTasks: 500 });

class AgentStateStore {
  constructor({ collection = null, options = {} } = {}) {
    this._collection = collection;
    this._opts = { ...DEFAULTS, ...options };
    this._latest = new Map(); // taskId -> snapshot
    this._byTask = new Map(); // taskId -> snapshot[]
  }

  async put(snapshot) {
    const taskId = snapshot.taskId || snapshot.workspaceId;
    this._latest.set(taskId, snapshot);
    if (!this._byTask.has(taskId)) this._byTask.set(taskId, []);
    const list = this._byTask.get(taskId);
    list.push(snapshot);
    if (list.length > this._opts.keepPerTask) {
      const dropped = list.splice(0, list.length - this._opts.keepPerTask);
      if (this._collection) for (const d of dropped) await this._collection.delete(d.id);
    }
    if (this._byTask.size > this._opts.maxTasks) this._evict();
    if (this._collection) await this._collection.put(snapshot.id, snapshot);
    return snapshot;
  }

  latest(taskId) {
    return this._latest.get(taskId) || null;
  }

  async loadLatest(taskId) {
    const live = this.latest(taskId);
    if (live) return live;
    if (!this._collection) return null;
    const all = await this._collection.list({ filter: (s) => s.taskId === taskId });
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  }

  async get(id) {
    if (this._collection) return this._collection.get(id);
    for (const list of this._byTask.values()) {
      const found = list.find((s) => s.id === id);
      if (found) return found;
    }
    return null;
  }

  history(taskId) {
    return [...(this._byTask.get(taskId) || [])];
  }

  list({ status = null, limit = 100 } = {}) {
    return [...this._latest.values()]
      .filter((s) => !status || s.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(summarizeSnapshot);
  }

  // Every task whose latest snapshot says it stopped mid-flight. This is what
  // the recovery manager reads at startup.
  async listInterrupted() {
    const live = [...this._latest.values()].filter(isInterrupted);
    if (!this._collection) return live;
    const persisted = await this._collection.list({ filter: isInterrupted });
    const seen = new Set(live.map((s) => s.taskId));
    const merged = [...live];
    for (const s of persisted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
      if (seen.has(s.taskId)) continue;
      seen.add(s.taskId);
      merged.push(s);
    }
    return merged;
  }

  async delete(taskId) {
    const list = this._byTask.get(taskId) || [];
    if (this._collection) for (const s of list) await this._collection.delete(s.id);
    this._byTask.delete(taskId);
    this._latest.delete(taskId);
    return true;
  }

  _evict() {
    const oldest = [...this._latest.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (!oldest) return;
    this._latest.delete(oldest[0]);
    this._byTask.delete(oldest[0]);
  }
}

module.exports = { AgentStateStore, DEFAULTS };
