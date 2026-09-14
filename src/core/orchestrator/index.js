// Barrel for the orchestration layer.
//
// The Orchestrator sits *above* the AgentRuntime, never in place of it: it
// routes a request into a shape, builds the workspace/context/trace that shape
// needs, and calls the existing runtime, coordinator or workflow engine.

const { Orchestrator } = require('./orchestrator');
const { Router, detectCapabilities } = require('./router');
const { Scheduler, PRIORITY, JOB_STATUS } = require('./scheduler');
const policies = require('./policies');
const delegation = require('./delegation');

module.exports = {
  Orchestrator,
  Router,
  Scheduler,
  PRIORITY,
  JOB_STATUS,
  EXECUTION_MODES: policies.EXECUTION_MODES,
  DEFAULT_POLICIES: policies.DEFAULT_POLICIES,
  createPolicies: policies.createPolicies,
  detectCapabilities,
  planDelegations: delegation.planDelegations,
  readyDelegations: delegation.readyDelegations,
  auditDelegations: delegation.auditDelegations,
};
