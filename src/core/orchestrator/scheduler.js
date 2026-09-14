// Scheduler: bounded concurrency, priorities and cancellation.
//
// Without one, "run this" means "start this now", and a user who queues five
// tasks gets five agents competing for the same workspace, the same shell and
// the same model quota. The scheduler makes concurrency a number rather than an
// accident.
//
// It is deliberately small: a priority queue, a running set, and a cancel that
// works on both. No retry logic (recovery owns that), no dependency graph
// (workflows own that).

const { newId } = require('../workspace/identity');

const PRIORITY = Object.freeze({ HIGH: 0, NORMAL: 1, LOW: 2 });

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

class Scheduler {
  constructor({ maxConcurrent = 3, logger = null } = {}) {
    this._max = Math.max(1, maxConcurrent);
    this._logger = logger;
    this._queue = [];             // { job } waiting, kept sorted
    this._running = new Map();    // jobId -> job
    this._jobs = new Map();       // jobId -> job (all, bounded by prune)
    this._draining = false;
  }

  get capacity() { return this._max; }
  get runningCount() { return this._running.size; }
  get queuedCount() { return this._queue.length; }

  // `run` is an async function receiving { signal, job }. The returned promise
  // settles when the job does, so a caller can await one job without knowing
  // whether it started immediately or waited.
  submit({ id = null, run, priority = PRIORITY.NORMAL, taskId = null, label = '', signal = null } = {}) {
    if (typeof run !== 'function') throw new TypeError('scheduler.submit requires a run function');
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const job = {
      id: id || newId('job'),
      taskId,
      label,
      priority,
      status: JOB_STATUS.QUEUED,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: null,
      _run: run,
      _controller: controller,
    };
    job.result = new Promise((resolve, reject) => { job._resolve = resolve; job._reject = reject; });

    this._jobs.set(job.id, job);
    this._queue.push(job);
    // Priority first, then arrival: a high-priority job never starves a queue,
    // and equal priorities stay FIFO so ordering is predictable.
    this._queue.sort((a, b) => (a.priority - b.priority) || (a.queuedAt - b.queuedAt));
    this._drain();
    return job;
  }

  cancel(jobId, reason = 'cancelled') {
    const job = this._jobs.get(jobId);
    if (!job) return false;
    if (job.status === JOB_STATUS.QUEUED) {
      this._queue = this._queue.filter((j) => j.id !== jobId);
      this._finish(job, JOB_STATUS.CANCELLED, new Error(reason));
      return true;
    }
    if (job.status === JOB_STATUS.RUNNING) {
      job._controller.abort();
      return true;
    }
    return false;
  }

  cancelTask(taskId, reason = 'cancelled') {
    let n = 0;
    for (const job of this._jobs.values()) {
      if (job.taskId === taskId && (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.RUNNING)) {
        if (this.cancel(job.id, reason)) n += 1;
      }
    }
    return n;
  }

  cancelAll(reason = 'shutting down') {
    let n = 0;
    for (const job of [...this._jobs.values()]) {
      if (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.RUNNING) {
        if (this.cancel(job.id, reason)) n += 1;
      }
    }
    return n;
  }

  get(jobId) {
    const job = this._jobs.get(jobId);
    return job ? this._view(job) : null;
  }

  list({ status = null, taskId = null } = {}) {
    return [...this._jobs.values()]
      .filter((j) => (!status || j.status === status) && (!taskId || j.taskId === taskId))
      .sort((a, b) => b.queuedAt - a.queuedAt)
      .map((j) => this._view(j));
  }

  stats() {
    const counts = {};
    for (const j of this._jobs.values()) counts[j.status] = (counts[j.status] || 0) + 1;
    return { capacity: this._max, running: this._running.size, queued: this._queue.length, counts };
  }

  // Drop finished jobs so a long session does not accumulate them.
  prune({ keep = 200 } = {}) {
    const finished = [...this._jobs.values()]
      .filter((j) => [JOB_STATUS.COMPLETED, JOB_STATUS.FAILED, JOB_STATUS.CANCELLED].includes(j.status))
      .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    const drop = Math.max(0, finished.length - keep);
    for (let i = 0; i < drop; i += 1) this._jobs.delete(finished[i].id);
    return drop;
  }

  _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._running.size < this._max && this._queue.length > 0) {
        const job = this._queue.shift();
        this._start(job);
      }
    } finally {
      this._draining = false;
    }
  }

  _start(job) {
    if (job._controller.signal.aborted) {
      this._finish(job, JOB_STATUS.CANCELLED, new Error('cancelled before start'));
      return;
    }
    job.status = JOB_STATUS.RUNNING;
    job.startedAt = Date.now();
    this._running.set(job.id, job);

    Promise.resolve()
      .then(() => job._run({ signal: job._controller.signal, job: this._view(job) }))
      .then(
        (value) => {
          this._running.delete(job.id);
          // Cancellation is cooperative: a run function that ignores its signal
          // can still resolve. Reporting that as "completed" would make
          // `cancel()` a lie, so an aborted job settles as cancelled whatever
          // its body returned.
          if (job._controller.signal.aborted) this._finish(job, JOB_STATUS.CANCELLED, new Error('cancelled'));
          else this._finish(job, JOB_STATUS.COMPLETED, null, value);
        },
        (err) => {
          this._running.delete(job.id);
          const cancelled = job._controller.signal.aborted;
          this._finish(job, cancelled ? JOB_STATUS.CANCELLED : JOB_STATUS.FAILED, err);
        },
      )
      .finally(() => this._drain());
  }

  _finish(job, status, error, value) {
    if (job.finishedAt) return;
    job.status = status;
    job.finishedAt = Date.now();
    job.error = error ? error.message : null;
    if (status === JOB_STATUS.COMPLETED) job._resolve(value);
    // A cancelled or failed job settles as a *value*, not a rejection: several
    // callers await a whole batch, and one cancellation should not turn into an
    // unhandled rejection that takes the batch with it.
    else job._resolve({ ok: false, status, error: job.error });
  }

  _view(job) {
    return {
      id: job.id, taskId: job.taskId, label: job.label, priority: job.priority,
      status: job.status, queuedAt: job.queuedAt, startedAt: job.startedAt,
      finishedAt: job.finishedAt, error: job.error, result: job.result,
    };
  }
}

module.exports = { Scheduler, PRIORITY, JOB_STATUS };
