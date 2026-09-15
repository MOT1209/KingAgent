// The KingAgent Skill Taxonomy: the closed vocabulary skills are tagged with.
//
// Why a closed vocabulary at all? Discovery, ranking and policy all key off
// these strings. If a skill could invent its own category, an untrusted
// manifest could name a category no policy document covers and quietly escape
// every rule written against the taxonomy. So a manifest may declare only
// categories listed here; anything else is a validation error, not a warning.
//
// The groups are documentation, not behaviour — a category belongs to exactly
// one group and lookups go through CATEGORY_SET / groupOf(). Adding a category
// is a deliberate edit to this file and a docs change (docs/skills/architecture.md).

const GROUPS = Object.freeze({
  'core-agent': [
    'planning', 'task-decomposition', 'requirement-analysis', 'reasoning',
    'problem-solving', 'decision-making', 'context-engineering', 'clarification',
    'project-analysis', 'codebase-analysis',
  ],
  'software-engineering': [
    'implementation', 'debugging', 'code-review', 'refactoring', 'architecture',
    'domain-modeling', 'api-design', 'dependency-management', 'git', 'github',
    'documentation', 'release-management',
  ],
  testing: [
    'unit-testing', 'integration-testing', 'e2e-testing', 'regression-testing',
    'test-generation', 'test-analysis', 'browser-testing', 'api-testing',
    'performance-testing', 'security-testing', 'quality-gates',
  ],
  'self-healing': [
    'error-detection', 'root-cause-analysis', 'log-analysis', 'stack-trace-analysis',
    'autofix', 'regression-repair', 'dependency-conflict-resolution', 'retry',
    'recovery', 'replanning', 'verification',
  ],
  web: [
    'web-research', 'web-search', 'browser-automation', 'agent-browser',
    'web-scraping', 'website-analysis', 'documentation-research', 'api-discovery',
  ],
  mcp: [
    'mcp-discovery', 'mcp-client', 'mcp-builder', 'mcp-server-builder',
    'mcp-tool-design', 'mcp-resource-design', 'mcp-prompt-design', 'mcp-testing',
    'mcp-debugging', 'mcp-security', 'mcp-inspector', 'mcp-registry',
    'mcp-installation', 'mcp-configuration', 'mcp-transport', 'mcp-authentication',
    'mcp-permissions', 'mcp-app-builder', 'mcp-app-ui', 'mcp-evaluation',
  ],
  'multi-agent': [
    'agent-delegation', 'agent-handoff', 'agent-collaboration', 'agent-communication',
    'agent-routing', 'agent-role-assignment', 'parallel-agents', 'agent-review',
    'consensus', 'conflict-resolution', 'team-builder',
  ],
  workflow: [
    'workflow-builder', 'workflow-executor', 'workflow-debugger', 'workflow-optimizer',
    'workflow-retry', 'workflow-recovery', 'parallel-workflows', 'conditional-workflows',
    'approval-gates', 'human-in-the-loop', 'scheduled-workflows', 'event-driven-workflows',
  ],
  security: [
    'security-audit', 'secure-coding', 'owasp', 'secret-detection', 'dependency-security',
    'supply-chain-security', 'permission-analysis', 'sandbox-analysis', 'command-safety',
    'authentication', 'authorization', 'input-validation', 'threat-modeling',
  ],
  'desktop-system': [
    'windows', 'macos', 'electron', 'filesystem', 'shell', 'powershell', 'terminal',
    'process-management', 'environment-management', 'desktop-automation', 'system-diagnostics',
  ],
  'frontend-ui': [
    'frontend-design', 'ui-design', 'ux-design', 'responsive-design', 'mobile-design',
    'desktop-design', 'accessibility', 'design-system', 'component-design', 'visual-testing',
  ],
  database: [
    'database-design', 'sql', 'postgresql', 'sqlite', 'supabase', 'redis',
    'schema-migrations', 'query-optimization', 'data-modeling', 'vector-database',
    'database-security',
  ],
  'devops-cloud': [
    'docker', 'kubernetes', 'cicd', 'github-actions', 'vercel', 'cloudflare', 'aws',
    'azure', 'deployment', 'monitoring', 'observability', 'rollback', 'infrastructure-as-code',
  ],
  'ai-ml': [
    'llm-integration', 'prompt-engineering', 'agent-engineering', 'rag', 'embeddings',
    'vector-search', 'model-selection', 'model-routing', 'tool-calling', 'structured-output',
    'model-evaluation', 'fine-tuning', 'memory-engineering', 'ai-safety',
  ],
  memory: [
    'memory-extraction', 'memory-validation', 'memory-deduplication', 'memory-summarization',
    'context-compression', 'long-term-memory', 'project-memory', 'semantic-retrieval',
    'memory-ranking',
  ],
  observability: [
    'logging', 'metrics', 'tracing', 'performance-monitoring', 'cost-tracking',
    'token-tracking', 'agent-analytics', 'execution-analytics', 'error-monitoring',
  ],
});

