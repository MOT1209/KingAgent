// Barrel for the workspace subsystem: identity, environment, file tracking,
// the workspace itself and its manager.

const { AgentWorkspace, STATUS, DEFAULT_POLICY, derivePolicy } = require('./workspace');
const { WorkspaceManager } = require('./manager');
const { createEnvironment, looksSecret } = require('./environment');
const { createFileContext, OPERATIONS } = require('./file-context');
const identity = require('./identity');

module.exports = {
  AgentWorkspace,
  WorkspaceManager,
  STATUS,
  DEFAULT_POLICY,
  derivePolicy,
  createEnvironment,
  looksSecret,
  createFileContext,
  FILE_OPERATIONS: OPERATIONS,
  ...identity,
};
