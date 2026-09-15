// Claim analysis (§16): turn a question plus a pile of evidence into claims with
// a derived verification status and an honest confidence number.
//
// Two rules govern everything here.
//
//   1. **Status is derived, never asserted.** `analyze()` is the only thing that
//      writes `verificationStatus`, and it computes it from the evidence in the
//      store. A synthesizer cannot label its own output "strongly supported".
//   2. **Independence is counted, not assumed.** Corroboration is measured over
//      dedup clusters and domains (deduplicator.independentCount), so five
//      copies of one vendor's blog post is one source, not five.
//
// Claim *extraction* — deciding which assertions the research is about — is
// deterministic by default and can be improved by a model. The model may
// propose claim texts; it can never attach evidence to them, because evidence
// linkage is what the extractor's verbatim spans establish.

const { normalizeClaim, VERIFICATION } = require('../schemas/claim');
const { STANCE } = require('../schemas/evidence');
const { independentCount } = require('../retrieval/deduplicator');
const { aggregateStrength } = require('./evidenceRanker');
const { tokenSet, coverage } = require('../text');
const { clamp01 } = require('../schemas/source');

// Confidence bands. Stated as constants because they are a policy decision, not
// an implementation detail: these numbers decide when the system is allowed to
// speak plainly and when it must hedge.
const BANDS = Object.freeze({
  STRONG: 0.75,   // strongly_supported requires this *and* independent breadth
  SUPPORTED: 0.5,
  WEAK: 0.25,     // below this: insufficient_evidence
});

// A claim is only "strongly supported" with corroboration from genuinely
// separate sources. One excellent source is `supported`, however good it is.
const STRONG_MIN_INDEPENDENT = 2;

// Derive candidate claims from the question and the evidence.
//
// The default strategy: each high-strength piece of evidence that asserts
// something on-topic becomes a candidate claim, and near-identical candidates
// merge. This is intentionally conservative — it produces claims the evidence
// already supports rather than inventing propositions to go looking for.
function extractClaims({ question, evidence, store, maxClaims = 12, minStrength = 0.25 }) {
  const questionTokens = tokenSet(question);
  const candidates = [];

  for (const e of evidence) {
    if ((e.strength ?? e.relevance ?? 0) < minStrength) continue;
    const sentence = firstAssertion(e.text);
    if (!sentence) continue;
    const onTopic = coverage(questionTokens, tokenSet(sentence));
    if (onTopic < 0.15) continue;
    candidates.push({ text: sentence, evidence: e, onTopic, strength: e.strength ?? e.relevance ?? 0 });
  }

  candidates.sort((a, b) => (b.onTopic + b.strength) - (a.onTopic + a.strength));

  const claims = [];
  for (const c of candidates) {
    if (claims.length >= maxClaims) break;
    const existing = claims.find((k) => similar(k.text, c.text));
    if (existing) {
      store.link(existing.id, c.evidence.id, c.evidence.stance === STANCE.NEUTRAL ? STANCE.SUPPORTS : c.evidence.stance);
      continue;
    }
    const claim = store.addClaim(normalizeClaim({
      text: c.text,
      subject: null,
      // Materiality: a claim that answers the question directly is material;
      // an aside picked up along the way is not, and §20 only holds material
      // claims to the citation bar.
      material: c.onTopic >= 0.3,
      queryId: c.evidence.queryId,
    }));
    store.link(claim.id, c.evidence.id, c.evidence.stance === STANCE.NEUTRAL ? STANCE.SUPPORTS : c.evidence.stance);
    claims.push(claim);
  }
  return claims;
}

// The first sentence in a span that actually asserts something. A span often
// opens with a fragment; the claim should be the proposition, not the lead-in.
function firstAssertion(text) {
  const parts = String(text).split(/(?<=[.!?])\s+/);
  for (const part of parts) {
    const t = part.trim();
    if (t.length < 20 || t.length > 400) continue;
    if (/\b(?:is|are|was|were|has|have|supports?|requires?|provides?|returns?|means|allows?|includes?|does not|cannot)\b/i.test(t)) {
      return t;
    }
  }
  const whole = String(text).trim();
  return whole.length >= 20 && whole.length <= 400 ? whole : null;
}

