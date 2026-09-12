// Lifecycle owner for tasks.
//
// The TaskManager is where a task is born, transitions, and dies. It owns the
// StateMachine transition call and publishes the corresponding event bus
// events so the runtime, workflows, trace and UI all observe the same moves.

const { createTask, snapshot, summarize } = require('./task');
const { StateMachine, STATES } = require('./state-machine');
const { TYPES } = require('../events/event-bus');
const crypto = require('node:crypto');

class TaskManager {
  constructor({ bus, store } = {}) {
    if (!bus) throw new Error('TaskManager requires an EventBus');
    this._bus = bus;
    this._store = store || null; // optional persistence: { set(key, value), get(key) }
    this._tasks = new Map();
    this._machines = new Map(); // id -> StateMachine
  }

  create(spec) {
    if (!spec.id) spec.id = `task-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const task = createTask(spec);
    this._machines.set(task.id, new StateMachine({ initial: STATES.CREATED, onChange: this._onChange(task) }));
    this._tasks.set(task.id, task);
    this._bus.emit(TYPES.TASK_CREATED, { taskId: task.id, agentId: task.agentId }, { request: task.request, mode: task.mode });
    return task;
  }

  // Returns the current task view.
  get(id) {
    return this._tasks.get(id);
  }

  list() {
    return [...this._tasks.values()];
  }

  listSummaries(filterState) {
    const all = this.list().filter((t) => !filterState || filterState.length === 0 || filterState.includes(t.state));
    return all.map(summarize).sort((a, b) => b.createdAt - a.createdAt);
  }

  // Transition + event. `payload` rides along; `eventType` overrides the
  // default event so callers can emit richer detail (e.g. task.completed with a
  // result summary).
  _transition(id, to, opts = {}) {
    const task = this._tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    const machine = this._machines.get(id);
    machine.go(to, opts.note);
    task.state = to;
    task.updatedAt = Date.now();
    if (to === STATES.EXECUTING || to === STATES.ANALYZING || to === STATES.PLANNING) task.phase = to;
    if (to === STATES.COMPLETED || to === STATES.CANCELLED) task.phase = to.substring(0, to.length - 2); // 'complete', 'cancelled'
    if (to === STATES.FAILED) task.phase = 'failed';
    if (opts.emit) {
      this._bus.emit(opts.emit.type, { taskId: id, agentId: task.agentId }, opts.emit.payload);
    }
    if (this._store) this._store.set(`task:${id}`, snapshot(task)).catch(() => {});
    return task;
  }

  queue(id) {
    return this._transition(id, STATES.QUEUED, { note: 'queued', emit: { type: TYPES.TASK_QUEUED } });
  }

  start(id) {
    const task = this._transition(id, STATES.ANALYZING, {
      note: 'started',
      emit: { type: TYPES.TASK_STARTED, payload: { startedAt: Date.now() } },
    });
    task.startedAt = Date.now();
    return task;
  }

  pause(id) {
    const task = this._transition(id, STATES.PAUSED, { note: 'paused', emit: { type: TYPES.TASK_PAUSED } });
    task.pausedAt = Date.now();
    return task;
  }

  resume(id) {
    return this._transition(id, STATES.EXECUTING, { note: 'resumed', emit: { type: TYPES.TASK_RESUMED } });
  }

  cancel(id, reason = 'user requested') {
    const task = this._tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    task.cancellation = { requestedAt: Date.now(), reason };
    // Cancellation is valid from nearly anywhere; go via CANCELLING.
    if (task.state === STATES.CANCELLED || task.state === STATES.COMPLETED) return task;
    const machine = this._machines.get(id);
    if (machine.can(STATES.CANCELLING)) {
      this._transition(id, STATES.CANCELLING, { note: `cancel: ${reason}` });
      this._transition(id, STATES.CANCELLED, {
        note: 'cancelled',
        emit: { type: TYPES.TASK_CANCELLED, payload: { reason } },
      });
    }
    return this._tasks.get(id);
  }

  // The executor/runtime calls this when a task has not yet completed moving on
  // its own. Idempotent: repeated calls only emit once.
  fail(id, error) {
    const task = this._tasks.get(id);
    if (task.state === STATES.FAILED || isTerminal(task.state)) return task;
    this._transition(id, STATES.FAILED, {
      note: 'failed',
      emit: { type: TYPES.TASK_FAILED, payload: { error: error && error.message } },
    });
    task.outcome = { status: 'failed', error: error.message, at: Date.now() };
    return task;
  }

  // The runtime calls this when the last step passes.
  complete(id, summaryPayload) {
    const task = this._transition(id, STATES.COMPLETED, {
      note: 'complete',
      emit: { type: TYPES.TASK_COMPLETED, payload: summaryPayload },
    });
    if (!task.outcome) task.outcome = { status: 'completed', at: Date.now() };
    if (summaryPayload) task.outcome.summary = summaryPayload;
    task.completedAt = Date.now();
    return task;
  }

  // Exposes task history as an ordered trace for the UI / audit.
  history(id) {
    const task = this._tasks.get(id);
    if (!task) return null;
    return {
      task: summarize(task),
      trace: task.trace,
      stepLog: task.stepLog,
      outcome: task.outcome,
    };
  }

  _onChange(task) {
    return ({ from, to, at }) => {
      task.trace = task.trace || [];
      task.trace.push({ type: 'task.state', from, to, at });
      if (task.trace.length > 500) task.trace.splice(0, task.trace.length - 500);
    };
  }
}

function isTerminal(s) {
  return s === STATES.COMPLETED || s === STATES.CANCELLED || s === STATES.FAILED;
}

module.exports = { TaskManager };