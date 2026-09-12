// Thin adapter over states.js so "the state machine" is a type of its own and
// task/state concerns live in one module. The heavy lifting is the transition
// table; this wrapper owns an instance's current state.
//
// Later this is the seam where a task's state gets persisted on change, so task
// state survives a restart — the table above already forbids the impossible
// moves even across restarts.

const { STATES, canTransition, assertTransition, isTerminal } = require('./states');

class StateMachine {
  constructor({ initial = STATES.CREATED, onChange } = {}) {
    this._state = initial;
    this._onChange = onChange || null;
  }

  get state() {
    return this._state;
  }

  can(to) {
    return canTransition(this._state, to);
  }

  // Attempts to move to `to`. Returns the new state on success, throws on an
  // illegal move. `note` is passed to onChange so the owning task can record
  // why the move happened.
  go(to, note) {
    assertTransition(this._state, to);
    const from = this._state;
    this._state = to;
    if (this._onChange) this._onChange({ from, to, at: Date.now(), note });
    return to;
  }

  get terminal() {
    return isTerminal(this._state);
  }
}

module.exports = { StateMachine, STATES };