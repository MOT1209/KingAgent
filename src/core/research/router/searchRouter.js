// SearchRouter (§8): which source types answer this query, in what order.
//
// The classifier decides what kind of question the *task* is. The router
// decides, per query, which doors to knock on — and they are not the same
// decision: a deep comparison task will have a "licensing" query that belongs in
// the repository and a "reception" query that belongs in discussions.
//
// Routing is a filter, never a grant. A route can only narrow what the strategy
// already allows; it can never reach a source type the task, the strategy or
// the policy engine excluded.

const { SOURCE_TYPES } = require('../schemas/source');
const { QUERY_INTENT } = require('../schemas/researchQuery');

// Query-level signals, matched against the query text rather than the original
// question. Ordered: the first match sets the lead source type.
const ROUTES = Object.freeze([
  { id: 'api-shape', re: /\b(api|endpoint|parameter|option|flag|config|schema|signature|returns?|throws?)\b/i, lead: SOURCE_TYPES.DOCUMENTATION },
  { id: 'version-change', re: /\b(changelog|release notes|what changed|migration|deprecat|breaking change|upgrade from)\b/i, lead: SOURCE_TYPES.DOCUMENTATION },
  { id: 'repo', re: /\b(repository|repo|readme|pull request|issue|commit|stargazers|license|dependencies|github\.com)\b/i, lead: SOURCE_TYPES.GITHUB },
  { id: 'paper', re: /\b(paper|study|arxiv|doi|peer[- ]reviewed|journal|citation|benchmark results)\b/i, lead: SOURCE_TYPES.ACADEMIC },
  { id: 'sentiment', re: /\b(community|people (say|think)|reception|reviews?|complaints?|experience with|criticism|limitations in practice)\b/i, lead: SOURCE_TYPES.DISCUSSION },
  { id: 'breaking', re: /\b(news|announced|announcement|launch|today|this week|just released)\b/i, lead: SOURCE_TYPES.NEWS },
  { id: 'file', re: /\b(uploaded|attached|this document|these files)\b/i, lead: SOURCE_TYPES.FILE },
]);

// Intent carries its own preference, used when no textual route fires.
const INTENT_LEAD = Object.freeze({
  [QUERY_INTENT.DEFINITION]: [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.WEB],
  [QUERY_INTENT.EVIDENCE]: [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.GITHUB, SOURCE_TYPES.WEB],
  [QUERY_INTENT.VERIFICATION]: [SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.ACADEMIC, SOURCE_TYPES.GITHUB, SOURCE_TYPES.WEB],
  [QUERY_INTENT.RECENCY]: [SOURCE_TYPES.NEWS, SOURCE_TYPES.WEB],
  [QUERY_INTENT.COMPARISON]: [SOURCE_TYPES.WEB, SOURCE_TYPES.DOCUMENTATION, SOURCE_TYPES.DISCUSSION],
  [QUERY_INTENT.DISCOVERY]: [SOURCE_TYPES.WEB, SOURCE_TYPES.DOCUMENTATION],
});

// Returns { sourceTypes, lead, reasons } — the ordered list of types to try for
// this query, already intersected with what is permitted.
function route({ query, strategy, allowed = null, maxFanout = 3 }) {
  const usable = allowed && allowed.length ? allowed : (strategy ? strategy.sourceTypes : []);
  const asked = usable.filter((t) => !query.sourceTypes.length
    || query.sourceTypes.includes(t)
    || query.sourceTypes.includes(SOURCE_TYPES.WEB));
  // A query naming only source types this task cannot reach falls back to what
  // it can, rather than routing nowhere. Same reasoning as researchStrategy's
  // fallback: the query's preference is a preference, and dropping the query
  // entirely spends a planned search on nothing. The narrowing still holds —
  // the fallback can only offer types `usable` already contains.
  const permitted = new Set(asked.length ? asked : usable);
  // A query that named its own types is honoured first, still intersected.
  const named = query.sourceTypes.filter((t) => permitted.has(t));
  const reasons = [];

  const matched = ROUTES.filter((r) => r.re.test(query.text));
  const leads = [];
  for (const m of matched) {
    if (permitted.has(m.lead) && !leads.includes(m.lead)) { leads.push(m.lead); reasons.push(m.id); }
  }
  if (leads.length === 0) {
    for (const t of INTENT_LEAD[query.intent] || []) {
      if (permitted.has(t) && !leads.includes(t)) { leads.push(t); reasons.push(`intent:${query.intent}`); }
    }
  }

  // Lead types first, then whatever the query named, then the strategy's own
  // order — deduplicated, capped at the fanout.
  const ordered = [];
  for (const list of [leads, named, strategy ? strategy.sourceOrder : []]) {
    for (const t of list) {
      if (permitted.has(t) && !ordered.includes(t)) ordered.push(t);
    }
  }

  return {
    queryId: query.id,
    sourceTypes: ordered.slice(0, Math.max(1, maxFanout)),
    lead: ordered[0] || null,
    reasons: [...new Set(reasons)],
    dropped: [...permitted].filter((t) => !ordered.slice(0, maxFanout).includes(t)),
  };
}

// Route a whole plan at once. Returns one entry per query.
function routeAll({ queries, strategy, allowed = null, maxFanout = 3 }) {
  return queries.map((query) => route({ query, strategy, allowed, maxFanout }));
}

module.exports = { ROUTES, INTENT_LEAD, route, routeAll };
