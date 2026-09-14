// StateRecoveryManager: pause, resume, and picking up after a crash.
//
// The Phase 2 RecoveryManager (core/recovery/recovery.js) decides what to do
// about a *failed step* — retry, replan, ask. It stays exactly as it is. This is
// the other half: what to do about a task that stopped existing mid-run because
// the process did.
//
// The rule that shapes it: **never blindly restart a destructive action.** A
// snapshot records whether the last action was mutating and whether an
// observation came back for it. If an irreversible action was in flight when
// the lights went out, we do not know whether it happened — so recovery refuses
// to replay and asks for a replan (or a human), rather than deleting the same
// thing twice.

const { TYPES } = require('../events/event-bus');
const { identityRefs } = require('../workspace/identity');
const {
  createAgentStateSnapshot, summarizeSnapshot, isInterrupted, endedMidMutation, SNAPSHOT_REASONS,
} = require('./snapshot');
const { AgentStateStore } = require('./store');
const { TRACE_EVENTS } = require('../trace/events');

const RECOVERY_ACTIONS = Object.freeze({
  CONTINUE: 'continue',   // safe to resume where we left off
  REPLAN: 'replan',       // state is unclear; re-derive a plan from the world as it is
  ASK: 'ask',             // a human has to say what happened
  DISCARD: 'discard',     // nothing worth recovering
});

class StateRecoveryManager {
  constructor({
    store = null, collection = null, workspaces = null, traces = null,
    approvals = null, bus = null, logger = null,
  } = {}) {
    this._store = store || new AgentStateStore({ collection });
    this._workspaces = workspaces;
    this._traces = traces;
    this._approvals = approvals;
    this._bus = bus;
    this._logger = logger;
  }

  get store() { return this._store; }

  // --- capture -------------------------------------------------------------

  async capture({
    workspace, task = null, agentState = null, currentStep = null,
    lastAction = null, lastObservation = null, activeTools = [],
    reason = SNAPSHOT_REASONS.CHECKPOINT,
  } = {}) {
    if (!workspace) throw new Error('capture requires a workspace');
    const pending = this._approvals
      ? this._approvals.getPendingApprovals({ taskId: workspace.taskId }).map((a) => a.id)
      : [];

    const snapshot = createAgentStateSnapshot({
      identity: workspace.identity,
      status: task ? task.state : workspace.status,
      agentState,
      currentStep,
      completedSteps: task ? (task.steps || []).filter((s) => s.status === 'completed').map((s) => s.id) : [],
      activeTools,
      memoryRefs: workspace.memoryRefs,
      contextRefs: workspace.contextRefs,
      artifactRefs: workspace.artifactIds,
      pendingApprovals: pending,
      lastObservation,
      lastAction,
      plan: task ? task.plan : null,
      reason,
    });

    await this._store.put(snapshot);
    if (this._workspaces) await this._workspaces.persist(workspace.workspaceId).catch(() => {});
    if (this._traces) this._traces.appendEvent(workspace.traceId, TRACE_EVENTS.SNAPSHOT, summarizeSnapshot(snapshot));
    if (this._bus) this._bus.emit(TYPES.STATE_SNAPSHOT_CREATED, identityRefs(workspace.identity), summarizeSnapshot(snapshot));
    return snapshot;
  }

  // --- pause / resume ------------------------------------------------------

  // Pausing is: stop admitting new work, write down where we are, suspend the
  // workspace. It deliberately does not kill anything in flight — a tool call
  // that is already running finishes and is observed, because aborting it
  // mid-write is how a half-written file happens.
  async pause({ workspace, task = null, currentStep = null, lastAction = null, lastObservation = null }) {
    const snapshot = await this.capture({
      workspace, task, currentStep, lastAction, lastObservation, reason: SNAPSHOT_REASONS.PAUSE,
    });
    if (this._workspaces) this._workspaces.suspend(workspace.workspaceId);
    else workspace.suspend();
    return snapshot;
  }

