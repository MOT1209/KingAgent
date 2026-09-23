// Barrel for the run subsystem.

const { RunManager, DEFAULT_CAPS } = require('./manager');
const run = require('./run');

module.exports = {
  RunManager,
  DEFAULT_RUN_CAPS: DEFAULT_CAPS,
  RUN_STATES: run.RUN_STATES,
  RUN_EDGES: run.RUN_EDGES,
  RUN_COLLECTIONS: run.RUN_COLLECTIONS,
  TERMINAL_RUN_STATES: run.TERMINAL_STATES,
  isRunState: run.isRunState,
  canTransitionRun: run.canTransition,
  assertRunTransition: run.assertTransition,
  isTerminalRun: run.isTerminal,
  createRun: run.createRun,
  validateRun: run.validateRun,
  runRef: run.runRef,
};
