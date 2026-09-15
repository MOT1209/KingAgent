// SkillLoader: bringing a skill's content into memory for one run, and refusing
// to when the content is not the content that was approved.
//
// The integrity check is the reason this module exists rather than being three
// lines inside the runtime. A skill is validated and scanned at install time,
// and its content digest is recorded. Every load compares the digest of what it
// just read against that record — and "what it just read" means the entry
// document *and* every resource it points at, because a resource is prompt text
// too and restricting the hash to the entry document is how a rewritten
// resource keeps passing as the skill that was approved:
//
//   same digest      -> load, with the verdict that was already reached
//   different digest -> the bytes changed after they were approved. Re-scan; if
//                       the new content is clean the record is updated and the
//                       change is reported, and if it is not, the skill is
//                       quarantined. Either way nothing runs on the old verdict.
//
// This is what makes a local skill directory safe to develop in and a remote
// skill safe to keep installed: a file edited after approval is a *new* thing
// to decide about, not an invisible one.

const { digestOfSkill, SkillCache } = require('../cache/SkillCache');
const { scanSkill } = require('../security/SkillScanner');
const { SKILL_STATES, isLoadable } = require('../lifecycle/states');
const { TYPES } = require('../../events/event-bus');

class SkillLoadError extends Error {
  constructor(message, { code = 'SKILL_LOAD_FAILED', skillId = null } = {}) {
    super(message);
    this.name = 'SkillLoadError';
    this.code = code;
    this.skillId = skillId;
  }
}

class SkillLoader {
  constructor({ registry, sources = {}, cache = null, bus = null, logger = null } = {}) {
    this._registry = registry;
    this._sources = sources; // sourceType -> adapter
    this._cache = cache || new SkillCache({ logger });
    this._bus = bus;
    this._logger = logger;
  }

  get cache() { return this._cache; }

  source(type) {
    const adapter = this._sources[type];
    if (!adapter) throw new SkillLoadError(`no source adapter is configured for "${type}"`, { code: 'SKILL_SOURCE_MISSING' });
    return adapter;
  }

  // Load one skill's content. Returns
  // `{ record, instructions, resources, digest, changed, rescan }`.
  async load(record, { refresh = false, quarantineOnChange = true } = {}) {
    if (!record) throw new SkillLoadError('load requires a skill record');
    // `usable` is the *selection* question; loading is wider. A skill already
    // loaded or running for another task is still loadable — what must not be
    // loadable is one that is disabled, quarantined, failed or blocked.
    if (!isLoadable(record.state) || record.security.blocked) {
      throw new SkillLoadError(`skill ${record.id} is ${record.security.blocked ? 'blocked by the scanner' : record.state} and cannot be loaded`, { code: 'SKILL_NOT_USABLE', skillId: record.id });
    }

    const key = SkillCache.key(record.id, record.version, record.manifest.source.type);
    let payload = refresh ? null : this._cache.get(key);

    if (!payload) {
      const adapter = this.source(record.manifest.source.type);
      const fetched = await adapter.read(record.manifest);
      if (!fetched || typeof fetched.content !== 'string') {
        throw new SkillLoadError(`source ${record.manifest.source.type} returned no content for ${record.id}`, { code: 'SKILL_EMPTY', skillId: record.id });
      }
      const resources = fetched.resources || {};
      payload = {
        content: fetched.content,
        resources,
        digest: digestOfSkill({ content: fetched.content, resources }),
      };
      this._cache.set(key, payload);
    }

    const changed = Boolean(record.contentDigest) && record.contentDigest !== payload.digest;
    let rescan = null;

    if (changed) {
      // The bytes are not the bytes that were approved. Decide again.
      rescan = scanSkill({ manifest: record.manifest, content: payload.content, resources: payload.resources });
      this._emit(TYPES.SKILL_SCANNED, record, { reason: 'content or resources changed since installation', blocked: rescan.blocked, findings: rescan.summary });
      if (rescan.blocked && quarantineOnChange) {
        record.setSecurity({ scanned: true, findings: rescan.findings, sandboxRequired: true, blocked: true });
        this._quarantine(record, 'content changed after installation and the new content was refused by the scanner');
        throw new SkillLoadError(
          `skill ${record.id} changed on disk and the new content was refused: ${rescan.findings.filter((f) => f.severity === 'critical').map((f) => f.summary).join('; ')}`,
          { code: 'SKILL_CONTENT_REFUSED', skillId: record.id },
        );
      }
      record.setSecurity({ scanned: true, findings: rescan.findings, sandboxRequired: record.security.sandboxRequired, blocked: false });
      record.contentDigest = payload.digest;
      if (this._logger) this._logger.warn(`skill ${record.id} changed since installation; re-scanned clean`, { digest: payload.digest.slice(0, 12) });
    } else if (!record.contentDigest) {
      record.contentDigest = payload.digest;
    }

    if (record.state === SKILL_STATES.ENABLED || record.state === SKILL_STATES.ACTIVE) {
      if (this._registry) this._registry.transition(record, SKILL_STATES.LOADED, { reason: 'loaded for a run' });
      else record.transition(SKILL_STATES.LOADED, { reason: 'loaded for a run' });
    }

    this._emit(TYPES.SKILL_LOADED, record, { digest: payload.digest.slice(0, 12), changed, bytes: payload.content.length });

    return {
      record,
      instructions: payload.content,
      resources: payload.resources,
      digest: payload.digest,
      changed,
      rescan,
    };
  }

  // Load a whole dependency-ordered set. Stops at the first failure and reports
  // what was loaded, because a partially loaded set is a state the caller must
  // know about rather than discover mid-run.
  async loadAll(records, opts = {}) {
    const loaded = [];
    for (const record of records) {
      try {
        loaded.push(await this.load(record, opts));
      } catch (err) {
        return { ok: false, loaded, failed: { skillId: record.id, error: err.message, code: err.code } };
      }
    }
    return { ok: true, loaded, failed: null };
  }

  _quarantine(record, reason) {
    try {
      if (this._registry) this._registry.transition(record, SKILL_STATES.QUARANTINED, { reason, actor: 'loader' });
      else record.transition(SKILL_STATES.QUARANTINED, { reason, actor: 'loader' });
    } catch (err) {
      // A record already in a terminal state cannot be quarantined again; that
      // is not an error worth masking the real one with.
      if (this._logger) this._logger.debug(`could not quarantine ${record.id}: ${err.message}`);
    }
  }

  _emit(type, record, payload) {
    if (this._bus) this._bus.emit(type, { skillId: record.id }, { skill: record.id, version: record.version, ...payload });
  }
}

module.exports = { SkillLoader, SkillLoadError };
