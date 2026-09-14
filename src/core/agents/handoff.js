// AgentHandoff: passing work to another agent without passing the whole session.
//
// The naive handoff forwards the conversation. That is the most expensive
// possible option — it grows with the run, it re-teaches the receiver things it
// does not need, and it carries every intermediate failure as though it were a
// finding. A handoff package is a *brief*: the objective, where things stand,
// the files and artifacts that matter, the constraints that must hold, and
// what is still open.
//
// Everything here is bounded and by reference. Artifacts travel as refs (the
// artifact store already owns content and permissions) and memory travels as a
// small set of ids the receiving workspace is allowed to read.

const crypto = require('node:crypto');

const LIMITS = Object.freeze({
  files: 40,
  results: 20,
  constraints: 20,
  memories: 20,
  artifacts: 25,
  openIssues: 20,
  objectiveChars: 1000,
  stateChars: 2000,
});

function newHandoffId() {
  return `hof-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function clip(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
}

function createHandoff({
  id = null,
  fromAgent,
  toAgent,
  objective,
  currentState = null,
  files = [],
  results = [],
  constraints = [],
  memories = [],
  artifacts = [],
  openIssues = [],
  identity = {},
  metadata = {},
} = {}) {
  if (!fromAgent || !toAgent) throw new Error('a handoff requires fromAgent and toAgent');
  if (!objective) throw new Error('a handoff requires an objective');

  return Object.freeze({
    id: id || newHandoffId(),
    fromAgent,
    toAgent,
    objective: clip(objective, LIMITS.objectiveChars),
    currentState: currentState === null ? null : clip(currentState, LIMITS.stateChars),
    // Paths and short reasons, never file contents: the receiver has the same
    // workspace root and can read what it needs.
    files: files.slice(0, LIMITS.files).map((f) => (typeof f === 'string'
      ? { path: f, reason: null }
      : { path: f.path, reason: f.reason || null })),
    results: results.slice(0, LIMITS.results).map((r) => ({
      id: r.id || null, ok: r.ok ?? null, summary: clip(r.summary || '', 240),
    })),
    constraints: constraints.slice(0, LIMITS.constraints).map((c) => clip(c, 240)),
    memories: memories.slice(0, LIMITS.memories).map((m) => (typeof m === 'string' ? m : m.id)),
    artifacts: artifacts.slice(0, LIMITS.artifacts).map((a) => (typeof a === 'string'
      ? { id: a }
      : { id: a.id, type: a.type || null, name: a.name || null })),
    openIssues: openIssues.slice(0, LIMITS.openIssues).map((i) => clip(i, 240)),
    taskId: identity.taskId || null,
    workspaceId: identity.workspaceId || null,
    traceId: identity.traceId || null,
    sessionId: identity.sessionId || null,
    metadata: { ...metadata },
    createdAt: Date.now(),
  });
}

// Build the brief from what a workspace actually did, so a caller does not have
// to assemble it by hand (and so it stays bounded by construction).
function handoffFromWorkspace(workspace, { fromAgent, toAgent, objective, openIssues = [], constraints = [], results = [], memories = [], artifacts = [] }) {
  const changed = workspace.files.diff().map((d) => ({ path: d.path, reason: d.operation }));
  const active = workspace.files.activeFiles().map((p) => ({ path: p, reason: 'active' }));
  return createHandoff({
    fromAgent,
    toAgent,
    objective,
    currentState: JSON.stringify(workspace.files.summary()),
    files: [...changed, ...active],
    results,
    constraints,
    memories,
    artifacts: artifacts.length ? artifacts : workspace.artifactIds.map((id) => ({ id })),
    openIssues,
    identity: workspace.identity,
  });
}

// One line for the trace and the UI.
function summarizeHandoff(handoff) {
  return {
    id: handoff.id,
    from: handoff.fromAgent,
    to: handoff.toAgent,
    objective: handoff.objective.slice(0, 160),
    files: handoff.files.length,
    artifacts: handoff.artifacts.length,
    openIssues: handoff.openIssues.length,
  };
}

module.exports = { createHandoff, handoffFromWorkspace, summarizeHandoff, LIMITS, newHandoffId };