const CATEGORIES = Object.freeze(Object.values(GROUPS).flat().sort());
const CATEGORY_SET = new Set(CATEGORIES);

const GROUP_OF = Object.freeze(Object.fromEntries(
  Object.entries(GROUPS).flatMap(([group, list]) => list.map((c) => [c, group])),
));

// Phrases a user actually types, mapped to the categories they imply.
//
// This is the only fuzzy part of discovery and it is deliberately *data*: it is
// reviewable, testable, and it never runs anything. A category's own name is
// already matched token-wise by the discovery pass (see discovery/SkillDiscovery.js),
// so this table only carries the words that name a technology or an intent
// rather than a category — "next.js" means frontend work, "broken" means
// debugging.
const KEYWORDS = Object.freeze({
  // intents
  'build a rest api': ['api-design', 'implementation', 'architecture'],
  'rest api': ['api-design', 'implementation'],
  'api': ['api-design'],
  'endpoint': ['api-design', 'implementation'],
  'graphql': ['api-design', 'implementation'],
  'fix': ['debugging', 'root-cause-analysis', 'autofix'],
  'broken': ['debugging', 'root-cause-analysis', 'codebase-analysis'],
  'failing': ['debugging', 'root-cause-analysis', 'test-analysis'],
  'crash': ['debugging', 'stack-trace-analysis', 'error-detection'],
  'bug': ['debugging', 'root-cause-analysis'],
  'refactor': ['refactoring', 'code-review'],
  'review': ['code-review', 'agent-review'],
  'test': ['unit-testing', 'test-generation'],
  'tests': ['unit-testing', 'test-generation'],
  'deploy': ['deployment', 'cicd'],
  'ship': ['deployment', 'release-management'],
  'release': ['release-management', 'deployment'],
  'document': ['documentation'],
  'docs': ['documentation'],
  'audit': ['security-audit', 'permission-analysis'],
  'secure': ['secure-coding', 'security-audit'],
  'vulnerability': ['security-audit', 'owasp', 'dependency-security'],
  'slow': ['performance-testing', 'performance-monitoring', 'query-optimization'],
  'research': ['web-research', 'documentation-research'],
  'scrape': ['web-scraping', 'browser-automation'],
  'team': ['team-builder', 'agent-delegation', 'agent-routing'],
  'multi-agent': ['team-builder', 'agent-delegation', 'parallel-agents'],
  'agents in parallel': ['parallel-agents', 'agent-routing'],
  'schedule': ['scheduled-workflows'],
  'pipeline': ['workflow-builder', 'cicd'],
  'migrate': ['schema-migrations', 'refactoring'],
  'authentication': ['authentication', 'authorization', 'security-audit'],
  'auth': ['authentication', 'authorization'],
  'login': ['authentication'],
  'website': ['frontend-design', 'implementation'],
  'web app': ['frontend-design', 'implementation'],
  'dashboard': ['frontend-design', 'component-design'],
  'ui': ['ui-design', 'component-design'],
  'design system': ['design-system', 'component-design'],
  // technologies
  'next.js': ['frontend-design', 'implementation', 'deployment'],
  'nextjs': ['frontend-design', 'implementation', 'deployment'],
  'react': ['frontend-design', 'component-design', 'implementation'],
  'vue': ['frontend-design', 'component-design', 'implementation'],
  'svelte': ['frontend-design', 'component-design', 'implementation'],
  'electron': ['electron', 'desktop-design'],
  'node': ['implementation'],
  'typescript': ['implementation'],
  'python': ['implementation'],
  'rust': ['implementation'],
  'go': ['implementation'],
  'supabase': ['supabase', 'database-design', 'authentication'],
  'postgres': ['postgresql', 'database-design', 'sql'],
  'postgresql': ['postgresql', 'database-design', 'sql'],
  'sqlite': ['sqlite', 'database-design'],
  'redis': ['redis'],
  'vector database': ['vector-database', 'embeddings', 'vector-search'],
  'pgvector': ['vector-database', 'postgresql'],
  'rag': ['rag', 'embeddings', 'vector-search'],
  'embedding': ['embeddings', 'vector-search'],
  'llm': ['llm-integration', 'prompt-engineering'],
  'prompt': ['prompt-engineering'],
  'docker': ['docker', 'deployment'],
  'kubernetes': ['kubernetes', 'deployment'],
  'k8s': ['kubernetes', 'deployment'],
  'vercel': ['vercel', 'deployment'],
  'cloudflare': ['cloudflare', 'deployment'],
  'aws': ['aws', 'deployment'],
  'azure': ['azure', 'deployment'],
  'github actions': ['github-actions', 'cicd'],
  'ci': ['cicd'],
  'ci/cd': ['cicd'],
  'git': ['git'],
  'pull request': ['github', 'git', 'code-review'],
  'github': ['github', 'git'],
  'playwright': ['browser-testing', 'e2e-testing', 'browser-automation'],
  'puppeteer': ['browser-automation', 'browser-testing'],
  'browser': ['browser-automation', 'agent-browser'],
  'windows': ['windows', 'desktop-automation'],
  'macos': ['macos', 'desktop-automation'],
  'powershell': ['powershell', 'shell'],
  'shell': ['shell', 'command-safety'],
  'terminal': ['terminal', 'shell'],
  // mcp
  'mcp': ['mcp-discovery', 'mcp-client'],
  'mcp server': ['mcp-builder', 'mcp-server-builder', 'mcp-tool-design'],
  'model context protocol': ['mcp-builder', 'mcp-client'],
  'mcp tool': ['mcp-tool-design', 'mcp-builder'],
  'mcp app': ['mcp-app-builder', 'mcp-app-ui'],
  'inspect mcp': ['mcp-inspector', 'mcp-testing'],
});

