// The reducer behind the research progress display (§41).
//
// Split out from research-panel.mjs so the interesting part — deciding what a
// stream of events means — is a pure function over data and can be tested
// without a DOM.
//
// The design rule: **a stage that did not happen is not a tick.** A progress
// list where everything is always a green check is decoration. So each line
// carries one of five marks — pending, running, done, warning, failure — and a
// stage that was skipped, degraded or produced nothing says so on its own line.

const STAGE_ORDER = Object.freeze([
  'plan', 'search', 'retrieve', 'dedup', 'rerank', 'evidence', 'verify', 'conflicts', 'citations', 'quality', 'review',
]);

const STAGE_LABEL = Object.freeze({
  plan: 'Planning research',
  search: 'Searching',
  retrieve: 'Retrieving sources',
  dedup: 'Removing duplicates',
  rerank: 'Ranking sources',
  evidence: 'Extracting evidence',
  verify: 'Verifying claims',
  conflicts: 'Checking for conflicts',
  citations: 'Checking citations',
  quality: 'Quality check',
  review: 'Reviewing',
});

// event type -> which stage it advances.
const EVENT_STAGE = Object.freeze({
  'research.classified': 'plan',
  'research.query.planned': 'plan',
  'research.query.executed': 'search',
  'research.source.retrieved': 'retrieve',
  'research.source.deduplicated': 'dedup',
  'research.sources.reranked': 'rerank',
  'research.evidence.extracted': 'evidence',
  'research.claim.verified': 'verify',
  'research.conflict.detected': 'conflicts',
  'research.conflict.resolved': 'conflicts',
  'research.citations.validated': 'citations',
  'research.evaluated': 'quality',
  'research.reviewed': 'review',
});

function emptyState() {
  return {
    stages: {},
    queries: { planned: 0, executed: 0, failed: 0 },
    sources: { retrieved: 0, removed: 0, unusable: 0 },
    evidence: 0,
    claims: { verified: 0 },
    conflicts: { detected: 0, unresolved: 0 },
    citations: { ok: null, errors: 0, warnings: 0 },
    quality: null,
    review: null,
    degraded: null,
    replans: 0,
    terminal: null,
    reason: '',
  };
}

// Fold one event into the state. Pure: returns a new object, never mutates.
function summarize(prev, ev) {
  const state = prev ? { ...prev, stages: { ...prev.stages } } : emptyState();
  if (!ev || !ev.type) return state;
  const p = ev.payload || {};

  const stage = EVENT_STAGE[ev.type];
  if (stage) state.stages[stage] = 'done';

  switch (ev.type) {
    case 'research.started':
      return { ...emptyState(), stages: { plan: 'running' } };
    case 'research.classified':
      state.degraded = p.degraded ? { unavailable: p.unavailable || [] } : null;
      break;
    case 'research.query.planned':
      state.queries = { ...state.queries, planned: state.queries.planned + (p.count || 0) };
      state.stages.search = 'running';
      break;
    case 'research.query.executed':
      state.queries = {
        ...state.queries,
        executed: state.queries.executed + (p.status === 'completed' ? 1 : 0),
        failed: state.queries.failed + (p.status === 'failed' || p.status === 'skipped' ? 1 : 0),
      };
      break;
    case 'research.source.retrieved':
      state.sources = { ...state.sources, retrieved: state.sources.retrieved + (p.count || 0) };
      break;
    case 'research.source.deduplicated':
      state.sources = {
        ...state.sources,
        retrieved: p.before ?? state.sources.retrieved,
        removed: p.removed || 0,
        unusable: p.unusable || 0,
      };
      break;
    case 'research.evidence.extracted':
      state.evidence = p.count || 0;
      break;
    case 'research.claim.verified':
      state.claims = { ...state.claims, verified: state.claims.verified + 1 };
      break;
    case 'research.conflict.detected':
      state.conflicts = { ...state.conflicts, detected: state.conflicts.detected + 1, unresolved: state.conflicts.unresolved + 1 };
      break;
    case 'research.conflict.resolved':
      if (p.resolution && p.resolution !== 'unresolved') {
        state.conflicts = { ...state.conflicts, unresolved: Math.max(0, state.conflicts.unresolved - 1) };
      }
      break;
    case 'research.citations.validated':
      state.citations = { ok: p.ok === true, errors: p.errors || 0, warnings: p.warnings || 0 };
      break;
    case 'research.evaluated':
      state.quality = { score: p.score, grade: p.grade, passed: p.passed, targetsMet: p.targetsMet, reasons: p.reasons || [] };
      break;
    case 'research.reviewed':
      state.review = { verdict: p.verdict, blocking: p.blocking || 0 };
      break;
    case 'research.replanned':
      state.replans += 1;
      // A replan reopens the stages it is going to redo, so the list does not
      // claim a finished search while a second round is running.
      for (const s of ['search', 'retrieve', 'evidence', 'quality']) state.stages[s] = 'running';
      break;
    case 'research.completed':
      state.terminal = p.partial ? 'partial' : 'completed';
      break;
    case 'research.failed':
      state.terminal = 'failed';
      state.reason = p.reason || '';
      break;
    case 'research.cancelled':
      state.terminal = 'cancelled';
      state.reason = p.reason || '';
      break;
    default:
      break;
  }
  return state;
}

