// SkillRegistry: every skill this install knows about, and the one place a
// skill's state is allowed to change.
//
// A deliberate sibling of AgentRegistry, HarnessRegistry and ToolManager rather
// than a replacement for any of them. They answer different questions:
//
//   AgentRegistry   — who is working
//   HarnessRegistry — what can execute work
//   ToolManager     — what actions exist, and who may call them
//   SkillRegistry   — what the platform knows *how to do*, and how well
//
// A registry never runs anything, never fetches anything, and never decides
// whether a skill is safe. It stores validated records, indexes them for
// discovery, and enforces that state changes go through the lifecycle table.
// Fetching is a source's job, safety is the validator's, execution is the
// runtime's — keeping those apart is what makes each of them testable.
//
// Versions: records are keyed `id@version`, so two versions of one skill can
// coexist while a dependency range is resolved. `get(id)` without a range
// answers with the highest usable version, which is what every caller that does
// not care about versions means.

const { SkillRecord } = require('./SkillMetadata');
const { compareVersions, maxSatisfying, satisfies } = require('./SkillVersion');
const { validateManifest } = require('../schemas/SkillManifest');
const { SKILL_STATES, isUsable } = require('../lifecycle/states');
const { trustRank } = require('./SkillSource');
const { TYPES } = require('../../events/event-bus');

class SkillRegistryError extends Error {
  constructor(message, { code = 'SKILL_REGISTRY_ERROR', skillId = null } = {}) {
    super(message);
    this.name = 'SkillRegistryError';
    this.code = code;
    this.skillId = skillId;
  }
}

class SkillRegistry {
  constructor({ bus = null, logger = null, collection = null, platform = null } = {}) {
    this._bus = bus;
    this._logger = logger;
    this._collection = collection;
    this._platform = platform; // 'windows' | 'macos' | 'linux' | null (= any)
    this._byKey = new Map();      // `${id}@${version}` -> SkillRecord
    this._byId = new Map();       // id -> Set<key>
    this._byCategory = new Map(); // category -> Set<key>
    this._byCapability = new Map(); // capability -> Set<key>
  }

  static key(id, version) {
    return `${id}@${version}`;
  }

  // --- registration ---------------------------------------------------------

  // Accepts a validated manifest, a raw manifest object, or a SkillRecord.
  // Raw objects are validated here rather than trusted, because this is the
  // narrowest point every skill passes through and a caller that skipped
  // validation is exactly the bug this catches.
  register(input, { state = SKILL_STATES.DISCOVERED, source = null, replace = false, now = Date.now() } = {}) {
    const record = this._toRecord(input, { state, source, now });
    const key = SkillRegistry.key(record.id, record.version);
    if (this._byKey.has(key) && !replace) {
      throw new SkillRegistryError(`skill ${key} is already registered`, { code: 'SKILL_EXISTS', skillId: record.id });
    }
    if (this._byKey.has(key)) this._unindex(this._byKey.get(key));
    this._byKey.set(key, record);
    this._index(record);
    this._persist(record);
    this._emit(TYPES.SKILL_DISCOVERED, record, { state: record.state, version: record.version, source: record.source.type });
    return record;
  }

  _toRecord(input, { state, source, now }) {
    if (input instanceof SkillRecord) return input;
    const manifest = input && input.manifest ? input.manifest : input;
    const { ok, manifest: validated, errors } = validateManifest(manifest, source ? { source } : {});
    if (!ok) throw new SkillRegistryError(`invalid skill manifest: ${errors.join('; ')}`, { code: 'SKILL_INVALID', skillId: manifest && manifest.id });
    return new SkillRecord({ manifest: validated, state, now });
  }

  _index(record) {
    const key = SkillRegistry.key(record.id, record.version);
    if (!this._byId.has(record.id)) this._byId.set(record.id, new Set());
    this._byId.get(record.id).add(key);
    for (const category of record.manifest.categories) {
      if (!this._byCategory.has(category)) this._byCategory.set(category, new Set());
      this._byCategory.get(category).add(key);
    }
    for (const capability of record.manifest.capabilities) {
      if (!this._byCapability.has(capability)) this._byCapability.set(capability, new Set());
      this._byCapability.get(capability).add(key);
    }
  }

