// The Run entity.
//
// A "run" is the thing a person actually started and will ask about later: one
// objective, from the moment King said it until the final result came back.
// Before this, that idea was *implicit* — spread across a task, a workspace, a
// trace, a session and a pile of artifacts, each of which could only be joined
// back together by an expert who knew all five ids. A Run aggregates them.
//
// It deliberately owns no behaviour: routing, execution, policy and approvals
// all stay where they are. A run is an index over work that already happened,
// which is what makes it cheap to add and impossible to disagree with.

const { newId } = require('../workspace/identity');
const { isPlainObject, nonEmptyString, validId } = require('../schema/validate');

const RUN_STATES = Object.freeze({
  CREATED: 'created',
  RUNNING: 'running',
  PAUSED: 'paused',
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  STOPPED: 'stopped',
});

// from -> legal targets. The same guarded-transition pattern as the task state
// machine (runtime/states.js) and the agent lifecycle (agents/lifecycle.js), so
// there is one idea of "state machine" in the codebase rather than three.
const RUN_EDGES = Object.freeze({
  [RUN_STATES.CREATED]: [RUN_STATES.RUNNING, RUN_STATES.CANCELLED, RUN_STATES.STOPPED],
  [RUN_STATES.RUNNING]: [
    RUN_STATES.PAUSED, RUN_STATES.WAITING_FOR_APPROVAL,
    RUN_STATES.COMPLETED, RUN_STATES.FAILED, RUN_STATES.CANCELLED, RUN_STATES.STOPPED,
  ],
  [RUN_STATES.PAUSED]: [RUN_STATES.RUNNING, RUN_STATES.FAILED, RUN_STATES.CANCELLED, RUN_STATES.STOPPED],
  [RUN_STATES.WAITING_FOR_APPROVAL]: [RUN_STATES.RUNNING, RUN_STATES.FAILED, RUN_STATES.CANCELLED, RUN_STATES.STOPPED],
  [RUN_STATES.COMPLETED]: [RUN_STATES.STOPPED],
  [RUN_STATES.FAILED]: [RUN_STATES.STOPPED],
  [RUN_STATES.CANCELLED]: [RUN_STATES.STOPPED],
  [RUN_STATES.STOPPED]: [],
});

const RUN_TRANSITIONS = new Map(Object.entries(RUN_EDGES).map(([from, to]) => [from, new Set(to)]));

const TERMINAL_STATES = Object.freeze([
  RUN_STATES.COMPLETED, RUN_STATES.FAILED, RUN_STATES.CANCELLED, RUN_STATES.STOPPED,
]);

// Collections a run indexes. Each is bounded on write (see manager.js) so a
// long run cannot grow without limit just by doing a lot of work.
const RUN_COLLECTIONS = Object.freeze([
  'agents', 'tasks', 'tools', 'workflows', 'models', 'providers',
  'browserSessions', 'artifacts', 'events', 'errors',
]);

function isRunState(s) {
  return typeof s === 'string' && s in RUN_EDGES;
}

function canTransition(from, to) {
  if (!isRunState(from) || !isRunState(to)) return false;
  return RUN_TRANSITIONS.get(from).has(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid run state transition: ${from} -> ${to}. `
      + `Legal targets from ${from}: [${[...RUN_TRANSITIONS.get(from)].join(', ')}]`,
    );
  }
  return true;
}

function isTerminal(s) {
  return TERMINAL_STATES.includes(s);
}

// A run id is minted, never supplied: two hosts starting the same objective
// must not collide on an id a caller chose.
function createRun({
  id = null,
  objective = '',
  projectId = null,
  conversationId = null,
  rootTaskId = null,
  sessionId = null,
  traceId = null,
  agentId = null,
  createdBy = 'king',
  metadata = {},
  now = Date.now(),
} = {}) {
  return {
    id: id || newId('run'),
    objective: typeof objective === 'string' ? objective : String(objective || ''),
    status: RUN_STATES.CREATED,
    projectId,
    conversationId,
    rootTaskId,
    sessionId,
    traceId,
    agentId,
    createdBy,
    // Everything the run touched, by id. Never the objects themselves — a run
    // record must stay a small, cheap index, not a second copy of the world.
    agents: [],
    tasks: [],
    tools: [],
    workflows: [],
    models: [],
    providers: [],
    browserSessions: [],
    artifacts: [],
    events: [],
    errors: [],
    usage: { tokens: 0, cost: 0, toolCalls: 0, taskCount: 0 },
    result: null,
    error: null,
    retryOf: null,
    startedAt: now,
    pausedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    metadata: isPlainObject(metadata) ? { ...metadata } : {},
  };
}

function validateRun(run) {
  if (!isPlainObject(run)) return { ok: false, errors: ['run must be an object'] };
  if (!validId(run.id)) return { ok: false, errors: [`invalid run id: ${JSON.stringify(run.id)}`] };
  if (!isRunState(run.status)) return { ok: false, errors: [`invalid run status: ${JSON.stringify(run.status)}`] };
  if (!nonEmptyString(run.objective)) return { ok: false, errors: ['run requires a non-empty objective'] };
  return { ok: true, errors: [] };
}

// The compact shape list/inspect surfaces use, so a UI never ships a whole run
// record to render a row.
function runRef(run) {
  return {
    id: run.id,
    objective: run.objective,
    status: run.status,
    projectId: run.projectId,
    conversationId: run.conversationId,
    rootTaskId: run.rootTaskId,
    agents: run.agents.length,
    tasks: run.tasks.length,
    artifacts: run.artifacts.length,
    errors: run.errors.length,
    cost: run.usage.cost,
    tokens: run.usage.tokens,
    durationMs: (run.endedAt || Date.now()) - run.startedAt,
    retryOf: run.retryOf,
  };
}

module.exports = {
  RUN_STATES,
  RUN_EDGES,
  RUN_TRANSITIONS,
  RUN_COLLECTIONS,
  TERMINAL_STATES,
  isRunState,
  canTransition,
  assertTransition,
  isTerminal,
  createRun,
  validateRun,
  runRef,
};
