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
    this._evict();
    this._bus.emit(TYPES.TASK_CREATED, { taskId: task.id, agentId: task.agentId }, { request: task.request, mode: task.mode });
    return task;
  }

  // A finished task carries its whole trace (up to 500 entries) and nothing
  // ever removed it, so a long-lived host grew with every task it ever ran. Past
  // MAX_FINISHED, the oldest finished ones go first, in creation order; a task
  // that is still doing anything is never evicted, so there is no cap on live
  // work, only on history.
  _evict() {
    let over = this._tasks.size - TaskManager.MAX_TASKS;
    if (over <= 0) return;
    for (const [id, task] of this._tasks) {
      if (over <= 0) break;
      const machine = this._machines.get(id);
      const done = machine && (machine.terminal || task.state === STATES.FAILED);
      if (!done) continue;
      this._tasks.delete(id); this._machines.delete(id); over--;
    }
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

  // Cancellation is cooperative. With `settle: false` (the runtime passes it
  // while a run loop is still alive) the task only moves to CANCELLING: the
  // loop has been told to stop but may still be inside a step, so it is not yet
  // "cancelled" and callers waiting on a terminal state keep waiting. The loop
  // then calls settleCancel() from its finally. With the default `settle: true`
  // (nothing is running) both transitions happen at once.
  cancel(id, reason = 'user requested', { settle = true } = {}) {
    const task = this._tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    if (task.state === STATES.CANCELLED || task.state === STATES.COMPLETED) return task;
    if (!task.cancellation || !task.cancellation.requestedAt) task.cancellation = { requestedAt: Date.now(), reason };
    // Cancellation is valid from nearly anywhere; go via CANCELLING.
    const machine = this._machines.get(id);
    if (task.state !== STATES.CANCELLING && machine.can(STATES.CANCELLING)) {
      this._transition(id, STATES.CANCELLING, { note: `cancel: ${reason}` });
    }
    if (settle) this.settleCancel(id);
    return this._tasks.get(id);
  }

  // CANCELLING -> CANCELLED, once nothing is running for the task any more.
  settleCancel(id) {
    const task = this._tasks.get(id);
    if (!task || task.state !== STATES.CANCELLING) return task || null;
    const reason = task.cancellation && task.cancellation.reason;
    this._transition(id, STATES.CANCELLED, {
      note: 'cancelled',
      emit: { type: TYPES.TASK_CANCELLED, payload: { reason } },
    });
    return task;
  }

  // The executor/runtime calls this when a task has not yet completed moving on
  // its own. Idempotent: repeated calls only emit once.
  fail(id, error) {
    const task = this._tasks.get(id);
    // A task being cancelled stays cancelled: the step that threw because it was
    // aborted must not turn the cancellation into a failure.
    if (task.state === STATES.FAILED || task.state === STATES.CANCELLING || isTerminal(task.state)) return task;
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

// History kept for finished tasks; see _evict.
TaskManager.MAX_TASKS = 500;

module.exports = { TaskManager };