  _unindex(record) {
    const key = SkillRegistry.key(record.id, record.version);
    const ids = this._byId.get(record.id);
    if (ids) { ids.delete(key); if (ids.size === 0) this._byId.delete(record.id); }
    for (const category of record.manifest.categories) {
      const set = this._byCategory.get(category);
      if (set) { set.delete(key); if (set.size === 0) this._byCategory.delete(category); }
    }
    for (const capability of record.manifest.capabilities) {
      const set = this._byCapability.get(capability);
      if (set) { set.delete(key); if (set.size === 0) this._byCapability.delete(capability); }
    }
  }

  // --- lookup ---------------------------------------------------------------

  // `get('mcp-builder')`            -> highest usable version
  // `get('mcp-builder', '^1.0.0')`  -> highest version satisfying the range
  // `get('mcp-builder', '1.2.3')`   -> that exact version, usable or not
  get(id, range = null) {
    const records = this.all(id);
    if (records.length === 0) return null;
    if (range === null) {
      const usable = records.filter((r) => isUsable(r.state));
      const pool = usable.length ? usable : records;
      return pool.sort((a, b) => compareVersions(a.version, b.version))[pool.length - 1];
    }
    const version = maxSatisfying(records.map((r) => r.version), range);
    if (!version) return null;
    return this._byKey.get(SkillRegistry.key(id, version)) || null;
  }

  getExact(id, version) {
    return this._byKey.get(SkillRegistry.key(id, version)) || null;
  }

  all(id) {
    const keys = this._byId.get(id);
    if (!keys) return [];
    return [...keys].map((k) => this._byKey.get(k)).filter(Boolean);
  }

  has(id) {
    return this._byId.has(id);
  }

  count() {
    return this._byKey.size;
  }

  ids() {
    return [...this._byId.keys()].sort();
  }

