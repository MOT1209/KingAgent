// The skill lifecycle: the states a skill can be in and the moves between them.
//
// Written as an explicit transition table for the same reason the harness
// lifecycle is (core/harness/lifecycle.js): a capability that can run code on a
// user's machine must not have an implicit state machine. Every move is either
// in this table or it is a bug, and "quarantined" in particular has exactly one
// way out — a human releasing it — so a repeatedly failing skill can never
// re-enable itself by taking an undeclared path.
//
//   discovered  a source offered it; nothing has been read yet
//   validating  manifest + content are being checked and scanned
//   installed   present on disk/in the registry, not yet allowed to run
//   enabled     the user (or policy default) allows it to be selected
//   loaded      its content is in memory for a specific run
//   running     it is executing right now
//   evaluating  its result is being scored
//   active      it has run successfully at least once and is in good standing
//   disabled    present but not selectable
//   deprecated  superseded; still runnable, flagged in the UI
//   failed      a validation or execution failure that is not (yet) a safety issue
//   quarantined a safety or repeated-failure stop. Only a human releases it.
//   removed     terminal

const SKILL_STATES = Object.freeze({
  DISCOVERED: 'discovered',
  VALIDATING: 'validating',
  INSTALLED: 'installed',
  ENABLED: 'enabled',
  LOADED: 'loaded',
  RUNNING: 'running',
  EVALUATING: 'evaluating',
  ACTIVE: 'active',
  DISABLED: 'disabled',
  DEPRECATED: 'deprecated',
  FAILED: 'failed',
  QUARANTINED: 'quarantined',
  REMOVED: 'removed',
});

const STATE_LIST = Object.freeze(Object.values(SKILL_STATES));

// A state a skill may be selected from for new work. `loaded`/`running` are
// deliberately absent: they describe one run, not availability.
const USABLE_STATES = Object.freeze(['enabled', 'active', 'deprecated']);

const TERMINAL_STATES = Object.freeze(['removed']);

// States from which content may be read for a run. Wider than USABLE_STATES on
// purpose: those three describe one run in progress, and a skill already
// loaded for task A must still be loadable for task B. Selection is the
// narrower question and still uses USABLE_STATES.
const LOADABLE_STATES = Object.freeze([...USABLE_STATES, 'loaded', 'running', 'evaluating']);

const TRANSITIONS = Object.freeze({
  discovered: Object.freeze(['validating', 'failed', 'removed']),
  validating: Object.freeze(['installed', 'failed', 'quarantined', 'removed']),
  installed: Object.freeze(['enabled', 'disabled', 'deprecated', 'quarantined', 'failed', 'removed']),
  enabled: Object.freeze(['loaded', 'disabled', 'deprecated', 'quarantined', 'failed', 'validating', 'removed']),
  loaded: Object.freeze(['running', 'enabled', 'active', 'disabled', 'quarantined', 'failed']),
  running: Object.freeze(['evaluating', 'failed', 'quarantined', 'disabled']),
  evaluating: Object.freeze(['active', 'enabled', 'failed', 'quarantined', 'disabled']),
  active: Object.freeze(['loaded', 'enabled', 'disabled', 'deprecated', 'quarantined', 'failed', 'validating', 'removed']),
  disabled: Object.freeze(['enabled', 'deprecated', 'quarantined', 'removed', 'validating']),
  deprecated: Object.freeze(['enabled', 'disabled', 'quarantined', 'removed']),
  // A failure is recoverable: re-validating (after an update) or being switched
  // off are both legitimate. Going straight back to `active` is not — a skill
  // earns `active` by running successfully, never by being reset.
  failed: Object.freeze(['validating', 'enabled', 'disabled', 'quarantined', 'removed']),
  // The one-way door. `disabled` is the release valve and SkillEnabler requires
  // an explicit human actor to use it.
  quarantined: Object.freeze(['disabled', 'removed']),
  removed: Object.freeze([]),
});

function isState(value) {
  return typeof value === 'string' && STATE_LIST.includes(value);
}

function canTransition(from, to) {
  if (!isState(from) || !isState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

function isUsable(state) {
  return USABLE_STATES.includes(state);
}

function isLoadable(state) {
  return LOADABLE_STATES.includes(state);
}

// Why a move was refused, phrased for an error message and an audit line.
function transitionError(from, to) {
  if (!isState(from)) return `unknown skill state "${from}"`;
  if (!isState(to)) return `unknown skill state "${to}"`;
  if (isTerminal(from)) return `a ${from} skill cannot change state`;
  if (from === 'quarantined') return 'a quarantined skill can only be disabled by a person or removed';
  return `a skill cannot go from ${from} to ${to} (allowed: ${TRANSITIONS[from].join(', ') || 'none'})`;
}

module.exports = {
  SKILL_STATES,
  STATE_LIST,
  USABLE_STATES,
  LOADABLE_STATES,
  TERMINAL_STATES,
  TRANSITIONS,
  isState,
  canTransition,
  isTerminal,
  isUsable,
  isLoadable,
  transitionError,
};
