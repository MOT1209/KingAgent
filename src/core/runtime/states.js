// The task state machine: states, legal edges, and the guarded transition.
//
// Tasks are the unit of work the runtime executes. Their lifecycle is a
// directed graph, not a free-for-all, so pause/resume/cancel behave the same on
// every path and a stale UI click can never push a task somewhere invalid.

const STATES = Object.freeze({
  CREATED: 'created',
  QUEUED: 'queued',
  ANALYZING: 'analyzing',
  PLANNING: 'planning',
  EXECUTING: 'executing',
  OBSERVING: 'observing',
  EVALUATING: 'evaluating',
  RECOVERING: 'recovering',
  REPLANNING: 'replanning',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLING: 'cancelling',
  CANCELLED: 'cancelled',
});

// from -> [legal targets]
const EDGES = Object.freeze({
  [STATES.CREATED]: [STATES.QUEUED, STATES.CANCELLED],
  [STATES.QUEUED]: [STATES.ANALYZING, STATES.PAUSED, STATES.CANCELLING],
  [STATES.ANALYZING]: [STATES.PLANNING, STATES.FAILED, STATES.PAUSED, STATES.CANCELLING],
  [STATES.PLANNING]: [STATES.EXECUTING, STATES.FAILED, STATES.PAUSED, STATES.CANCELLING],
  [STATES.EXECUTING]: [STATES.OBSERVING, STATES.COMPLETED, STATES.FAILED, STATES.PAUSED, STATES.CANCELLING],
  [STATES.OBSERVING]: [STATES.EVALUATING, STATES.FAILED, STATES.CANCELLING],
  [STATES.EVALUATING]: [STATES.EXECUTING, STATES.REPLANNING, STATES.COMPLETED, STATES.FAILED, STATES.CANCELLING],
  [STATES.RECOVERING]: [STATES.REPLANNING, STATES.EXECUTING, STATES.FAILED, STATES.CANCELLING],
  [STATES.REPLANNING]: [STATES.EXECUTING, STATES.FAILED, STATES.CANCELLING],
  [STATES.PAUSED]: [STATES.EXECUTING, STATES.CANCELLING],
  [STATES.FAILED]: [STATES.REPLANNING],
  [STATES.CANCELLING]: [STATES.CANCELLED],
  [STATES.COMPLETED]: [],
  [STATES.CANCELLED]: [],
});

// Derived transition map: from -> Set of valid targets.
const TRANSITIONS = new Map(
  Object.entries(EDGES).map(([from, to]) => [from, new Set(to)]),
);

function isState(s) {
  return typeof s === 'string' && s in EDGES;
}

function canTransition(from, to) {
  if (!isState(from) || !isState(to)) return false;
  return TRANSITIONS.get(from).has(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid task state transition: ${from} -> ${to}. ` +
      `Legal targets from ${from}: [${[...TRANSITIONS.get(from)].join(', ')}]`,
    );
  }
  return true;
}

function isTerminal(s) {
  return s === STATES.COMPLETED || s === STATES.CANCELLED;
}

module.exports = { STATES, EDGES, TRANSITIONS, isState, canTransition, assertTransition, isTerminal };