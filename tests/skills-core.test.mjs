// Phase 6 unit tests: manifests, versions, provenance, the registry and the
// dependency graph. Everything here runs without a platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateManifest } = require('../src/core/skills/schemas/SkillManifest.js');
const V = require('../src/core/skills/registry/SkillVersion.js');
const S = require('../src/core/skills/registry/SkillSource.js');
const { SkillRegistry } = require('../src/core/skills/registry/SkillRegistry.js');
const { SkillRecord } = require('../src/core/skills/registry/SkillMetadata.js');
const states = require('../src/core/skills/lifecycle/states.js');
const { SkillCache, digestOf, digestOfSkill } = require('../src/core/skills/cache/SkillCache.js');
const dep = require('../src/core/skills/loader/SkillDependencyResolver.js');
const taxonomy = require('../src/core/skills/taxonomy.js');
const perms = require('../src/core/skills/schemas/SkillPermissionSchema.js');

const manifest = (over = {}) => ({
  id: 'demo', name: 'Demo', version: '1.0.0', description: 'A demo skill',
  categories: ['implementation'], source: { type: 'builtin' }, ...over,
});

// --- manifest ----------------------------------------------------------------

test('manifest: a valid manifest normalizes and freezes', () => {
  const { ok, manifest: m } = validateManifest(manifest({ capabilities: ['code.write'], tags: ['b', 'a'] }));
  assert.equal(ok, true);
  assert.deepEqual([...m.tags], ['a', 'b']);
  assert.equal(Object.isFrozen(m), true);
});

test('manifest: executable fields are refused, not sanitized', () => {
  for (const key of ['command', 'postInstall', 'scripts', 'env', 'hooks']) {
    const res = validateManifest(manifest({ [key]: ['anything'] }));
    assert.equal(res.ok, false, `${key} must be refused`);
    assert.match(res.errors[0], /may not declare/);
  }
});

test('manifest: categories must come from the taxonomy', () => {
  assert.equal(validateManifest(manifest({ categories: ['made-up'] })).ok, false);
  assert.equal(validateManifest(manifest({ categories: [] })).ok, false);
  assert.equal(validateManifest(manifest({ categories: ['mcp-builder'] })).ok, true);
});

test('manifest: a declared risk level is raised to what the permissions imply', () => {
  const { manifest: m } = validateManifest(manifest({ permissions: ['process.execute'], riskLevel: 'low' }));
  assert.equal(m.riskLevel, 'high');
  assert.equal(m.declaredRiskLevel, 'low');
  assert.equal(m.riskRaised, true);
});

test('manifest: risk is never lowered below the declaration', () => {
  const { manifest: m } = validateManifest(manifest({ permissions: ['filesystem.read'], riskLevel: 'critical' }));
  assert.equal(m.riskLevel, 'critical');
  assert.equal(m.riskRaised, false);
});

test('manifest: entry paths cannot escape the skill', () => {
  assert.equal(validateManifest(manifest({ entry: '../../etc/passwd' })).ok, false);
  assert.equal(validateManifest(manifest({ entry: { instructions: 'SKILL.md', resources: ['../x'] } })).ok, false);
  assert.equal(validateManifest(manifest({ entry: { instructions: 'docs/SKILL.md' } })).ok, true);
});

test('manifest: an mcp server entry may name a server but never start one', () => {
  assert.equal(validateManifest(manifest({ mcp: { servers: ['github'] } })).ok, true);
  const res = validateManifest(manifest({ mcp: { servers: [{ id: 'evil', command: 'curl' }] } }));
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /may not carry command/);
});

test('manifest: dependencies accept three spellings and reject junk', () => {
  const { manifest: m } = validateManifest(manifest({ dependencies: ['a@^1.0.0', 'b', { id: 'c', version: '~2.0.0' }] }));
  assert.deepEqual(m.dependencies.map((d) => `${d.id}@${d.range}`), ['a@^1.0.0', 'b@*', 'c@~2.0.0']);
  assert.equal(validateManifest(manifest({ dependencies: [{ id: 'A B', version: '1' }] })).ok, false);
  assert.equal(validateManifest(manifest({ dependencies: ['a', 'a'] })).ok, false);
});

// --- versions ----------------------------------------------------------------

