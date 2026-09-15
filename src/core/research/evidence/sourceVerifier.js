// Source verification (§18): the second opinion.
//
// Everything before this point is retrieval and analysis of what the first
// search happened to return. Verification is the deliberate act of going back
// out to *a different kind of source* to check a claim — and it is the only
// stage that can move a claim to `strongly_supported`, because that status
// requires independent corroboration by construction (claimAnalyzer).
//
// The strategy is the ladder §18 describes:
//
//     search → primary source → secondary source → cross-check → confidence
//
// Concretely: for each claim that needs it, plan a query aimed at a source type
// the claim is not already resting on, prefer primary types, retrieve, extract
// evidence, link it, and re-analyze. A claim already supported by the
// specification does not get re-verified against a blog.
//
// Verification runs through the same SourceManager as everything else, so it
// passes the same policy gate and the same security screen. There is no
// privileged retrieval path.

const { VERIFICATION } = require('../schemas/claim');
const { planVerificationQueries } = require('../planner/queryPlanner');
const { analyze, BANDS } = require('./claimAnalyzer');
const { rankEvidence } = require('./evidenceRanker');
const { ResearchBudgetError, ResearchCancelledError } = require('../errors/researchErrors');
const { PRIMARY_TYPES } = require('../schemas/source');

// Which claims are worth spending a verification query on, in priority order.
//
// Deliberately *not* "everything below the bar". A claim resting on one
// excellent primary source and a claim resting on three vague blogs both read
// as "supported", but only the second is improved by looking again — so the
// ordering puts thin corroboration and unresolved conflict first.
function selectForVerification(claims, { store, limit = 5, minConfidence = BANDS.SUPPORTED }) {
  const scored = [];
  for (const claim of claims) {
    if (!claim.material) continue;
    const sourceTypes = sourceTypesFor(claim, store);
    const hasPrimary = sourceTypes.some((t) => PRIMARY_TYPES.includes(t));

    let need = 0;
    let why = '';
    if (claim.verificationStatus === VERIFICATION.CONFLICTING) { need = 1.0; why = 'sources disagree'; }
    else if (claim.verificationStatus === VERIFICATION.CONTRADICTED) { need = 0.9; why = 'the evidence contradicts this'; }
    else if (claim.independentSourceCount <= 1) { need = 0.85; why = 'only one independent source'; }
    else if (claim.confidence < minConfidence) { need = 0.7; why = `confidence ${claim.confidence.toFixed(2)} is below the bar`; }
    else if (!hasPrimary) { need = 0.4; why = 'no primary source among the support'; }
    if (need === 0) continue;

    scored.push({ claim, need, why, usedSourceTypes: sourceTypes });
  }
  scored.sort((a, b) => b.need - a.need);
  return scored.slice(0, limit);
}

function sourceTypesFor(claim, store) {
  const types = new Set();
  for (const e of store.evidenceForClaim(claim.id)) {
    const s = store.source(e.sourceId);
    if (s) types.add(s.type);
  }
  return [...types];
}

class SourceVerifier {
  constructor({ sourceManager, extractor, planner = null, logger = null, emit = null } = {}) {
    if (!sourceManager) throw new TypeError('SourceVerifier requires a SourceManager');
    if (!extractor) throw new TypeError('SourceVerifier requires an EvidenceExtractor');
    this._sources = sourceManager;
    this._extractor = extractor;
    this._planner = planner;
    this._logger = logger;
    this._emit = typeof emit === 'function' ? emit : () => {};
  }

  // Verify a set of claims. Mutates the claims in place (via analyze) and
  // returns a report of what was attempted and what changed.
  //
  // Budget and cancellation propagate: verification is not exempt from §30.
  async verify({ task, claims, store, strategy, conflicts = [], signal = null, maxClaims = 5 }) {
    const targets = selectForVerification(claims, {
      store, limit: maxClaims, minConfidence: strategy ? strategy.targets.minConfidence : BANDS.SUPPORTED,
    });
    const report = { attempted: [], verified: 0, improved: 0, unchanged: 0, queries: 0, stopped: null };
    if (targets.length === 0) return report;

    const allowed = this._sources.allowedTypes(task);

    for (const target of targets) {
      if (signal && signal.aborted) { report.stopped = 'cancelled'; break; }

      const before = {
        status: target.claim.verificationStatus,
        confidence: target.claim.confidence,
        independent: target.claim.independentSourceCount,
      };

      const queries = planVerificationQueries({
        task,
        claim: target.claim,
        usedSourceTypes: target.usedSourceTypes,
        available: allowed,
        limit: 1,
      });
      if (queries.length === 0) {
        report.attempted.push({ claimId: target.claim.id, why: target.why, outcome: 'no query budget left' });
        report.stopped = report.stopped || 'budget';
        break;
      }

      let gathered = 0;
      for (const query of queries) {
        task.queries.push(query);
        for (const sourceType of query.sourceTypes) {
          if (signal && signal.aborted) { report.stopped = 'cancelled'; break; }
          let outcome;
          try {
            outcome = await this._sources.retrieve({
              task, query, sourceType, signal,
              freshness: strategy ? strategy.freshness : undefined,
            });
          } catch (err) {
            if (err instanceof ResearchBudgetError) { report.stopped = 'budget'; break; }
            if (err instanceof ResearchCancelledError) { report.stopped = 'cancelled'; break; }
            throw err;
          }
          if (!outcome.results.length) continue;

          const sources = outcome.results.map((r) => r.source);
          store.addSources(sources);
          task.sources.push(...sources);

          const extracted = this._extractor.extractAll({
            sources, question: task.question, claim: target.claim, queryId: query.id,
          });
          const ranked = rankEvidence(extracted, { store: { source: (id) => store.source(id) }, claim: target.claim, question: task.question });
          for (const e of ranked) {
            store.addEvidence(e);
            // Only evidence that actually takes a side is linked. Neutral text
            // about the subject is not corroboration, and counting it as such
            // is how confidence inflates without new information arriving.
            if (e.stance !== 'neutral') store.link(target.claim.id, e.id, e.stance);
            gathered += 1;
          }
          task.evidence.push(...ranked);
        }
        report.queries += 1;
        if (report.stopped) break;
      }

      analyze(target.claim, { store, conflicts });
      const after = {
        status: target.claim.verificationStatus,
        confidence: target.claim.confidence,
        independent: target.claim.independentSourceCount,
      };

      const changed = after.status !== before.status || Math.abs(after.confidence - before.confidence) > 0.01;
      if (changed) report.improved += 1; else report.unchanged += 1;
      if (after.status === VERIFICATION.STRONGLY_SUPPORTED || after.status === VERIFICATION.SUPPORTED) report.verified += 1;

      report.attempted.push({
        claimId: target.claim.id,
        why: target.why,
        evidenceAdded: gathered,
        before, after,
        // The honest outcome, including the one nobody likes: we looked again
        // and learned nothing.
        outcome: gathered === 0 ? 'no further evidence found'
          : changed ? `status ${before.status} -> ${after.status}`
            : 'evidence added but the verdict did not move',
      });

      this._emit({
        type: 'CLAIM_VERIFIED',
        payload: {
          claimId: target.claim.id, status: after.status,
          confidence: after.confidence, independentSources: after.independent,
        },
      });

      if (report.stopped) break;
    }

    return report;
  }
}

module.exports = { SourceVerifier, selectForVerification, sourceTypesFor };
