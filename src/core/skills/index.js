// The skill platform's public surface, and the factory that wires it.
//
// One import point for everything Phase 6 adds, for the same reason
// core/harness/index.js exists: the internal split between registry, discovery,
// loader, runtime, security, lifecycle, evaluation, sources and cache is an
// implementation detail, and a caller reaching into those paths directly turns
// every future refactor into a breaking change.
//
// `createSkillPlatform` takes the subsystems that already exist — the policy
// engine, the approval manager, the sandbox manager, the tool manager, memory —
// and hands them to the skill layer rather than growing parallel versions of
// them. If a dependency is absent the layer degrades honestly: no policy means
// skills cannot be granted permissions, no sandbox means a skill that requires
// one refuses to run, no tool manager means a skill has no tool surface. In no
// case does an absent control become an open one.

const { SkillRegistry, SkillRegistryError } = require('./registry/SkillRegistry');
const { SkillRecord } = require('./registry/SkillMetadata');
const SkillVersion = require('./registry/SkillVersion');
const SkillSourceSpec = require('./registry/SkillSource');
const { validateManifest, manifestView } = require('./schemas/SkillManifest');
const SkillPermissionSchema = require('./schemas/SkillPermissionSchema');
const SkillResultSchema = require('./schemas/SkillResultSchema');
const taxonomy = require('./taxonomy');

const SkillDiscovery = require('./discovery/SkillDiscovery');
const SkillRanking = require('./discovery/SkillRanking');
const SkillSearch = require('./discovery/SkillSearch');
const SkillRecommendation = require('./discovery/SkillRecommendation');

const { SkillLoader, SkillLoadError } = require('./loader/SkillLoader');
const { SkillResolver } = require('./loader/SkillResolver');
const SkillDependencyResolver = require('./loader/SkillDependencyResolver');

const { SkillRuntime } = require('./runtime/SkillRuntime');
const { SkillExecutor } = require('./runtime/SkillExecutor');
const SkillContext = require('./runtime/SkillContext');
const SkillResult = require('./runtime/SkillResult');

const SkillValidator = require('./security/SkillValidator');
const SkillScanner = require('./security/SkillScanner');
const SkillTrust = require('./security/SkillTrust');
const SkillPermissions = require('./security/SkillPermissions');
const SkillSandbox = require('./security/SkillSandbox');

const { SkillInstaller, SkillInstallError } = require('./lifecycle/SkillInstaller');
const { SkillUpdater } = require('./lifecycle/SkillUpdater');
const { SkillRemover } = require('./lifecycle/SkillRemover');
const { SkillEnabler, SkillStateError } = require('./lifecycle/SkillEnabler');
const states = require('./lifecycle/states');

const { SkillEvaluator } = require('./evaluation/SkillEvaluator');
const SkillQualityScore = require('./evaluation/SkillQualityScore');
const SkillBenchmarks = require('./evaluation/SkillBenchmarks');

const { SkillCache, digestOf, digestOfSkill, DIGEST_SCHEME } = require('./cache/SkillCache');
const { BuiltinSkillSource } = require('./sources/BuiltinSkillSource');
const { LocalSkillSource } = require('./sources/LocalSkillSource');
const { GitHubSkillSource } = require('./sources/GitHubSkillSource');
const { SkillsShSource } = require('./sources/SkillsShSource');
const { BUILTIN_SKILLS } = require('./builtin/catalog');

function currentPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

