// The session layer's public surface.

const {
  SESSION_STATES,
  SessionLifecycle,
  canTransition,
  assertTransition,
  isTerminal,
  isActive,
} = require('./lifecycle');
const {
  createSession,
  snapshot,
  summarize,
  attachTask,
  attachArtifact,
  attachSandbox,
  attachHarness,
  attachAgent,
} = require('./session');
const { SessionManager } = require('./manager');

module.exports = {
  SESSION_STATES,
  SessionLifecycle,
  canTransition,
  assertTransition,
  isTerminal,
  isActive,
  createSession,
  snapshot,
  summarize,
  attachTask,
  attachArtifact,
  attachSandbox,
  attachHarness,
  attachAgent,
  SessionManager,
};
