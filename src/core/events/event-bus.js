// The centralized event bus.
//
// Every subsystem reports its lifecycle here so that the UI, the execution
// trace, workflows and future observers all see the same structured stream and
// nothing has to reach into another subsystem's internals to watch it.

let seq = 0;

function makeEvent(type, refs = {}, payload) {
  const id = `evt-${Date.now().toString(36)}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ev = {
    id,
    type,
    timestamp: Date.now(),
    taskId: refs.taskId || null,
    agentId: refs.agentId || null,
    toolId: refs.toolId || null,
    workflowId: refs.workflowId || null,
    nodeId: refs.nodeId || null,
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
});

module.exports = { EventBus, makeEvent, TYPES };