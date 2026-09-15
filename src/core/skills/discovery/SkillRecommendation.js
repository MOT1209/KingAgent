// SkillRecommendation: from "what does this task need" to "here is the working
// set, in the order it should be used".
//
// This is where discovery and ranking become a plan. Three outputs, each of
// which a caller genuinely needs:
//
//   selected — one skill per needed category, the best-ranked eligible one.
//              Deduplicated across categories: a skill that covers three of the
//              needed categories is selected once and credited for all three,
//              which is how the working set stays small.
//   pipeline — those skills grouped into ordered phases. A skill pipeline is
//              not a workflow (the workflow engine owns those); it is the
//              sequence the orchestrator should *consider*, so that
//              architecture is read before implementation and security review
//              does not run before there is code.
//   gaps     — needed categories nothing installed covers. Reported rather than
//              silently dropped, because a gap is the honest reason a task will
//              be done worse, and it is what a "search skills.sh for this"
//              suggestion is built from.

const { discover } = require('./SkillDiscovery');
const { rankAll } = require('./SkillRanking');
const { groupOf } = require('../taxonomy');

// Phases, in execution order. Membership is by category first, then by taxonomy
// group, so a category that is not named individually still lands somewhere
// sensible rather than at the end.
const PHASES = Object.freeze([
  {
    id: 'research',
    label: 'Research',
    categories: ['web-research', 'web-search', 'documentation-research', 'api-discovery', 'website-analysis', 'mcp-discovery'],
    groups: ['web'],
  },
  {
    id: 'analysis',
    label: 'Analysis',
    categories: ['requirement-analysis', 'task-decomposition', 'project-analysis', 'codebase-analysis', 'clarification', 'root-cause-analysis', 'log-analysis', 'stack-trace-analysis', 'error-detection'],
    groups: ['core-agent', 'self-healing'],
  },
  {
    id: 'design',
    label: 'Design',
    categories: ['architecture', 'api-design', 'domain-modeling', 'database-design', 'data-modeling', 'schema-migrations', 'threat-modeling', 'mcp-tool-design', 'mcp-resource-design', 'mcp-prompt-design'],
    groups: ['frontend-ui', 'database'],
  },
  {
    id: 'implementation',
    label: 'Implementation',
    categories: ['implementation', 'refactoring', 'autofix', 'regression-repair', 'dependency-management', 'mcp-builder', 'mcp-server-builder', 'mcp-app-builder', 'workflow-builder', 'team-builder'],
    groups: ['software-engineering', 'multi-agent', 'workflow', 'ai-ml', 'memory', 'desktop-system'],
  },
  {
    id: 'testing',
    label: 'Testing',
    categories: [],
    groups: ['testing'],
  },
  {
    id: 'security',
    label: 'Security review',
    categories: ['mcp-security'],
    groups: ['security'],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    categories: ['deployment', 'cicd', 'github-actions', 'release-management', 'rollback', 'docker', 'kubernetes', 'vercel', 'cloudflare', 'aws', 'azure', 'git', 'github', 'documentation'],
    groups: ['devops-cloud', 'observability'],
  },
]);

const PHASE_INDEX = Object.freeze(Object.fromEntries(PHASES.map((p, i) => [p.id, i])));
const DEFAULT_PHASE = 'implementation';

function phaseFor(category) {
  for (const phase of PHASES) {
    if (phase.categories.includes(category)) return phase.id;
  }
  const group = groupOf(category);
  for (const phase of PHASES) {
    if (group && phase.groups.includes(group)) return phase.id;
  }
  return DEFAULT_PHASE;
}

// The working set for a request.
//
// `maxSkills` exists because "which skills are relevant" and "how many can I
// afford to load" are different questions: relevance is unbounded, context is
// not. The cap is applied after ranking so the ones dropped are the weakest.
function recommend({
  request,
  registry,
  platform = null,
  maxSkills = 8,
  minScore = 0.25,
  provider = null,
  providerCategories = [],
} = {}) {
  const discovery = discover({ request, registry, platform, provider, providerCategories });
  const ranked = rankAll(discovery.candidates, { platform, registry });
  const eligible = ranked.filter((r) => r.eligible && r.score >= minScore);

  // Per needed category, the best eligible skill covering it.
  const bestPerCategory = new Map();
  for (const entry of discovery.covered) {
    const best = eligible.find((r) => r.matchedCategories.includes(entry.category));
    if (best) bestPerCategory.set(entry.category, best);
  }

  // Deduplicate into the working set, crediting each skill with every category
  // it was chosen for.
  const selectedById = new Map();
  for (const [category, entry] of bestPerCategory) {
    const key = `${entry.skillId}@${entry.version}`;
    const existing = selectedById.get(key);
    if (existing) {
      existing.coversCategories.push(category);
      continue;
    }
    selectedById.set(key, {
      skillId: entry.skillId,
      version: entry.version,
      score: entry.score,
      explanation: entry.explanation,
      factors: entry.factors,
      coversCategories: [category],
    });
  }

  const selected = [...selectedById.values()]
    .map((s) => ({
      ...s,
      coversCategories: s.coversCategories.sort(),
      phase: leadingPhase(s.coversCategories),
    }))
    .sort((a, b) => (PHASE_INDEX[a.phase] - PHASE_INDEX[b.phase]) || b.score - a.score)
    .slice(0, maxSkills);

  const pipeline = PHASES
    .map((phase) => ({
      phase: phase.id,
      label: phase.label,
      skills: selected.filter((s) => s.phase === phase.id).map((s) => ({ skillId: s.skillId, version: s.version, covers: s.coversCategories })),
    }))
    .filter((step) => step.skills.length > 0);

  const gaps = discovery.missing.map((m) => ({
    category: m.category,
    group: m.group,
    score: m.score,
    evidence: m.evidence,
    // What the UI offers to do about it. A suggestion, never an action: nothing
    // is fetched or installed by a recommendation.
    suggestion: `no installed skill covers "${m.category}" — search the configured sources for one`,
  }));

  return {
    request: discovery.request,
    categories: discovery.categories,
    matchedPhrases: discovery.matchedPhrases,
    selected,
    pipeline,
    gaps,
    considered: ranked.length,
    rejected: ranked.filter((r) => !r.eligible).map((r) => ({ skillId: r.skillId, version: r.version, blockers: r.blockers })),
  };
}

// A skill covering several categories belongs to the earliest phase among them:
// an `architecture` + `implementation` skill should be read while designing,
// not after the code is written.
function leadingPhase(categories) {
  return categories
    .map(phaseFor)
    .sort((a, b) => PHASE_INDEX[a] - PHASE_INDEX[b])[0] || DEFAULT_PHASE;
}

module.exports = { PHASES, PHASE_INDEX, phaseFor, leadingPhase, recommend };
