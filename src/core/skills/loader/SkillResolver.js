// SkillResolver: turning a reference into a concrete skill.
//
// References arrive from four places and each has a different failure mode
// worth naming, which is why this is one module rather than scattered lookups:
//
//   "mcp-builder"            a user or a manifest naming a skill
//   "mcp-builder@^1.2.0"     the same, pinned to a range
//   { capability: "mcp.server.create" }   a planner asking for an ability
//   { category: "mcp-builder" }           discovery asking for coverage
//
// Resolution is registry-first and never fetches: an installed skill that
// satisfies the reference wins, and if none does, the answer is a *candidate*
// from a configured source plus the reason the local lookup failed. Deciding to
// fetch is the installer's job and needs a human or a policy behind it, so a
// resolver that silently downloaded would be the wrong place for that decision.

const { satisfies, compareVersions } = require('../registry/SkillVersion');
const { rankAll } = require('../discovery/SkillRanking');

const REFERENCE = /^([a-z][a-z0-9._:-]*)(?:@(.+))?$/;

function parseReference(ref) {
  if (typeof ref === 'string') {
    const m = REFERENCE.exec(ref.trim());
    if (!m) return null;
    return { id: m[1], range: m[2] || '*', capability: null, category: null };
  }
  if (ref && typeof ref === 'object') {
    if (ref.id) return { id: ref.id, range: ref.range || ref.version || '*', capability: null, category: null };
    if (ref.capability) return { id: null, range: '*', capability: ref.capability, category: null };
    if (ref.category) return { id: null, range: '*', category: ref.category, capability: null };
  }
  return null;
}

class SkillResolver {
  constructor({ registry, sources = [], platform = null, logger = null } = {}) {
    this._registry = registry;
    this._sources = sources;
    this._platform = platform;
    this._logger = logger;
  }

  // Resolve locally. Returns `{ ok, record, reason, alternatives }`.
  resolve(ref, { usableOnly = true } = {}) {
    const parsed = parseReference(ref);
    if (!parsed) return { ok: false, record: null, reason: `unparseable skill reference: ${JSON.stringify(ref)}`, alternatives: [] };

    if (parsed.id) {
      const all = this._registry.all(parsed.id);
      if (all.length === 0) return { ok: false, record: null, reason: `no skill named "${parsed.id}" is installed`, alternatives: [], parsed };
      const matching = all.filter((r) => satisfies(r.version, parsed.range));
      if (matching.length === 0) {
        return {
          ok: false,
          record: null,
          reason: `installed ${parsed.id} versions (${all.map((r) => r.version).join(', ')}) do not satisfy ${parsed.range}`,
          alternatives: all.map((r) => ({ id: r.id, version: r.version, state: r.state })),
          parsed,
        };
      }
      const usable = matching.filter((r) => r.usable);
      if (usableOnly && usable.length === 0) {
        return {
          ok: false,
          record: null,
          reason: `${parsed.id} is installed but not usable (${[...new Set(matching.map((r) => r.state))].join(', ')})`,
          alternatives: matching.map((r) => ({ id: r.id, version: r.version, state: r.state })),
          parsed,
        };
      }
      const pool = usableOnly ? usable : matching;
      const record = pool.sort((a, b) => compareVersions(a.version, b.version))[pool.length - 1];
      if (this._platform && !record.manifest.supportedPlatforms.includes(this._platform)) {
        return { ok: false, record: null, reason: `${record.id}@${record.version} does not support ${this._platform}`, alternatives: [], parsed };
      }
      return { ok: true, record, reason: '', alternatives: pool.filter((r) => r !== record).map((r) => ({ id: r.id, version: r.version })), parsed };
    }

    // Capability / category: several skills may answer, so rank rather than
    // pick the first index hit — "which skill provides this" and "which skill
    // should provide this" are the same question once more than one does.
    const pool = parsed.capability
      ? this._registry.byCapability(parsed.capability)
      : this._registry.byCategory(parsed.category);
    if (pool.length === 0) {
      return {
        ok: false,
        record: null,
        reason: `no installed skill provides ${parsed.capability ? `capability "${parsed.capability}"` : `category "${parsed.category}"`}`,
        alternatives: [],
        parsed,
      };
    }
    const ranked = rankAll(
      pool.map((record) => ({ record, relevance: 3, matchedCategories: parsed.category ? [parsed.category] : [] })),
      { platform: this._platform, registry: this._registry },
    );
    const best = ranked.find((r) => r.eligible);
    if (!best) {
      return { ok: false, record: null, reason: `every candidate is ineligible: ${ranked.map((r) => `${r.skillId} (${r.blockers.join(', ')})`).join('; ')}`, alternatives: [], parsed };
    }
    return {
      ok: true,
      record: this._registry.getExact(best.skillId, best.version),
      reason: best.explanation,
      alternatives: ranked.filter((r) => r !== best).map((r) => ({ id: r.skillId, version: r.version, score: r.score })),
      parsed,
    };
  }

  // Local first; if nothing satisfies, ask the configured sources what exists.
  // The result is explicitly a *proposal*: `install: false` and the candidate's
  // origin, for a caller that will decide (or ask a person) whether to fetch it.
  async resolveOrPropose(ref, opts = {}) {
    const local = this.resolve(ref, opts);
    if (local.ok) return { ...local, proposal: null };
    const parsed = local.parsed || parseReference(ref);
    if (!parsed || !parsed.id) return { ...local, proposal: null };

    for (const source of this._sources) {
      if (!source || typeof source.find !== 'function') continue;
      try {
        const found = await source.find({ id: parsed.id, range: parsed.range });
        if (found) {
          return {
            ...local,
            proposal: {
              id: parsed.id,
              range: parsed.range,
              source: source.id,
              listing: found,
              install: false,
              reason: `${parsed.id} is available from ${source.id}; installing it is a separate, approved step`,
            },
          };
        }
      } catch (err) {
        if (this._logger) this._logger.debug(`source ${source.id} could not look up ${parsed.id}: ${err.message}`);
      }
    }
    return { ...local, proposal: null };
  }
}

module.exports = { SkillResolver, parseReference };
