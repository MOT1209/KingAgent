// SkillEnabler: enable, disable, quarantine and release.
//
// One module rather than the four the phase brief sketches, because these are
// four moves on one state machine and splitting them across files would hide
// the only rule that matters: **quarantine is one-way without a person.**
//
//   enable      make a skill selectable again
//   disable     stop selecting it; keep everything known about it
//   quarantine  stop it for cause (security finding, failure streak) — the
//               system may do this on its own
//   release     take it out of quarantine — only a named human actor may, and
//               it lands in `disabled`, never straight back into service
//
// That last asymmetry is deliberate. Automatic quarantine with automatic
// release is a loop that re-enables a failing skill the moment the evidence
// scrolls out of a window; requiring a person means someone has looked.

const { SKILL_STATES } = require('./states');
const { TYPES } = require('../../events/event-bus');

class SkillStateError extends Error {
  constructor(message, { code = 'SKILL_STATE_ERROR', skillId = null } = {}) {
    super(message);
    this.name = 'SkillStateError';
    this.code = code;
    this.skillId = skillId;
  }
}

class SkillEnabler {
  constructor({ registry, bus = null, logger = null, policy = null } = {}) {
    if (!registry) throw new Error('SkillEnabler requires a SkillRegistry');
    this._registry = registry;
    this._bus = bus;
    this._logger = logger;
    this._policy = policy;
  }

  _require(id, version = null) {
    const record = version ? this._registry.getExact(id, version) : this._registry.get(id);
    if (!record) throw new SkillStateError(`${id} is not installed`, { code: 'SKILL_NOT_INSTALLED', skillId: id });
    return record;
  }

  async enable(id, { version = null, actor = 'user', reason = 'enabled by the user', context = {} } = {}) {
    const record = this._require(id, version);
    if (record.state === SKILL_STATES.QUARANTINED) {
      throw new SkillStateError(
        `${id} is quarantined (${lastReason(record)}). Release it first — that is a decision a person makes.`,
        { code: 'SKILL_QUARANTINED', skillId: id },
      );
    }
    if (record.security.blocked) {
      throw new SkillStateError(`${id} was refused by the security scanner and cannot be enabled`, { code: 'SKILL_BLOCKED', skillId: id });
    }
    // Enabling is itself a gated action: a deployment can forbid enabling
    // skills from a source, or of a risk level, through the same policy engine
    // everything else uses.
    if (this._policy) {
      const decision = await this._policy.evaluate({
        action: 'skill.enable',
        context: { ...context, skillId: id },
      });
      if (decision.effect === 'deny') {
        throw new SkillStateError(`policy denies enabling ${id}: ${decision.reason}`, { code: 'SKILL_ENABLE_DENIED', skillId: id });
      }
      if (decision.requiresApproval && !decision.approved) {
        throw new SkillStateError(`enabling ${id} needs approval: ${decision.reason}`, { code: 'SKILL_ENABLE_APPROVAL_REQUIRED', skillId: id });
      }
    }
    if (record.state === SKILL_STATES.ENABLED || record.state === SKILL_STATES.ACTIVE) {
      return { record, changed: false, state: record.state };
    }
    this._registry.transition(record, SKILL_STATES.ENABLED, { reason, actor });
    return { record, changed: true, state: record.state };
  }

  disable(id, { version = null, actor = 'user', reason = 'disabled by the user' } = {}) {
    const record = this._require(id, version);
    if (record.state === SKILL_STATES.DISABLED) return { record, changed: false, state: record.state };
    this._registry.transition(record, SKILL_STATES.DISABLED, { reason, actor });
    return { record, changed: true, state: record.state };
  }

  // Stop a skill for cause. `actor` defaults to the system because this is the
  // one transition the platform performs on its own — after a failure streak or
  // a security incident (see SkillEvaluator).
  quarantine(id, { version = null, actor = 'system', reason } = {}) {
    if (!reason) throw new SkillStateError('quarantine requires a reason — it is evidence, not a flag', { code: 'SKILL_QUARANTINE_NO_REASON', skillId: id });
    const record = this._require(id, version);
    if (record.state === SKILL_STATES.QUARANTINED) return { record, changed: false, state: record.state };
    this._registry.transition(record, SKILL_STATES.QUARANTINED, { reason, actor });
    if (this._logger) this._logger.warn(`quarantined skill ${id}`, { reason, actor });
    this._emit(TYPES.SKILL_QUARANTINED, record, { reason, actor });
    return { record, changed: true, state: record.state, reason };
  }

  // Out of quarantine, into `disabled`. Requires a named human and a note; the
  // note is kept in the record's history so the next person can see who decided
  // what, and why.
  release(id, { version = null, actor, note = '' } = {}) {
    if (!actor || typeof actor !== 'string' || actor === 'system') {
      throw new SkillStateError(
        'releasing a skill from quarantine requires a named person — the platform does not release its own quarantines',
        { code: 'SKILL_RELEASE_NEEDS_ACTOR', skillId: id },
      );
    }
    const record = this._require(id, version);
    if (record.state !== SKILL_STATES.QUARANTINED) {
      throw new SkillStateError(`${id} is not quarantined (state: ${record.state})`, { code: 'SKILL_NOT_QUARANTINED', skillId: id });
    }
    this._registry.transition(record, SKILL_STATES.DISABLED, {
      reason: `released from quarantine by ${actor}${note ? `: ${note}` : ''}`,
      actor,
    });
    // The findings stay. Releasing says "I have seen this"; it does not say the
    // scanner was wrong, and re-enabling still re-applies the posture.
    return { record, changed: true, state: record.state, note };
  }

  // Bulk switches the settings UI needs. Each one goes through the same
  // single-skill path so no bulk action can take a shortcut past the rules.
  disableAllFromSource(sourceType, { actor = 'user', reason = 'source disabled' } = {}) {
    return this._registry.list({ sourceType })
      .filter((r) => r.state !== SKILL_STATES.DISABLED && r.state !== SKILL_STATES.QUARANTINED)
      .map((r) => this.disable(r.id, { version: r.version, actor, reason }));
  }

  _emit(type, record, payload) {
    if (this._bus) this._bus.emit(type, { skillId: record.id }, { skill: record.id, version: record.version, ...payload });
  }
}

function lastReason(record) {
  const entry = [...record.history].reverse().find((h) => h.to === SKILL_STATES.QUARANTINED);
  return entry ? entry.reason : 'reason not recorded';
}

module.exports = { SkillEnabler, SkillStateError };
