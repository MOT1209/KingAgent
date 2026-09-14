// Harness lifecycle: the states a backend moves through, and the legal edges.
//
// A harness is an external process, so its lifecycle is *not* the task
// lifecycle (runtime/states.js) and must not be conflated with it: a task can
// be paused while its harness keeps running, and a harness can die under a task
// that is still perfectly healthy. Keeping the two tables separate is what lets
// recovery tell "the agent failed" apart from "the backend died".
//
// `registered` is where a harness enters the registry. `detected` means the
// host looked for it and found it; `installable` means it is missing but the
// manifest knows how to get it. Nothing here runs an installer or a probe — the
// adapter asks the injected host for that (see adapter.js).

const HARNESS_STATES = Object.freeze({
  REGISTERED: 'registered',
  DETECTED: 'detected',
  INSTALLABLE: 'installable', // declared, not present on this machine
  STARTING: 'starting',
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  FAILED: 'failed',
  DISPOSED: 'disposed',
});

const EDGES = Object.freeze({
  // `starting` is reachable straight from `registered` on purpose: detection is
  // advice the router uses, not a permission the manager needs. A host that
  // knows its own command should not have to run a probe before spawning it,
  // and an attempt from `installable` produces the real error (spawn failed)
  // rather than a state-machine complaint.
  [HARNESS_STATES.REGISTERED]: [HARNESS_STATES.DETECTED, HARNESS_STATES.INSTALLABLE, HARNESS_STATES.STARTING, HARNESS_STATES.FAILED, HARNESS_STATES.DISPOSED],
  [HARNESS_STATES.DETECTED]: [HARNESS_STATES.STARTING, HARNESS_STATES.INSTALLABLE, HARNESS_STATES.FAILED, HARNESS_STATES.DISPOSED],
  [HARNESS_STATES.INSTALLABLE]: [HARNESS_STATES.DETECTED, HARNESS_STATES.STARTING, HARNESS_STATES.FAILED, HARNESS_STATES.DISPOSED],
  [HARNESS_STATES.STARTING]: [HARNESS_STATES.READY, HARNESS_STATES.RUNNING, HARNESS_STATES.FAILED, HARNESS_STATES.STOPPING],
  [HARNESS_STATES.READY]: [HARNESS_STATES.RUNNING, HARNESS_STATES.STOPPING, HARNESS_STATES.FAILED],
  [HARNESS_STATES.RUNNING]: [HARNESS_STATES.PAUSED, HARNESS_STATES.READY, HARNESS_STATES.STOPPING, HARNESS_STATES.FAILED],
  [HARNESS_STATES.PAUSED]: [HARNESS_STATES.RUNNING, HARNESS_STATES.STOPPING, HARNESS_STATES.FAILED],
  [HARNESS_STATES.STOPPING]: [HARNESS_STATES.STOPPED, HARNESS_STATES.FAILED],
  [HARNESS_STATES.STOPPED]: [HARNESS_STATES.STARTING, HARNESS_STATES.DISPOSED],
  [HARNESS_STATES.FAILED]: [HARNESS_STATES.STARTING, HARNESS_STATES.STOPPING, HARNESS_STATES.DISPOSED],
  [HARNESS_STATES.DISPOSED]: [],
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
      `Invalid harness state transition: ${from} -> ${to}. ` +
      `Legal targets from ${from}: [${[...TRANSITIONS.get(from)].join(', ')}]`,
    );
  }
  return true;
}

// A harness that can still be started. `stopped` is deliberately *not* terminal:
// restarting a backend after a clean stop is normal.
function isTerminal(s) {
  return s === HARNESS_STATES.DISPOSED;
}

// Owns one harness instance's current state. Same shape as the task
// StateMachine so the two lifecycles are read the same way.
class HarnessLifecycle {
  constructor({ initial = HARNESS_STATES.REGISTERED, onChange = null } = {}) {
    this._state = initial;
    this._onChange = onChange;
  }

  get state() {
    return this._state;
  }

  get terminal() {
    return isTerminal(this._state);
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

module.exports = { HARNESS_STATES, EDGES, TRANSITIONS, isState, canTransition, assertTransition, isTerminal, HarnessLifecycle };
