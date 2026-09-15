// SkillRanking: choosing between skills that could all do the job.
//
// The brief is explicit about the failure mode to avoid — "never select a skill
// only because it has the highest installation count" — and popularity is
// exactly the signal that quietly dominates a naive score, because it is the
// one number that grows without bound. Two structural choices prevent it here:
//
//   1. every factor is normalized to 0..1 before weighting, so no input can
//      out-shout the others by being large;
//   2. popularity is capped at POPULARITY_CAP of the total and is a
//      *tie-breaker weight*, below relevance, trust, reliability and security.
//
// The second design rule is that a rank must be explainable. `rank()` returns
// the contribution of every factor, not just a number, because "why did it pick
// that skill?" is a question a user will ask the moment a run goes badly.

const { trustRank, TRUST_TIERS } = require('../registry/SkillSource');
const { riskRank } = require('../schemas/SkillPermissionSchema');
const { highestSeverity } = require('../security/SkillScanner');

const WEIGHTS = Object.freeze({
  relevance: 0.32,   // does it match what this task needs
  reliability: 0.18, // has it worked before, here
  trust: 0.16,       // where did it come from
  security: 0.14,    // what did the scanner find
  quality: 0.10,     // the evaluator's score
  maintenance: 0.05, // is it current, is it deprecated
  compatibility: 0.03, // platform + dependency fit
  popularity: 0.02,  // installs. Deliberately last and deliberately tiny.
});
const POPULARITY_CAP = WEIGHTS.popularity;

// A skill with no history is not a bad skill; it is an unknown one. Scoring it
// 0 for reliability would mean a new, well-matched skill could never beat a
// mediocre one with a track record, so an unrun skill takes this neutral prior
// and earns its way up or down from there.
const UNKNOWN_RELIABILITY = 0.6;
const CONFIDENCE_RUNS = 5; // runs after which the observed rate is trusted fully

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function relevanceScore(candidate) {
  // Discovery hands out roughly 1 point per matched category; three solid
  // matches is a strong signal, so that is where the curve saturates.
  return clamp01((candidate.relevance || 0) / 3);
}

// Observed success rate, shrunk toward the neutral prior until there is enough
// history to believe it. One lucky run is not a 100% success rate.
function reliabilityScore(record) {
  const { runs, successes } = record.stats;
  if (runs === 0) return UNKNOWN_RELIABILITY;
  const observed = successes / runs;
  const confidence = Math.min(1, runs / CONFIDENCE_RUNS);
  return clamp01(observed * confidence + UNKNOWN_RELIABILITY * (1 - confidence));
}

function trustScore(record) {
  const rank = trustRank(record.trust.tier);
  return rank < 0 ? 0 : rank / (TRUST_TIERS.length - 1);
}

// Security is a penalty scale, not a reward: a clean scan is 1.0 and findings
// take it down. A skill that has actually caused an incident lands at 0.
function securityScore(record) {
  if (record.security.blocked) return 0;
  if (record.stats.securityIncidents > 0) return 0;
  const worst = highestSeverity(record.security.findings || []);
  const base = worst === 'critical' ? 0 : worst === 'warn' ? 0.5 : record.security.scanned ? 1 : 0.7;
  // High-risk skills are not penalized for being high-risk — that is what the
  // sandbox and the approval are for — but a high-risk skill with findings is
  // worse than a low-risk one with the same findings.
  const riskPenalty = worst === 'info' ? 0 : riskRank(record.manifest.riskLevel) * 0.05;
  return clamp01(base - riskPenalty);
}

function qualityScore(record) {
  if (!record.quality || !Number.isFinite(record.quality.score)) return 0.5; // unevaluated = neutral
  return clamp01(record.quality.score);
}

