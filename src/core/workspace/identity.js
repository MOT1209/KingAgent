// Workspace identity: the correlation keys every Phase 3 record carries.
//
// A task is not one object any more — it is a workspace, a context packet, a
// pile of memory entries, a trace, artifacts and (soon) messages between
// agents. The only thing that makes those a *single* execution is that they all
// quote the same identity. Debugging a multi-agent run means filtering on one
// of these keys, so they are minted once, frozen, and passed down rather than
// re-derived anywhere.
//
// Child executions (a delegated sub-task) inherit project/session/trace lineage
// and get their own workspace + task ids, so a delegation is traceable both as
// its own unit and as part of its parent.

const crypto = require('node:crypto');

// The full key set. Order matters only for readability in logs.
const IDENTITY_FIELDS = Object.freeze([
  'workspaceId', 'projectId', 'taskId', 'sessionId', 'agentId', 'traceId',
]);

// ids are lowercase so they pass the platform's validId shape wherever one is
// reused as a store key, and carry their prefix so a stray id is readable.
function newId(prefix) {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(5).toString('hex');
  return `${prefix}-${stamp}-${rand}`;
}

function createIdentity({
  workspaceId = null,
  projectId = null,
  taskId = null,
  sessionId = null,
  agentId = null,
  traceId = null,
  parentWorkspaceId = null,
  parentTaskId = null,
} = {}) {
  const identity = {
    workspaceId: workspaceId || newId('ws'),
    projectId: projectId || null,
    taskId: taskId || newId('task'),
    sessionId: sessionId || newId('sess'),
    agentId: agentId || null,
    traceId: traceId || newId('trace'),
    parentWorkspaceId: parentWorkspaceId || null,
    parentTaskId: parentTaskId || null,
  };
  return Object.freeze(identity);
}

// A delegated / handed-off execution: same project, session and trace lineage,
// new workspace and task, and a recorded parent so the tree can be rebuilt.
function childIdentity(parent, { agentId = null, taskId = null, traceId = null } = {}) {
  if (!parent) throw new Error('childIdentity requires a parent identity');
  return createIdentity({
    projectId: parent.projectId,
    sessionId: parent.sessionId,
    traceId: traceId || parent.traceId,
    taskId: taskId || null,
    agentId: agentId || parent.agentId,
    parentWorkspaceId: parent.workspaceId,
    parentTaskId: parent.taskId,
  });
}

// The subset the EventBus carries on every event (see events/event-bus.js).
function identityRefs(identity) {
  if (!identity) return {};
  return {
    taskId: identity.taskId || null,
    agentId: identity.agentId || null,
    workspaceId: identity.workspaceId || null,
    projectId: identity.projectId || null,
    sessionId: identity.sessionId || null,
    traceId: identity.traceId || null,
  };
}

function sameWorkspace(a, b) {
  return Boolean(a && b && a.workspaceId && a.workspaceId === b.workspaceId);
}

// True when `child` descends from `ancestor` by one hop. Deeper lineage is a
// walk the caller owns — the identity object deliberately stores one parent
// rather than a full chain that could grow without bound.
function isChildOf(child, ancestor) {
  return Boolean(child && ancestor && child.parentWorkspaceId === ancestor.workspaceId);
}

function validateIdentity(identity) {
  if (!identity || typeof identity !== 'object') return { ok: false, errors: ['identity must be an object'] };
  for (const key of ['workspaceId', 'taskId', 'sessionId', 'traceId']) {
    if (typeof identity[key] !== 'string' || identity[key].length === 0) {
      return { ok: false, errors: [`identity.${key} is required`] };
    }
  }
  return { ok: true, errors: [] };
}

module.exports = {
  IDENTITY_FIELDS,
  newId,
  createIdentity,
  childIdentity,
  identityRefs,
  sameWorkspace,
  isChildOf,
  validateIdentity,
};
