// The research subsystem's public surface, and its one assembly function.
//
// `createResearchSubsystem` is where the layers meet the platform. Everything
// it needs is injected — the policy manager, the memory manager, the trace
// store, the artifact manager, the tool manager, the agent registry — and it
// returns the objects a host wires onto the platform. It constructs nothing the
// platform already owns.
//
// With no search providers configured it still builds, still registers, and
// still answers file-based questions; networked source types report themselves
// unavailable with a reason rather than silently returning nothing.

const { createSourceRegistry } = require('./sources/sourceRegistry');
const { createSearchProviderRegistry } = require('./sources/searchProvider');
const { SourceManager } = require('./sources/sourceManager');
const { createWebSource, createNewsSource } = require('./sources/webSource');
const { createAcademicSource } = require('./sources/academicSource');
const { createDiscussionSource } = require('./sources/discussionSource');
const { createGithubSource } = require('./sources/githubSource');
const { createDocumentationSource } = require('./sources/documentationSource');
const { createFileSource } = require('./sources/fileSource');
const { createMcpSource } = require('./sources/mcpSource');
const { createRetrievalCache } = require('./retrieval/retrievalCache');
const { ResearchEngine, ARTIFACT_INLINE_BUDGET, MAX_RETAINED_TASKS } = require('./engine');
const { ResearchMemory } = require('./memory/researchMemory');
const { Researcher } = require('./agents/researcher');
const { Verifier } = require('./agents/verifier');
const { registerResearchAgent, ResearchAgentHandler, RESEARCH_AGENT_ID, researchAgentDefinition } = require('./agents/researchAgent');
const { registerResearchTools, RESEARCH_SKILLS, listResearchSkills, resolveSkill, CAPABILITY } = require('./tools');
const { loadResearchPolicies, RESEARCH_ACTION } = require('./policies/researchPolicy');
const { RESEARCH_EVENTS, UI_EVENTS, STAGE_LABEL } = require('./traceEvents');
const { assertWithin } = require('../tools/path-guard');

// Defaults matching §50's configuration surface. A host overrides any of them;
// the names are the setting names, so `research.maxSources` maps to
// `config.maxSources` with no translation table.
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  defaultMode: 'standard',
  maxQueries: null,        // null = use the mode's own ceiling
  maxSources: null,
  maxConcurrency: null,
  timeoutMs: null,
  requireCitations: true,
  requireVerification: true,
  cacheEnabled: true,
  cacheMaxEntries: 500,
  allowedDomains: [],
  blockedDomains: [],
  allowNetworkedSources: false,
  maxRounds: 3,
});

