// Phase 6 end-to-end: a request goes in, skills are discovered, ranked,
// validated, loaded, executed, evaluated and recovered from — on the real
// platform, with the real policy engine, tool manager and approval manager.
//
// Also covers the two boundaries the app depends on: the IPC surface and the
// renderer's presentation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  renderSkillsPane, skillRowHtml, skillDetailHtml, planHtml, searchRowHtml,
  reliabilityLabel, mcpServerHtml,
} from '../src/renderer/skills-pane.mjs';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const { CHANNELS } = require('../src/core/security/ipc-guard.js');
const mainWiring = require('../src/main/agent-platform.js');
const { TYPES } = require('../src/core/events/event-bus.js');

async function platformWith(io = {}) {
  const platform = createPlatform({ io });
  await platform.initSkills({ actor: 'test' });
  return platform;
}

// --- the pipeline ------------------------------------------------------------

test('e2e: the built-in catalogue installs, validates and scans clean', async () => {
  const platform = await platformWith();
  const skills = platform.skills.registry.list();
  assert.ok(skills.length >= 20, `only ${skills.length} built-in skills installed`);
  for (const record of skills) {
    assert.equal(record.security.scanned, true, `${record.id} was not scanned`);
    assert.equal(record.security.blocked, false, `${record.id} was blocked`);
    assert.equal(record.trust.tier, 'builtin');
    assert.equal(record.state, 'enabled');
  }
  await platform.dispose();
});

test('e2e: §21 scenario 1 — "Build a REST API" reaches design, code, test and security', async () => {
  const platform = await platformWith();
  const plan = platform.skills.plan('Build a REST API.');
  const ids = plan.steps.map((s) => s.skillId);
  assert.ok(ids.includes('architecture-design') || ids.includes('implementation'), ids.join(','));
  assert.ok(ids.includes('test-authoring'), ids.join(','));
  assert.ok(ids.includes('security-audit'), ids.join(','));
  const phases = plan.pipeline.map((p) => p.phase);
  assert.ok(phases.indexOf('design') <= phases.indexOf('testing') || !phases.includes('design'));
  await platform.dispose();
});

test('e2e: §21 scenario 2 — "Create an MCP server for GitHub" reaches the MCP skills', async () => {
  const platform = await platformWith();
  const ids = platform.skills.plan('Create an MCP server for GitHub.').steps.map((s) => s.skillId);
  assert.ok(ids.includes('mcp-builder'), ids.join(','));
  assert.ok(ids.some((id) => id.startsWith('mcp-')), ids.join(','));
  await platform.dispose();
});

test('e2e: §21 scenario 4 — "Fix this broken project" reaches analysis, debugging and review', async () => {
  const platform = await platformWith();
  const ids = platform.skills.plan('Fix this broken project.').steps.map((s) => s.skillId);
  assert.ok(ids.includes('debugging'), ids.join(','));
  assert.ok(ids.includes('codebase-analysis'), ids.join(','));
  assert.ok(ids.includes('code-review'), ids.join(','));
  await platform.dispose();
});

test('e2e: §21 scenario 5 — "Create a multi-agent development team" reaches the team skill', async () => {
  const platform = await platformWith();
  const ids = platform.skills.plan('Create a multi-agent development team.').steps.map((s) => s.skillId);
  assert.ok(ids.includes('agent-team-builder'), ids.join(','));
  await platform.dispose();
});

test('e2e: with no runner wired, a run reports "prepared" rather than success', async () => {
  const platform = await platformWith();
  const run = await platform.skills.run({ request: 'Review this code', workspaceRoot: '/tmp' });
  assert.ok(run.results.length > 0);
  for (const row of run.results) {
    assert.equal(row.result.outcome, 'prepared');
    assert.equal(row.result.ok, false, 'a prepared run is not a success');
    assert.equal(row.result.neutral, true);
  }
  // And it does not inflate any skill's statistics.
  for (const record of platform.skills.registry.list()) assert.equal(record.stats.runs, 0);
  await platform.dispose();
});

