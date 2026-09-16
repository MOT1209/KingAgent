// Research as tools and skills (§22).
//
// An honest note on §22. It asks to integrate with "the Phase 6 Skill
// Ecosystem". There is no skill *registry* in this repository — `src/core/` has
// no skills module, and the `skills` field on an agent definition is a list of
// free-form strings nothing resolves. What does exist, and does exactly the job
// §22 describes, is the ToolManager's capability index: tools declare
// capabilities, `ToolManager.discover(agent, { capabilities })` returns the ones
// an agent may use, and the planner already reasons over that.
//
// So research capabilities are registered as tools with research capability
// tags, and `RESEARCH_SKILLS` below maps each skill name §22 lists onto the
// capability that resolves it. When a skill registry is built, that table is
// what it reads — nothing here has to change, and no second registry exists in
// the meantime.

const { PERMISSIONS } = require('../../tools/definition');
const { RESEARCH_ACTION } = require('../policies/researchPolicy');
const { SOURCE_TYPES } = require('../schemas/source');
const { sourceView } = require('../schemas/source');
const { claimView } = require('../schemas/claim');
const { citationView } = require('../schemas/citation');

// The capability vocabulary research contributes to the tool index.
const CAPABILITY = Object.freeze({
  RESEARCH: 'research',
  WEB_RESEARCH: 'web_research',
  DEEP_RESEARCH: 'deep_research',
  ACADEMIC_RESEARCH: 'academic_research',
  GITHUB_RESEARCH: 'github_research',
  DOC_RESEARCH: 'documentation_research',
  FILE_RESEARCH: 'file_research',
  VERIFICATION: 'source_verification',
  CITATION: 'citation_generation',
  FACT_CHECK: 'fact_checking',
  COMPARISON: 'comparison_research',
});

// §22's skill names, resolved through the capability index rather than through
// a registry that does not exist. Each entry says what the skill *is* in terms
// the platform can already act on: which tool runs it, with what defaults.
const RESEARCH_SKILLS = Object.freeze({
  'web-research': { tool: 'research:run', capability: CAPABILITY.WEB_RESEARCH, defaults: { mode: 'standard', sourcePreferences: [SOURCE_TYPES.WEB, SOURCE_TYPES.DOCUMENTATION] } },
  'deep-research': { tool: 'research:run', capability: CAPABILITY.DEEP_RESEARCH, defaults: { mode: 'deep' } },
  'academic-research': { tool: 'research:run', capability: CAPABILITY.ACADEMIC_RESEARCH, defaults: { mode: 'standard', sourcePreferences: [SOURCE_TYPES.ACADEMIC, SOURCE_TYPES.WEB] } },
  'github-research': { tool: 'research:run', capability: CAPABILITY.GITHUB_RESEARCH, defaults: { mode: 'standard', sourcePreferences: [SOURCE_TYPES.GITHUB, SOURCE_TYPES.DOCUMENTATION] } },
  'documentation-research': { tool: 'research:run', capability: CAPABILITY.DOC_RESEARCH, defaults: { mode: 'standard', sourcePreferences: [SOURCE_TYPES.DOCUMENTATION] } },
  'file-research': { tool: 'research:run', capability: CAPABILITY.FILE_RESEARCH, defaults: { mode: 'standard', filesOnly: true } },
  'source-verification': { tool: 'research:verify', capability: CAPABILITY.VERIFICATION, defaults: {} },
  'citation-generation': { tool: 'research:run', capability: CAPABILITY.CITATION, defaults: { requireCitations: true } },
  'fact-checking': { tool: 'research:verify', capability: CAPABILITY.FACT_CHECK, defaults: { mode: 'standard' } },
  'comparison-research': { tool: 'research:run', capability: CAPABILITY.COMPARISON, defaults: { mode: 'deep' } },
});

function listResearchSkills() {
  return Object.entries(RESEARCH_SKILLS).map(([id, s]) => ({ id, ...s, defaults: { ...s.defaults } }));
}

// Resolve a skill name to something runnable, checking that the agent is
// actually permitted the tool behind it. Returns null when the skill is unknown
// or the agent cannot reach it — never a "sure, go ahead" for a capability the
// agent does not have.
function resolveSkill(name, { toolManager, agent }) {
  const skill = RESEARCH_SKILLS[name];
  if (!skill) return null;
  if (!toolManager) return null;
  const permitted = toolManager.discover(agent, { capabilities: [skill.capability] });
  if (!permitted.includes(skill.tool)) return null;
  return { id: name, ...skill, toolId: skill.tool };
}

