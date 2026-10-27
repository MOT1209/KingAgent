// Every number that bounds how long or how deep orchestration may go, in one
// frozen place.
//
// There are two orchestrators (the task one and the harness one) and two
// coordinators, written at different times; each carried its own copy of the
// depth, timeout and poll constants, and the copies disagreed (depth 3/3/4,
// task timeout 15/10/5 minutes, poll 40/25/50 ms) with nothing saying whether
// the disagreement was a decision. This file is that statement. The values
// below are exactly what each module used before, so importing them changes no
// behaviour; where two differ on purpose, the reason is written next to them,
// and tests/orchestration-limits.test.mjs fails if a module stops reading from
// here or if a value drifts from what is recorded.

const MIN = 60 * 1000;

const ORCHESTRATION_LIMITS = Object.freeze({
  // Levels of delegation. The task orchestrator and agents/coordinator count
  // from 0 and refuse at >= 3 (three levels). The harness coordinator counts
  // from 1 and refuses at > 4 (four levels): an external harness session is
  // itself one level of nesting the internal path does not have.
  delegationDepth: Object.freeze({ task: 3, coordinator: 3, harness: 4 }),
  // How long one task may run before the orchestrator gives up on it.
  taskTimeoutMs: Object.freeze({ task: 15 * MIN, harness: 10 * MIN }),
  // How long one delegated child may run.
  delegationTimeoutMs: Object.freeze({ task: 5 * MIN, coordinator: 5 * MIN }),
  // How many children one delegation may fan out to (coordinator only; the
  // others do not fan out).
  maxFanout: 6,
  // How often a waiting loop re-checks its task. A smaller number is a faster
  // answer for a CPU cost; the harness path polls a local sandbox, hence faster.
  pollMs: Object.freeze({ task: 40, coordinator: 50, harness: 25 }),
});

module.exports = { ORCHESTRATION_LIMITS };
