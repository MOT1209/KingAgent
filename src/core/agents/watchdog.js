// The runaway watchdog.
//
// A governor can *answer* "is this agent over its limits?" — but answering is
// not stopping. An agent that stops asking anything (a wedged call, a task that
// quietly stopped reporting) never triggers a check, so it stays live forever
// and keeps holding a slot against `maxConcurrentAgents` while `maxRuntimeMs`
// goes on being a number in a config file. This module is the missing verb: it
// sweeps, and for every breach it actually stops the work.
//
// A stop does four things, in this order, because a later step must not be able
// to lose an earlier one:
//
//   1. cancel the agent's delegations (the work it started stops),
//   2. release its governor slot, so a healthy agent can take it,
//   3. announce AGENT_STOPPED on the bus — with the `runId` ref, so a run's
//      timeline picks the stop up without this module knowing Runs exist,
//   4. keep the stop in `lastStopped` for whoever asks afterwards.
//
// Deliberately host-driven. `tick()` is synchronous, takes no arguments and is
// what a test drives; `start()` only adds the timer a real app wants, and that
// timer is unref'd so a watchdog can never be the reason a process stays alive.

const { TYPES } = require('../events/event-bus');

const DEFAULTS = Object.freeze({
  intervalMs: 30_000,
  // A sweep that suddenly reports hundreds of breaches is itself a symptom.
  // Bounding the stops per tick keeps one pathological sweep from turning into
  // hundreds of cancellations in a single synchronous pass; the next tick
  // picks up whatever is left, so nothing is silently dropped.
  maxStopsPerTick: 32,
});

// Codes that mean "this agent spent too much", as opposed to "this agent did
// something wrong". Both stop the agent; only the reason differs, and a host
// may want to show them differently.
const BUDGET_CODES = Object.freeze([
  'AGENT_RUNTIME_EXCEEDED',
  'AGENT_TOKEN_BUDGET_EXCEEDED',
  'AGENT_COST_BUDGET_EXCEEDED',
  'AGENT_TASK_LIMIT_EXCEEDED',
  'RUN_TOKEN_BUDGET_EXCEEDED',
  'RUN_COST_BUDGET_EXCEEDED',
]);

function createAgentWatchdog({
  governor,
  coordinator = null,
  bus = null,
  logger = null,
  clock = null,
  intervalMs = null,
  maxStopsPerTick = null,
} = {}) {
  if (!governor || typeof governor.sweep !== 'function') {
    throw new Error('createAgentWatchdog requires an AgentGovernor');
  }
  const opts = {
    intervalMs: intervalMs === null ? DEFAULTS.intervalMs : intervalMs,
    maxStopsPerTick: maxStopsPerTick === null ? DEFAULTS.maxStopsPerTick : maxStopsPerTick,
  };
  const now = clock || (() => Date.now());
  let timer = null;
  let sweeps = 0;
  let stopCount = 0;
  let lastSweepAt = null;
  let lastStopped = [];

  // One breach, one stop. Returns what actually happened rather than a boolean,
  // so a caller (and a test) can tell "stopped and cancelled two delegations"
  // from "was already gone".
  function stopAgent({ agentId, code, reason }) {
    // Read the record *before* releasing it: `runId` comes from there, and the
    // bus ref is the only thing that gets the stop onto the run's timeline.
    const record = governor.get(agentId);
    const runId = record ? record.runId : null;

    let cancelledDelegations = 0;
    if (coordinator && typeof coordinator.cancelDelegations === 'function') {
      try {
        cancelledDelegations = coordinator.cancelDelegations({ agentId }) || 0;
      } catch (err) {
        // A stop must not fail because the cancellation did. The slot is still
        // released below, which is the part that protects everything else.
        if (logger) logger.warn('watchdog could not cancel delegations', { agentId, error: err.message });
      }
    }

    const released = governor.release(agentId);

    if (bus) {
      bus.emit(TYPES.AGENT_STOPPED, {
        agentId,
        agentDefinitionId: agentId,
        runId,
      }, {
        code,
        reason,
        kind: BUDGET_CODES.includes(code) ? 'budget' : 'limit',
        parentAgentId: record ? record.parentAgentId : null,
        role: record ? record.role : null,
        cancelledDelegations,
      });
    }
    if (logger) logger.warn('watchdog stopped an agent', { agentId, code, reason, cancelledDelegations });

    return { agentId, code, reason, runId, released, cancelledDelegations, stoppedAt: now() };
  }

  // The whole watchdog in one call: sweep, then stop what the sweep found.
  function tick() {
    sweeps += 1;
    lastSweepAt = now();
    const breaches = governor.sweep(lastSweepAt) || [];
    const bounded = breaches.slice(0, Math.max(0, opts.maxStopsPerTick));
    lastStopped = bounded.map(stopAgent);
    stopCount += lastStopped.length;
    return {
      checked: governor.liveCount,
      breached: breaches.length,
      stopped: lastStopped,
      // True when the cap hid breaches this pass. A host that sees this should
      // tick again rather than wait a whole interval.
      deferred: Math.max(0, breaches.length - bounded.length),
    };
  }

  function start() {
    if (timer) return false;
    timer = setInterval(() => {
      try {
        tick();
      } catch (err) {
        if (logger) logger.error('watchdog tick failed', { error: err.message });
      }
    }, opts.intervalMs);
    // Never a reason for the process to stay up — the watchdog watches agents,
    // it is not itself work.
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop() {
    if (!timer) return false;
    clearInterval(timer);
    timer = null;
    return true;
  }

  return {
    get running() { return timer !== null; },
    get intervalMs() { return opts.intervalMs; },
    get stats() { return { sweeps, stops: stopCount, lastSweepAt }; },
    get lastStopped() { return lastStopped.map((s) => ({ ...s })); },
    tick,
    start,
    stop,
  };
}

module.exports = { createAgentWatchdog, DEFAULTS, BUDGET_CODES };
