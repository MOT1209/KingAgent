// The research quality evaluator (§37): the honest scorecard, computed before
// anything is shown to anyone.
//
// The line this module exists to hold: **do not claim high confidence when the
// evidence is weak.** Every input here is already computed by a layer that can
// be argued with — source quality, evidence shape, completeness, citation
// validation — and this combines them into one number plus the reasons behind
// it. A caller can disagree with the weighting; it cannot get a good score out
// of bad research.
//
// The composite is also *capped by its weakest structural input*. Averaging
// lets a task with excellent sources and no coverage score respectably, which
// is precisely the report nobody should trust.

const { assess: assessEvidence } = require('./evidenceQuality');
const { evaluate: evaluateCompleteness } = require('./completenessEvaluator');
const { validateAll } = require('../citations/citationValidator');
const { VERIFICATION, isAssertable } = require('../schemas/claim');
const { clamp01 } = require('../schemas/source');

const GRADE = Object.freeze({
  STRONG: 'strong',
  ADEQUATE: 'adequate',
  WEAK: 'weak',
  INSUFFICIENT: 'insufficient',
});

// Did this question need researching at all? A request routed here that needed
// no research is allowed to produce no claims.
function researchWasNeeded(task) {
  return !task.classification || task.classification.needsResearch !== false;
}

function gradeFor(score, { blocked }) {
  if (blocked) return GRADE.INSUFFICIENT;
  if (score >= 0.75) return GRADE.STRONG;
  if (score >= 0.55) return GRADE.ADEQUATE;
  if (score >= 0.3) return GRADE.WEAK;
  return GRADE.INSUFFICIENT;
}

