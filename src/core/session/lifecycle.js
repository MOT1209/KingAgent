// Session lifecycle: the third state machine, and the one that must not be
// confused with the other two.
//
//   task state    (runtime/states.js)  — what one unit of work is doing
//   harness state (harness/lifecycle.js) — whether a backend is alive
//   session state (here)               — whether a person's working context is
//                                        open, and whether it is accepting work
//
// §25 is explicit that task and session lifecycles stay distinct, and the
// practical reason is that all four combinations are normal: a paused session
// can contain a running task (you paused *sending*, not the work), and a
// running session can contain a failed task. Collapsing them would make pause
// ambiguous, which is exactly the bug this file prevents.
//
// WAITING is the state that carries the most meaning: the session is open and
// healthy but blocked on a human (an approval, a question). It is not an error
// and it is not idle time.

const SESSION_STATES = Object.freeze({
  CREATED: 'created',
  INITIALIZING: 'initializing',
  READY: 'ready',
  RUNNING: 'running',
  WAITING: 'waiting',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

const EDGES = Object.freeze({
  [SESSION_STATES.CREATED]: [SESSION_STATES.INITIALIZING, SESSION_STATES.STOPPING, SESSION_STATES.FAILED],
  [SESSION_STATES.INITIALIZING]: [SESSION_STATES.READY, SESSION_STATES.STOPPING, SESSION_STATES.FAILED],
  [SESSION_STATES.READY]: [SESSION_STATES.RUNNING, SESSION_STATES.WAITING, SESSION_STATES.STOPPING, SESSION_STATES.FAILED],
  [SESSION_STATES.RUNNING]: [SESSION_STATES.WAITING, SESSION_STATES.PAUSED, SESSION_STATES.STOPPING, SESSION_STATES.COMPLETED, SESSION_STATES.FAILED],
  [SESSION_STATES.WAITING]: [SESSION_STATES.RUNNING, SESSION_STATES.PAUSED, SESSION_STATES.STOPPING, SESSION_STATES.COMPLETED, SESSION_STATES.FAILED],
  [SESSION_STATES.PAUSED]: [SESSION_STATES.RUNNING, SESSION_STATES.WAITING, SESSION_STATES.STOPPING, SESSION_STATES.FAILED],
  [SESSION_STATES.STOPPING]: [SESSION_STATES.STOPPED, SESSION_STATES.FAILED],
  [SESSION_STATES.STOPPED]: [],
  [SESSION_STATES.COMPLETED]: [],
  [SESSION_STATES.FAILED]: [],
});

const TRANSITIONS = new Map(Object.entries(EDGES).map(([from, to]) => [from, new Set(to)]));

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
      `Invalid session state transition: ${from} -> ${to}. ` +
      `Legal targets from ${from}: [${[...TRANSITIONS.get(from)].join(', ')}]`,
    );
  }
  return true;
}

function isTerminal(s) {
  return s === SESSION_STATES.STOPPED || s === SESSION_STATES.COMPLETED || s === SESSION_STATES.FAILED;
}

// Can this session accept new work right now?
function isActive(s) {
  return s === SESSION_STATES.READY || s === SESSION_STATES.RUNNING || s === SESSION_STATES.WAITING;
}

class SessionLifecycle {
  constructor({ initial = SESSION_STATES.CREATED, onChange = null } = {}) {
    this._state = initial;
    this._onChange = onChange;
  }

  get state() {
    return this._state;
  }

  get terminal() {
    return isTerminal(this._state);
  }

  get active() {
    return isActive(this._state);
  }

  can(to) {
    return canTransition(this._state, to);
  }

  go(to, note) {
    assertTransition(this._state, to);
    const from = this._state;
    this._state = to;
    if (this._onChange) this._onChange({ from, to, at: Date.now(), note });
    return to;
  }
}

module.exports = { SESSION_STATES, EDGES, TRANSITIONS, isState, canTransition, assertTransition, isTerminal, isActive, SessionLifecycle };
