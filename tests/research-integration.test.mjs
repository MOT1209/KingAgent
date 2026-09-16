// Phase 7 §44 (integration): research inside the platform, not beside it.
//
// The claim Phase 7 has to earn is that research is a *subsystem of KingAgent*
// rather than a parallel stack that happens to live in the same repo. These
// tests are how that claim is checked: research must go through the existing
// policy engine, the existing tool manager, the existing agent registry, the
// existing trace store, the existing artifact manager and the existing memory
// manager — and must not have built a second one of any of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const { createPlatform } = require('../src/core/index.js');
const { createResearchSubsystem, RESEARCH_AGENT_ID } = require('../src/core/research');
const { PolicyManager } = require('../src/core/policy');
const { MemoryManager } = require('../src/core/memory/manager');
const { ExecutionTraceStore } = require('../src/core/trace/store');
const { ArtifactManager } = require('../src/core/artifacts/manager');
const { EventBus } = require('../src/core/events/event-bus');
const { validateAgentDefinition } = require('../src/core/agents/definition');
const { researchAgentDefinition } = require('../src/core/research/agents/researchAgent');
const { RESEARCH_SKILLS, resolveSkill } = require('../src/core/research/tools');
const { UI_EVENTS } = require('../src/core/research/traceEvents');

const DOCS = [
  { title: 'Protocol specification', url: 'https://std.example/spec', publishedAt: '2025-03-01',
    content: 'The protocol is an open standard for connecting assistants to data sources. It supports stdio and streamable HTTP transports and is built on JSON-RPC 2.0.' },
  { title: 'Vendor overview', url: 'https://vendor.example/protocol', publishedAt: '2025-04-01',
    content: 'The protocol is an open standard for connecting assistants to tools. It supports stdio and HTTP transports in every supported runtime.' },
];

const provider = () => ({ sourceTypes: ['web', 'documentation'], async search({ limit }) { return DOCS.slice(0, limit); } });

function openPolicy() {
  const policy = new PolicyManager({ defaultEffect: 'allow' });
  policy.loadBaseline();
  policy.setApprover(async () => true);
  return policy;
}

// --- no duplicate architecture ----------------------------------------------

test('integration: research adds no second manager of anything the platform owns', () => {
  const research = fs.readdirSync(path.join(ROOT, 'src', 'core', 'research'), { recursive: true })
    .filter((f) => typeof f === 'string' && f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'core', 'research', f), 'utf8'));
  const body = research.join('\n');
  // A class named like one of the platform's managers would be a second one of
  // it, which §51 forbids. (SourceManager is research's own and has no
  // platform-level twin.)
  for (const banned of ['class ToolManager', 'class PolicyManager', 'class MemoryManager',
    'class ArtifactManager', 'class AgentRegistry', 'class ExecutionTraceStore', 'class Orchestrator',
    'class ApprovalManager', 'class SandboxManager', 'class HarnessManager']) {
    assert.ok(!body.includes(banned), `research defines its own ${banned}`);
  }
  // And it must not reach around the platform to the network directly. The
  // `fetch` check looks for a *call* — `await fetch(`, `= fetch(` — because
  // `fetch()` also appears as a provider method name and in prose.
  for (const banned of ["require('node:http')", "require('node:https')", "require('http')", "require('https')", "require('node:net')", "require('node:dgram')"]) {
    assert.ok(!body.includes(banned), `research reaches the network directly via ${banned}`);
  }
  assert.ok(!/(?:await|return|=|\(|,)\s*fetch\s*\(/.test(body), 'research calls global fetch directly');
});

test('integration: the research subsystem is wired into createPlatform', () => {
  const platform = createPlatform({ io: {} });
  try {
    assert.ok(platform.research, 'platform.research is missing');
    assert.ok(platform.tools.get('research:run'), 'research tools are not registered');
    assert.ok(platform.agents.get(RESEARCH_AGENT_ID), 'the research agent is not registered');
    assert.ok(platform.policy.list().some((d) => d.id === 'baseline-research'), 'research policies are not loaded');
  } finally {
    platform.dispose();
  }
});

