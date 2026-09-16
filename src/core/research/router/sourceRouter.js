// SourceRouter: how much of the task's budget each source type gets.
//
// Distinct from searchRouter.js, which answers "which doors?". This answers
// "how hard do we knock on each?" — and it is the difference between a deep
// research task that spends eighty sources on the first query and one that
// still has budget left for the claim it needs to verify.
//
// Allocation is proportional to a source type's expected value for the question
// (primary types earn more) and floored so no routed type gets zero, because a
// type allocated zero results is a type that should not have been routed.

const { SOURCE_TYPES } = require('../schemas/source');
const { remaining } = require('../schemas/researchTask');

// Expected yield per source type: roughly, how often a retrieved row from this
// type turns into usable evidence. Tuned conservatively — these only order the
// allocation, they are not presented as measurements.
const YIELD = Object.freeze({
  [SOURCE_TYPES.DOCUMENTATION]: 1.0,
  [SOURCE_TYPES.GITHUB]: 0.95,
  [SOURCE_TYPES.FILE]: 0.95,
  [SOURCE_TYPES.ACADEMIC]: 0.85,
  [SOURCE_TYPES.WEB]: 0.6,
  [SOURCE_TYPES.MCP]: 0.6,
  [SOURCE_TYPES.LOCAL]: 0.6,
  [SOURCE_TYPES.NEWS]: 0.5,
  [SOURCE_TYPES.DISCUSSION]: 0.4,
});

const MIN_PER_TYPE = 2;

// Allocate a query's result budget across the source types it was routed to.
function allocate({ task, query, sourceTypes, reserveFraction = 0.25 }) {
  if (!sourceTypes.length) return [];

  // Hold back part of the remaining source budget for later queries and for
  // verification. A first query that consumes everything leaves nothing to
  // check it with, which is how a task reports high confidence from one page.
  const left = remaining(task, 'sources');
  if (left <= 0) return [];
  const reserve = Math.floor(left * reserveFraction);
  const spendable = Math.max(MIN_PER_TYPE, Math.min(query.maxResults * sourceTypes.length, left - reserve));

  const weights = sourceTypes.map((t) => YIELD[t] ?? 0.5);
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  const out = sourceTypes.map((type, i) => ({
    type,
    limit: Math.max(MIN_PER_TYPE, Math.round((weights[i] / total) * spendable)),
  }));

  // Trim from the lowest-value type down until the allocation fits. Rounding up
  // to MIN_PER_TYPE can overshoot, and overshooting the budget here is what
  // makes the ceiling throw later in a place that reads like a bug.
  let sum = out.reduce((a, b) => a + b.limit, 0);
  for (let i = out.length - 1; i >= 0 && sum > left; i -= 1) {
    const cut = Math.min(out[i].limit - 1, sum - left);
    if (cut > 0) { out[i].limit -= cut; sum -= cut; }
  }
  return out.filter((a) => a.limit > 0);
}

// Order the routed types for execution. Parallel retrieval still runs them
// concurrently; this decides who starts first when concurrency is the limit, so
// the highest-yield source is never the one that gets cancelled by a deadline.
function executionOrder(sourceTypes) {
  return [...sourceTypes].sort((a, b) => (YIELD[b] ?? 0.5) - (YIELD[a] ?? 0.5));
}

module.exports = { YIELD, MIN_PER_TYPE, allocate, executionOrder };
