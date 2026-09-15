// Phase 6: installation, update, removal, enable/disable/quarantine, and the
// evaluator that decides a skill has stopped being worth selecting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SkillRegistry } = require('../src/core/skills/registry/SkillRegistry.js');
const { SkillInstaller } = require('../src/core/skills/lifecycle/SkillInstaller.js');
const { SkillUpdater } = require('../src/core/skills/lifecycle/SkillUpdater.js');
const { SkillRemover } = require('../src/core/skills/lifecycle/SkillRemover.js');
const { SkillEnabler } = require('../src/core/skills/lifecycle/SkillEnabler.js');
const { SkillEvaluator } = require('../src/core/skills/evaluation/SkillEvaluator.js');
const Quality = require('../src/core/skills/evaluation/SkillQualityScore.js');
const { SkillCache } = require('../src/core/skills/cache/SkillCache.js');
const { BuiltinSkillSource } = require('../src/core/skills/sources/BuiltinSkillSource.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');
const { PolicyManager } = require('../src/core/policy');
const SkillResult = require('../src/core/skills/runtime/SkillResult.js');

// A source whose content and versions the test controls.
function fakeSource(state) {
  return {
    id: 'skills.sh',
    type: 'skills.sh',
    async fetch({ id }) {
      const entry = state[id];
      if (!entry) throw new Error(`no ${id}`);
      return {
        manifest: { ...entry.manifest, source: { type: 'skills.sh', slug: id, digest: entry.digest } },
        content: entry.content,
        resources: {},
        digest: entry.digest,
      };
    },
    async find({ id }) {
      const entry = state[id];
      return entry ? { id, version: entry.manifest.version, name: id, description: 'd', source: 'skills.sh' } : null;
    },
    async read({ id }) { return { content: state[id].content, resources: {} }; },
  };
}

function harness({ policy = null, state = {} } = {}) {
  const bus = new EventBus();
  const events = [];
  bus.on('*', (ev) => { if (ev.type.startsWith('skill.')) events.push(ev); });
  const registry = new SkillRegistry({ bus });
  const cache = new SkillCache({});
  const sources = { 'skills.sh': fakeSource(state), builtin: new BuiltinSkillSource() };
  const installer = new SkillInstaller({ registry, sources, policy, cache, bus, platform: 'linux' });
  const enabler = new SkillEnabler({ registry, bus, policy });
  return {
    bus, events, registry, cache, sources, installer, enabler,
    updater: new SkillUpdater({ registry, installer, sources, cache, bus }),
    remover: new SkillRemover({ registry, cache, bus }),
    evaluator: new SkillEvaluator({ registry, enabler, bus }),
  };
}

const spec = (over = {}) => ({
  id: 'demo', name: 'Demo', version: '1.0.0', description: 'A skill', categories: ['implementation'], ...over,
});

// --- install -----------------------------------------------------------------

test('install: a validated skill lands enabled with its digest pinned', async () => {
  const state = { demo: { manifest: spec(), content: 'Do the work.', digest: 'a'.repeat(64) } };
  const h = harness({ state });
  const result = await h.installer.install({ source: 'skills.sh', id: 'demo' }, { approve: () => true });
  assert.equal(result.installed, true);
  assert.equal(result.record.state, 'enabled');
  assert.equal(result.record.contentDigest, 'a'.repeat(64));
  assert.equal(result.record.trust.tier, 'community', 'a digest-pinned skills.sh skill is community, not builtin');
});

test('install: installing the same version twice is a reported no-op', async () => {
  const state = { demo: { manifest: spec(), content: 'Do the work.', digest: 'a'.repeat(64) } };
  const h = harness({ state });
  await h.installer.install({ source: 'skills.sh', id: 'demo' }, { approve: () => true });
  const again = await h.installer.install({ source: 'skills.sh', id: 'demo' }, { approve: () => true });
  assert.equal(again.installed, false);
  assert.match(again.reason, /already installed/);
});

test('install: dependencies are installed first and on their own terms', async () => {
  const state = {
    parent: { manifest: spec({ id: 'parent', dependencies: ['child@^1.0.0'] }), content: 'Parent.', digest: 'b'.repeat(64) },
    child: { manifest: spec({ id: 'child' }), content: 'Child.', digest: 'c'.repeat(64) },
  };
  const h = harness({ state });
  const approvals = [];
  const result = await h.installer.install({ source: 'skills.sh', id: 'parent' }, {
    approve: ({ manifest }) => { approvals.push(manifest.id); return true; },
  });
  assert.deepEqual(result.dependencies.map((d) => d.id), ['child']);
  assert.deepEqual(approvals.sort(), ['child', 'parent'], 'a dependency is approved on its own, not inherited');
  assert.equal(h.registry.has('child'), true);
});