  // Resume rebuilds the *references*: workspace, context ids, memory ids,
  // artifact ids, trace. It does not re-run anything — it returns a plan of
  // action and lets the caller (orchestrator / runtime) act on it.
  async resume(taskId, { environment = null } = {}) {
    const snapshot = await this._store.loadLatest(taskId);
    if (!snapshot) return { ok: false, reason: 'no snapshot for this task', action: RECOVERY_ACTIONS.DISCARD };

    let workspace = this._workspaces ? this._workspaces.get(snapshot.workspaceId) : null;
    if (!workspace && this._workspaces) {
      workspace = await this._workspaces.restore(snapshot.workspaceId, { environment });
    }
    if (!workspace) return { ok: false, reason: 'workspace could not be restored', action: RECOVERY_ACTIONS.REPLAN, snapshot };

    if (workspace.status !== 'active') {
      if (this._workspaces) this._workspaces.reactivate(workspace.workspaceId);
      else workspace.reactivate();
    }
    // Approvals do not survive a pause across their own deadline; sweeping here
    // means a resumed task never believes it is still waiting on a dead request.
    if (this._approvals) this._approvals.sweep();

    const decision = this.decide(snapshot);
    if (this._traces) {
      this._traces.appendEvent(workspace.traceId, TRACE_EVENTS.RECOVERY, {
        summary: `resumed from snapshot ${snapshot.id}`, action: decision.action, reason: decision.reason,
      });
    }
    if (this._bus) {
      this._bus.emit(TYPES.STATE_SNAPSHOT_RESTORED, identityRefs(workspace.identity), {
        ...summarizeSnapshot(snapshot), action: decision.action,
      });
    }

    return {
      ok: true,
      snapshot,
      workspace,
      action: decision.action,
      reason: decision.reason,
      contextRefs: snapshot.contextRefs,
      memoryRefs: snapshot.memoryRefs,
      artifactRefs: snapshot.artifactRefs,
      pendingApprovals: snapshot.pendingApprovals,
      resumeStep: decision.action === RECOVERY_ACTIONS.CONTINUE ? snapshot.currentStep : null,
    };
  }

  // --- crash recovery ------------------------------------------------------

  // Every task whose last snapshot says it was still running. Called once at
  // startup; the caller decides whether to offer each one to the user.
  async listInterrupted() {
    const snaps = await this._store.listInterrupted();
    return snaps.map((s) => ({ ...summarizeSnapshot(s), decision: this.decide(s) }));
  }

  // The safety judgement, in one place so it can be tested on its own.
  decide(snapshot) {
    if (!snapshot) return { action: RECOVERY_ACTIONS.DISCARD, reason: 'no snapshot' };
    if (!isInterrupted(snapshot)) {
      return { action: RECOVERY_ACTIONS.DISCARD, reason: `task already ended in "${snapshot.status}"` };
    }
    if (endedMidMutation(snapshot)) {
      // We know an irreversible action was started and we do not know whether it
      // finished. Replaying could do it twice; skipping could leave it undone.
      // Neither is ours to guess.
      return {
        action: RECOVERY_ACTIONS.ASK,
        reason: `stopped during a mutating action (${snapshot.lastAction.type}${snapshot.lastAction.target ? ` on ${snapshot.lastAction.target}` : ''}) with no recorded outcome`,
      };
    }
    if (snapshot.pendingApprovals.length > 0) {
      return { action: RECOVERY_ACTIONS.ASK, reason: `${snapshot.pendingApprovals.length} approval(s) were outstanding` };
    }
    if (snapshot.status === 'paused') {
      return { action: RECOVERY_ACTIONS.CONTINUE, reason: 'paused deliberately; safe to continue' };
    }
    if (!snapshot.currentStep) {
      return { action: RECOVERY_ACTIONS.REPLAN, reason: 'no step was in flight; re-derive the plan from the current state' };
    }
    // A non-mutating step that was in flight is safe to redo: reads are
    // idempotent by nature, so continuing costs a repeat rather than a risk.
    if (snapshot.lastAction && snapshot.lastAction.mutating) {
      return { action: RECOVERY_ACTIONS.REPLAN, reason: 'the last action changed state; re-plan against the world as it is now' };
    }
    return { action: RECOVERY_ACTIONS.CONTINUE, reason: 'the interrupted step was read-only and can be repeated safely' };
  }

  async discard(taskId) {
    await this._store.delete(taskId);
    return true;
  }
}

module.exports = { StateRecoveryManager, RECOVERY_ACTIONS, SNAPSHOT_REASONS };
