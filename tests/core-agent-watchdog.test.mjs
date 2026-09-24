// The watchdog is the verb behind the governor's numbers. A sweep that finds a
// runaway agent proves nothing unless the agent is actually stopped — released,
// its delegations cancelled, and the stop announced with the `runId` that puts
// it on the run's timeline. These tests hold that, plus the two things a
// watchdog must never do: keep a process alive, or let one bad sweep take down
// the tick loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentGovernor } = require('../src/core/agents/governor.js');
const { createAgentWatchdog, DEFAULTS, BUDGET_CODES } = require('../src/core/agents/watchdog.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');

function fixture({ config = {}, clock = () => 0 } = {}) {
  const bus = new EventBus();
  const governor = new AgentGovernor({ config, clock });
  const cancelled = [];
  const coordinator = {
    cancelDelegations({ agentId = null } = {}) {
      cancelled.push(agentId);
      return agentId === 'quiet' ? 2 : 0;
    },
  };
  const watchdog = createAgentWatchdog({ governor, coordinator, bus, clock });
  return { bus, governor, coordinator, cancelled, watchdog };
}

// --- stopping is the point --------------------------------------------------------

test('watchdog: an agent past its runtime limit is stopped, not merely reported', () => {
  let now = 1_000;
  const { governor, cancelled, watchdog } = fixture({ config: { maxRuntimeMs: 500 }, clock: () => now });
  governor.register({ agentId: 'quiet', role: 'researcher', runId: 'run-7' });
  now = 1_000 + 900; // 900ms of runtime against a 500ms limit

  const result = watchdog.tick();

  assert.equal(result.breached, 1);
  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].agentId, 'quiet');
  assert.equal(result.stopped[0].code, 'AGENT_RUNTIME_EXCEEDED');
  assert.equal(result.stopped[0].runId, 'run-7', 'the stop knows which run it belongs to');
  assert.equal(governor.get('quiet'), null, 'the agent no longer holds a slot');
  assert.deepEqual(cancelled, ['quiet'], 'its delegations were cancelled');
  assert.equal(result.stopped[0].cancelledDelegations, 2);
});

test('watchdog: a token breach stops the agent and counts as a budget stop', () => {
  const bus = new EventBus();
  const governor = new AgentGovernor({ config: { maxTokenBudget: 100 } });
  const watchdog = createAgentWatchdog({ governor, bus });
  const seen = [];
  bus.on(TYPES.AGENT_STOPPED, (ev) => seen.push(ev));

  governor.register({ agentId: 'spender', role: 'coder', runId: 'run-1' });
  governor.noteUsage('spender', { tokens: 140 });

  const result = watchdog.tick();

  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].code, 'AGENT_TOKEN_BUDGET_EXCEEDED');
  assert.equal(seen.length, 1, 'the stop is announced on the bus');
  assert.equal(seen[0].payload.kind, 'budget');
  assert.equal(seen[0].runId, 'run-1', 'the runId ref is what puts it on the run timeline');
  assert.match(seen[0].payload.reason, /140/);
  assert.ok(BUDGET_CODES.includes(seen[0].payload.code));
});

test('watchdog: a healthy agent is left alone', () => {
  const { governor, cancelled, watchdog } = fixture({ config: { maxRuntimeMs: 10_000 } });
  governor.register({ agentId: 'fine', role: 'tester' });

  const result = watchdog.tick();

  assert.deepEqual(result.stopped, []);
  assert.equal(result.checked, 1);
  assert.deepEqual(cancelled, []);
  assert.ok(governor.get('fine'), 'still live');
});

// --- the parts that must not fail --------------------------------------------------

test('watchdog: one sweep cannot lose the stops after the cap', () => {
  let now = 1_000;
  const clock = () => now;
  const governor = new AgentGovernor({ config: { maxRuntimeMs: 0 }, clock });
  const watchdog = createAgentWatchdog({ governor, maxStopsPerTick: 2, clock });
  for (const id of ['a', 'b', 'c', 'd']) governor.register({ agentId: id, role: id });
  now = 1_001; // 1ms of runtime each, against a zero-millisecond limit

  const first = watchdog.tick();
  assert.equal(first.breached, 4);
  assert.equal(first.stopped.length, 2);
  assert.equal(first.deferred, 2, 'the rest are reported, not silently dropped');

  const second = watchdog.tick();
  assert.equal(second.stopped.length, 2);
  assert.equal(second.deferred, 0);
  assert.equal(governor.liveCount, 0);
});

test('watchdog: a coordinator that throws does not break the stop', () => {
  let now = 5_000;
  const clock = () => now;
  const bus = new EventBus();
  const governor = new AgentGovernor({ config: { maxRuntimeMs: 100 }, clock });
  const watchdog = createAgentWatchdog({
    governor,
    bus,
    clock,
    coordinator: { cancelDelegations() { throw new Error('coordinator is gone'); } },
  });
  const seen = [];
  bus.on(TYPES.AGENT_STOPPED, (ev) => seen.push(ev));
  governor.register({ agentId: 'x', role: 'x' });
  now = 5_500;

  const result = watchdog.tick();

  assert.equal(result.stopped.length, 1);
  assert.equal(result.stopped[0].cancelledDelegations, 0);
  assert.equal(governor.get('x'), null, 'the slot is still released');
  assert.equal(seen.length, 1, 'and the stop is still announced');
});

test('watchdog: the timer is unref’d and start/stop are idempotent', () => {
  const { watchdog } = fixture();
  assert.equal(watchdog.running, false);
  assert.equal(watchdog.stop(), false, 'stopping what never started is a no-op');

  assert.equal(watchdog.start(), true);
  assert.equal(watchdog.running, true);
  assert.equal(watchdog.start(), false, 'a second start does not stack timers');

  assert.equal(watchdog.stop(), true);
  assert.equal(watchdog.running, false);
  assert.equal(DEFAULTS.intervalMs, 30_000, 'a watchdog polls far more slowly than it can act');
});

test('watchdog: requires a governor worth watching', () => {
  assert.throws(() => createAgentWatchdog({}), /requires an AgentGovernor/);
});