// Longest phrases first: "mcp server" must win over the bare "mcp" so a request
// to build one is not merely classified as discovery.
const KEYWORD_PHRASES = Object.freeze(
  Object.keys(KEYWORDS).sort((a, b) => b.length - a.length || (a < b ? -1 : 1)),
);

// What a category implies in practice.
//
// Keyword matching only finds what the user said, and what a user says is
// systematically narrower than what the work needs: nobody writes "build a REST
// API, and also test it, document it and check it for injection flaws". Expert
// practice fills that in, and a discovery layer that does not is one that
// silently drops the testing skill from every task.
//
// Applied at ONE level only, at a lower weight than a direct match (see
// discovery/SkillDiscovery.js). One level is the guardrail: transitive
// implication turns four matched words into half the taxonomy, which is the
// "load every skill" failure this whole layer exists to prevent. Where a chain
// genuinely matters ("debugging implies a code change, which implies a review")
// the second step is written out here explicitly rather than derived.
const IMPLIES = Object.freeze({
  implementation: ['unit-testing', 'code-review'],
  refactoring: ['code-review', 'regression-testing'],
  'api-design': ['documentation', 'security-audit'],
  architecture: ['api-design', 'documentation'],
  debugging: ['root-cause-analysis', 'implementation', 'unit-testing', 'code-review'],
  'root-cause-analysis': ['codebase-analysis', 'log-analysis'],
  autofix: ['implementation', 'verification', 'regression-testing'],
  'mcp-builder': ['mcp-tool-design', 'mcp-testing', 'mcp-security', 'api-design', 'documentation', 'security-audit'],
  'mcp-server-builder': ['mcp-builder', 'mcp-tool-design'],
  'mcp-client': ['mcp-configuration', 'mcp-security'],
  'frontend-design': ['component-design', 'accessibility', 'responsive-design'],
  deployment: ['cicd', 'git', 'rollback'],
  cicd: ['git'],
  'database-design': ['schema-migrations', 'database-security', 'sql'],
  supabase: ['database-design', 'authentication'],
  authentication: ['authorization', 'security-audit'],
  'security-audit': ['owasp', 'secure-coding', 'codebase-analysis'],
  'team-builder': ['agent-delegation', 'agent-routing', 'agent-review', 'parallel-agents'],
  'workflow-builder': ['workflow-executor', 'approval-gates'],
  'codebase-analysis': ['project-analysis'],
  'unit-testing': ['test-generation'],
  'e2e-testing': ['browser-testing'],
  vercel: ['deployment'],
  docker: ['deployment'],
  kubernetes: ['deployment'],
});

// The categories `category` implies, filtered to the taxonomy.
function impliedBy(category) {
  return (IMPLIES[category] || []).filter((c) => CATEGORY_SET.has(c));
}

function isCategory(value) {
  return typeof value === 'string' && CATEGORY_SET.has(value);
}

function groupOf(category) {
  return GROUP_OF[category] || null;
}

function categoriesInGroup(group) {
  return GROUPS[group] ? [...GROUPS[group]] : [];
}

// Every category that is not in the taxonomy, for error messages that say which
// entry was wrong rather than "invalid categories".
function unknownCategories(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((c) => !isCategory(c));
}

module.exports = {
  GROUPS,
  IMPLIES,
  impliedBy,
  CATEGORIES,
  CATEGORY_SET,
  KEYWORDS,
  KEYWORD_PHRASES,
  isCategory,
  groupOf,
  categoriesInGroup,
  unknownCategories,
};
