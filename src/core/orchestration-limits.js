'use strict';

// One home for the numeric limits the three orchestration layers enforce.
// The values are what each layer used before this file existed (the audit's
// C7: they had drifted apart as private literals); changing one is now a
// visible, reviewed edit here rather than a silent divergence.

const ORCHESTRATION_LIMITS = Object.freeze({
  // src/core/orchestrator
  orchestrator: Object.freeze({
    maxDelegationDepth: 3,
    maxDelegationsPerTask: 6,
    taskTimeoutMs: 15 * 60 * 1000,
    delegationTimeoutMs: 5 * 60 * 1000,
    pollMs: 40,
  }),
  // src/core/harness-orchestrator
  harness: Object.freeze({
    maxDelegationDepth: 4,
    taskTimeoutMs: 10 * 60 * 1000,
    pollMs: 25,
  }),
  // src/core/agents/coordinator.js
  agents: Object.freeze({
    maxDepth: 3,
    maxFanout: 6,
    delegationTimeoutMs: 5 * 60 * 1000,
    pollMs: 50,
  }),
});

module.exports = { ORCHESTRATION_LIMITS };
