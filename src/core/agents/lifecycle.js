// The agent lifecycle.
//
// Tasks already have a state machine (runtime/states.js) and it stays exactly
// as it is. This is a *different* thing: the state of an agent *instance* — the
// running participant — which is what a coordinator needs to answer "is this
// agent ready to take a delegation?" and what a snapshot records so a
// half-finished participant can be resumed rather than restarted.
//
// It is modelled on the same guarded-transition pattern as runtime/states.js so
// there is one idea of "state machine" in the codebase, not two competing ones.

const AGENT_STATES = Object.freeze({
  CREATED: 'created',
  INITIALIZING: 'initializing',
  READY: 'ready',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RECOVERING: 'recovering',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
});

// from -> legal targets. STOPPING is reachable from everywhere non-terminal,
// so a cancel is always available; STOPPED and COMPLETED are absorbing.
const AGENT_EDGES = Object.freeze({
  [AGENT_STATES.CREATED]: [AGENT_STATES.INITIALIZING, AGENT_STATES.STOPPING],
  [AGENT_STATES.INITIALIZING]: [AGENT_STATES.READY, AGENT_STATES.FAILED, AGENT_STATES.STOPPING],
  [AGENT_STATES.READY]: [AGENT_STATES.RUNNING, AGENT_STATES.STOPPING, AGENT_STATES.COMPLETED],
  [AGENT_STATES.RUNNING]: [AGENT_STATES.PAUSED, AGENT_STATES.COMPLETED, AGENT_STATES.FAILED, AGENT_STATES.STOPPING],
  [AGENT_STATES.PAUSED]: [AGENT_STATES.RUNNING, AGENT_STATES.STOPPING, AGENT_STATES.FAILED],
  [AGENT_STATES.FAILED]: [AGENT_STATES.RECOVERING, AGENT_STATES.STOPPING],
  [AGENT_STATES.RECOVERING]: [AGENT_STATES.READY, AGENT_STATES.RUNNING, AGENT_STATES.FAILED, AGENT_STATES.STOPPING],
  [AGENT_STATES.COMPLETED]: [AGENT_STATES.STOPPING],
  [AGENT_STATES.STOPPING]: [AGENT_STATES.STOPPED],
  [AGENT_STATES.STOPPED]: [],
});

const AGENT_TRANSITIONS = new Map(Object.entries(AGENT_EDGES).map(([from, to]) => [from, new Set(to)]));

function isAgentState(s) {
  return typeof s === 'string' && s in AGENT_EDGES;
}

function canTransition(from, to) {
  if (!isAgentState(from) || !isAgentState(to)) return false;
  return AGENT_TRANSITIONS.get(from).has(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid agent state transition: ${from} -> ${to}. `
      + `Legal targets from ${from}: [${[...AGENT_TRANSITIONS.get(from)].join(', ')}]`,
    );
  }
  return true;
}

function isTerminal(s) {
  return s === AGENT_STATES.STOPPED;
}

class AgentLifecycle {
  constructor({ agentId, workspaceId = null, initial = AGENT_STATES.CREATED, onChange = null } = {}) {
    this.agentId = agentId;
    this.workspaceId = workspaceId;
    this._state = initial;
    this._onChange = onChange;
    this.history = [{ to: initial, at: Date.now(), note: 'created' }];
  }

  get state() { return this._state; }
  get terminal() { return isTerminal(this._state); }

  can(to) { return canTransition(this._state, to); }

  go(to, note = '') {
    assertTransition(this._state, to);
    const from = this._state;
    this._state = to;
    const entry = { from, to, at: Date.now(), note };
    this.history.push(entry);
    if (this.history.length > 200) this.history.splice(0, this.history.length - 200);
    if (this._onChange) this._onChange(entry);
    return to;
  }

  // Cancellation is always available from a non-terminal state: go via STOPPING.
  stop(note = 'stopped') {
    if (this.terminal) return this._state;
    if (this._state !== AGENT_STATES.STOPPING) this.go(AGENT_STATES.STOPPING, note);
    return this.go(AGENT_STATES.STOPPED, note);
  }

  toJSON() {
    return { agentId: this.agentId, workspaceId: this.workspaceId, state: this._state, history: this.history.slice(-50) };
  }
}

module.exports = {
  AGENT_STATES, AGENT_EDGES, AGENT_TRANSITIONS, AgentLifecycle,
  isAgentState, canTransition, assertTransition, isTerminal,
};
