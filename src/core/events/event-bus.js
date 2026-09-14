// The centralized event bus.
//
// Every subsystem reports its lifecycle here so that the UI, the execution
// trace, workflows and future observers all see the same structured stream and
// nothing has to reach into another subsystem's internals to watch it.

let seq = 0;

function makeEvent(type, refs = {}, payload) {
  const id = `evt-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ev = {
    id, // the correlation key every Phase 3/4 observer joins on
    type,
    timestamp: Date.now(),
    taskId: refs.taskId || null,
    agentId: refs.agentId || null,
    toolId: refs.toolId || null,
    workflowId: refs.workflowId || null,
    nodeId: refs.nodeId || null,
    // Phase 3 correlation keys. A multi-agent run produces interleaved events
    // from several workspaces; without these the stream is unreadable and a
    // trace cannot be rebuilt. They default to null so every Phase 1/2 emitter
    // keeps working unchanged.
    workspaceId: refs.workspaceId || null,
    projectId: refs.projectId || null,
    sessionId: refs.sessionId || null,
    traceId: refs.traceId || null,
    parentEventId: refs.parentEventId || null,
    seq: seq,
    // Phase 4 correlation refs. A harness/policy/sandbox event is only useful
    // if it can be joined back to the work it happened for.
    harnessId: refs.harnessId || null,
    policyId: refs.policyId || null,
    sandboxId: refs.sandboxId || null,
    delegationId: refs.delegationId || null,
    payload: payload === undefined ? null : payload,
  };
  return Object.freeze(ev);
}

class EventBus {
  constructor() {
    this._handlers = new Map(); // type -> Set<fn>
  }

  // `fn(ev)` for one event type (or `'*'` for everything). Returns an
  // unsubscribe function; idempotent.
  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('EventBus.on requires a function');
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type).delete(fn);
  }

  off(type, fn) {
    const set = this._handlers.get(type);
    if (set) set.delete(fn);
  }

  publish(ev) {
    const forth = this._handlers.get(ev.type);
    if (forth) for (const fn of [...forth]) {
      try { fn(ev); } catch (err) { this._squelch(err, ev); }
    }
    const all = this._handlers.get('*');
    if (all) for (const fn of [...all]) {
      try { fn(ev); } catch (err) { this._squelch(err, ev); }
    }
    return ev;
  }

  // Convenience: build and publish. Returns the frozen event.
  emit(type, refs, payload) {
    return this.publish(makeEvent(type, refs, payload));
  }

  listenerCount(type) {
    return this._handlers.has(type) ? this._handlers.get(type).size : 0;
  }

  _squelch(err, ev) {
    // A broken subscriber must never take down the task it is watching.
    if (process.env.KINGAGENT_EVENT_DEBUG) console.error('[event-bus] handler threw', err, ev.type);
  }
}

// Event types, kept together so docs, the UI and tests reference one source.
const TYPES = Object.freeze({
  TASK_CREATED: 'task.created',
  TASK_QUEUED: 'task.queued',
  TASK_STARTED: 'task.started',
  TASK_ANALYZING: 'task.analyzing',
  TASK_PLANNING: 'task.planning',
  PLAN_CREATED: 'task.plan.created',
  STEP_STARTED: 'task.step.started',
  STEP_COMPLETED: 'task.step.completed',
  STEP_FAILED: 'task.step.failed',
  TASK_FAILED: 'task.failed',
  TASK_REPLANNED: 'task.replanned',
  TASK_CANCELLED: 'task.cancelled',
  TASK_COMPLETED: 'task.completed',
  TASK_PAUSED: 'task.paused',
  TASK_RESUMED: 'task.resumed',
  AGENT_STARTED: 'agent.started',
  AGENT_COMPLETED: 'agent.completed',
  TOOL_CALLED: 'tool.called',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',
  WORKFLOW_STARTED: 'workflow.started',
  WORKFLOW_COMPLETED: 'workflow.completed',
  WORKFLOW_FAILED: 'workflow.failed',
  WORKFLOW_CANCELLED: 'workflow.cancelled',
  APPROVAL_REQUIRED: 'approval.required',
  APPROVAL_GRANTED: 'approval.granted',
  APPROVAL_DENIED: 'approval.denied',

  // --- Phase 3 -------------------------------------------------------------
  // Context
  CONTEXT_CREATED: 'context.created',
  CONTEXT_UPDATED: 'context.updated',
  // Memory
  MEMORY_READ: 'memory.read',
  MEMORY_WRITE: 'memory.write',
  MEMORY_SEARCH: 'memory.search',
  MEMORY_UPDATED: 'memory.updated',
  // Workspace
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  WORKSPACE_FILE_ADDED: 'workspace.file.added',
  WORKSPACE_FILE_REMOVED: 'workspace.file.removed',
  WORKSPACE_FILE_MODIFIED: 'workspace.file.modified',
  // Trace
  TRACE_STARTED: 'trace.started',
  TRACE_COMPLETED: 'trace.completed',
  // Agent loop
  AGENT_OBSERVATION: 'agent.observation',
  AGENT_ACTION: 'agent.action',
  AGENT_VALIDATION: 'agent.validation',
  AGENT_RECOVERY: 'agent.recovery',
  // Artifacts
  ARTIFACT_CREATED: 'artifact.created',
  ARTIFACT_UPDATED: 'artifact.updated',
  ARTIFACT_DELETED: 'artifact.deleted',
  // State
  STATE_SNAPSHOT_CREATED: 'state.snapshot.created',
  STATE_SNAPSHOT_RESTORED: 'state.snapshot.restored',
  // Multi-agent
  AGENT_MESSAGE: 'agent.message',
  AGENT_DELEGATED: 'agent.delegated',
  AGENT_HANDOFF: 'agent.handoff',
  // Approvals (Phase 3 lifecycle; approval.required/granted/denied above stay
  // for the Phase 2 tool-authorization path the renderer already listens to)
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_APPROVED: 'approval.approved',
  APPROVAL_REJECTED: 'approval.rejected',
  APPROVAL_EXPIRED: 'approval.expired',
  // Orchestration
  ORCHESTRATION_ROUTED: 'orchestration.routed',
  ORCHESTRATION_COMPLETED: 'orchestration.completed',
  ORCHESTRATION_FAILED: 'orchestration.failed',
  // Project
  PROJECT_DETECTED: 'project.detected',
  PROJECT_INDEXED: 'project.indexed',

  // --- Phase 4 (harness-orchestrator: src/core/harness-orchestrator/, an
  // independent control-plane layer that coexists with the Phase 3 one
  // above rather than replacing it — see docs/harness-orchestrator.md) -----
  HARNESS_SELECTED: 'harness.selected',
  HARNESS_STARTED: 'harness.started',
  HARNESS_STOPPED: 'harness.stopped',
  HARNESS_FAILED: 'harness.failed',
  POLICY_EVALUATED: 'policy.evaluated',
  POLICY_DENIED: 'policy.denied',
  POLICY_APPROVAL_REQUIRED: 'policy.approval_required',
  SANDBOX_CREATED: 'sandbox.created',
  SANDBOX_STARTED: 'sandbox.started',
  SANDBOX_STOPPED: 'sandbox.stopped',
  SANDBOX_FAILED: 'sandbox.failed',
  SANDBOX_PROCESS_REGISTERED: 'sandbox.process.registered',
  AGENT_ROUTED: 'agent.routed',
  SESSION_CREATED: 'session.created',
  SESSION_STARTED: 'session.started',
  SESSION_PAUSED: 'session.paused',
  SESSION_RESUMED: 'session.resumed',
  SESSION_COMPLETED: 'session.completed',
  SESSION_FAILED: 'session.failed',
  SESSION_STOPPED: 'session.stopped',
  ORCHESTRATOR_STEP: 'orchestrator.step',
  // AGENT_DELEGATED, AGENT_HANDOFF, AGENT_MESSAGE and ARTIFACT_CREATED were
  // also defined here under Phase 4 with the identical key and value the
  // Phase 3 block above already declares; not repeated.
});

module.exports = { EventBus, makeEvent, TYPES };