  // Every record, filtered. Filters compose (an AND), and none of them mutate.
  // `query` is a substring match over id/name/description/tags — the search
  // module (discovery/SkillSearch.js) is what ranks; this just filters.
  list({
    id = null, category = null, capability = null, state = null, states = null,
    trust = null, minTrust = null, usable = null, sourceType = null, query = null,
    platform = null, includeRemoved = false,
  } = {}) {
    let keys = null;
    if (id) keys = this._byId.get(id) || new Set();
    if (category) keys = intersect(keys, this._byCategory.get(category) || new Set());
    if (capability) keys = intersect(keys, this._byCapability.get(capability) || new Set());
    let records = keys === null ? [...this._byKey.values()] : [...keys].map((k) => this._byKey.get(k)).filter(Boolean);

    if (!includeRemoved) records = records.filter((r) => r.state !== SKILL_STATES.REMOVED);
    if (state) records = records.filter((r) => r.state === state);
    if (Array.isArray(states) && states.length) records = records.filter((r) => states.includes(r.state));
    if (trust) records = records.filter((r) => r.trust.tier === trust);
    if (minTrust) records = records.filter((r) => trustRank(r.trust.tier) >= trustRank(minTrust));
    if (usable === true) records = records.filter((r) => r.usable);
    if (usable === false) records = records.filter((r) => !r.usable);
    if (sourceType) records = records.filter((r) => r.manifest.source.type === sourceType);
    const wantedPlatform = platform || this._platform;
    if (wantedPlatform) records = records.filter((r) => r.manifest.supportedPlatforms.includes(wantedPlatform));
    if (query) {
      const q = String(query).toLowerCase();
      records = records.filter((r) => matchesQuery(r, q));
    }
    return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : compareVersions(a.version, b.version)));
  }

  // The records a run may actually select from: usable state, this platform,
  // not blocked by the scanner. Discovery and ranking both start here, so a
  // quarantined skill cannot be reached by any path that forgets to filter.
  selectable({ platform = null } = {}) {
    return this.list({ usable: true, platform: platform || this._platform });
  }

  // --- state ----------------------------------------------------------------

  // Every state change goes through here so the event, the persistence write
  // and the audit line happen together — a caller mutating `record.state`
  // directly is a bug the lifecycle table already refuses.
  transition(record, to, { reason = '', actor = 'system', now = Date.now() } = {}) {
    const target = record instanceof SkillRecord ? record : this.get(record);
    if (!target) throw new SkillRegistryError(`unknown skill: ${record}`, { code: 'SKILL_UNKNOWN' });
    const from = target.state;
    target.transition(to, { reason, actor, now });
    this._persist(target);
    const type = STATE_EVENTS[to] || null;
    if (type) this._emit(type, target, { from, to, reason, actor });
    if (this._logger) this._logger.debug(`skill ${target.id} ${from} -> ${to}`, { reason, actor });
    return target;
  }

  // Drop a skill (one version, or every version). The record is deleted rather
  // than left in `removed`: the lifecycle's terminal state exists for a record
  // that is still being reported on, and `SkillRemover` moves it there first so
  // the removal is auditable before the row disappears.
  remove(id, version = null) {
    const targets = version ? [this.getExact(id, version)].filter(Boolean) : this.all(id);
    for (const record of targets) {
      this._unindex(record);
      this._byKey.delete(SkillRegistry.key(record.id, record.version));
      if (this._collection) this._collection.delete(SkillRegistry.key(record.id, record.version)).catch(() => {});
      this._emit(TYPES.SKILL_REMOVED, record, { version: record.version });
    }
    return targets.length;
  }

  // --- persistence ----------------------------------------------------------

  async load() {
    if (!this._collection) return 0;
    const rows = await this._collection.list();
    let n = 0;
    for (const row of rows) {
      const record = SkillRecord.fromJSON(row);
      if (!record) continue;
      const key = SkillRegistry.key(record.id, record.version);
      if (this._byKey.has(key)) this._unindex(this._byKey.get(key));
      this._byKey.set(key, record);
      this._index(record);
      n += 1;
    }
    if (this._logger) this._logger.info(`restored ${n} skills`);
    return n;
  }

  _persist(record) {
    if (!this._collection) return;
    this._collection.put(SkillRegistry.key(record.id, record.version), record.toJSON()).catch((err) => {
      if (this._logger) this._logger.warn(`could not persist skill ${record.id}`, { error: err && err.message });
    });
  }

  _emit(type, record, payload) {
    if (!this._bus) return;
    this._bus.emit(type, { skillId: record.id }, { skill: record.id, version: record.version, ...payload });
  }

  // --- reporting ------------------------------------------------------------

  stats() {
    const byState = {};
    const byTrustTier = {};
    const bySource = {};
    for (const record of this._byKey.values()) {
      byState[record.state] = (byState[record.state] || 0) + 1;
      byTrustTier[record.trust.tier] = (byTrustTier[record.trust.tier] || 0) + 1;
      bySource[record.manifest.source.type] = (bySource[record.manifest.source.type] || 0) + 1;
    }
    return {
      total: this._byKey.size,
      distinct: this._byId.size,
      byState,
      byTrust: byTrustTier,
      bySource,
      categories: this._byCategory.size,
      capabilities: this._byCapability.size,
    };
  }

  // Which installed skills cover a category — the index discovery reads.
  byCategory(category) {
    const keys = this._byCategory.get(category);
    if (!keys) return [];
    return [...keys].map((k) => this._byKey.get(k)).filter((r) => r && r.usable);
  }

  byCapability(capability) {
    const keys = this._byCapability.get(capability);
    if (!keys) return [];
    return [...keys].map((k) => this._byKey.get(k)).filter((r) => r && r.usable);
  }

  // Does an installed, usable skill satisfy `id@range`? The dependency resolver
  // asks this; kept here because only the registry knows what is installed.
  satisfiesDependency({ id, range }) {
    return this.all(id).some((r) => r.usable && satisfies(r.version, range));
  }
}

const STATE_EVENTS = Object.freeze({
  [SKILL_STATES.INSTALLED]: TYPES.SKILL_INSTALLED,
  [SKILL_STATES.ENABLED]: TYPES.SKILL_ENABLED,
  [SKILL_STATES.DISABLED]: TYPES.SKILL_DISABLED,
  [SKILL_STATES.QUARANTINED]: TYPES.SKILL_QUARANTINED,
  [SKILL_STATES.LOADED]: TYPES.SKILL_LOADED,
  [SKILL_STATES.RUNNING]: TYPES.SKILL_STARTED,
  [SKILL_STATES.FAILED]: TYPES.SKILL_FAILED,
  [SKILL_STATES.REMOVED]: TYPES.SKILL_REMOVED,
});

function intersect(a, b) {
  if (a === null) return new Set(b);
  const out = new Set();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

function matchesQuery(record, q) {
  const m = record.manifest;
  return m.id.includes(q)
    || m.name.toLowerCase().includes(q)
    || m.description.toLowerCase().includes(q)
    || m.tags.some((t) => t.includes(q))
    || m.categories.some((c) => c.includes(q))
    || m.capabilities.some((c) => c.includes(q));
}

module.exports = { SkillRegistry, SkillRegistryError };
