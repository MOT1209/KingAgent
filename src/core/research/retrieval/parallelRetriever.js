// Parallel retrieval (§9, §46, §47).
//
// The three properties this has to hold at once, and each of them is where a
// naive `Promise.all` fails:
//
//   * **Partial failure never ends the run.** `Promise.all` rejects on the
//     first failure and abandons the other in-flight calls. Every retrieval
//     here is settled individually and a failure becomes a recorded outcome,
//     so eight queries with one dead provider return seven queries' results.
//   * **Concurrency is bounded.** Twenty queries across three source types is
//     sixty provider calls; issuing them at once gets the install rate-limited
//     and holds sixty sockets. A worker pool caps in-flight work at the
//     strategy's concurrency.
//   * **Cancellation reaches the bottom.** One AbortController is threaded
//     through every provider call, so cancelling the task cancels the requests
//     rather than orphaning them and ignoring their results (§47).
//
// The budget is checked between units of work, not inside them: a retrieval
// already in flight is allowed to finish and be counted, because throwing away
// a result we have already paid for helps nobody.

const { QUERY_STATUS } = require('../schemas/researchQuery');
const { spend, remaining, expired, recordFailure } = require('../schemas/researchTask');
const { allocate, executionOrder } = require('../router/sourceRouter');
const { ResearchBudgetError, ResearchCancelledError } = require('../errors/researchErrors');

// Run `jobs` with at most `concurrency` in flight. Every job settles; the
// caller gets one outcome per job in input order.
async function pool(jobs, concurrency, { signal = null } = {}) {
  const results = new Array(jobs.length);
  let next = 0;
  const width = Math.max(1, Math.min(concurrency, jobs.length));

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      if (signal && signal.aborted) {
        results[i] = { ok: false, cancelled: true, error: new ResearchCancelledError('task', 'signal aborted') };
        continue;
      }
      try {
        results[i] = { ok: true, value: await jobs[i]() };
      } catch (err) {
        // A budget or cancellation error is about the *task*, so it is recorded
        // and re-thrown by the caller after every worker has stopped — not
        // swallowed into a per-job outcome that reads like a provider failure.
        results[i] = { ok: false, error: err, fatal: err instanceof ResearchBudgetError || err instanceof ResearchCancelledError };
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

class ParallelRetriever {
  constructor({ sourceManager, router, logger = null, emit = null } = {}) {
    if (!sourceManager) throw new TypeError('ParallelRetriever requires a SourceManager');
    this._sources = sourceManager;
    this._router = router;
    this._logger = logger;
    this._emit = typeof emit === 'function' ? emit : () => {};
  }

  // Retrieve for every query in the plan. Returns
  // `{ results, outcomes, stopped }` — `stopped` names the reason the run ended
  // early (budget, deadline, cancellation) or is null.
  async retrieveAll({ task, queries, strategy, signal = null }) {
    const allowed = this._sources.allowedTypes(task);
    const outcomes = [];
    const results = [];
    let stopped = null;

    // One unit of work = one (query, sourceType) pair. Flattening first is what
    // lets the pool interleave a slow documentation call with a fast web one
    // instead of blocking the whole query behind its slowest source.
    const units = [];
    for (const query of queries) {
      const routed = this._router
        ? this._router.route({ query, strategy, allowed, maxFanout: 3 })
        : { sourceTypes: query.sourceTypes.filter((t) => allowed.includes(t)) };
      if (!routed.sourceTypes.length) {
        query.status = QUERY_STATUS.SKIPPED;
        query.errors.push({ sourceId: null, reason: 'no available source type for this query', code: 'unconfigured' });
        continue;
      }
      const budgets = allocate({ task, query, sourceTypes: routed.sourceTypes });
      for (const type of executionOrder(routed.sourceTypes)) {
        const alloc = budgets.find((b) => b.type === type);
        if (!alloc) continue;
        units.push({ query, sourceType: type, limit: alloc.limit, routed });
      }
    }

    if (units.length === 0) return { results, outcomes, stopped: 'nothing to retrieve' };

    // Queries are marked running before the pool starts so a UI polling mid-run
    // sees the real state rather than everything flipping at the end.
    for (const query of queries) {
      if (units.some((u) => u.query === query)) {
        query.status = QUERY_STATUS.RUNNING;
        query.startedAt = Date.now();
      }
    }

    const jobs = units.map((unit) => async () => {
      if (expired(task)) throw new ResearchCancelledError(task.id, 'deadline exceeded');
      if (remaining(task, 'sources') <= 0) throw new ResearchBudgetError('sources', task.usage.sources, task.limits.maxSources);
      return this._sources.retrieve({
        task,
        query: unit.query,
        sourceType: unit.sourceType,
        limit: unit.limit,
        signal,
        freshness: strategy ? strategy.freshness : undefined,
      });
    });

    const settled = await pool(jobs, strategy ? strategy.concurrency : 4, { signal });

    for (const [i, s] of settled.entries()) {
      const unit = units[i];
      if (s && s.ok) {
        outcomes.push(s.value);
        results.push(...s.value.results);
        continue;
      }
      const err = s ? s.error : new Error('retrieval produced no outcome');
      if (s && s.fatal && !stopped) stopped = err.code === 'RESEARCH_BUDGET_EXHAUSTED' ? 'budget' : 'cancelled';
      recordFailure(task, {
        stage: 'retrieve', queryId: unit.query.id, sourceId: unit.sourceType,
        reason: err.message, code: err.code || null,
      });
      outcomes.push({
        sourceType: unit.sourceType, queryId: unit.query.id, results: [],
        error: err.message, deniedBy: s && s.fatal ? 'task' : 'provider', fromCache: false,
      });
    }

    // Finalize each query's status from its own outcomes, not from the run's.
    for (const query of queries) {
      if (query.status !== QUERY_STATUS.RUNNING) continue;
      const mine = outcomes.filter((o) => o.queryId === query.id);
      const any = mine.some((o) => o.results.length > 0);
      query.status = any ? QUERY_STATUS.COMPLETED : (mine.length ? QUERY_STATUS.FAILED : QUERY_STATUS.SKIPPED);
      query.completedAt = Date.now();
      if (any) {
        try { spend(task, 'queries', 1); } catch (err) {
          if (!stopped) stopped = 'budget';
          recordFailure(task, { stage: 'retrieve', queryId: query.id, reason: err.message, code: err.code });
        }
      }
      this._emit({
        type: 'QUERY_EXECUTED',
        payload: {
          queryId: query.id, text: query.text, status: query.status,
          resultCount: query.resultCount, sourceTypes: [...query.sourceTypes],
          durationMs: (query.completedAt || 0) - (query.startedAt || query.completedAt || 0),
        },
      });
    }

    if (!stopped && expired(task)) stopped = 'deadline';
    return { results, outcomes, stopped };
  }
}

module.exports = { ParallelRetriever, pool };
