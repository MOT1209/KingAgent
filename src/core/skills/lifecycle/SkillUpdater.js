// SkillUpdater: checking for a newer version, and replacing one safely.
//
// An update is not a smaller install — it is a *trust reset*. The bytes change,
// so everything that was decided about the old bytes stops applying:
//
//   * the content digest is re-pinned from what was actually fetched;
//   * the content is re-scanned and the policy re-evaluated;
//   * a human verification (`trust: community/workspace`) does not carry over —
//     someone reviewed the old version, not this one;
//   * a major version bump, or any new permission, requires approval again even
//     if the previous version was approved. "It was allowed yesterday" is how a
//     benign skill becomes a malicious one in a single release.
//
// What *is* carried over is the observation history — run counts, failures,
// security incidents — because those describe the skill's track record on this
// machine and are exactly what a user needs to see when deciding.

const { compareVersions, diffKind, satisfies } = require('../registry/SkillVersion');
const { SKILL_STATES } = require('./states');
const { TYPES } = require('../../events/event-bus');

class SkillUpdateError extends Error {
  constructor(message, { code = 'SKILL_UPDATE_FAILED', skillId = null } = {}) {
    super(message);
    this.name = 'SkillUpdateError';
    this.code = code;
    this.skillId = skillId;
  }
}

class SkillUpdater {
  constructor({ registry, installer, sources = {}, cache = null, bus = null, logger = null } = {}) {
    if (!registry) throw new Error('SkillUpdater requires a SkillRegistry');
    if (!installer) throw new Error('SkillUpdater requires a SkillInstaller');
    this._registry = registry;
    this._installer = installer;
    this._sources = sources;
    this._cache = cache;
    this._bus = bus;
    this._logger = logger;
  }

  // What would change if we updated. Read-only: this is what a "3 updates
  // available" badge is built from, and it must never install anything.
  async check(id, { range = '*' } = {}) {
    const record = this._registry.get(id);
    if (!record) throw new SkillUpdateError(`${id} is not installed`, { code: 'SKILL_NOT_INSTALLED', skillId: id });
    const adapter = this._sources[record.manifest.source.type];
    if (!adapter || typeof adapter.find !== 'function') {
      return { id, current: record.version, latest: null, available: false, reason: `source ${record.manifest.source.type} cannot be queried for updates` };
    }

    let listing = null;
    try {
      listing = await adapter.find({ id: record.manifest.source.slug || id, range });
    } catch (err) {
      return { id, current: record.version, latest: null, available: false, reason: `update check failed: ${err.message}` };
    }
    if (!listing || !listing.version) {
      return { id, current: record.version, latest: null, available: false, reason: 'the source did not report a version' };
    }

    const newer = compareVersions(listing.version, record.version) > 0;
    const kind = diffKind(record.version, listing.version);
    return {
      id,
      current: record.version,
      latest: listing.version,
      available: newer && satisfies(listing.version, range),
      kind,
      // Said out loud rather than buried: a major bump is a different skill
      // wearing the same id, and the UI should present it that way.
      requiresApproval: kind === 'major',
      source: record.manifest.source.type,
      reason: newer ? `${record.version} -> ${listing.version} (${kind})` : 'already up to date',
      listing,
    };
  }

  async checkAll({ ids = null } = {}) {
    const targets = ids || this._registry.ids();
    const results = [];
    for (const id of targets) {
      try {
        results.push(await this.check(id));
      } catch (err) {
        results.push({ id, current: null, latest: null, available: false, reason: err.message });
      }
    }
    return results;
  }

  // Perform the update. The new version is installed through the full install
  // path (fetch -> validate -> scan -> policy -> approval), and only once it is
  // registered is the old version retired — so a failed update leaves the
  // working skill in place rather than a gap.
  async update(id, { actor = 'user', approve = null, autoEnable = true, keepPrevious = false, context = {} } = {}) {
    const current = this._registry.get(id);
    if (!current) throw new SkillUpdateError(`${id} is not installed`, { code: 'SKILL_NOT_INSTALLED', skillId: id });

    const check = await this.check(id);
    if (!check.available) {
      return { id, updated: false, from: current.version, to: current.version, reason: check.reason };
    }

    const request = installRequestFor(current, check.listing);
    const before = {
      version: current.version,
      permissions: [...current.manifest.permissions],
      trust: current.trust.tier,
      stats: { ...current.stats },
      quality: current.quality,
    };

    const result = await this._installer.install(request, { actor, approve, autoEnable, context });
    const next = result.record;

    // New permissions are the thing a user most needs told. An update that adds
    // `process.execute` to a skill that only read files is a different program.
    const added = next.manifest.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !next.manifest.permissions.includes(p));

    // Carry the track record forward; deliberately not the trust decision.
    next.stats = { ...before.stats };
    next.quality = before.quality;

    if (!keepPrevious && current.version !== next.version) {
      try {
        this._registry.transition(current, SKILL_STATES.REMOVED, { reason: `superseded by ${next.version}`, actor });
      } catch (err) {
        if (this._logger) this._logger.debug(`could not retire ${id}@${current.version}: ${err.message}`);
      }
      this._registry.remove(id, current.version);
    }
    if (this._cache) this._cache.invalidateSkill(id);

    this._emit(TYPES.SKILL_UPDATED, next, {
      from: before.version,
      to: next.version,
      kind: check.kind,
      permissionsAdded: added,
      permissionsRemoved: removed,
      trustReset: before.trust !== next.trust.tier ? { from: before.trust, to: next.trust.tier } : null,
      actor,
    });

    return {
      id,
      updated: true,
      from: before.version,
      to: next.version,
      kind: check.kind,
      permissionsAdded: added,
      permissionsRemoved: removed,
      // An update never inherits a human verification. Say so; the UI shows a
      // "re-verify" affordance rather than a skill that looks still-verified.
      trustReset: before.trust !== next.trust.tier,
      record: next,
      warnings: result.warnings || [],
    };
  }

  async updateAll({ actor = 'user', approve = null, onlyPatch = false } = {}) {
    const checks = await this.checkAll();
    const updated = [];
    const skipped = [];
    const failed = [];
    for (const check of checks) {
      if (!check.available) { skipped.push({ id: check.id, reason: check.reason }); continue; }
      if (onlyPatch && check.kind !== 'patch') { skipped.push({ id: check.id, reason: `${check.kind} update held back` }); continue; }
      try {
        updated.push(await this.update(check.id, { actor, approve }));
      } catch (err) {
        failed.push({ id: check.id, error: err.message });
      }
    }
    return { updated, skipped, failed };
  }

  _emit(type, record, payload) {
    if (this._bus) this._bus.emit(type, { skillId: record.id }, { skill: record.id, version: record.version, ...payload });
  }
}

// Rebuild the install request from a record's own provenance, so an update
// fetches from where the skill actually came from rather than from wherever the
// caller happens to be pointing.
function installRequestFor(record, listing) {
  const source = record.manifest.source;
  switch (source.type) {
    case 'github':
      return { source: 'github', repository: source.repository, path: source.path, ref: (listing && listing.ref) || 'HEAD', id: record.id };
    case 'skills.sh':
      return { source: 'skills.sh', id: source.slug || record.id };
    case 'local':
      return { source: 'local', id: record.id, dir: source.path || record.id };
    default:
      return { source: source.type, id: record.id };
  }
}

module.exports = { SkillUpdater, SkillUpdateError, installRequestFor };
