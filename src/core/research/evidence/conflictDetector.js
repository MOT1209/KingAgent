// Conflict detection (§17): find the places sources disagree, and refuse to
// silently pick a winner.
//
// The design decision that matters: a detected conflict defaults to
// `unresolved`. Resolution is a separate, explicit step with a stated rule
// (prefer the primary source, prefer the more recent one, or report the
// uncertainty), and "report the uncertainty" is a legitimate final answer. A
// detector that quietly returned the higher-scoring position would give the
// user a confident answer and no way to know it was contested.
//
// Three kinds of disagreement are found, because they need different handling:
//
//   * **stance conflict** — evidence for the same claim, pointing opposite ways
//   * **value conflict**  — the same quantity with different numbers (a version,
//     a price, a benchmark). These are the ones a stance check misses entirely,
//     because "X costs $20" and "X costs $30" are both affirmative sentences.
//   * **temporal conflict** — the same fact stated differently at different
//     times, which is usually not a contradiction but an outdated source.

const { normalizeConflict, CONFLICT_SEVERITY, CONFLICT_RESOLUTION } = require('../schemas/claim');
const { STANCE } = require('../schemas/evidence');
const { independentCount } = require('../retrieval/deduplicator');
const { tokenSet, coverage } = require('../text');
const { VALUE_PATTERNS, valuesIn, valuesDisagree } = require('../values');

// A fact that changed between two dates a year apart is stale, not contested.
const STALENESS_MS = 365 * 24 * 60 * 60 * 1000;

// Do two passages talk about the same thing? A version conflict only means
// something if both sentences are about the same subject.
function sameSubject(a, b, threshold = 0.45) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  return coverage(ta, tb) >= threshold || coverage(tb, ta) >= threshold;
}

function detect({ store, claims, sources = null }) {
  const sourcesById = sources || store.sourcesById();
  const clusterOf = store.clusterMap();
  const conflicts = [];

  for (const claim of claims) {
    const evidence = store.evidenceForClaim(claim.id);
    if (evidence.length < 2) continue;

    const found = [
      ...stanceConflicts({ claim, evidence, sourcesById, clusterOf }),
      ...valueConflicts({ claim, evidence, sourcesById, clusterOf }),
    ];
    conflicts.push(...collapse(found, clusterOf));
  }
  return conflicts;
}

// One disagreement per claim per pair of sources.
//
// A stance conflict and a value conflict over the same two documents are the
// same argument described twice, and reporting both inflates every count a
// reader uses to judge how contested something is. The most severe survives.
const SEVERITY_RANK = { minor: 0, material: 1, direct: 2 };

// A conflict whose two positions are both real statements says more than one
// whose positions are "X" and "not: X". A value conflict names the two numbers;
// a stance conflict only names the claim and its negation — so when both cover
// the same pair of sources, the specific positions survive and the severity is
// the higher of the two.
function isSpecific(conflict) {
  return conflict.positions.length === 2
    && conflict.positions.every((p) => p.statement && !/^not:\s/i.test(p.statement));
}

function collapse(conflicts, clusterOf) {
  const best = new Map();
  for (const c of conflicts) {
    const pair = [...new Set(c.sourceIds.map((id) => clusterOf.get(id) || id))].sort().join('|');
    const key = `${c.claimId}::${pair}`;
    const incumbent = best.get(key);
    if (!incumbent) { best.set(key, c); continue; }

    const winner = isSpecific(c) === isSpecific(incumbent)
      ? (SEVERITY_RANK[c.severity] > SEVERITY_RANK[incumbent.severity] ? c : incumbent)
      : (isSpecific(c) ? c : incumbent);
    const loser = winner === c ? incumbent : c;
    // Keep the winner's positions, but never soften the severity: a flat
    // contradiction is a flat contradiction however it was found.
    best.set(key, SEVERITY_RANK[loser.severity] > SEVERITY_RANK[winner.severity]
      ? normalizeConflict({ ...winner, severity: loser.severity })
      : winner);
  }
  return [...best.values()];
}

function stanceConflicts({ claim, evidence, sourcesById, clusterOf }) {
  const supporting = evidence.filter((e) => e.stance === STANCE.SUPPORTS);
  const contradicting = evidence.filter((e) => e.stance === STANCE.CONTRADICTS);
  if (supporting.length === 0 || contradicting.length === 0) return [];

  const forSources = [...new Set(supporting.map((e) => e.sourceId))];
  const againstSources = [...new Set(contradicting.map((e) => e.sourceId))];
  // One source contradicting itself is a parsing artefact, not a conflict
  // between sources — the same page saying "X is supported" and "X is not
  // supported on Windows" is a nuance, and inventing a conflict from it would
  // fill the report with noise.
  if (independentCount([...forSources, ...againstSources], { clusterOf, sourcesById }) < 2) return [];

  const forWeight = weightOf(supporting);
  const againstWeight = weightOf(contradicting);

  return [normalizeConflict({
    claimId: claim.id,
    claimText: claim.text,
    positions: [
      { statement: claim.text, sourceIds: forSources, evidenceIds: supporting.map((e) => e.id), weight: forWeight },
      { statement: `not: ${claim.text}`, sourceIds: againstSources, evidenceIds: contradicting.map((e) => e.id), weight: againstWeight },
    ],
    sourceIds: [...forSources, ...againstSources],
    severity: CONFLICT_SEVERITY.DIRECT,
    resolution: CONFLICT_RESOLUTION.UNRESOLVED,
    confidence: Math.abs(forWeight - againstWeight),
  })];
}