// --- agents -----------------------------------------------------------------

test('integration: the research agent is a valid, read-only platform agent', () => {
  const def = researchAgentDefinition();
  const { ok, errors } = validateAgentDefinition(def);
  assert.ok(ok, `invalid agent definition: ${(errors || []).join('; ')}`);
  assert.deepEqual(def.permissions.levels, ['read_only', 'safe']);
  assert.equal(def.permissions.allowDestructive, false);
  assert.equal(def.workspacePolicy.allowDestructive, false);
});

test('integration: research runs as an agent task and returns a cited answer', async () => {
  const s = createResearchSubsystem({ policy: openPolicy(), io: { searchProviders: { docs: provider() } }, config: { allowNetworkedSources: true } });
  const out = await s.agentHandler.handle({ request: 'What transports does the protocol support?' });
  assert.equal(out.researched, true);
  assert.ok(out.summary.length > 0);
  assert.ok(out.citations.length > 0);
  assert.ok(out.quality);
});

// --- tools and skills -------------------------------------------------------

test('integration: research tools go through the platform ToolManager and its gates', async () => {
  const platform = createPlatform({
    io: { research: { searchProviders: { docs: provider() } } },
    policies: { research: { allowNetworkedSources: true } },
  });
  try {
    platform.policy.setApprover(async () => true);
    const agent = platform.agents.get(RESEARCH_AGENT_ID);
    const result = await platform.tools.execute({ id: 'research:run', input: { question: 'What transports does the protocol support?' }, agent });
    assert.equal(result.ok, true);
    assert.ok(result.data.citations.length > 0);
    assert.ok(result.data.quality);
  } finally {
    await platform.dispose();
  }
});

test('integration: an agent that may not use research cannot reach it', () => {
  const platform = createPlatform({ io: {} });
  try {
    // The `analyst` preset does not list the research tools, so tool-scoped
    // discovery excludes them — the existing permission model, not a new one.
    const analyst = platform.agents.get('analyst');
    assert.ok(!platform.tools.discover(analyst, { capabilities: ['research'] }).includes('research:run'));
  } finally {
    platform.dispose();
  }
});

test('integration: research skills resolve through the tool capability index', () => {
  const platform = createPlatform({ io: {} });
  try {
    const agent = platform.agents.get(RESEARCH_AGENT_ID);
    for (const name of Object.keys(RESEARCH_SKILLS)) {
      const resolved = resolveSkill(name, { toolManager: platform.tools, agent });
      assert.ok(resolved, `skill ${name} does not resolve`);
      assert.ok(platform.tools.get(resolved.toolId), `skill ${name} points at a tool that is not registered`);
    }
    // A skill an agent is not permitted resolves to nothing, rather than to a
    // "sure, go ahead" for a capability it does not have.
    assert.equal(resolveSkill('web-research', { toolManager: platform.tools, agent: platform.agents.get('analyst') }), null);
  } finally {
    platform.dispose();
  }
});

test('integration: every registered research tool declares a research policy action', () => {
  const platform = createPlatform({ io: {} });
  try {
    for (const t of platform.tools.list().filter((x) => x.category === 'research')) {
      assert.match(t.policyAction || '', /^research\./, `${t.id} has no research policy action`);
      assert.equal(t.permissions.level, 'read_only', `${t.id} is not read-only`);
    }
  } finally {
    platform.dispose();
  }
});

// --- policy -----------------------------------------------------------------

test('integration: with the research gate closed, research retrieves nothing and says why', async () => {
  const policy = new PolicyManager({ defaultEffect: 'allow' });
  policy.loadBaseline(); // no approver: an approval gate is a denial
  const s = createResearchSubsystem({ policy, io: { searchProviders: { docs: provider() } }, config: { allowNetworkedSources: false } });
  const { result } = await s.researcher.answer('What transports does the protocol support?');
  assert.equal(result.sources.length, 0);
  assert.ok(result.queries.some((q) => q.errors.some((e) => /policy/i.test(e.reason))), 'the refusal must be recorded on the query');
});