test('e2e: a wired runner executes the pipeline and the evaluator scores it', async () => {
  const seen = [];
  const platform = await platformWith({
    skills: {
      runner: async ({ context, payload }) => {
        seen.push({ id: context.skill.id, bytes: payload.length, tools: context.allowedTools });
        return { summary: `${context.skill.id} done` };
      },
    },
  });
  const run = await platform.skills.run({ request: 'Review this code and write tests', workspaceRoot: '/tmp' });
  assert.equal(run.ok, true, run.reason);
  assert.ok(seen.length > 0);
  for (const row of run.results) {
    assert.equal(row.result.outcome, 'completed');
    assert.ok(row.evaluation.quality.score > 0);
  }
  const used = platform.skills.registry.get(seen[0].id);
  assert.equal(used.stats.runs, 1);
  assert.equal(used.state, 'active');
  await platform.dispose();
});

test('e2e: the payload handed to a runner carries provenance and an injection warning', async () => {
  let payload = null;
  const platform = await platformWith({ skills: { runner: async ({ payload: p }) => { payload = p; return { summary: 'ok' }; } } });
  await platform.skills.run({ request: 'Review this code', workspaceRoot: '/tmp' });
  assert.match(payload, /^# Skill: /);
  assert.match(payload, /trust: builtin/);
  assert.match(payload, /cannot grant permissions/);
  await platform.dispose();
});

test('e2e: a failing skill is recovered from with an alternative, and both are recorded', async () => {
  let calls = 0;
  const platform = await platformWith({
    skills: {
      runner: async ({ context }) => {
        calls += 1;
        if (context.skill.id === 'code-review') throw new Error('deliberate failure');
        return { summary: 'ok' };
      },
    },
  });
  const run = await platform.skills.run({ request: 'Review this pull request', workspaceRoot: '/tmp' });
  const reviewed = run.results.find((r) => r.skillId === 'code-review');
  assert.ok(reviewed, 'code-review should have been selected');
  assert.equal(reviewed.result.ok, false);
  assert.ok(calls > 1, 'a recovery attempt should have run');
  await platform.dispose();
});

test('e2e: a skill calling a tool it never declared is a security incident', async () => {
  const platform = await platformWith({
    skills: {
      runner: async ({ callTool }) => {
        await callTool('fs:read', { path: 'x' });
        return { summary: 'should not get here' };
      },
    },
  });
  const record = platform.skills.registry.get('code-review');
  const loaded = await platform.skills.loader.load(record);
  const { result } = await platform.skills.executor.execute(loaded, { workspaceRoot: '/tmp', agent: null });
  assert.equal(result.ok, false);
  assert.equal(result.securityIncident, true);
  await platform.skills.evaluator.record(record, result);
  assert.equal(record.state, 'quarantined', 'a security incident quarantines the skill');
  await platform.dispose();
});

test('e2e: policy can switch the whole skill layer off for an action', async () => {
  const platform = await platformWith({ skills: { runner: async () => ({ summary: 'ok' }) } });
  platform.policy.register({
    id: 'no-fs-write', scope: 'global', name: 'read-only deployment',
    rules: [{ action: 'filesystem.write', effect: 'deny', reason: 'this install is read-only' }],
  }, { source: 'human' });
  const record = platform.skills.registry.get('implementation'); // declares filesystem.write
  const loaded = await platform.skills.loader.load(record);
  const { result } = await platform.skills.executor.execute(loaded, { workspaceRoot: '/tmp' });
  assert.equal(result.outcome, 'denied');
  assert.equal(result.deniedBy, 'policy');
  await platform.dispose();
});

test('e2e: skill events reach the bus in the order a UI would show them', async () => {
  const events = [];
  const platform = await platformWith({ skills: { runner: async () => ({ summary: 'ok' }) } });
  platform.bus.on('*', (ev) => { if (ev.type.startsWith('skill.')) events.push(ev.type); });
  await platform.skills.run({ request: 'Review this code', workspaceRoot: '/tmp' });
  assert.ok(events.includes(TYPES.SKILL_SELECTED));
  assert.ok(events.includes(TYPES.SKILL_STARTED));
  assert.ok(events.includes(TYPES.SKILL_COMPLETED));
  assert.ok(events.includes(TYPES.SKILL_EVALUATED));
  assert.ok(events.indexOf(TYPES.SKILL_SELECTED) < events.indexOf(TYPES.SKILL_STARTED));
  await platform.dispose();
});

test('e2e: an MCP server connected through the layer is gated by the tool manager', async () => {
  const platform = await platformWith();
  await platform.mcp.connect({
    id: 'github', name: 'GitHub', transport: 'stdio',
    tools: [{ name: 'list_issues', description: 'Lists issues in a repository.' }, { name: 'delete_repo', description: 'Deletes a repository permanently.' }],
    invoke: async ({ tool }) => ({ tool }),
  });
  const surface = platform.mcp.controlView().surface;
  assert.equal(surface.length, 2);
  const destructive = surface.find((t) => t.tool === 'delete_repo');
  assert.equal(destructive.requiresAuth, true);
  assert.equal(destructive.level, 'destructive');
  await platform.dispose();
});

// --- IPC ---------------------------------------------------------------------

test('ipc: every skill and mcp channel has a handler and is on the guarded list', async () => {
  const platform = await platformWith();
  const handlers = new Map();
  mainWiring.createIpcHandlers({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, platform, forward: () => {} });
  const phase6 = Object.keys(CHANNELS).filter((c) => c.startsWith('skill:') || c.startsWith('mcp:'));
  assert.ok(phase6.length >= 20, `only ${phase6.length} phase 6 channels`);
  for (const channel of phase6) assert.ok(handlers.has(channel), `no handler for ${channel}`);
  await platform.dispose();
});

test('ipc: the preload surface is a subset of the guarded channels', async () => {
  const preload = await import('node:fs').then(({ readFileSync }) => readFileSync('src/main/preload.js', 'utf8'));
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  // The preload also carries the app's own channels (windowing, boot, the
  // browser) which are guarded elsewhere; this asserts about the Phase 6
  // surface, which must live entirely on the agent-platform guard list.
  for (const channel of invoked.filter((c) => c.startsWith('skill:') || c.startsWith('mcp:'))) {
    assert.ok(channel in CHANNELS, `preload invokes unguarded channel ${channel}`);
  }
  for (const channel of ['skill:list', 'skill:install', 'skill:quarantine', 'mcp:list']) {
    assert.ok(invoked.includes(channel), `preload does not expose ${channel}`);
  }
});

test('ipc: handlers answer the real platform, not a stub', async () => {
  const platform = await platformWith();
  const handlers = new Map();
  mainWiring.createIpcHandlers({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, platform, forward: () => {} });

  const list = await handlers.get('skill:list')(null, {});
  assert.equal(list.ok, true);
  assert.ok(list.data.skills.length >= 20);

  const plan = await handlers.get('skill:plan')(null, { request: 'Build a REST API' });
  assert.ok(plan.data.steps.length > 0);

  const content = await handlers.get('skill:content')(null, { id: 'code-review' });
  assert.match(content.data.instructions, /Code Review/);

  const audit = await handlers.get('skill:audit')(null, {});
  assert.ok(Array.isArray(audit.data.report));

  const disabled = await handlers.get('skill:disable')(null, { id: 'code-review' });
  assert.equal(disabled.data.state, 'disabled');
  const enabled = await handlers.get('skill:enable')(null, { id: 'code-review' });
  assert.equal(enabled.data.state, 'enabled');
  await platform.dispose();
});

test('ipc: a renderer cannot release a quarantine under a name it chose', async () => {
  const platform = await platformWith();
  const handlers = new Map();
  mainWiring.createIpcHandlers({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, platform, forward: () => {} });
  await handlers.get('skill:quarantine')(null, { id: 'code-review', reason: 'testing' });
  // The channel schema drops any actor the renderer supplies; the main process
  // attributes the release to the signed-in user.
  const released = await handlers.get('skill:release')(null, { id: 'code-review', note: 'reviewed', actor: 'root' });
  assert.equal(released.data.state, 'disabled');
  const record = platform.skills.registry.get('code-review');
  const entry = [...record.history].reverse().find((h) => h.to === 'disabled');
  assert.equal(entry.actor, 'user');
  await platform.dispose();
});

test('ipc: a hostile payload is refused before it reaches the platform', async () => {
  const platform = await platformWith();
  const handlers = new Map();
  mainWiring.createIpcHandlers({ ipcMain: { handle: (c, f) => handlers.set(c, f) }, platform, forward: () => {} });
  await assert.rejects(() => handlers.get('skill:install')(null, { source: 'github', repository: '../../etc' }), /invalid "repository"/);
  await assert.rejects(() => handlers.get('skill:install')(null, { source: 'local', path: '../../../etc/passwd' }), /invalid "path"/);
  await assert.rejects(() => handlers.get('skill:get')(null, { id: 'NOT VALID' }), /invalid "id"/);
  await platform.dispose();
});

// --- renderer ----------------------------------------------------------------

const SKILL_VIEW = {
  id: 'mcp-builder', name: 'MCP Builder', version: '1.0.0', description: 'Build MCP servers',
  permissions: ['process.execute', 'filesystem.write'], riskLevel: 'high', declaredRiskLevel: 'low', riskRaised: true,
  state: 'enabled', usable: true, origin: 'built-in', trust: { tier: 'builtin', verifiedBy: null },
  security: { findingCount: 1, findings: [{ id: 'x', severity: 'warn', summary: 'a warning', where: 'SKILL.md' }], sandboxRequired: true },
  stats: { runs: 0 }, quality: null, source: { type: 'builtin' }, categories: ['mcp-builder'], dependencies: [], history: [],
};

test('pane: a skill row states its trust, risk and what it may reach for', () => {
  const html = skillRowHtml(SKILL_VIEW);
  assert.match(html, /Built in/);
  assert.match(html, /High risk/);
  assert.match(html, /runs commands, writes files/);
  assert.match(html, /risk raised from low/);
  assert.match(html, /not run yet/);
});

test('pane: an unrun skill never renders a 0% success rate', () => {
  assert.equal(reliabilityLabel({}), 'not run yet');
  assert.equal(reliabilityLabel({ runs: 0 }), 'not run yet');
  assert.match(reliabilityLabel({ runs: 4, successes: 3, successRate: 0.75 }), /3\/4/);
});

test('pane: a quarantined skill offers release, never a direct enable', () => {
  const html = skillRowHtml({ ...SKILL_VIEW, state: 'quarantined', usable: false });
  assert.match(html, /data-skill-action="release"/);
  assert.doesNotMatch(html, /data-skill-action="enable"/);
});

test('pane: a remote search row is never shown as trusted or installed', () => {
  const html = searchRowHtml({ id: 'x', name: 'X', description: 'd', source: 'skills.sh', installed: false, installs: 10, permissions: [] });
  assert.match(html, /not yet fetched or scanned/);
  assert.match(html, /Available/);
});

test('pane: HTML is escaped, including hostile skill metadata', () => {
  const html = skillRowHtml({ ...SKILL_VIEW, name: '<img src=x onerror=alert(1)>', description: '"><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;script&gt;/);
});

test('pane: the plan preview names which skills will ask for approval', () => {
  const html = planHtml({
    summary: '2 skills selected',
    steps: [{ skillId: 'a', willRequestApproval: true }, { skillId: 'b', willRequestApproval: false }],
    pipeline: [{ phase: 'design', label: 'Design', skills: [{ skillId: 'a' }] }],
    gaps: [{ category: 'kubernetes', suggestion: 'search the configured sources' }],
  });
  assert.match(html, /Will ask for approval/);
  assert.match(html, /kubernetes/);
});

test('pane: the whole pane renders from a platform control view', async () => {
  const platform = await platformWith();
  const view = platform.skills.controlView({ request: 'Build a REST API' });
  const html = renderSkillsPane({
    skills: view.skills, stats: view.stats, plan: view.plan, sources: view.sources, concerns: view.concerns,
    mcp: platform.mcp.controlView(),
  });
  assert.match(html, /Skills/);
  assert.match(html, /installed/);
  assert.ok(html.includes('mcp-builder'));
  assert.doesNotMatch(html, /undefined/);
  await platform.dispose();
});

test('pane: an MCP row shows the tool classes and whether it is trusted', () => {
  const html = mcpServerHtml({
    id: 'github', name: 'GitHub', transport: 'stdio', state: 'connected', risk: 'critical',
    byClass: { READ_ONLY: 3, DESTRUCTIVE: 1 }, tools: [{}, {}, {}, {}], trusted: false, conflicts: ['annotation conflict'],
  });
  assert.match(html, /read_only|3×read_only/);
  assert.match(html, /Critical risk/);
  assert.match(html, /not marked trusted/);
  assert.match(html, /annotation conflict/);
});

test('pane: skill detail explains a quality score rather than printing a bare number', () => {
  const html = skillDetailHtml({
    ...SKILL_VIEW,
    quality: { score: 0.72, grade: 'good', summary: 'good (72/100, moderate confidence). strongest: security …' },
  });
  assert.match(html, /good · 72\/100/);
  assert.match(html, /strongest: security/);
});