function similar(a, b, threshold = 0.7) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size) >= threshold;
}

// Attach every relevant piece of evidence to every claim, not just the piece
// that produced it. Without this pass a claim is only ever supported by its own
// origin, and cross-source corroboration — the thing §16 is about — never
// happens.
function linkEvidenceToClaims({ claims, evidence, store, minOverlap = 0.4, extractor = null }) {
  for (const claim of claims) {
    const claimTokens = tokenSet(claim.text);
    const linked = new Set(store.evidenceForClaim(claim.id).map((x) => x.id));
    for (const e of evidence) {
      if (linked.has(e.id)) continue;
      if (coverage(claimTokens, tokenSet(e.text)) < minOverlap) continue;
      // Re-derive the stance against *this* claim: a passage that supports one
      // claim can contradict another, and reusing the original label would
      // propagate the wrong sign.
      const stance = extractor
        ? extractor._stanceFor(e.text, claim)
        : (e.stance === STANCE.NEUTRAL ? STANCE.SUPPORTS : e.stance);
      if (stance === STANCE.NEUTRAL) continue;
      store.link(claim.id, e.id, stance);
    }
  }
  return claims;
}

// The derivation. Returns the claim, mutated in place with its derived fields.
function analyze(claim, { store, conflicts = [] } = {}) {
  const evidence = store.evidenceForClaim(claim.id);
  const claimConflictsAll = conflicts.filter((c) => c.claimId === claim.id);

  // Evidence a resolved conflict ruled against no longer supports anything. A
  // claim whose only support was the outdated version number must not keep
  // reading as "strongly supported" because the conflict it lost was closed.
  const superseded = new Set();
  for (const c of claimConflictsAll) {
    for (const id of c.supersededEvidenceIds || []) superseded.add(id);
  }

  const supporting = evidence.filter((e) => e.stance === STANCE.SUPPORTS && !superseded.has(e.id));
  const contradicting = evidence.filter((e) => e.stance === STANCE.CONTRADICTS && !superseded.has(e.id));
  const supersededSupport = evidence.filter((e) => e.stance === STANCE.SUPPORTS && superseded.has(e.id));

  const sourcesById = store.sourcesById();
  const clusterOf = store.clusterMap();
  const supportingSources = [...new Set(supporting.map((e) => e.sourceId))];
  const contradictingSources = [...new Set(contradicting.map((e) => e.sourceId))];
  const allSources = [...new Set([...supportingSources, ...contradictingSources])];

  const independent = independentCount(supportingSources, { clusterOf, sourcesById });
  const independentAgainst = independentCount(contradictingSources, { clusterOf, sourcesById });

  const agg = aggregateStrength(evidence, { independentSources: independent });

  // Source quality is the mean of the supporting sources' own scores, so a
  // claim supported only by weak sources cannot outrank one supported by the
  // specification.
  const qualities = supportingSources
    .map((id) => sourcesById.get(id))
    .filter(Boolean)
    .map((s) => s.qualityScore ?? (s.primary ? 0.7 : 0.5));
  const sourceQuality = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 0;

  const claimConflicts = claimConflictsAll;

  claim.supportingEvidence = supporting.map((e) => e.id);
  claim.contradictingEvidence = contradicting.map((e) => e.id);
  claim.conflictIds = claimConflicts.map((c) => c.id);
  claim.sourceCount = allSources.length;
  claim.independentSourceCount = independent;
  claim.sourceQuality = Number(sourceQuality.toFixed(4));
  claim.supersededEvidence = supersededSupport.map((e) => e.id);
  claim.verificationStatus = deriveStatus({
    agg, independent, independentAgainst,
    hasConflict: claimConflicts.some((c) => c.resolution === 'unresolved'),
    supportingCount: supporting.length,
    // All of this claim's support lost a conflict: the claim has been
    // superseded, not merely weakened.
    fullySuperseded: supportingCount0(evidence) > 0 && supporting.length === 0 && supersededSupport.length > 0,
  });
  claim.confidence = Number(deriveConfidence({ claim, agg, sourceQuality }).toFixed(4));
  claim.updatedAt = Date.now();
  return claim;
}

