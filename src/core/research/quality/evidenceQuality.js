// Evidence quality: is the *body of evidence* good, as distinct from whether any
// individual passage is (evidenceRanker) or whether any individual source is
// (sourceQuality)?
//
// The failure this measures is the one a per-item score cannot see: twenty
// strong passages that all say the same thing, from pages that all trace back to
// one announcement, look excellent item by item and are worth roughly one
// source. So the metrics here are all about *shape* — breadth, independence,
// balance, and whether the primary source is present at all.

const { STANCE } = require('../schemas/evidence');
const { independentCount } = require('../retrieval/deduplicator');
const { clamp01 } = require('../schemas/source');

function assess({ store, claims, evidence = null }) {
  const all = evidence || store.allEvidence();
  const sourcesById = store.sourcesById();
  const clusterOf = store.clusterMap();

  if (all.length === 0) {
    return {
      score: 0, items: 0, independentSources: 0, distinctDomains: 0,
      primaryShare: 0, meanStrength: 0, balance: 0, concentration: 1,
      reasons: ['no evidence was extracted'],
    };
  }

  const sourceIds = [...new Set(all.map((e) => e.sourceId))];
  const independent = independentCount(sourceIds, { clusterOf, sourcesById });
  const domains = new Set(sourceIds.map((id) => (sourcesById.get(id) || {}).domain).filter(Boolean));
  const primaries = sourceIds.filter((id) => (sourcesById.get(id) || {}).primary).length;
  const strengths = all.map((e) => e.strength ?? 0);
  const meanStrength = strengths.reduce((a, b) => a + b, 0) / strengths.length;

  // Concentration: what share of the evidence comes from its single biggest
  // contributor? 1.0 means everything came from one page.
  const perSource = new Map();
  for (const e of all) perSource.set(e.sourceId, (perSource.get(e.sourceId) || 0) + 1);
  const concentration = Math.max(...perSource.values()) / all.length;

  // Balance: a claim set with no contradicting evidence anywhere is either
  // uncontroversial or under-searched, and the two are hard to tell apart. This
  // is reported, not penalized — a genuinely settled question should not be
  // marked down for being settled.
  const contradicting = all.filter((e) => e.stance === STANCE.CONTRADICTS).length;
  const balance = all.length ? contradicting / all.length : 0;

  const materialClaims = claims.filter((c) => c.material);
  const withTwo = materialClaims.filter((c) => c.independentSourceCount >= 2).length;
  const corroborationRate = materialClaims.length ? withTwo / materialClaims.length : 0;

  const reasons = [];
  if (independent <= 1) reasons.push('all evidence traces back to a single independent source');
  if (concentration > 0.7 && all.length > 3) reasons.push('most of the evidence comes from one document');
  if (primaries === 0) reasons.push('no primary source among the evidence');
  if (corroborationRate < 0.5 && materialClaims.length > 1) reasons.push('fewer than half the material claims have independent corroboration');

  const score = clamp01(
    meanStrength * 0.3
    + clamp01(independent / 4) * 0.28
    + clamp01(domains.size / 4) * 0.14
    + clamp01(primaries / Math.max(1, sourceIds.length)) * 0.16
    + corroborationRate * 0.12,
  ) * (concentration > 0.8 ? 0.8 : 1);

  return {
    score: Number(score.toFixed(4)),
    items: all.length,
    sources: sourceIds.length,
    independentSources: independent,
    distinctDomains: domains.size,
    primaryShare: Number((primaries / Math.max(1, sourceIds.length)).toFixed(4)),
    meanStrength: Number(meanStrength.toFixed(4)),
    corroborationRate: Number(corroborationRate.toFixed(4)),
    balance: Number(balance.toFixed(4)),
    concentration: Number(concentration.toFixed(4)),
    reasons,
  };
}

module.exports = { assess };
