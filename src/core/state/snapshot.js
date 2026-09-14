// AgentStateSnapshot: enough to pick a task back up, and nothing more.
//
// The distinction that makes this work: a snapshot stores *references*, not
// contents. Memory ids, not memories; context packet ids, not packets; artifact
// ids, not artifacts. Each of those lives in its own store with its own
// permissions, so a snapshot that leaked would still not be a way to read them,
// and a snapshot stays small enough to write on every step.
//
// It also records the last action — specifically whether it was mutating — so
// recovery can refuse to blindly replay something irreversible.

const crypto = require('node:crypto');

const SNAPSHOT_VERSION = 1;

const SNAPSHOT_REASONS = Object.freeze({
  CHECKPOINT: 'checkpoint',
  PAUSE: 'pause',
  STEP: 'step',
  APPROVAL: 'approval',
  COMPLETION: 'completion',
  FAILURE: 'failure',
});

function newSnapshotId() {
  return `snap-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function createAgentStateSnapshot({
  id = null,
  identity = {},
  status,
  agentState = null,
  currentStep = null,
  completedSteps = [],
  activeTools = [],
  memoryRefs = [],
  contextRefs = [],
  artifactRefs = [],
  pendingApprovals = [],
  lastObservation = null,
  lastAction = null,
  plan = null,
  reason = SNAPSHOT_REASONS.CHECKPOINT,
  metadata = {},
} = {}) {
  return Object.freeze({
    version: SNAPSHOT_VERSION,
    id: id || newSnapshotId(),
    agentId: identity.agentId || null,
    taskId: identity.taskId || null,
    workspaceId: identity.workspaceId || null,
    projectId: identity.projectId || null,
    sessionId: identity.sessionId || null,
    traceId: identity.traceId || null,
    status,
    agentState,
    currentStep,
    completedSteps: [...completedSteps],
    activeTools: [...activeTools],
    memoryRefs: [...memoryRefs],
    contextRefs: [...contextRefs],
    artifactRefs: [...artifactRefs],
    pendingApprovals: pendingApprovals.map((a) => (typeof a === 'string' ? a : a.id)),
    // Bounded summaries, so a snapshot never carries a 20 MB tool output.
    lastObservation: lastObservation ? {
      id: lastObservation.id, type: lastObservation.type, source: lastObservation.source,
      summary: lastObservation.summary, ok: lastObservation.ok, timestamp: lastObservation.timestamp,
    } : null,
    lastAction: lastAction ? {
      id: lastAction.id, type: lastAction.type, target: lastAction.target,
      toolId: lastAction.toolId, stepId: lastAction.stepId,
      mutating: Boolean(lastAction.mutating), timestamp: lastAction.timestamp,
    } : null,
    plan: plan ? { id: plan.id, objective: plan.objective, mode: plan.mode, stepCount: (plan.steps || []).length } : null,
    reason,
    metadata: { ...metadata },
    updatedAt: Date.now(),
  });
}

// A run that stopped mid-flight rather than finishing.
const INTERRUPTED_STATUSES = new Set(['analyzing', 'planning', 'executing', 'observing', 'evaluating', 'recovering', 'replanning', 'paused', 'queued']);

function isInterrupted(snapshot) {
  return Boolean(snapshot && INTERRUPTED_STATUSES.has(snapshot.status));
}

// The question recovery has to answer before doing anything: did we stop in the
// middle of something that changed the world?
function endedMidMutation(snapshot) {
  return Boolean(snapshot && snapshot.lastAction && snapshot.lastAction.mutating && !snapshot.lastObservation);
}

function summarizeSnapshot(snapshot) {
  return {
    id: snapshot.id,
    taskId: snapshot.taskId,
    agentId: snapshot.agentId,
    workspaceId: snapshot.workspaceId,
    status: snapshot.status,
    currentStep: snapshot.currentStep,
    reason: snapshot.reason,
    pendingApprovals: snapshot.pendingApprovals.length,
    updatedAt: snapshot.updatedAt,
  };
}

module.exports = {
  SNAPSHOT_VERSION, SNAPSHOT_REASONS, INTERRUPTED_STATUSES,
  createAgentStateSnapshot, isInterrupted, endedMidMutation, summarizeSnapshot, newSnapshotId,
};
