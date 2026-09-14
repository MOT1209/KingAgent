// The orchestration layer's public surface.

const {
  ROUTING_STRATEGIES,
  AGENT_CAPABILITY_MAP,
  TASK_TYPE_HINTS,
  classifyTask,
  requiredTagsFor,
  AgentRouter,
} = require('./router');
const { MESSAGE_TYPES, createMessage, validateMessage, replyTo, createMailbox } = require('./messages');
const {
  DELEGATION_STATUS,
  createDelegation,
  validateDelegation,
  containment,
  delegationView,
} = require('./delegation');
const { HANDOFF_FIELDS, createHandoff, validateHandoff, summarizeHandoff, readyToAccept } = require('./handoff');
const { createFileLockManager, normalizeKey } = require('./locks');
const {
  createAgentCoordinator,
  ROLES,
  TEAM_TEMPLATES,
  MAX_DEPTH,
  DelegationDeniedError,
} = require('./coordinator');
const { Orchestrator, OrchestratorError } = require('./orchestrator');

module.exports = {
  // routing
  ROUTING_STRATEGIES,
  AGENT_CAPABILITY_MAP,
  TASK_TYPE_HINTS,
  classifyTask,
  requiredTagsFor,
  AgentRouter,
  // protocol
  MESSAGE_TYPES,
  createMessage,
  validateMessage,
  replyTo,
  createMailbox,
  // delegation
  DELEGATION_STATUS,
  createDelegation,
  validateDelegation,
  containment,
  delegationView,
  // handoff
  HANDOFF_FIELDS,
  createHandoff,
  validateHandoff,
  summarizeHandoff,
  readyToAccept,
  // parallelism
  createFileLockManager,
  normalizeKey,
  // coordination
  createAgentCoordinator,
  ROLES,
  TEAM_TEMPLATES,
  MAX_DEPTH,
  DelegationDeniedError,
  // top level
  Orchestrator,
  OrchestratorError,
};