// --- trace ------------------------------------------------------------------

test('integration: research events land in the platform trace with full correlation', async () => {
  const bus = new EventBus();
  const traces = new ExecutionTraceStore({ bus });
  const s = createResearchSubsystem({ policy: openPolicy(), traces, bus, io: { searchProviders: { docs: provider() } }, config: { allowNetworkedSources: true } });

  const seen = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('research.')) seen.push(ev); });

  const task = s.engine.create({ question: 'What transports does the protocol support?', sessionId: 'sess-1', workspaceId: 'ws-1', agentId: 'research' });
  await s.engine.run(task);

  assert.ok(seen.length > 0, 'no research events reached the bus');
  for (const ev of seen) {
    assert.equal(ev.sessionId, 'sess-1');
    assert.equal(ev.workspaceId, 'ws-1');
    assert.ok(ev.traceId, `${ev.type} has no traceId`);
  }
  const trace = traces.getTrace(task.traceId) || [...seen].map((e) => traces.getTrace(e.traceId)).find(Boolean);
  assert.ok(trace, 'no trace was created');
  assert.ok(trace.events.some((e) => e.type === 'research.completed'));
});

test('integration: no research event carries anything resembling deliberation', async () => {
  const bus = new EventBus();
  const s = createResearchSubsystem({ policy: openPolicy(), bus, io: { searchProviders: { docs: provider() } }, config: { allowNetworkedSources: true } });
  const payloads = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('research.')) payloads.push(JSON.stringify(ev.payload || {})); });
  await s.researcher.answer('What transports does the protocol support?');
  const { isForbiddenKey } = require('../src/core/trace/events');
  for (const raw of payloads) {
    for (const key of Object.keys(JSON.parse(raw))) {
      assert.ok(!isForbiddenKey(key), `a research event carried a forbidden key: ${key}`);
    }
  }
});

test('integration: only the summarized event set is meant for the UI', () => {
  // Per-source and per-citation events fire many times per run and are
  // deliberately absent from the UI set — the same judgement already applied to
  // `policy.evaluated`.
  assert.ok(!UI_EVENTS.includes('research.source.retrieved'));
  assert.ok(!UI_EVENTS.includes('research.citation.created'));
  assert.ok(UI_EVENTS.includes('research.progress'));
  assert.ok(UI_EVENTS.includes('research.completed'));
});

// --- artifacts --------------------------------------------------------------

test('integration: research writes its report through the platform ArtifactManager', async () => {
  const bus = new EventBus();
  const artifacts = new ArtifactManager({ bus });
  const s = createResearchSubsystem({ policy: openPolicy(), artifacts, bus, io: { searchProviders: { docs: provider() } }, config: { allowNetworkedSources: true } });

  const workspace = { workspaceId: 'ws-1', taskId: 'task-1', agentId: 'research', traceId: 'trace-1', projectId: null, identity: { workspaceId: 'ws-1', taskId: 'task-1', agentId: 'research', traceId: 'trace-1' }, attachArtifact() {} };
  const task = s.engine.create({ question: 'What transports does the protocol support?', workspaceId: 'ws-1' });
  const result = await s.engine.run(task, { workspace });

  const names = result.artifacts.map((a) => a.name).sort();
  assert.deepEqual(names, ['citations.json', 'evidence.json', 'research-report.json', 'research-report.md', 'sources.json']);
  const stored = await artifacts.list({ workspace });
  assert.equal(stored.length, 5);
});

// --- memory -----------------------------------------------------------------

