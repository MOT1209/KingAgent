// The session model: the container that ties a person's work together.
//
// §24 lists the seven things a session connects — User, Agent, Workspace, Task,
// Harness, Trace, Artifacts — and this is where that list becomes a shape. A
// session is deliberately *not* a task: a session outlives the tasks inside it,
// can hold several at once, and answers the questions the UI actually asks
// ("what am I looking at, and what happened here?") without walking every
// runtime structure on every render.
//
// Bounded on purpose: tasks and artifacts are capped, because a session that
// lives for a week must not grow without limit in memory.

const { SESSION_STATES } = require('./lifecycle');

const MAX_TASKS = 200;
const MAX_ARTIFACTS = 500;

function createSession({
  id,
  label = null,
  userId = null,
  agentIds = [],
  workspaceId = null,
  workspaceRoot = null,
  harnessId = null,
  traceId = null,
  metadata = {},
}) {
  if (!id) throw new Error('session requires an id');
  return {
    id,
    label: label || id,
    userId,
    state: SESSION_STATES.CREATED,
    agentIds: [...new Set(agentIds.filter((a) => typeof a === 'string' && a))],
    workspaceId,
    workspaceRoot,
    harnessIds: harnessId ? [harnessId] : [],
    traceId,
    taskIds: [],
    artifactIds: [],
    sandboxIds: [],
    approvals: [], // { id, action, at, granted }
    messages: 0,
    delegations: 0,
    createdAt: Date.now(),
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    updatedAt: Date.now(),
    failure: null,
    metadata: { ...metadata },
  };
}

function touch(session) {
  session.updatedAt = Date.now();
  return session;
}

function attachTask(session, taskId) {
  if (!session.taskIds.includes(taskId)) {
    session.taskIds.push(taskId);
    if (session.taskIds.length > MAX_TASKS) session.taskIds.splice(0, session.taskIds.length - MAX_TASKS);
  }
  return touch(session);
}

function attachArtifact(session, artifactId) {
  if (!session.artifactIds.includes(artifactId)) {
    session.artifactIds.push(artifactId);
    if (session.artifactIds.length > MAX_ARTIFACTS) session.artifactIds.splice(0, session.artifactIds.length - MAX_ARTIFACTS);
  }
  return touch(session);
}

function attachSandbox(session, sandboxId) {
  if (!session.sandboxIds.includes(sandboxId)) session.sandboxIds.push(sandboxId);
  return touch(session);
}

function attachHarness(session, harnessId) {
  if (harnessId && !session.harnessIds.includes(harnessId)) {
    session.harnessIds.push(harnessId);
    if (session.harnessIds.length > 20) session.harnessIds.splice(0, session.harnessIds.length - 20);
  }
  return touch(session);
}

function attachAgent(session, agentId) {
  if (agentId && !session.agentIds.includes(agentId)) session.agentIds.push(agentId);
  return touch(session);
}

// Serializable view. Everything the control center shows about a session comes
// from here, so it stays free of handles and class instances.
function snapshot(session) {
  return {
    id: session.id,
    label: session.label,
    userId: session.userId,
    state: session.state,
    agentIds: [...session.agentIds],
    workspaceId: session.workspaceId,
    workspaceRoot: session.workspaceRoot,
    harnessIds: [...session.harnessIds],
    traceId: session.traceId,
    taskIds: [...session.taskIds],
    artifactIds: [...session.artifactIds],
    sandboxIds: [...session.sandboxIds],
    approvals: session.approvals.slice(-20).map((a) => ({ ...a })),
    messages: session.messages,
    delegations: session.delegations,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    pausedAt: session.pausedAt,
    completedAt: session.completedAt,
    updatedAt: session.updatedAt,
    failure: session.failure,
    metadata: { ...session.metadata },
  };
}

function summarize(session) {
  return {
    id: session.id,
    label: session.label,
    state: session.state,
    workspaceId: session.workspaceId,
    taskCount: session.taskIds.length,
    artifactCount: session.artifactIds.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

module.exports = {
  MAX_TASKS,
  MAX_ARTIFACTS,
  createSession,
  snapshot,
  summarize,
  attachTask,
  attachArtifact,
  attachSandbox,
  attachHarness,
  attachAgent,
  touch,
};