// Register the research tools into the platform's existing ToolManager.
//
// `engine` and `verifier` are the live objects; the tools are thin adapters so
// an agent's tool call and a direct engine call take the same path through
// policy, budget and citation validation.
function registerResearchTools(toolManager, { engine, verifier = null, sourceManager = null, defaultIdentity = () => ({}) } = {}) {
  if (!toolManager || typeof toolManager.register !== 'function') {
    throw new TypeError('registerResearchTools requires a ToolManager');
  }
  if (!engine) throw new TypeError('registerResearchTools requires a ResearchEngine');

  const registered = [];
  const add = (def) => {
    if (toolManager.get(def.id)) return;
    toolManager.register(def);
    registered.push(def.id);
  };

  add({
    id: 'research:run',
    name: 'Research a question',
    description: 'Investigate a question across the configured sources and return verified claims with citations.',
    category: 'research',
    capabilities: [
      CAPABILITY.RESEARCH, CAPABILITY.WEB_RESEARCH, CAPABILITY.DEEP_RESEARCH,
      CAPABILITY.ACADEMIC_RESEARCH, CAPABILITY.GITHUB_RESEARCH, CAPABILITY.DOC_RESEARCH,
      CAPABILITY.FILE_RESEARCH, CAPABILITY.CITATION, CAPABILITY.COMPARISON, 'read',
    ],
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', required: true },
        mode: { type: 'string' },
        files: { type: 'array' },
        filesOnly: { type: 'boolean' },
        allowWeb: { type: 'boolean' },
        sourcePreferences: { type: 'array' },
        allowedDomains: { type: 'array' },
        excludedDomains: { type: 'array' },
      },
    },
    // Read-only as far as the workspace is concerned, but it reaches the
    // network, so it presents as `research.start` and the policy engine gates
    // each source on top of that.
    permissions: { level: PERMISSIONS.READ_ONLY, requiresAuth: false },
    policyAction: RESEARCH_ACTION.START,
    // Research is long-running by design; the engine enforces its own deadline,
    // so this ceiling only has to be above the largest mode's timeout.
    timeoutMs: 360_000,
    async execute(input, { abort } = {}) {
      const task = engine.create({ ...defaultIdentity(), ...input });
      const result = await engine.run(task, { signal: abort });
      return {
        taskId: task.id,
        answer: result.answer ? (result.answer.prose || result.answer.markdown) : '',
        claims: result.claims,
        citations: result.citations,
        conflicts: result.conflicts,
        quality: result.quality,
        partial: result.partial,
        sources: result.sources.length,
      };
    },
  });

  add({
    id: 'research:verify',
    name: 'Verify statements',
    description: 'Check specific statements against retrieved sources and report what supports or contradicts each.',
    category: 'research',
    capabilities: [CAPABILITY.VERIFICATION, CAPABILITY.FACT_CHECK, CAPABILITY.RESEARCH, 'read'],
    inputSchema: {
      type: 'object',
      properties: { statements: { type: 'array', required: true }, mode: { type: 'string' } },
    },
    permissions: { level: PERMISSIONS.READ_ONLY },
    policyAction: RESEARCH_ACTION.SEARCH,
    timeoutMs: 180_000,
    async execute(input, { abort } = {}) {
      if (!verifier) throw new Error('no verifier is wired into this platform');
      const statements = (input.statements || []).filter((s) => typeof s === 'string' && s.trim());
      if (statements.length === 0) throw new Error('research:verify needs at least one statement');
      // A verification run is still a research task: it gets a task with a
      // budget, so it cannot spend unboundedly outside the engine's accounting.
      const task = engine.create({
        ...defaultIdentity(),
        question: `Verify: ${statements[0]}`,
        mode: input.mode || 'standard',
      });
      const strategy = (await engine.plan(task)).strategy;
      const out = await verifier.check({ task, statements, strategy, signal: abort });
      return {
        taskId: task.id,
        claims: out.claims.map(claimView),
        conflicts: out.conflicts,
        report: out.report,
      };
    },
  });

  add({
    id: 'research:sources',
    name: 'Inspect research sources',
    description: 'List the sources a completed research task retrieved, with their scores and provenance.',
    category: 'research',
    capabilities: [CAPABILITY.RESEARCH, 'read'],
    inputSchema: { type: 'object', properties: { taskId: { type: 'string', required: true } } },
    permissions: { level: PERMISSIONS.READ_ONLY },
    policyAction: RESEARCH_ACTION.PLAN,
    async execute(input) {
      const result = engine.result(input.taskId);
      if (!result) throw new Error(`no research task ${input.taskId} is live`);
      return {
        taskId: input.taskId,
        sources: result.sources,
        citations: result.citations.map(citationView),
        bibliography: result.bibliography,
      };
    },
  });

  add({
    id: 'research:capabilities',
    name: 'Research capabilities',
    description: 'Report which research sources this installation can actually use, and why not where it cannot.',
    category: 'research',
    capabilities: [CAPABILITY.RESEARCH, 'read'],
    inputSchema: { type: 'object', properties: {} },
    permissions: { level: PERMISSIONS.READ_ONLY },
    policyAction: RESEARCH_ACTION.PLAN,
    async execute() {
      return {
        sources: sourceManager ? sourceManager.capabilities() : [],
        skills: listResearchSkills().map((s) => ({ id: s.id, capability: s.capability, tool: s.tool })),
      };
    },
  });

  return registered;
}

module.exports = {
  CAPABILITY, RESEARCH_SKILLS, registerResearchTools, listResearchSkills, resolveSkill, sourceView,
};
