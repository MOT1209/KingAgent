// The sandbox layer's public surface.

const {
  FILESYSTEM_MODES,
  NETWORK_MODES,
  ENVIRONMENT_MODES,
  DEFAULT_LIMITS,
  DEFAULT_CEILING,
  validateLimits,
  normalizeLimits,
  clampLimits,
  describeClamp,
  labelFor,
} = require('./limits');
const {
  SANDBOX_FEATURES,
  BACKEND_FAMILIES,
  RECOMMENDED_BACKEND,
  platformName,
  describeBackend,
  listBackends,
  selectBackend,
  enforcementLabel,
} = require('./capabilities');
const { createAdvisoryBackend, createNullBackend, isBackend, SandboxBackendError } = require('./backend');
const { createSandbox, SandboxPathError, SandboxLimitError, SANDBOX_STATES } = require('./sandbox');
const { SandboxManager, SandboxDeniedError } = require('./manager');

module.exports = {
  // limits
  FILESYSTEM_MODES,
  NETWORK_MODES,
  ENVIRONMENT_MODES,
  DEFAULT_LIMITS,
  DEFAULT_CEILING,
  validateLimits,
  normalizeLimits,
  clampLimits,
  describeClamp,
  labelFor,
  // backends
  SANDBOX_FEATURES,
  BACKEND_FAMILIES,
  RECOMMENDED_BACKEND,
  platformName,
  describeBackend,
  listBackends,
  selectBackend,
  enforcementLabel,
  createAdvisoryBackend,
  createNullBackend,
  isBackend,
  // instances
  createSandbox,
  SANDBOX_STATES,
  // manager
  SandboxManager,
  // errors
  SandboxBackendError,
  SandboxPathError,
  SandboxLimitError,
  SandboxDeniedError,
};
