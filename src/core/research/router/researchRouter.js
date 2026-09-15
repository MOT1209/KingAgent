// ResearchRouter: the top of §2's pipeline — does this request need research at
// all, and if so, by what route?
//
// This is the seam between the agent runtime and the research engine. An agent
// handed a request asks here first, and gets one of four answers:
//
//   none      — answer from what you already know; no research task is created
//   memory    — a prior verified research result already covers this (§28)
//   direct    — one query, one source, cite it and stop (a simple fact)
//   pipeline  — the full plan → retrieve → evidence → verify → cite run
//
// Creating a research task for "rename this function" is the cheapest way to
// make an agent platform feel slow, and answering "what changed in v3?" from
// memory without checking freshness is the cheapest way to make it wrong. Both
// failures are decided here.

const { classify, CATEGORY } = require('../planner/queryClassifier');
const { FRESHNESS } = require('../retrieval/retrievalCache');

const ROUTE = Object.freeze({
  NONE: 'none',
  MEMORY: 'memory',
  DIRECT: 'direct',
  PIPELINE: 'pipeline',
});

// How long a remembered research answer stays usable, by how fast its subject
// moves. Mirrors the cache's TTL bands rather than inventing a second set.
const MEMORY_TTL_MS = Object.freeze({
  static: 30 * 24 * 60 * 60 * 1000,
  slow: 7 * 24 * 60 * 60 * 1000,
  moderate: 2 * 24 * 60 * 60 * 1000,
  fast: 6 * 60 * 60 * 1000,
  realtime: 0,
});

// `lookupMemory` is injected (researchMemory.findAnswer) so this module stays
// pure and testable; without one, the memory route simply never fires.
async function routeRequest({ request, task = null, lookupMemory = null, now = Date.now() }) {
  const classification = classify(request, { task });

  if (!classification.needsResearch) {
    return freeze({
      route: ROUTE.NONE, classification,
      reason: classification.reasons[0] || 'nothing here needs looking up',
    });
  }

  if (typeof lookupMemory === 'function') {
    // A memory lookup that fails is not a reason to refuse to research, so the
    // failure path simply leaves `hit` unset and the pipeline route is taken.
    let hit = null;
    try {
      hit = await lookupMemory({ question: request, classification });
    } catch { /* fall through to a fresh research run */ }
    if (hit && hit.answer) {
      const ttl = MEMORY_TTL_MS[classification.freshness] ?? MEMORY_TTL_MS.moderate;
      const age = now - (hit.verifiedAt || hit.createdAt || 0);
      // A realtime question has a zero TTL, so it can never be served from
      // memory — the same rule the retrieval cache applies, for the same reason.
      if (ttl > 0 && age <= ttl && hit.confidence >= 0.6) {
        return freeze({
          route: ROUTE.MEMORY, classification, memory: hit,
          reason: `a verified prior result from ${Math.round(age / 3600000)}h ago covers this`,
        });
      }
      if (ttl === 0) {
        return freeze({
          route: ROUTE.PIPELINE, classification, memory: hit,
          reason: 'a prior result exists but the question is time-sensitive, so it is re-checked',
        });
      }
    }
  }

  const direct = classification.category === CATEGORY.SIMPLE_FACT
    && classification.suggestedQueries <= 1
    && classification.freshness !== FRESHNESS.REALTIME
    && !classification.needsVerification;

  return freeze({
    route: direct ? ROUTE.DIRECT : ROUTE.PIPELINE,
    classification,
    reason: direct
      ? 'a single factual lookup with a citation is enough'
      : `${classification.category} needs ${classification.suggestedQueries} queries across ${classification.sourceTypes.length} source type(s)`,
  });
}

function freeze(o) {
  return Object.freeze({ memory: null, ...o });
}

module.exports = { ROUTE, MEMORY_TTL_MS, routeRequest };