test('install: built-in skills install without an approval prompt but not without validation', async () => {
  const h = harness({});
  let asked = 0;
  const result = await h.installer.installBuiltins({ actor: 'system' });
  assert.equal(asked, 0);
  assert.ok(result.installed.length > 15);
  assert.deepEqual(result.failed, []);
  for (const record of h.registry.list()) assert.equal(record.security.scanned, true);
});

test('install: inspect reports without touching the registry', async () => {
  const state = { demo: { manifest: spec(), content: 'Do the work.', digest: 'a'.repeat(64) } };
  const h = harness({ state });
  const verdict = await h.installer.inspect({ source: 'skills.sh', id: 'demo' });
  assert.equal(verdict.ok, true);
  assert.equal(h.registry.count(), 0);
  assert.ok(verdict.request.summary.length > 0);
});

// --- update ------------------------------------------------------------------

test('update: a newer version replaces the old one and keeps the track record', async () => {
  const state = { demo: { manifest: spec(), content: 'v1', digest: 'a'.repeat(64) } };
  const h = harness({ state });
  const first = await h.installer.install({ source: 'skills.sh', id: 'demo' }, { approve: () => true });
  first.record.recordRun({ ok: true, durationMs: 10 });

  state.demo = { manifest: spec({ version: '1.1.0' }), content: 'v1.1', digest: 'd'.repeat(64) };
  const result = await h.updater.update('demo', { approve: () => true });
  assert.equal(result.updated, true);
  assert.equal(result.to, '1.1.0');
  assert.equal(result.kind, 'minor');
  assert.equal(h.registry.get('demo').stats.runs, 1, 'run history carries forward');
  assert.equal(h.registry.all('demo').length, 1, 'the old version is retired');
});

test('update: new permissions in an update are reported, not absorbed', async () => {
  const state = { demo: { manifest: spec(), content: 'v1', digest: 'a'.repeat(64) } };
  const h = harness({ state });
  await h.installer.install({ source: 'skills.sh', id: 'demo' }, { approve: () => true });
  state.demo = { manifest: spec({ version: '2.0.0', permissions: ['process.execute'] }), content: 'v2', digest: 'e'.repeat(64) };
  const result = await h.updater.update('demo', { approve: () => true });
  assert.deepEqual(result.permissionsAdded, ['process.execute']);
  assert.equal(result.kind, 'major');
});

test('update: a declined update leaves the working version in place', async () => {
  const state = { demo: { manifest: spec(), content: 'v1', digest: 'a'.repeat(64) } };
  const h = harness({ state });
  await h.installer.install({ source: 'skills.sh', id: 'demo' }, { approve: () => true });
  state.demo = { manifest: spec({ version: '1.2.0' }), content: 'v2', digest: 'f'.repeat(64) };
  await assert.rejects(() => h.updater.update('demo', { approve: () => false }), /not approved/);
  assert.equal(h.registry.get('demo').version, '1.0.0');
});

test('update: check() reports without installing anything', async () => {
  const state = { demo: { manifest: spec(), content: 'v1', digest: 'a'.repeat(64) } };
  const h = harness({ state });
  await h.installer.install({ source: 'skills.sh', id: 'demo' }, { approve: () => true });
  state.demo = { manifest: spec({ version: '3.0.0' }), content: 'v3', digest: '0'.repeat(64) };
  const check = await h.updater.check('demo');
  assert.equal(check.available, true);
  assert.equal(check.requiresApproval, true, 'a major bump always re-asks');
  assert.equal(h.registry.get('demo').version, '1.0.0');
});

// --- remove ------------------------------------------------------------------

test('remove: a skill something depends on is not removed silently', async () => {
  const state = {
    parent: { manifest: spec({ id: 'parent', dependencies: ['child'] }), content: 'P', digest: 'b'.repeat(64) },
    child: { manifest: spec({ id: 'child' }), content: 'C', digest: 'c'.repeat(64) },
  };
  const h = harness({ state });
  await h.installer.install({ source: 'skills.sh', id: 'parent' }, { approve: () => true });
  await assert.rejects(() => h.remover.remove('child'), /cannot be removed/);
  const forced = await h.remover.remove('child', { force: true });
  assert.equal(forced.forced, true);
  assert.deepEqual(forced.brokenDependents.map((d) => d.id), ['parent']);
});

test('remove: built-in skills cannot be removed by source', async () => {
  const h = harness({});
  await assert.rejects(() => h.remover.removeBySource('builtin'), /part of the application/);
});

test('remove: the record is gone and the cache with it', async () => {
  const state = { demo: { manifest: spec(), content: 'x', digest: 'a'.repeat(64) } };
  const h = harness({ state });
  await h.installer.install({ source: 'skills.sh', id: 'demo' }, { approve: () => true });
  h.cache.set('demo@1.0.0#skills.sh', { content: 'x' });
  await h.remover.remove('demo');
  assert.equal(h.registry.has('demo'), false);
  assert.equal(h.cache.get('demo@1.0.0#skills.sh'), null);
});