function valueConflicts({ claim, evidence, sourcesById, clusterOf }) {
  const out = [];
  const withValues = evidence
    .map((e) => ({ e, values: valuesIn(e.text) }))
    .filter((r) => r.values.length > 0);

  // One conflict per pair of evidence, however many values disagree inside it:
  // a page listing three numbers that all differ from another page's three is
  // one disagreement, not three.
  const seenPairs = new Set();

  for (let i = 0; i < withValues.length; i += 1) {
    for (let j = i + 1; j < withValues.length; j += 1) {
      const a = withValues[i];
      const b = withValues[j];
      if (a.e.sourceId === b.e.sourceId) continue;
      const pairKey = `${a.e.id}::${b.e.id}`;
      if (seenPairs.has(pairKey)) continue;
      if (!sameSubject(a.e.text, b.e.text)) continue;

      for (const va of a.values) {
        const vb = b.values.find((v) => valuesDisagree(va, v));
        if (!vb) continue;
        seenPairs.add(pairKey);

        const sa = sourcesById.get(a.e.sourceId);
        const sb = sourcesById.get(b.e.sourceId);
        const temporal = isStale(sa, sb);
        out.push(normalizeConflict({
          claimId: claim.id,
          claimText: claim.text,
          positions: [
            { statement: `${va.text} — ${trim(a.e.text)}`, sourceIds: [a.e.sourceId], evidenceIds: [a.e.id], weight: a.e.strength || 0 },
            { statement: `${vb.text} — ${trim(b.e.text)}`, sourceIds: [b.e.sourceId], evidenceIds: [b.e.id], weight: b.e.strength || 0 },
          ],
          sourceIds: [a.e.sourceId, b.e.sourceId],
          severity: temporal ? CONFLICT_SEVERITY.MINOR : CONFLICT_SEVERITY.MATERIAL,
          resolution: CONFLICT_RESOLUTION.UNRESOLVED,
          resolutionReason: temporal ? 'the two sources are more than a year apart; this may be a change rather than a disagreement' : '',
          confidence: Math.abs((a.e.strength || 0) - (b.e.strength || 0)),
        }));
        break;
      }
    }
  }
  // Two independent sources are required for a value conflict too.
  return out.filter((c) => independentCount(c.sourceIds, { clusterOf, sourcesById }) >= 2);
}

function isStale(a, b) {
  const ta = a && (a.updatedAt || a.publishedAt);
  const tb = b && (b.updatedAt || b.publishedAt);
  if (!ta || !tb) return false;
  return Math.abs(ta - tb) > STALENESS_MS;
}

function weightOf(list) {
  return list.reduce((acc, e) => Math.max(acc, e.strength || 0), 0);
}

function trim(text) {
  return String(text).replace(/\s+/g, ' ').slice(0, 180);
}

// --- resolution -------------------------------------------------------------

// Apply the resolution rules §17 allows, and *only* those. Anything that does
// not clearly meet a rule stays unresolved and is reported as uncertainty —
// which is the honest answer, not a failure of the detector.
function resolve(conflict, { store, sourcesById = null } = {}) {
  const byId = sourcesById || store.sourcesById();
  const [left, right] = conflict.positions;
  if (!left || !right) return conflict;

  // Resolving a conflict has to have consequences for the losing side, or the
  // resolution is decoration: a claim built on the superseded position would
  // still read as "strongly supported" while the report says the other source
  // won. `supersededEvidenceIds` is how that feeds back into claimAnalyzer.
  const decide = (winner, loser, resolution, reason, confidence) => normalizeConflict({
    ...conflict,
    resolution,
    resolutionReason: `${reason}: ${trim(winner.statement)}`,
    supersededEvidenceIds: [...loser.evidenceIds],
    winningEvidenceIds: [...winner.evidenceIds],
    confidence,
  });

  const leftSources = left.sourceIds.map((id) => byId.get(id)).filter(Boolean);
  const rightSources = right.sourceIds.map((id) => byId.get(id)).filter(Boolean);
  if (!leftSources.length || !rightSources.length) return conflict;

  const leftPrimary = leftSources.some((s) => s.primary);
  const rightPrimary = rightSources.some((s) => s.primary);

  // Rule 1: one side is a primary source and the other is not. The
  // specification beats the blog post about the specification.
  if (leftPrimary !== rightPrimary) {
    const [winner, loser] = leftPrimary ? [left, right] : [right, left];
    return decide(winner, loser, CONFLICT_RESOLUTION.PREFER_PRIMARY, 'resolved toward the primary source', 0.7);
  }

  // Rule 2: both are the same kind of source, but one is materially newer and
  // the conflict looked temporal. A newer figure supersedes an older one.
  const newest = (list) => Math.max(...list.map((s) => s.updatedAt || s.publishedAt || 0));
  const lt = newest(leftSources);
  const rt = newest(rightSources);
  if (conflict.severity === CONFLICT_SEVERITY.MINOR && lt && rt && Math.abs(lt - rt) > STALENESS_MS) {
    const [winner, loser] = lt > rt ? [left, right] : [right, left];
    return decide(winner, loser, CONFLICT_RESOLUTION.PREFER_RECENT, 'the sources are over a year apart; taking the newer', 0.6);
  }

  // Everything else is reported, not decided.
  return normalizeConflict({
    ...conflict,
    resolution: CONFLICT_RESOLUTION.REPORT_UNCERTAINTY,
    resolutionReason: 'the sources are of comparable standing and disagree; the answer states both positions',
    confidence: 0.3,
  });
}

function resolveAll(conflicts, { store }) {
  const sourcesById = store.sourcesById();
  return conflicts.map((c) => resolve(c, { store, sourcesById }));
}

module.exports = {
  detect, resolve, resolveAll, valuesIn, valuesDisagree, sameSubject,
  VALUE_PATTERNS, STALENESS_MS, CONFLICT_SEVERITY, CONFLICT_RESOLUTION,
};
