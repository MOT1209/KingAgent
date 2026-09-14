// The harness layer's public surface.
//
// Import from here, not from the individual modules, so a future split of the
// adapter interface does not ripple through every caller.

const {
  CAPABILITY_TAGS,
  SUPPORT_FLAGS,
  normalizeCapabilities,
  deriveSupports,
  createCapabilities,
  satisfies,
} = require('./capabilities');
const { validateManifest, manifestView, HARNESS_TYPES, PLATFORMS } = require('./manifest');
const {
  createHarness,
  normalizeTransport,
  currentPlatform,
  HarnessError,
  HarnessCapabilityError,
  HarnessNotWiredError,
} = require('./adapter');
const { HarnessLifecycle, HARNESS_STATES, canTransition, isTerminal } = require('./lifecycle');
const { HarnessRegistry } = require('./registry');
const { HarnessManager } = require('./manager');
const { builtinHarnesses, TASK_CAPABILITY_HINTS } = require('./presets');

// Register the built-in manifests. Returns the registry so it can be chained.
// `options.perHarness` maps a harness id to `{ transport, probe, installer }`
// for the ones this host actually wired.
function registerBuiltinHarnesses(registry, options = {}) {
  const per = options.perHarness || {};
  for (const manifest of builtinHarnesses()) {
    const overrides = per[manifest.id] || {};
    registry.register(manifest, {
      transport: overrides.transport || options.transport || null,
      probe: overrides.probe || options.probe || null,
      installer: overrides.installer || options.installer || null,
    });
  }
  return registry;
}

module.exports = {
  // capabilities
  CAPABILITY_TAGS,
  SUPPORT_FLAGS,
  normalizeCapabilities,
  deriveSupports,
  createCapabilities,
  satisfies,
  // manifests
  validateManifest,
  manifestView,
  HARNESS_TYPES,
  PLATFORMS,
  builtinHarnesses,
  TASK_CAPABILITY_HINTS,
  // adapters
  createHarness,
  normalizeTransport,
  currentPlatform,
  // lifecycle
  HarnessLifecycle,
  HARNESS_STATES,
  canTransition,
  isTerminal,
  // registry + manager
  HarnessRegistry,
  HarnessManager,
  registerBuiltinHarnesses,
  // errors
  HarnessError,
  HarnessCapabilityError,
  HarnessNotWiredError,
};