// --- enable / disable / quarantine -------------------------------------------

test('quarantine: the platform may quarantine, only a person may release', async () => {
  const h = harness({});
  await h.installer.installBuiltins({});
  const id = h.registry.ids()[0];
  h.enabler.quarantine(id, { reason: 'failure streak' });
  await assert.rejects(() => h.enabler.enable(id), /quarantined/);
  assert.throws(() => h.enabler.release(id, { actor: 'system' }), /named person/);
  const released = h.enabler.release(id, { actor: 'hamad', note: 'reviewed the findings' });
  assert.equal(released.state, 'disabled', 'release lands in disabled, never straight back in service');
});

test('quarantine: a reason is mandatory — it is evidence, not a flag', async () => {
  const h = harness({});
  await h.installer.installBuiltins({});
  assert.throws(() => h.enabler.quarantine(h.registry.ids()[0], {}), /requires a reason/);
});

test('enable: policy can forbid enabling a skill', async () => {
  const policy = new PolicyManager({ defaultEffect: 'allow' });
  policy.register({
    id: 'locked', scope: 'global', name: 'no new skills',
    rules: [{ action: 'skill.enable', effect: 'deny', reason: 'skills are managed centrally here' }],
  }, { source: 'human' });
  const h = harness({ policy });
  await h.installer.installBuiltins({ autoEnable: false });
  const id = h.registry.ids()[0];
  await assert.rejects(() => h.enabler.enable(id), /policy denies enabling/);
});

// --- evaluation --------------------------------------------------------------

test('evaluator: three consecutive failures quarantine a skill automatically', async () => {
  const h = harness({});
  await h.installer.installBuiltins({});
  const record = h.registry.get(h.registry.ids()[0]);
  for (let i = 0; i < 3; i++) {
    await h.evaluator.record(record, SkillResult.failed(record, { error: 'boom' }));
  }
  assert.equal(record.state, 'quarantined');
  assert.ok(h.events.some((e) => e.type === TYPES.SKILL_QUARANTINED));
});

test('evaluator: one security incident quarantines immediately', async () => {
  const h = harness({});
  await h.installer.installBuiltins({});
  const record = h.registry.get(h.registry.ids()[1]);
  await h.evaluator.record(record, SkillResult.failed(record, { error: 'denied', securityIncident: true }));
  assert.equal(record.state, 'quarantined');
});

test('evaluator: a successful run makes a skill active', async () => {
  const h = harness({});
  await h.installer.installBuiltins({});
  const record = h.registry.get(h.registry.ids()[2]);
  // The path a real run takes: the loader marks it loaded, the executor marks
  // it running, and only then is there a result to evaluate.
  h.registry.transition(record, 'loaded', { reason: 'test' });
  h.registry.transition(record, 'running', { reason: 'test' });
  await h.evaluator.record(record, SkillResult.completed(record, { summary: 'done', durationMs: 20 }));
  assert.equal(record.state, 'active');
  assert.equal(record.stats.successes, 1);
});

test('evaluator: a prepared result does not count as a run', async () => {
  const h = harness({});
  await h.installer.installBuiltins({});
  const record = h.registry.get(h.registry.ids()[3]);
  const prepared = SkillResult.prepared(record, {});
  assert.equal(prepared.ok, false);
  assert.equal(prepared.neutral, true);
});

test('quality: an unrun skill is "unproven", not "failing"', () => {
  const h = harness({});
  const registry = h.registry;
  const record = registry.register(spec());
  const score = Quality.score(record);
  assert.equal(score.grade, 'unproven');
  assert.equal(score.confidenceLabel, 'low');
  assert.ok(score.caveats.some((c) => /never run/.test(c)));
});

test('quality: the score always carries its components and caveats', async () => {
  const h = harness({});
  await h.installer.installBuiltins({});
  const record = h.registry.get(h.registry.ids()[0]);
  for (let i = 0; i < 12; i++) record.recordRun({ ok: true, durationMs: 5 });
  const score = h.evaluator.rescore(record);
  assert.equal(score.components.length, Object.keys(Quality.WEIGHTS).length);
  for (const c of score.components) assert.ok(c.explanation.length > 5, `${c.name} has no explanation`);
  assert.ok(score.confidence >= 0.7);
  assert.match(score.summary, /strongest/);
});

test('quality: a security incident caps the score regardless of success rate', async () => {
  const h = harness({});
  await h.installer.installBuiltins({});
  const record = h.registry.get(h.registry.ids()[0]);
  for (let i = 0; i < 20; i++) record.recordRun({ ok: true, durationMs: 1 });
  const clean = Quality.score(record).score;
  record.recordRun({ ok: true, securityIncident: true });
  const dirty = Quality.score(record).score;
  assert.ok(dirty < clean);
  assert.equal(Quality.score(record).components.find((c) => c.name === 'security').value, 0);
});
