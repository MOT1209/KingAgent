// Evidence ranking: how much weight does this particular passage carry?
//
// Distinct from source scoring, and the distinction is load-bearing. A
// high-authority source can contain a throwaway aside, and a low-authority blog
// can contain the only precise number anyone published. Strength here is a
// product of *both*: how good the source is, and how directly this passage
// speaks to the claim.
//
// The numbers are deliberately capped below 1. Nothing in research is certain
// from one passage, and a scoring function that can return 1.0 invites a
// confidence report that says so.

const { clamp01 } = require('../schemas/source');
const { normalizeEvidence, EVIDENCE_KIND, STANCE } = require('../schemas/evidence');
const { tokenSet, coverage } = require('../text');

// What kind of passage is most convincing. A quoted specification beats an
// example; a bare quote with the right words in it beats neither.
const KIND_WEIGHT = Object.freeze({
  [EVIDENCE_KIND.DEFINITION]: 1.0,
  [EVIDENCE_KIND.STATISTIC]: 0.95,
  [EVIDENCE_KIND.METADATA]: 0.9,
  [EVIDENCE_KIND.CODE]: 0.85,
  [EVIDENCE_KIND.QUOTE]: 0.8,
  [EVIDENCE_KIND.EXAMPLE]: 0.6,
});

// Hedging is information. A page that says "X may support Y" is not evidence
// that X supports Y, and treating it as such is how a research system reports
// confident answers built from speculation.
const HEDGES = /\b(?:may|might|could|possibly|perhaps|reportedly|allegedly|seems?|appears?|is expected to|is said to|rumou?red|probably|likely|we think|in theory|planned|upcoming|roadmap)\b/i;
// The opposite: the passage is stating a fact about itself.
const DIRECT = /\b(?:is|are|was|were|does|do|has|have|must|shall|returns?|requires?|supports?|provides?|defined as|specified|documented)\b/i;

const MAX_STRENGTH = 0.95;

// Score one piece of evidence. `source` and `sourceScore` come from the
// source-quality layer; passing them in keeps a single source of truth for how
// good a source is.
function scoreEvidence(evidence, { source, sourceScore = null, claim = null, question = '' } = {}) {
  const target = claim ? claim.text : question;
  const targetTokens = tokenSet(target);
  const directness = coverage(targetTokens, tokenSet(evidence.text));

  const kind = KIND_WEIGHT[evidence.kind] ?? 0.7;
  const hedged = HEDGES.test(evidence.text);
  const direct = DIRECT.test(evidence.text);
  const assertiveness = hedged ? 0.45 : direct ? 1.0 : 0.75;

  const quality = clamp01(sourceScore ?? source.qualityScore ?? (source.primary ? 0.7 : 0.5));
  // A source that tried to inject instructions is still usable — see
  // researchSecurity — but its evidence carries less weight, which is the
  // proportionate response.
  const injectionPenalty = source.safety && source.safety.injectionAttempts > 0 ? 0.75 : 1;

  // Length: a one-clause fragment rarely proves anything, and a 1200-character
  // block is usually several claims at once.
  const len = evidence.text.length;
  const lengthFit = len < 40 ? 0.5 : len > 900 ? 0.75 : 1;

  const strength = clamp01(
    (directness * 0.4 + quality * 0.35 + kind * 0.25)
    * assertiveness * injectionPenalty * lengthFit,
  );

  return {
    strength: Math.min(MAX_STRENGTH, strength),
    relevance: clamp01(directness),
    terms: { directness, quality, kind, assertiveness, injectionPenalty, lengthFit, hedged },
  };
}

// Score a list, returning new Evidence records with `strength` and `relevance`
// filled in. Evidence is immutable, so this produces replacements rather than
// mutating — the store's replaceEvidence checks that the quote did not change.
function rankEvidence(evidenceList, { store, sourceScoreOf = null, claim = null, question = '' } = {}) {
  const out = [];
  for (const e of evidenceList) {
    const source = store.source(e.sourceId);
    if (!source) continue;
    const { strength, relevance } = scoreEvidence(e, {
      source,
      sourceScore: sourceScoreOf ? sourceScoreOf(source) : null,
      claim,
      question,
    });
    out.push(normalizeEvidence({ ...e, strength, relevance }));
  }
  out.sort((a, b) => (b.strength - a.strength) || (b.relevance - a.relevance));
  return out;
}

// The aggregate a claim's confidence is built from (§16).
//
// Diminishing returns are the point: the second independent source moves
// confidence a lot, the fifth barely. Summing strengths linearly is how a
// system reports 0.99 confidence from nine copies of one blog post.
function aggregateStrength(evidenceList, { independentSources = 1 } = {}) {
  const supporting = evidenceList.filter((e) => e.stance === STANCE.SUPPORTS);
  const contradicting = evidenceList.filter((e) => e.stance === STANCE.CONTRADICTS);
  if (supporting.length === 0 && contradicting.length === 0) return { support: 0, contradiction: 0, net: 0 };

  const fold = (list) => {
    const sorted = [...list].sort((a, b) => (b.strength || 0) - (a.strength || 0));
    let acc = 0;
    for (const [i, e] of sorted.entries()) acc += (e.strength || 0) * Math.pow(0.55, i);
    return clamp01(acc);
  };

  const support = fold(supporting);
  const contradiction = fold(contradicting);
  // Independence multiplier: one source can never carry a claim past 0.7,
  // whatever it says about itself.
  const breadth = independentSources <= 1 ? 0.7 : independentSources === 2 ? 0.88 : 1;

  return {
    support: clamp01(support * breadth),
    contradiction: clamp01(contradiction * breadth),
    net: clamp01(support * breadth - contradiction * breadth * 0.8),
  };
}

module.exports = { scoreEvidence, rankEvidence, aggregateStrength, KIND_WEIGHT, MAX_STRENGTH, HEDGES };
