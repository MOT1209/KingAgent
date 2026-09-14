// Built-in harness manifests.
//
// These are *descriptions*, not integrations. Registering them costs nothing
// and runs nothing: a manifest says what a backend can do, and the host decides
// whether a transport is wired for it. That is what makes the platform honest
// about a machine where nothing is installed — the harness appears, detection
// reports "not present", and routing explains why it was skipped.
//
// The one harness that is real on every install is `kingagent-runtime`: this
// platform's own Phase 2 AgentRuntime, exposed as a backend. Without it,
// routing would have nothing to choose between on a fresh machine, and the
// internal runtime would be a special case instead of a peer.

const { createCapabilities } = require('./capabilities');

// Model ids are deliberately not enumerated here. A manifest that lists
// hard-coded vendor model names is stale within a release; an empty list means
// "the host decides", which registry.resolve() honours by not filtering.
function base({ id, name, description, type = 'cli', platforms, tags, command = null, provider = null, version = 'unknown', detectable = true }) {
  return {
    id,
    name,
    description,
    type,
    provider: provider || id,
    version,
    platforms,
    capabilities: [...tags],
    command,
    supportedModels: [],
    environmentPolicy: { mode: 'minimal' },
    workspacePolicy: { mode: 'workspace' },
    secretEnv: [],
    ...(detectable ? { detect: { command: command ? command[0] : id } } : {}),
  };
}

function builtinHarnesses() {
  return [
    base({
      id: 'kingagent-runtime',
      name: 'KingAgent Runtime',
      description: "KingAgent's own agent runtime — the built-in execution backend.",
      type: 'in-process',
      platforms: ['windows', 'macos', 'linux'],
      tags: ['coding', 'terminal', 'files', 'git', 'streaming', 'review', 'planning', 'research', 'structured_events', 'pause', 'parallel'],
      provider: 'kingagent',
      detectable: false,
    }),
    base({
      id: 'claude-code',
      name: 'Claude Code',
      description: 'Anthropic Claude Code CLI agent.',
      platforms: ['windows', 'macos', 'linux'],
      tags: ['coding', 'terminal', 'files', 'git', 'streaming', 'review', 'mcp', 'model_selection', 'structured_events', 'pause'],
      command: ['claude'],
      provider: 'anthropic',
      secretEnv: ['ANTHROPIC_API_KEY'],
    }),
    base({
      id: 'codex',
      name: 'Codex',
      description: 'OpenAI Codex CLI agent.',
      platforms: ['windows', 'macos', 'linux'],
      tags: ['coding', 'terminal', 'files', 'git', 'streaming', 'structured_events'],
      command: ['codex'],
      provider: 'openai',
      secretEnv: ['OPENAI_API_KEY'],
    }),
    base({
      id: 'opencode',
      name: 'OpenCode',
      description: 'OpenCode terminal agent.',
      platforms: ['windows', 'macos', 'linux'],
      tags: ['coding', 'terminal', 'files', 'git', 'streaming', 'model_selection'],
      command: ['opencode'],
      provider: 'opencode',
      secretEnv: ['OPENCODE_API_KEY'],
    }),
    base({
      id: 'gemini-cli',
      name: 'Gemini CLI',
      description: 'Google Gemini command line agent.',
      platforms: ['windows', 'macos', 'linux'],
      tags: ['research', 'files', 'terminal', 'streaming', 'model_selection'],
      command: ['gemini'],
      provider: 'google',
      secretEnv: ['GEMINI_API_KEY'],
    }),
    base({
      id: 'acp-agent',
      name: 'ACP Agent',
      description: 'Any Agent Client Protocol compatible agent (the ACP pane connects it).',
      platforms: ['windows', 'macos', 'linux'],
      tags: ['coding', 'files', 'terminal', 'streaming', 'model_selection', 'structured_events', 'pause'],
      type: 'acp',
      provider: 'acp',
      detectable: false,
    }),
  ];
}

// The capability tags a task of a given kind needs. Used by the router's
// `capability` strategy, and deliberately a plain table so it is inspectable.
const TASK_CAPABILITY_HINTS = Object.freeze({
  code: ['coding', 'files'],
  review: ['review'],
  research: ['research'],
  test: ['terminal'],
  document: ['files'],
});

function builtinCapabilities(harness) {
  return createCapabilities({
    tags: harness.capabilities || [],
    models: harness.supportedModels || [],
  });
}

module.exports = { builtinHarnesses, TASK_CAPABILITY_HINTS, builtinCapabilities };
