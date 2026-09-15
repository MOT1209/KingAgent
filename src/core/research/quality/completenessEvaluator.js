// Completeness: did the research actually do what it set out to do?
//
// This is the metric that catches the most embarrassing failure mode — a
// polished, well-cited answer to *part* of the question, presented as if it
// were the whole thing. Coverage here is measured two ways, because either
// alone is easy to fool:
//
//   * **question coverage** — how much of the question's own vocabulary shows
//     up in the claims. Crude, but it catches a comparison of four tools that
//     only found evidence about two.
//   * **plan coverage** — how many planned queries actually returned anything.
//     A plan is a statement of what was needed; queries that silently failed
//     are gaps, and a report that does not count them is overstating itself.

const { tokenSet } = require('../text');
const { QUERY_STATUS } = require('../schemas/researchQuery');
const { clamp01 } = require('../schemas/source');
const { extractSubjects } = require('../planner/queryPlanner');

function evaluate({ task, claims, strategy = null }) {
  const questionTokens = tokenSet(task.question);
  const claimTokens = new Set();
  for (const c of claims) for (const t of tokenSet(c.text)) claimTokens.add(t);

  let covered = 0;
  const uncovered = [];
  for (const t of questionTokens) {
    if (claimTokens.has(t)) covered += 1;
    else uncovered.push(t);
  }
  const questionCoverage = questionTokens.size ? covered / questionTokens.size : 0;

  // Per-subject coverage: for a comparison, a subject with no claim at all is a
  // hole in the answer, and it is invisible in an aggregate token count.
  const subjects = extractSubjects(task.question);
  const subjectStatus = subjects.map((s) => {
    const st = tokenSet(s);
    const hit = [...st].some((t) => claimTokens.has(t));
    return { subject: s, covered: hit };
  });
  const subjectCoverage = subjectStatus.length
    ? subjectStatus.filter((s) => s.covered).length / subjectStatus.length
    : 1;

  const executed = task.queries.filter((q) => q.status === QUERY_STATUS.COMPLETED).length;
  const failed = task.queries.filter((q) => q.status === QUERY_STATUS.FAILED).length;
  const skipped = task.queries.filter((q) => q.status === QUERY_STATUS.SKIPPED).length;
  const planCoverage = task.queries.length ? executed / task.queries.length : 0;

  // Source types the strategy wanted but that produced nothing. These are the
  // honest version of "we did deep research": a deep run that only reached the
  // open web did not do what deep means.
  const usedTypes = new Set(task.sources.map((s) => s.type));
  const wantedTypes = strategy ? strategy.sourceTypes : [];
  const missingTypes = wantedTypes.filter((t) => !usedTypes.has(t));

  const reasons = [];
  if (subjectCoverage < 1) {
    reasons.push(`no claims found for: ${subjectStatus.filter((s) => !s.covered).map((s) => s.subject).join(', ')}`);
  }
  if (failed > 0) reasons.push(`${failed} planned quer${failed === 1 ? 'y' : 'ies'} returned nothing`);
  if (skipped > 0) reasons.push(`${skipped} planned quer${skipped === 1 ? 'y was' : 'ies were'} skipped for lack of an available source`);
  if (missingTypes.length) reasons.push(`no results from: ${missingTypes.join(', ')}`);
  if (strategy && strategy.degraded) {
    reasons.push(...strategy.downgrades.map((d) => `${d.what} was downgraded: ${d.why}`));
  }

  // Subject coverage is weighted hardest: a missing subject is a missing
  // answer, while a few uncovered question words are usually just phrasing.
  const score = clamp01(subjectCoverage * 0.5 + questionCoverage * 0.25 + planCoverage * 0.25);

  return {
    score: Number(score.toFixed(4)),
    questionCoverage: Number(questionCoverage.toFixed(4)),
    subjectCoverage: Number(subjectCoverage.toFixed(4)),
    planCoverage: Number(planCoverage.toFixed(4)),
    subjects: subjectStatus,
    uncoveredTerms: uncovered.slice(0, 20),
    queriesExecuted: executed,
    queriesFailed: failed,
    queriesSkipped: skipped,
    missingSourceTypes: missingTypes,
    reasons,
  };
}

module.exports = { evaluate };