function maintenanceScore(record, { now = Date.now() } = {}) {
  if (record.manifest.deprecated) return 0.1;
  const updatedAt = record.updatedAt || record.installedAt;
  if (!updatedAt) return 0.5;
  const days = (now - updatedAt) / 86_400_000;
  if (days <= 30) return 1;
  if (days >= 365) return 0.2;
  return clamp01(1 - (days - 30) / 335 * 0.8);
}

function compatibilityScore(record, { platform = null, registry = null } = {}) {
  if (platform && !record.manifest.supportedPlatforms.includes(platform)) return 0;
  const deps = record.manifest.dependencies;
  if (!deps.length || !registry) return 1;
  const satisfied = deps.filter((d) => registry.satisfiesDependency(d)).length;
  return clamp01(satisfied / deps.length);
}

// Installs, log-scaled so the difference between 10 and 100 matters more than
// between 10,000 and 100,000 — and capped by its weight regardless.
function popularityScore(record) {
  const installs = (record.quality && record.quality.installs) || 0;
  if (installs <= 0) return 0;
  return clamp01(Math.log10(installs + 1) / 5);
}

// Rank one candidate. `candidate` is `{ record, matchedCategories, relevance }`
// as produced by SkillDiscovery.discover().
function rank(candidate, { platform = null, registry = null, now = Date.now() } = {}) {
  const record = candidate.record;
  const factors = {
    relevance: relevanceScore(candidate),
    reliability: reliabilityScore(record),
    trust: trustScore(record),
    security: securityScore(record),
    quality: qualityScore(record),
    maintenance: maintenanceScore(record, { now }),
    compatibility: compatibilityScore(record, { platform, registry }),
    popularity: popularityScore(record),
  };

  const contributions = {};
  let score = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const value = factors[key] * weight;
    contributions[key] = Math.round(value * 1000) / 1000;
    score += value;
  }

  // Hard gates. These are not weights: a skill that cannot run here, or that
  // the scanner blocked, is not a lower-ranked option — it is not an option.
  const blockers = [];
  if (factors.compatibility === 0) blockers.push(platform ? `does not support ${platform}` : 'dependencies are unresolved');
  if (record.security.blocked) blockers.push('blocked by the security scanner');
  if (!record.usable) blockers.push(`state is "${record.state}"`);

  return {
    skillId: record.id,
    version: record.version,
    score: blockers.length ? 0 : Math.round(score * 1000) / 1000,
    eligible: blockers.length === 0,
    blockers,
    factors,
    contributions,
    matchedCategories: candidate.matchedCategories || [],
    explanation: explain(record, factors, contributions, blockers),
  };
}

function rankAll(candidates, opts = {}) {
  return candidates
    .map((c) => rank(c, opts))
    .sort((a, b) => b.score - a.score || (a.skillId < b.skillId ? -1 : 1));
}

// The sentence a user reads under a chosen skill. Built from the two factors
// that contributed most plus anything that dragged it down, because "chosen
// because it matched and is trusted, despite being unevaluated" is the honest
// form of an explanation.
function explain(record, factors, contributions, blockers) {
  if (blockers.length) return `not eligible: ${blockers.join('; ')}`;
  const top = Object.entries(contributions).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
  const weak = Object.entries(factors).filter(([, v]) => v < 0.4).map(([k]) => k);
  const parts = [`ranked on ${top.join(' and ')}`];
  if (record.stats.runs > 0) {
    parts.push(`${record.stats.successes}/${record.stats.runs} successful runs here`);
  } else {
    parts.push('never run here yet');
  }
  parts.push(`trust ${record.trust.tier}`);
  if (weak.length) parts.push(`weak on ${weak.join(', ')}`);
  return parts.join('; ');
}

module.exports = {
  WEIGHTS,
  POPULARITY_CAP,
  UNKNOWN_RELIABILITY,
  rank,
  rankAll,
  relevanceScore,
  reliabilityScore,
  trustScore,
  securityScore,
  maintenanceScore,
  compatibilityScore,
  popularityScore,
};