function supportingCount0(evidence) {
  return evidence.filter((e) => e.stance === STANCE.SUPPORTS).length;
}

function deriveStatus({ agg, independent, independentAgainst, hasConflict, supportingCount, fullySuperseded = false }) {
  // A claim every one of whose supports was ruled against is contradicted, and
  // saying so is the whole point of recording which side won.
  if (fullySuperseded) return VERIFICATION.CONTRADICTED;
  // An unresolved conflict is the status, whatever the support looks like.
  // Reporting "strongly supported" for a claim two sources flatly disagree
  // about is the failure §17 exists to prevent.
  if (hasConflict) return VERIFICATION.CONFLICTING;
  if (agg.contradiction > agg.support && agg.contradiction >= BANDS.SUPPORTED) return VERIFICATION.CONTRADICTED;
  if (agg.contradiction >= BANDS.WEAK && agg.support >= BANDS.WEAK && independentAgainst >= 1) return VERIFICATION.CONFLICTING;
  if (supportingCount === 0) return VERIFICATION.UNVERIFIED;
  if (agg.net < BANDS.WEAK) return VERIFICATION.INSUFFICIENT_EVIDENCE;
  if (agg.net >= BANDS.STRONG && independent >= STRONG_MIN_INDEPENDENT) return VERIFICATION.STRONGLY_SUPPORTED;
  if (agg.net >= BANDS.SUPPORTED) return VERIFICATION.SUPPORTED;
  return VERIFICATION.INSUFFICIENT_EVIDENCE;
}

// Confidence is the net evidence strength, tempered by source quality and by
// how many independent sources agree — and capped. Nothing here returns 1.0.
function deriveConfidence({ claim, agg, sourceQuality }) {
  if (claim.verificationStatus === VERIFICATION.UNVERIFIED) return 0;
  if (claim.verificationStatus === VERIFICATION.CONTRADICTED) return clamp01(agg.contradiction * 0.6);
  // A conflicting claim has low confidence *in the claim*, which is the honest
  // reading: we know sources disagree, we do not know which is right.
  if (claim.verificationStatus === VERIFICATION.CONFLICTING) return clamp01(Math.min(0.4, agg.support * 0.5));
  const breadth = Math.min(1, 0.6 + claim.independentSourceCount * 0.15);
  return clamp01(Math.min(0.92, agg.net * 0.6 + sourceQuality * 0.25 + breadth * 0.15) * (agg.net > 0 ? 1 : 0));
}

// Analyze every claim in the store. Returns them ordered by materiality then
// confidence, which is the order a report should present them in.
function analyzeAll({ store, conflicts = [] }) {
  const out = store.claims().map((c) => analyze(c, { store, conflicts }));
  out.sort((a, b) => (Number(b.material) - Number(a.material)) || (b.confidence - a.confidence));
  return out;
}

// The claims that still need work, for the replan loop (§39).
function gaps(claims, { minConfidence = BANDS.SUPPORTED } = {}) {
  return claims
    .filter((c) => c.material)
    .filter((c) => c.confidence < minConfidence
      || c.verificationStatus === VERIFICATION.INSUFFICIENT_EVIDENCE
      || c.verificationStatus === VERIFICATION.UNVERIFIED
      || c.verificationStatus === VERIFICATION.CONFLICTING)
    .map((c) => ({
      claim: c,
      reason: c.verificationStatus === VERIFICATION.CONFLICTING
        ? 'sources disagree and the conflict is unresolved'
        : `confidence ${c.confidence.toFixed(2)} is below the ${minConfidence} bar (${c.independentSourceCount} independent source(s))`,
    }));
}

module.exports = {
  BANDS, STRONG_MIN_INDEPENDENT, VERIFICATION,
  extractClaims, linkEvidenceToClaims, analyze, analyzeAll, gaps,
  deriveStatus, deriveConfidence, firstAssertion, similar,
};