test('version: ranges behave like npm for the supported subset', () => {
  assert.equal(V.satisfies('1.4.0', '^1.2.3'), true);
  assert.equal(V.satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(V.satisfies('0.2.9', '^0.2.3'), true);
  assert.equal(V.satisfies('0.3.0', '^0.2.3'), false);
  assert.equal(V.satisfies('1.2.9', '~1.2.3'), true);
  assert.equal(V.satisfies('1.3.0', '~1.2.3'), false);
  assert.equal(V.satisfies('9.9.9', '*'), true);
  assert.equal(V.satisfies('1.0.0', '>=1.0.0'), true);
});

test('version: prereleases sort below the release and diffKind names the bump', () => {
  assert.equal(V.compareVersions('1.0.0-beta.2', '1.0.0'), -1);
  assert.equal(V.compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(V.diffKind('1.0.0', '2.0.0'), 'major');
  assert.equal(V.diffKind('1.0.0', '1.1.0'), 'minor');
  assert.equal(V.diffKind('1.0.0', '1.0.1'), 'patch');
  assert.equal(V.diffKind('2.0.0', '1.0.0'), 'downgrade');
});

test('version: garbage does not parse', () => {
  for (const v of ['1', '1.0', 'v1.0.0', '1.0.0.0', '', null, 'latest']) assert.equal(V.isVersion(v), false, String(v));
});

// --- provenance --------------------------------------------------------------

test('source: a repository that looks like a traversal is refused', () => {
  assert.equal(S.validateSource({ type: 'github', repository: '../evil' }).ok, false);
  assert.equal(S.validateSource({ type: 'github', repository: 'MOT1209/KingAgent' }).ok, true);
});

test('source: refs and paths cannot climb', () => {
  assert.equal(S.validateSource({ type: 'github', repository: 'a/b', ref: '../../x' }).ok, false);
  assert.equal(S.validateSource({ type: 'github', repository: 'a/b', ref: 'refs/tags/v1' }).ok, true);
  assert.equal(S.validateSource({ type: 'local', directory: '/tmp', path: '../../etc' }).ok, false);
});

test('source: only an immutable ref earns community trust', () => {
  assert.equal(S.baseTrust(S.normalize({ type: 'github', ref: 'main' })), 'untrusted');
  assert.equal(S.baseTrust(S.normalize({ type: 'github', ref: 'a'.repeat(40) })), 'community');
  assert.equal(S.baseTrust(S.normalize({ type: 'builtin' })), 'builtin');
  assert.equal(S.baseTrust(S.normalize({ type: 'local' })), 'workspace');
});

// --- lifecycle states --------------------------------------------------------

test('states: quarantine is one-way apart from disable and remove', () => {
  assert.deepEqual([...states.TRANSITIONS.quarantined], ['disabled', 'removed']);
  assert.equal(states.canTransition('quarantined', 'enabled'), false);
  assert.equal(states.canTransition('quarantined', 'active'), false);
  assert.equal(states.canTransition('quarantined', 'disabled'), true);
});

test('states: a failed skill cannot jump straight back to active', () => {
  assert.equal(states.canTransition('failed', 'active'), false);
  assert.equal(states.canTransition('failed', 'validating'), true);
});

test('states: removed is terminal', () => {
  assert.equal(states.isTerminal('removed'), true);
  assert.deepEqual([...states.TRANSITIONS.removed], []);
});

// --- registry ----------------------------------------------------------------

function registryWith(...specs) {
  const registry = new SkillRegistry({});
  for (const spec of specs) {
    const record = registry.register(spec);
    registry.transition(record, 'validating');
    registry.transition(record, 'installed');
    registry.transition(record, 'enabled');
  }
  return registry;
}

test('registry: get() returns the highest usable version', () => {
  const registry = registryWith(manifest({ id: 'a', version: '1.0.0' }), manifest({ id: 'a', version: '1.5.0' }));
  assert.equal(registry.get('a').version, '1.5.0');
  assert.equal(registry.get('a', '~1.0.0').version, '1.0.0');
  assert.equal(registry.getExact('a', '1.0.0').version, '1.0.0');
});

test('registry: a disabled version is not selectable but is still listed', () => {
  const registry = registryWith(manifest({ id: 'a', version: '1.0.0' }));
  const record = registry.get('a');
  registry.transition(record, 'disabled', { reason: 'test' });
  assert.equal(registry.selectable().length, 0);
  assert.equal(registry.list().length, 1);
});

test('registry: an illegal transition throws rather than being applied', () => {
  const registry = registryWith(manifest({ id: 'a' }));
  const record = registry.get('a');
  registry.transition(record, 'quarantined', { reason: 'test' });
  assert.throws(() => registry.transition(record, 'enabled'), /quarantined/);
  assert.equal(record.state, 'quarantined');
});

test('registry: a record round-trips through JSON without losing its state', () => {
  const registry = registryWith(manifest({ id: 'a', permissions: ['process.execute'] }));
  const record = registry.get('a');
  record.recordRun({ ok: false, error: 'boom', durationMs: 5 });
  record.transition('quarantined', { reason: 'failure streak' });
  const restored = SkillRecord.fromJSON(JSON.parse(JSON.stringify(record.toJSON())));
  assert.equal(restored.state, 'quarantined');
  assert.equal(restored.stats.failures, 1);
  assert.equal(restored.manifest.riskLevel, 'high');
  assert.equal(restored.usable, false);
});

test('registry: shouldQuarantine fires on a failure streak and on an incident', () => {
  const registry = registryWith(manifest({ id: 'a' }));
  const record = registry.get('a');
  record.recordRun({ ok: false, error: 'x' });
  record.recordRun({ ok: false, error: 'x' });
  assert.equal(record.shouldQuarantine().quarantine, false);
  record.recordRun({ ok: false, error: 'x' });
  assert.equal(record.shouldQuarantine().quarantine, true);

  const other = new SkillRecord({ manifest: validateManifest(manifest({ id: 'b' })).manifest });
  other.recordRun({ ok: true, securityIncident: true });
  assert.equal(other.shouldQuarantine().quarantine, true);
});

test('registry: successRate is null before any run, never zero', () => {
  const record = new SkillRecord({ manifest: validateManifest(manifest()).manifest });
  assert.equal(record.successRate(), null);
  assert.equal(record.averageDurationMs(), null);
});

// --- dependencies ------------------------------------------------------------

test('dependencies: resolution is dependency-first', () => {
  const registry = registryWith(
    manifest({ id: 'a', dependencies: ['b@^1.0.0'] }),
    manifest({ id: 'b', dependencies: ['c'] }),
    manifest({ id: 'c' }),
  );
  const out = dep.resolve({ roots: ['a'], registry });
  assert.equal(out.ok, true);
  assert.deepEqual(out.order.map((r) => r.id), ['c', 'b', 'a']);
});

test('dependencies: a cycle is named, not broken silently', () => {
  const registry = registryWith(manifest({ id: 'x', dependencies: ['y'] }), manifest({ id: 'y', dependencies: ['x'] }));
  const out = dep.resolve({ roots: ['x'], registry });
  assert.equal(out.ok, false);
  assert.deepEqual(out.cycle, ['x', 'y', 'x']);
});

test('dependencies: a missing or unsatisfiable dependency is reported', () => {
  const registry = registryWith(manifest({ id: 'a', dependencies: ['gone@^2.0.0'] }));
  const out = dep.resolve({ roots: ['a'], registry });
  assert.equal(out.ok, false);
  assert.equal(out.missing[0].id, 'gone');
});

test('dependencies: an unsupported platform stops resolution', () => {
  const registry = registryWith(manifest({ id: 'a', supportedPlatforms: ['macos'] }));
  const out = dep.resolve({ roots: ['a'], registry, platform: 'windows' });
  assert.equal(out.ok, false);
  assert.equal(out.incompatible[0].id, 'a');
});

test('dependencies: removal is blocked while something still needs it', () => {
  const registry = registryWith(manifest({ id: 'a', dependencies: ['b'] }), manifest({ id: 'b' }));
  assert.equal(dep.canRemove(registry, 'b').ok, false);
  assert.equal(dep.canRemove(registry, 'a').ok, true);
  assert.deepEqual(dep.dependents(registry, 'b').map((d) => d.id), ['a']);
});

// --- cache -------------------------------------------------------------------

test('cache: entries expire and a skill can be invalidated wholesale', () => {
  let now = 1000;
  const cache = new SkillCache({ ttlMs: 100, clock: () => now });
  cache.set('a@1.0.0', { content: 'hello' });
  assert.equal(cache.get('a@1.0.0').content, 'hello');
  now += 200;
  assert.equal(cache.get('a@1.0.0'), null);

  cache.set('b@1.0.0#local', { content: 'x' });
  cache.set('b@2.0.0#local', { content: 'y' });
  assert.equal(cache.invalidateSkill('b'), 2);
});

test('cache: the digest is content-addressed, so a changed byte changes the key', () => {
  assert.equal(digestOf('abc'), digestOf('abc'));
  assert.notEqual(digestOf('abc'), digestOf('abd'));
});

// A skill is the instructions *and* the resources they point at. Both are prompt
// text, so a digest that covers only the entry document pins the smaller half.
test('cache: the digest a skill is pinned to covers every resource', () => {
  const skill = (resources, content = 'Read the checklist.') => ({ content, resources });

  assert.equal(digestOfSkill(skill({ 'notes.md': 'Be careful.' })), digestOfSkill(skill({ 'notes.md': 'Be careful.' })));
  // The order a source happened to read the resources in is not part of the value.
  assert.equal(digestOfSkill(skill({ 'a.md': 'one', 'b.md': 'two' })), digestOfSkill(skill({ 'b.md': 'two', 'a.md': 'one' })));
  // Changing, adding or removing one is a different skill...
  assert.notEqual(digestOfSkill(skill({ 'notes.md': 'Be careful.' })), digestOfSkill(skill({ 'notes.md': 'Be careful!' })));
  assert.notEqual(digestOfSkill(skill({ 'notes.md': 'x' })), digestOfSkill(skill({ 'notes.md': 'x', 'more.md': 'y' })));
  assert.notEqual(digestOfSkill(skill({ 'notes.md': 'x' })), digestOfSkill(skill({})));
  // ...and so is an empty one, which a digest over concatenated values would miss.
  assert.notEqual(digestOfSkill(skill({ 'notes.md': '' })), digestOfSkill(skill({})));
  // The instructions are still covered.
  assert.notEqual(digestOfSkill(skill({ 'notes.md': 'x' }, 'Read the checklist.')), digestOfSkill(skill({ 'notes.md': 'x' }, 'Read the checklist!')));
  // A digest taken under the previous scheme can never pass as one taken under
  // this one — which is what makes widening the coverage force a re-scan.
  assert.notEqual(digestOfSkill(skill({}, 'abc')), digestOf('abc'));
});

test('cache: set() pins the resources it is handed, not just the instructions', () => {
  const cache = new SkillCache({});
  const first = { content: 'x', resources: { 'notes.md': 'one' } };
  cache.set('a@1.0.0#local', first);
  cache.set('b@1.0.0#local', { content: 'x', resources: { 'notes.md': 'two' } });

  assert.equal(cache.get('a@1.0.0#local').digest, digestOfSkill(first));
  assert.notEqual(cache.get('a@1.0.0#local').digest, cache.get('b@1.0.0#local').digest);
});

// --- taxonomy + permissions --------------------------------------------------

test('taxonomy: every implication points at a real category', () => {
  for (const [from, list] of Object.entries(taxonomy.IMPLIES)) {
    assert.equal(taxonomy.isCategory(from), true, `${from} is not a category`);
    for (const to of list) assert.equal(taxonomy.isCategory(to), true, `${from} implies unknown ${to}`);
  }
});

test('taxonomy: every category belongs to exactly one group', () => {
  const seen = new Map();
  for (const [group, list] of Object.entries(taxonomy.GROUPS)) {
    for (const c of list) {
      assert.equal(seen.has(c), false, `${c} appears in two groups`);
      seen.set(c, group);
    }
  }
  assert.equal(seen.size, taxonomy.CATEGORIES.length);
});

test('permissions: each one maps to a policy action and a risk floor', () => {
  for (const name of perms.PERMISSION_NAMES) {
    assert.ok(perms.actionFor(name), `${name} has no policy action`);
    assert.ok(perms.RISK_LEVELS.includes(perms.PERMISSIONS[name].risk));
  }
  assert.equal(perms.derivedRisk(['filesystem.read']), 'low');
  assert.equal(perms.derivedRisk(['filesystem.read', 'credential.read']), 'critical');
  assert.deepEqual(perms.actionsFor(['filesystem.read', 'filesystem.read']), ['filesystem.read']);
});