test('integration: only verified claims reach memory, and each carries its citations', async () => {
  const bus = new EventBus();
  const memory = new MemoryManager({ bus });
  const s = createResearchSubsystem({ policy: openPolicy(), memory, bus, io: { searchProviders: { docs: provider() } }, config: { allowNetworkedSources: true } });
  const memoryPolicy = { scopes: ['task', 'session', 'project'], ids: { task: 'task-1', session: 'sess-1', project: null } };

  const task = s.engine.create({ question: 'What transports does the protocol support?', sessionId: 'sess-1', taskId: 'task-1' });
  const result = await s.engine.run(task, { memoryPolicy });

  const stored = await memory.search({ query: 'transports', tags: ['research'], limit: 20 }, { policy: memoryPolicy });
  for (const entry of stored) {
    if (entry.type !== 'fact') continue;
    assert.ok(entry.metadata.confidence >= 0.6, 'an unconfident claim reached memory');
    assert.ok(Array.isArray(entry.metadata.citations) && entry.metadata.citations.length > 0, 'a remembered fact has no citations');
    assert.ok(entry.metadata.expiresAt > Date.now(), 'a remembered fact has no expiry');
  }
  void result;
});

test('integration: a time-sensitive answer is never remembered as fact', async () => {
  const bus = new EventBus();
  const memory = new MemoryManager({ bus });
  const s = createResearchSubsystem({ policy: openPolicy(), memory, bus, io: { searchProviders: { news: { sourceTypes: ['web', 'news'], async search() { return [{ title: 'Today', url: 'https://news.example/1', content: 'A vendor announced a new product today with pricing and availability details.' }]; } } } }, config: { allowNetworkedSources: true } });
  const memoryPolicy = { scopes: ['task', 'session'], ids: { task: 'task-1', session: 'sess-1' } };

  const task = s.engine.create({ question: 'What was announced this week?', sessionId: 'sess-1', taskId: 'task-1' });
  await s.engine.run(task, { memoryPolicy });
  // The run summary — "this question was researched" — is still recorded, and
  // is useful: it is how a later run sees what has already been tried. What is
  // refused is storing any of it as a *fact*, because a realtime answer is
  // stale before it is read, and only facts are ever served back as answers.
  const facts = (task.memory || []).filter((m) => m.def.type === 'fact');
  assert.deepEqual(facts, [], 'a realtime question must not be remembered as fact');
  const stored = await memory.search({ query: 'announced', tags: ['research'], limit: 20, type: 'fact' }, { policy: memoryPolicy });
  assert.deepEqual(stored, [], 'no fact entry may be retrievable for a realtime question');
});

// --- recovery ---------------------------------------------------------------

test('integration: research failures classify into the platform recovery vocabulary', () => {
  const { classifyError, CATEGORIES } = require('../src/core/recovery/recovery');
  const { SourceTimeoutError, SourceUnavailableError, ResearchDeniedError } = require('../src/core/research/errors/researchErrors');
  assert.equal(classifyError(new SourceTimeoutError('p', 100)), CATEGORIES.TIMEOUT);
  assert.equal(classifyError(new ResearchDeniedError('denied', {})), CATEGORIES.PERMISSION_DENIED);
  // An unavailable source is environmental, which the platform already knows
  // not to retry forever.
  assert.equal(classifyError(new SourceUnavailableError('p', 'gone')), CATEGORIES.UNKNOWN);
});

test('integration: a provider that fails is retried on the next provider, not the next run', async () => {
  let primary = 0;
  let backup = 0;
  const s = createResearchSubsystem({
    policy: openPolicy(),
    io: { searchProviders: {
      primary: { sourceTypes: ['web', 'documentation'], priority: 10, async search() { primary += 1; throw new Error('ETIMEDOUT upstream'); } },
      backup: { sourceTypes: ['web', 'documentation'], priority: 1, async search({ limit }) { backup += 1; return DOCS.slice(0, limit); } },
    } },
    config: { allowNetworkedSources: true },
  });
  const { result } = await s.researcher.answer('What transports does the protocol support?');
  assert.ok(primary > 0 && backup > 0);
  assert.ok(result.sources.length > 0);
  assert.ok(result.failures.some((f) => /ETIMEDOUT/.test(f.reason)), 'the failure must be recorded, not hidden');
});

// --- capability reporting ----------------------------------------------------

test('integration: an unconfigured source type says so instead of returning nothing', () => {
  const s = createResearchSubsystem({ io: {} });
  const caps = s.capabilities();
  const academic = caps.sources.find((x) => x.id === 'academic');
  assert.equal(academic.available, false);
  assert.match(academic.reason, /no provider is configured/);
});