// Turn the state into display lines. `status` is the last `research:status`
// poll; when present its counts win, because a window that opened mid-run never
// saw the earlier events.
function renderProgressLines(state, status = null) {
  const s = state || emptyState();
  const counts = status && status.progress ? status.progress : null;
  const lines = [];

  const queriesPlanned = counts ? counts.queries.total : s.queries.planned;
  const queriesDone = counts ? counts.queries.completed : s.queries.executed;
  const sourceCount = counts ? counts.sources : Math.max(0, s.sources.retrieved - s.sources.removed);
  const evidenceCount = counts ? counts.evidence : s.evidence;
  const conflictCount = counts ? counts.conflicts : s.conflicts.detected;
  const citationCount = counts ? counts.citations : null;

  const push = (stage, mark, text, note) => lines.push({ stage, mark, text, note: note || '' });
  const mark = (stage, done) => (s.stages[stage] === 'running' ? 'run' : done ? 'done' : s.stages[stage] === 'done' ? 'done' : 'pending');

  push('plan', mark('plan', queriesPlanned > 0),
    queriesPlanned ? `Planned ${queriesPlanned} quer${queriesPlanned === 1 ? 'y' : 'ies'}` : 'Planning research',
    s.degraded && s.degraded.unavailable.length ? `no provider for ${s.degraded.unavailable.join(', ')}` : '');

  if (s.queries.failed > 0) {
    push('search', 'warn', `Searched ${queriesDone} of ${queriesPlanned}`, `${s.queries.failed} returned nothing`);
  } else {
    push('search', mark('search', queriesDone > 0), `Searched ${queriesDone} of ${queriesPlanned} queries`);
  }

  push('retrieve', mark('retrieve', sourceCount > 0),
    sourceCount ? `Retrieved ${sourceCount} source${sourceCount === 1 ? '' : 's'}` : 'Retrieving sources',
    sourceCount === 0 && s.stages.retrieve === 'done' ? 'nothing came back' : '');

  if (s.sources.removed > 0 || s.stages.dedup === 'done') {
    push('dedup', 'done', `Removed ${s.sources.removed} duplicate${s.sources.removed === 1 ? '' : 's'}`,
      s.sources.unusable ? `${s.sources.unusable} unusable` : '');
  }

  push('evidence', mark('evidence', evidenceCount > 0),
    evidenceCount ? `Extracted ${evidenceCount} evidence item${evidenceCount === 1 ? '' : 's'}` : 'Extracting evidence');

  if (s.claims.verified > 0 || s.stages.verify) {
    push('verify', s.stages.verify === 'running' ? 'run' : 'done', `Verified ${s.claims.verified} claim${s.claims.verified === 1 ? '' : 's'}`);
  }

  if (conflictCount > 0) {
    push('conflicts', s.conflicts.unresolved > 0 ? 'warn' : 'done',
      `${conflictCount} conflicting source${conflictCount === 1 ? '' : 's'}`,
      s.conflicts.unresolved > 0 ? `${s.conflicts.unresolved} unresolved` : 'resolved');
  } else if (s.stages.conflicts === 'done') {
    push('conflicts', 'done', 'No conflicts between sources');
  }

  if (s.citations.ok !== null) {
    push('citations', s.citations.ok ? (s.citations.warnings ? 'warn' : 'done') : 'fail',
      s.citations.ok ? `Citations check out${citationCount ? ` (${citationCount})` : ''}` : 'Citation problems found',
      s.citations.errors ? `${s.citations.errors} error(s)` : s.citations.warnings ? `${s.citations.warnings} warning(s)` : '');
  }

  if (s.quality) {
    push('quality', s.quality.passed ? (s.quality.targetsMet ? 'done' : 'warn') : 'fail',
      `Quality: ${s.quality.grade}`,
      s.quality.targetsMet ? '' : (s.quality.reasons[0] || 'below the bar for this mode'));
  }

  if (s.review) {
    push('review', s.review.blocking ? 'warn' : 'done', `Review: ${s.review.verdict.replace(/_/g, ' ')}`);
  }

  if (s.replans > 0) {
    push('review', 'run', `Researching further (round ${s.replans + 1})`);
  }

  if (s.terminal === 'partial') push('done', 'warn', 'Finished with partial results');
  else if (s.terminal === 'completed') push('done', 'done', 'Done');
  else if (s.terminal === 'failed') push('done', 'fail', 'Research failed', s.reason);
  else if (s.terminal === 'cancelled') push('done', 'warn', 'Cancelled', s.reason);

  return lines;
}

export { STAGE_ORDER, STAGE_LABEL, EVENT_STAGE, emptyState, summarize, renderProgressLines };
