// SkillRemover: taking a skill out, without leaving something that depended on
// it half-working.
//
// Removal is the operation most likely to be done in a hurry ("this one is
// misbehaving, get rid of it"), which is exactly why it checks first:
//
//   * a skill another installed skill depends on is not removed silently — the
//     dependents are named and the caller must force it deliberately;
//   * removal is recorded before the row disappears, so an audit of "what was
//     installed last week" survives the removal;
//   * cached content is invalidated in the same operation. A cache entry that
//     outlives its registry row is how a removed skill gets loaded again.
//
// Quarantine is *not* removal and is a separate operation (SkillEnabler): a
// quarantined skill is kept precisely so the evidence stays.

const { dependents, canRemove } = require('../loader/SkillDependencyResolver');
const { SKILL_STATES } = require('./states');
const { TYPES } = require('../../events/event-bus');

class SkillRemoveError extends Error {
  constructor(message, { code = 'SKILL_REMOVE_BLOCKED', skillId = null, blockers = [] } = {}) {
    super(message);
    this.name = 'SkillRemoveError';
    this.code = code;
    this.skillId = skillId;
    this.blockers = blockers;
  }
}

class SkillRemover {
  constructor({ registry, cache = null, bus = null, logger = null, memory = null } = {}) {
    if (!registry) throw new Error('SkillRemover requires a SkillRegistry');
    this._registry = registry;
    this._cache = cache;
    this._bus = bus;
    this._logger = logger;
    this._memory = memory;
  }

  // What removing this would break. Read-only; the UI calls it to show the
  // confirmation dialog's contents.
  impact(id, { version = null } = {}) {
    const records = version ? [this._registry.getExact(id, version)].filter(Boolean) : this._registry.all(id);
    if (records.length === 0) return { id, exists: false, dependents: [], removable: false, reason: `${id} is not installed` };
    const verdict = canRemove(this._registry, id, { version });
    return {
      id,
      exists: true,
      versions: records.map((r) => r.version),
      dependents: dependents(this._registry, id),
      removable: verdict.ok,
      reason: verdict.ok ? 'nothing installed depends on it' : `still required by ${verdict.blockers.map((b) => `${b.id}@${b.version} (${b.range})`).join(', ')}`,
    };
  }

  async remove(id, { version = null, force = false, actor = 'user', reason = 'removed by the user' } = {}) {
    const impact = this.impact(id, { version });
    if (!impact.exists) throw new SkillRemoveError(`${id} is not installed`, { code: 'SKILL_NOT_INSTALLED', skillId: id });
    if (!impact.removable && !force) {
      throw new SkillRemoveError(
        `${id} cannot be removed: ${impact.reason}. Remove the dependents first, or force the removal knowingly.`,
        { skillId: id, blockers: impact.dependents },
      );
    }

    const records = version ? [this._registry.getExact(id, version)].filter(Boolean) : this._registry.all(id);
    const removed = [];
    for (const record of records) {
      // Record the terminal state before the row goes, so the event carries the
      // history rather than just an id.
      try {
        this._registry.transition(record, SKILL_STATES.REMOVED, { reason, actor });
      } catch (err) {
        if (this._logger) this._logger.debug(`could not mark ${id}@${record.version} removed: ${err.message}`);
      }
      removed.push({
        id: record.id,
        version: record.version,
        runs: record.stats.runs,
        failures: record.stats.failures,
        securityIncidents: record.stats.securityIncidents,
        trust: record.trust.tier,
        source: record.manifest.source.type,
      });
    }

    this._registry.remove(id, version);
    if (this._cache) this._cache.invalidateSkill(id);

    this._emit(TYPES.SKILL_REMOVED, { id }, { versions: removed.map((r) => r.version), actor, reason, forced: force && !impact.removable, history: removed });
    if (this._logger) this._logger.info(`removed skill ${id}`, { versions: removed.map((r) => r.version), forced: force && !impact.removable });

    return { id, removed, forced: force && !impact.removable, brokenDependents: force ? impact.dependents : [] };
  }

  // Remove every skill from one source — what "disconnect this skill registry"
  // does. Built-ins are never included: they are part of the application.
  async removeBySource(sourceType, { actor = 'user', force = true } = {}) {
    if (sourceType === 'builtin') {
      throw new SkillRemoveError('built-in skills are part of the application and cannot be removed', { code: 'SKILL_BUILTIN', skillId: null });
    }
    const ids = [...new Set(this._registry.list({ sourceType }).map((r) => r.id))];
    const results = [];
    for (const id of ids) {
      results.push(await this.remove(id, { actor, force, reason: `source ${sourceType} disconnected` }).catch((err) => ({ id, error: err.message })));
    }
    return results;
  }

  _emit(type, record, payload) {
    if (this._bus) this._bus.emit(type, { skillId: record.id }, { skill: record.id, ...payload });
  }
}

module.exports = { SkillRemover, SkillRemoveError };
