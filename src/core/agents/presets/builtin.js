// Built-in agent presets the platform ships with. They are the "recognizable
// defaults" — a coding agent for the standard analyze → plan → implement →
// test → fix → report loop, and a research/analyst agent for read-only
// investigation. Everything here can be overridden or removed by user config.

const AGENTS = [
  {
    id: 'coder',
    name: 'Coder',
    description: 'Coding agent: analyzes a request, plans steps, writes and tests code, fixes failures and reports.',
    systemPrompt:
      'You are the Coder agent inside the KingAgent platform. Work through the request step by step: ' +
      'analyze the workspace, form a plan, implement with the tools, run tests, fix what breaks, and report. ' +
      'Do not claim work that tools did not confirm.',
    model: { provider: 'unset', id: 'default' },
    capabilities: ['repository_analysis', 'code', 'read', 'write', 'run_tests', 'code_search', 'git'],
    tools: ['fs:read', 'fs:list', 'fs:write', 'search:grep', 'git:status', 'terminal:run'],
    // 'destructive' + allowDestructive lets the coder REACH the dangerous tools
    // (fs:delete, terminal:run); every such call still goes through the per-call
    // authorization modal — needsAuthorization returns true unconditionally for
    // DESTRUCTIVE tools, so the flag never skips the human loop.
    permissions: { levels: ['read_only', 'safe', 'moderate', 'destructive'], allowDestructive: true },
    metadata: { role: 'default' },
  },
  {
    id: 'analyst',
    name: 'Analyst',
    description: 'Read-only investigator: explores a repository, searches code and produces a structured report.',
    systemPrompt:
      'You are the Analyst agent inside the KingAgent platform. You only read and search; you never modify files ' +
      'or run mutating commands. Produce a structured report with findings.',
    model: { provider: 'unset', id: 'default' },
    capabilities: ['repository_analysis', 'read', 'code_search', 'git', 'report'],
    tools: ['fs:read', 'fs:list', 'search:grep', 'git:status'],
    permissions: { levels: ['read_only', 'safe'], allowDestructive: false },
    metadata: { role: 'analyst' },
  },
];

function builtinAgents() {
  return AGENTS.map((a) => ({ ...a, capabilities: [...a.capabilities], tools: [...a.tools] }));
}

module.exports = { builtinAgents, AGENTS_DEFAULT_IDS: AGENTS.map((a) => a.id) };