function evaluate({ task, store, claims, citations, conflicts = [], strategy = null }) {
  const evidence = assessEvidence({ store, claims });
  const completeness = evaluateCompleteness({ task, claims, strategy });
  const validation = validateAll({
    claims, citations, store, conflicts,
    requireCitations: task.requireCitations,
  });

  const material = claims.filter((c) => c.material);
  // `isAssertable` is the schema's own definition of "safe to state plainly".
  // Re-implementing the status comparison here is how the evaluator and the
  // synthesizer drift into disagreeing about what the answer may assert.
  const assertable = material.filter(isAssertable);
  const unresolvedConflicts = conflicts.filter((c) => c.resolution === 'unresolved');

  const sources = store.sources();
  const sourceQuality = sources.length
    ? sources.reduce((a, s) => a + (s.qualityScore ?? 0.5), 0) / sources.length
    : 0;

  const relevance = sources.length
    ? sources.reduce((a, s) => a + (s.relevanceScore ?? 0), 0) / sources.length
    : 0;

  // Vacuously complete when there is nothing material to cite. A run that
  // established no material claim has a *coverage* problem, and scoring its
  // citations at zero as well would report the same failure twice and bury the
  // real one.
  const citationCompleteness = validation.materialClaims
    ? validation.citedMaterialClaims / validation.materialClaims
    : 1;

  // Mean confidence over *material* claims only. Including asides would let a
  // pile of well-supported trivia carry an unsupported headline claim.
  const confidence = material.length
    ? material.reduce((a, c) => a + c.confidence, 0) / material.length
    : 0;

  const freshness = sources.length
    ? sources.reduce((a, s) => a + (s.freshnessScore ?? 0.5), 0) / sources.length
    : 0;

  const diversity = clamp01(evidence.distinctDomains / 4);

  const metrics = {
    coverage: completeness.score,
    relevance: Number(relevance.toFixed(4)),
    sourceQuality: Number(sourceQuality.toFixed(4)),
    evidenceQuality: evidence.score,
    citationCompleteness: Number(citationCompleteness.toFixed(4)),
    sourceDiversity: Number(diversity.toFixed(4)),
    freshness: Number(freshness.toFixed(4)),
    conflictHandling: conflicts.length === 0 ? 1 : Number((1 - unresolvedConflicts.length / conflicts.length).toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
  };

  const weighted = clamp01(
    metrics.coverage * 0.22
    + metrics.evidenceQuality * 0.2
    + metrics.sourceQuality * 0.16
    + metrics.citationCompleteness * 0.14
    + metrics.confidence * 0.12
    + metrics.sourceDiversity * 0.08
    + metrics.freshness * 0.04
    + metrics.conflictHandling * 0.04,
  );

  // The cap. Research cannot be better than its worst structural pillar — if
  // nothing was covered, or nothing was corroborated, or the material claims
  // are uncited, the whole thing is bounded by that.
  const pillars = [
    { name: 'coverage', value: metrics.coverage },
    { name: 'evidence', value: metrics.evidenceQuality },
    { name: 'citations', value: task.requireCitations ? metrics.citationCompleteness : 1 },
  ];
  const weakest = pillars.reduce((a, b) => (b.value < a.value ? b : a));
  const score = Math.min(weighted, clamp01(weakest.value + 0.25));

  const reasons = [
    ...completeness.reasons,
    ...evidence.reasons,
  ];
  if (!validation.ok) reasons.push(`${validation.errors.length} citation integrity error(s)`);
  if (unresolvedConflicts.length) reasons.push(`${unresolvedConflicts.length} unresolved conflict(s) between sources`);
  if (material.length && assertable.length === 0) reasons.push('no material claim reached the "supported" bar');
  if (score < weighted - 0.001) reasons.push(`capped by the weakest pillar (${weakest.name} at ${weakest.value.toFixed(2)})`);
  if (task.usage.sources >= task.limits.maxSources) reasons.push('the source budget was exhausted; the picture may be incomplete');
  if (task.failures.some((f) => !f.fatal)) reasons.push(`${task.failures.length} non-fatal failure(s) during retrieval`);

  // Did the run clear the bar its own mode set? This is what stops a "deep"
  // label from meaning nothing.
  const targets = strategy ? strategy.targets : null;
  const misses = [];
  if (targets) {
    if (sources.length < targets.minSources) misses.push(`${sources.length} sources; ${targets.minSources} expected for ${strategy.mode}`);
    if (evidence.independentSources < targets.minIndependentSources) misses.push(`${evidence.independentSources} independent sources; ${targets.minIndependentSources} expected`);
    if (metrics.confidence < targets.minConfidence) misses.push(`mean confidence ${metrics.confidence.toFixed(2)}; ${targets.minConfidence} expected`);
    if (metrics.coverage < targets.minCoverage) misses.push(`coverage ${metrics.coverage.toFixed(2)}; ${targets.minCoverage} expected`);
    if (evidence.distinctDomains < targets.minDistinctDomains) misses.push(`${evidence.distinctDomains} distinct domains; ${targets.minDistinctDomains} expected`);
  }

  return Object.freeze({
    ...metrics,
    score: Number(score.toFixed(4)),
    grade: gradeFor(score, { blocked: !validation.ok }),
    // The gate. `false` means the answer does not ship as-is: either a citation
    // error, or nothing material is assertable while citations were required.
    // Passing requires citation integrity *and* something to say. "No material
    // claim was established" used to pass vacuously, which meant a run that
    // found nothing reported itself as fine.
    passed: validation.ok
      && (material.length > 0 || !researchWasNeeded(task))
      && (material.length === 0 || assertable.length > 0 || !task.requireVerification),
    blocking: validation.errors.map((e) => ({ type: e.type, message: e.message })),
    warnings: validation.warnings.map((w) => ({ type: w.type, message: w.message })),
    targetsMet: misses.length === 0,
    targetMisses: misses,
    reasons: [...new Set(reasons)],
    detail: { evidence, completeness, validation: { ok: validation.ok, errors: validation.errors.length, warnings: validation.warnings.length } },
    claims: { total: claims.length, material: material.length, assertable: assertable.length },
    conflicts: { total: conflicts.length, unresolved: unresolvedConflicts.length },
    evaluatedAt: Date.now(),
  });
}

// Where should another round of research go? Feeds the replan loop (§39).
function gapsFrom(evaluation, { claims, strategy }) {
  const out = [];
  const minConfidence = strategy ? strategy.targets.minConfidence : 0.5;
  for (const claim of claims) {
    if (!claim.material) continue;
    if (claim.confidence >= minConfidence && claim.verificationStatus !== VERIFICATION.CONFLICTING) continue;
    out.push({ claim, reason: `confidence ${claim.confidence.toFixed(2)} below ${minConfidence}` });
  }
  for (const s of evaluation.detail.completeness.subjects) {
    if (s.covered) continue;
    out.push({ query: s.subject, reason: `no claims were found about "${s.subject}"` });
  }
  return out;
}

module.exports = { evaluate, gapsFrom, GRADE, gradeFor };