function createResearchSubsystem({
  // platform pieces (all optional; the subsystem degrades rather than failing)
  policy = null,
  memory = null,            // MemoryManager
  traces = null,            // ExecutionTraceStore
  artifacts = null,         // ArtifactManager
  toolManager = null,
  agentRegistry = null,
  bus = null,
  logger = null,
  collections = null,
  provider = null,          // model provider, for optional refinement passes
  // research-specific io
  io = {},                  // { fs, root, searchProviders, mcp, extractText }
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // --- providers ------------------------------------------------------------
  const providers = createSearchProviderRegistry();
  for (const [id, adapter] of Object.entries(io.searchProviders || {})) {
    try {
      providers.register(id, adapter);
    } catch (err) {
      if (logger) logger.warn(`search provider "${id}" was not registered`, { reason: err.message });
    }
  }

  // --- source adapters ------------------------------------------------------
  const registry = createSourceRegistry();
  registry.register(createWebSource());
  registry.register(createNewsSource());
  registry.register(createAcademicSource());
  registry.register(createDiscussionSource());
  registry.register(createGithubSource());
  registry.register(createDocumentationSource());
  if (io.fs) {
    registry.register(createFileSource({
      fs: io.fs,
      root: io.root || null,
      extractText: io.extractText || null,
      // The same path guard the built-in fs tools use. Research does not get a
      // second, more permissive way out of the workspace.
      pathGuard: io.root ? assertWithin : null,
    }));
  }
  if (io.mcp) registry.register(createMcpSource({ client: io.mcp }));

  // --- cache ----------------------------------------------------------------
  const cache = createRetrievalCache({
    enabled: cfg.cacheEnabled,
    maxEntries: cfg.cacheMaxEntries,
    collection: collections && collections.researchCache ? collections.researchCache : null,
  });

  // --- policy ---------------------------------------------------------------
  if (policy) loadResearchPolicies(policy, { allowNetworkedSources: cfg.allowNetworkedSources });

  // --- the manager every retrieval goes through -----------------------------
  const sourceManager = new SourceManager({
    registry, providers, policy, cache, bus,
    logger: logger ? logger.child('research-sources') : null,
  });

  // --- memory ---------------------------------------------------------------
  const researchMemory = new ResearchMemory({
    memory,
    logger: logger ? logger.child('research-memory') : null,
  });

  // --- engine ---------------------------------------------------------------
  const engine = new ResearchEngine({
    sourceManager, provider, policy, traces, artifacts, bus,
    memory: researchMemory,
    logger: logger ? logger.child('research') : null,
    config: { maxRounds: cfg.maxRounds },
  });

  const researcher = new Researcher({ engine, logger });
  const verifier = new Verifier({ sourceManager, provider, logger });

  // --- platform integration -------------------------------------------------
  let tools = [];
  if (toolManager) {
    tools = registerResearchTools(toolManager, {
      engine, verifier, sourceManager,
      defaultIdentity: () => ({
        mode: cfg.defaultMode,
        requireCitations: cfg.requireCitations,
        requireVerification: cfg.requireVerification,
        allowedDomains: cfg.allowedDomains,
        excludedDomains: cfg.blockedDomains,
        ...(Number.isInteger(cfg.maxQueries) ? { maxQueries: cfg.maxQueries } : {}),
        ...(Number.isInteger(cfg.maxSources) ? { maxSources: cfg.maxSources } : {}),
        ...(Number.isInteger(cfg.maxConcurrency) ? { maxConcurrency: cfg.maxConcurrency } : {}),
        ...(Number.isInteger(cfg.timeoutMs) ? { timeoutMs: cfg.timeoutMs } : {}),
      }),
    });
  }
  if (agentRegistry) registerResearchAgent(agentRegistry);
  const agentHandler = new ResearchAgentHandler({ engine, logger });

  return {
    config: cfg,
    enabled: cfg.enabled,
    engine,
    researcher,
    verifier,
    memory: researchMemory,
    sources: sourceManager,
    sourceRegistry: registry,
    providers,
    cache,
    tools,
    agentHandler,
    agentId: RESEARCH_AGENT_ID,
    skills: listResearchSkills(),
    // What this install can actually do, for the UI and for the capability
    // report a user is shown before they wonder why a search returned nothing.
    capabilities() {
      return {
        enabled: cfg.enabled,
        sources: sourceManager.capabilities(),
        providers: providers.list(),
        skills: listResearchSkills().map((s) => ({ id: s.id, capability: s.capability, tool: s.tool })),
        cache: cache.stats(),
        mcp: io.mcp ? 'wired' : 'not configured',
        model: provider ? 'wired' : 'not configured',
      };
    },
    // Release anything held. Live research tasks are cancelled, not abandoned.
    async dispose() {
      for (const view of engine.list()) engine.cancel(view.id, 'platform disposed');
      for (const view of engine.list()) engine.dispose(view.id);
      await cache.clear();
      return true;
    },
  };
}

module.exports = {
  createResearchSubsystem,
  DEFAULT_CONFIG,
  // Re-exported so a host can reach the pieces without deep paths.
  ResearchEngine,
  ARTIFACT_INLINE_BUDGET,
  MAX_RETAINED_TASKS,
  ResearchMemory,
  Researcher,
  Verifier,
  SourceManager,
  createSourceRegistry,
  createSearchProviderRegistry,
  createRetrievalCache,
  registerResearchTools,
  registerResearchAgent,
  researchAgentDefinition,
  ResearchAgentHandler,
  RESEARCH_AGENT_ID,
  RESEARCH_SKILLS,
  RESEARCH_ACTION,
  RESEARCH_EVENTS,
  UI_EVENTS,
  STAGE_LABEL,
  CAPABILITY,
  listResearchSkills,
  resolveSkill,
  ...require('./schemas'),
  ...require('./errors/researchErrors'),
};
