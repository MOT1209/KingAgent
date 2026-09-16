// Research trace events (§33).
//
// These extend the existing trace vocabulary rather than starting a second
// telemetry system: every one of them is appended to the platform's
// ExecutionTrace through the normal store, carries the same correlation
// envelope (traceId, taskId, workspaceId, agentId, sessionId) and is scrubbed
// by the same serializer. The event *names* live here because that is where the
// research engine and its tests can share one list.
//
// Nothing here carries reasoning, prompts or model deliberation — the trace
// schema has no field for it and core/trace/events.js rejects the key shapes
// outright. What a user watching a research run sees is what was searched, what
// came back, what was rejected and why.

const RESEARCH_EVENTS = Object.freeze({
  RESEARCH_STARTED: 'research.started',
  RESEARCH_CLASSIFIED: 'research.classified',
  QUERY_PLANNED: 'research.query.planned',
  QUERY_EXECUTED: 'research.query.executed',
  SOURCE_RETRIEVED: 'research.source.retrieved',
  SOURCE_REJECTED: 'research.source.rejected',
  SOURCE_DEDUPLICATED: 'research.source.deduplicated',
  SOURCES_RERANKED: 'research.sources.reranked',
  EVIDENCE_EXTRACTED: 'research.evidence.extracted',
  CLAIM_CREATED: 'research.claim.created',
  CLAIM_VERIFIED: 'research.claim.verified',
  CONFLICT_DETECTED: 'research.conflict.detected',
  CONFLICT_RESOLVED: 'research.conflict.resolved',
  CITATION_CREATED: 'research.citation.created',
  CITATIONS_VALIDATED: 'research.citations.validated',
  RESEARCH_EVALUATED: 'research.evaluated',
  RESEARCH_REVIEWED: 'research.reviewed',
  RESEARCH_REPLANNED: 'research.replanned',
  MEMORY_STORED: 'research.memory.stored',
  RESEARCH_PROGRESS: 'research.progress',
  RESEARCH_COMPLETED: 'research.completed',
  RESEARCH_FAILED: 'research.failed',
  RESEARCH_CANCELLED: 'research.cancelled',
});

const ALL_RESEARCH_EVENTS = Object.freeze(Object.values(RESEARCH_EVENTS));

// The subset worth streaming to a UI live. `source.retrieved` fires per query
// per source type and `citation.created` fires per citation, so both are
// summarized into `research.progress` rather than put on the wire individually —
// the same judgement the platform already makes about `policy.evaluated`.
const UI_EVENTS = Object.freeze([
  RESEARCH_EVENTS.RESEARCH_STARTED,
  RESEARCH_EVENTS.RESEARCH_CLASSIFIED,
  RESEARCH_EVENTS.QUERY_PLANNED,
  RESEARCH_EVENTS.QUERY_EXECUTED,
  RESEARCH_EVENTS.SOURCE_DEDUPLICATED,
  RESEARCH_EVENTS.CONFLICT_DETECTED,
  RESEARCH_EVENTS.CITATIONS_VALIDATED,
  RESEARCH_EVENTS.RESEARCH_EVALUATED,
  RESEARCH_EVENTS.RESEARCH_REVIEWED,
  RESEARCH_EVENTS.RESEARCH_REPLANNED,
  RESEARCH_EVENTS.RESEARCH_PROGRESS,
  RESEARCH_EVENTS.RESEARCH_COMPLETED,
  RESEARCH_EVENTS.RESEARCH_FAILED,
  RESEARCH_EVENTS.RESEARCH_CANCELLED,
]);

// The stage a user-visible progress line belongs to (§41). Keeps the UI's
// vocabulary and the engine's in one place.
const STAGE_LABEL = Object.freeze({
  'research.started': 'Starting research',
  'research.classified': 'Understanding the question',
  'research.query.planned': 'Planning research',
  'research.query.executed': 'Searching',
  'research.source.deduplicated': 'Removing duplicates',
  'research.sources.reranked': 'Ranking sources',
  'research.evidence.extracted': 'Extracting evidence',
  'research.claim.verified': 'Verifying claims',
  'research.conflict.detected': 'Checking for conflicts',
  'research.citations.validated': 'Checking citations',
  'research.evaluated': 'Quality check',
  'research.reviewed': 'Reviewing',
  'research.replanned': 'Researching further',
  'research.completed': 'Done',
});

module.exports = { RESEARCH_EVENTS, ALL_RESEARCH_EVENTS, UI_EVENTS, STAGE_LABEL };
