// Barrel for agent state snapshots, pause/resume and crash recovery.
//
// Distinct from core/recovery/recovery.js, which classifies a failed *step* and
// decides retry/replan/ask. This subsystem is about a task that stopped
// existing — a pause, or a process that went away.

const { StateRecoveryManager, RECOVERY_ACTIONS } = require('./recovery');
const { AgentStateStore } = require('./store');
const snapshot = require('./snapshot');

module.exports = {
  StateRecoveryManager,
  AgentStateStore,
  RECOVERY_ACTIONS,
  SNAPSHOT_VERSION: snapshot.SNAPSHOT_VERSION,
  SNAPSHOT_REASONS: snapshot.SNAPSHOT_REASONS,
  createAgentStateSnapshot: snapshot.createAgentStateSnapshot,
  summarizeSnapshot: snapshot.summarizeSnapshot,
  isInterrupted: snapshot.isInterrupted,
  endedMidMutation: snapshot.endedMidMutation,
};