function createSkillPlatform({
  bus = null,
  logger = null,
  collection = null,
  policy = null,
  approvals = null,
  sandboxes = null,
  tools = null,
  memory = null,
  platform = currentPlatform(),
  // Host IO. Every remote source needs an injected HTTP client; without one it
  // reports that it is not wired rather than returning an empty result.
  io = {},           // { fs, skillsDir, http, githubAuthorize, skillsShAuthorize }
  sources: sourceOverrides = {},
  runner = null,     // the host's agent loop; without it a run reports `prepared`
  maxSkills = 8,
  skillsShOptions = {},
  githubOptions = {},
} = {}) {
  const registry = new SkillRegistry({ bus, logger: child(logger, 'skills'), collection, platform });
  const cache = new SkillCache({ logger: child(logger, 'skills.cache') });

  const sources = {
    builtin: sourceOverrides.builtin || new BuiltinSkillSource(),
    ...(io.fs && io.skillsDir
      ? { local: sourceOverrides.local || new LocalSkillSource({ fs: io.fs, directory: io.skillsDir, logger: child(logger, 'skills.local') }) }
      : {}),
    github: sourceOverrides.github || new GitHubSkillSource({
      http: io.http || null,
      authorize: io.githubAuthorize || null,
      logger: child(logger, 'skills.github'),
      ...githubOptions,
    }),
    'skills.sh': sourceOverrides['skills.sh'] || new SkillsShSource({
      http: io.http || null,
      authorize: io.skillsShAuthorize || null,
      logger: child(logger, 'skills.sh'),
      ...skillsShOptions,
    }),
  };

  const loader = new SkillLoader({ registry, sources, cache, bus, logger: child(logger, 'skills.loader') });
  const resolver = new SkillResolver({ registry, sources: Object.values(sources), platform, logger: child(logger, 'skills.resolver') });
  const enabler = new SkillEnabler({ registry, bus, logger: child(logger, 'skills.lifecycle'), policy });
  const installer = new SkillInstaller({
    registry, sources, policy, approvals, cache, bus, logger: child(logger, 'skills.install'), platform, memory,
  });
  const updater = new SkillUpdater({ registry, installer, sources, cache, bus, logger: child(logger, 'skills.update') });
  const remover = new SkillRemover({ registry, cache, bus, logger: child(logger, 'skills.remove'), memory });
  const evaluator = new SkillEvaluator({ registry, enabler, memory, bus, logger: child(logger, 'skills.eval') });
  const executor = new SkillExecutor({ registry, tools, policy, approvals, sandboxes, bus, logger: child(logger, 'skills.exec'), runner });
  const runtime = new SkillRuntime({ registry, loader, executor, evaluator, sandboxes, bus, logger: child(logger, 'skills.runtime'), platform, maxSkills });

  return {
    registry,
    cache,
    sources,
    loader,
    resolver,
    installer,
    updater,
    remover,
    enabler,
    evaluator,
    executor,
    runtime,
    platform,

    // --- convenience surface the IPC layer and the CLI both use -------------

    // Restore persisted skills, then make sure the built-in catalogue is
    // present. Built-ins are re-validated on every boot rather than trusted
    // from the store: a tampered store should not be able to hand the platform
    // a "built-in" skill that never shipped.
    async bootstrap({ actor = 'system', installBuiltins = true } = {}) {
      const restored = await registry.load();
      const builtins = installBuiltins ? await installer.installBuiltins({ actor }) : { installed: [], skipped: [], failed: [] };
      return { restored, builtins, skills: registry.count() };
    },

    search(query, opts = {}) {
      return SkillSearch.search({ registry, sources: Object.values(sources), query, ...opts });
    },

    discover(request) {
      return SkillDiscovery.discover({ request, registry, platform });
    },

    recommend(request, opts = {}) {
      return SkillRecommendation.recommend({ request, registry, platform, maxSkills, ...opts });
    },

    plan(request, opts = {}) {
      return runtime.plan({ request, ...opts });
    },

    run(opts) {
      return runtime.run(opts);
    },

    benchmark(opts = {}) {
      return SkillBenchmarks.run({ registry, platform, ...opts });
    },

    // Everything the skills pane needs in one call.
    controlView({ request = null } = {}) {
      return {
        ...runtime.controlView({ request }),
        report: evaluator.report(),
        concerns: evaluator.concerns(),
        sources: Object.entries(sources).map(([id, source]) => ({
          id,
          type: source.type,
          wired: source.wired === undefined ? true : source.wired,
          contract: typeof source.contract === 'function' ? source.contract() : null,
        })),
        platform,
      };
    },
  };
}

function child(logger, scope) {
  return logger && typeof logger.child === 'function' ? logger.child(scope) : logger;
}

module.exports = {
  // factory
  createSkillPlatform,
  currentPlatform,
  // registry
  SkillRegistry,
  SkillRegistryError,
  SkillRecord,
  SkillVersion,
  SkillSourceSpec,
  // schemas
  validateManifest,
  manifestView,
  SkillPermissionSchema,
  SkillResultSchema,
  taxonomy,
  // discovery
  SkillDiscovery,
  SkillRanking,
  SkillSearch,
  SkillRecommendation,
  // loader
  SkillLoader,
  SkillLoadError,
  SkillResolver,
  SkillDependencyResolver,
  // runtime
  SkillRuntime,
  SkillExecutor,
  SkillContext,
  SkillResult,
  // security
  SkillValidator,
  SkillScanner,
  SkillTrust,
  SkillPermissions,
  SkillSandbox,
  // lifecycle
  SkillInstaller,
  SkillInstallError,
  SkillUpdater,
  SkillRemover,
  SkillEnabler,
  SkillStateError,
  states,
  // evaluation
  SkillEvaluator,
  SkillQualityScore,
  SkillBenchmarks,
  // cache + sources
  SkillCache,
  digestOf,
  digestOfSkill,
  DIGEST_SCHEME,
  BuiltinSkillSource,
  LocalSkillSource,
  GitHubSkillSource,
  SkillsShSource,
  BUILTIN_SKILLS,
};
