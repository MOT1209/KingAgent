// Phase 6: discovery, ranking, search, recommendation and the scenario
// benchmarks. These test the layer that decides *which* skills a task needs,
// which is the part that decays silently if nothing checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../src/core/skills/discovery/SkillDiscovery.js');
const R = require('../src/core/skills/discovery/SkillRanking.js');
const Search = require('../src/core/skills/discovery/SkillSearch.js');
const Rec = require('../src/core/skills/discovery/SkillRecommendation.js');
const B = require('../src/core/skills/evaluation/SkillBenchmarks.js');
const { SkillRegistry } = require('../src/core/skills/registry/SkillRegistry.js');

function registryWith(specs) {
  const registry = new SkillRegistry({});
  for (const spec of specs) {
    const record = registry.register({
      id: spec.id, name: spec.id, version: spec.version || '1.0.0', description: spec.description || 'x',
      categories: spec.categories, capabilities: spec.capabilities || [], permissions: spec.permissions || [],
      tags: spec.tags || [],
      source: spec.sourceType === 'skills.sh' ? { type: 'skills.sh', slug: spec.id } : { type: spec.sourceType || 'builtin' },
    });
    registry.transition(record, 'validating');
    registry.transition(record, 'installed');
    registry.transition(record, 'enabled');
    if (spec.stats) Object.assign(record.stats, spec.stats);
    if (spec.state && spec.state !== 'enabled') registry.transition(record, spec.state, { reason: 'test' });
    if (spec.trust) record.setTrust({ tier: spec.trust, verifiedBy: 'tester' });
  }
  return registry;
}

// --- discovery ---------------------------------------------------------------

test('discovery: a request selects the categories it names', () => {
  const { categories } = D.analyze('Review this pull request and refactor the module');
  const names = categories.map((c) => c.category);
  assert.ok(names.includes('code-review'));
  assert.ok(names.includes('refactoring'));
});

test('discovery: a longer phrase beats the shorter one inside it', () => {
  const names = D.analyze('create an mcp server').categories.map((c) => c.category);
  assert.ok(names.includes('mcp-builder'), 'mcp server must select the builder');
  const bare = D.analyze('what is mcp').categories.map((c) => c.category);
  assert.ok(bare.includes('mcp-discovery'));
  assert.equal(bare.includes('mcp-builder'), false);
});

test('discovery: implications fill in what practice requires but nobody types', () => {
  const names = D.analyze('Build a REST API').categories.map((c) => c.category);
  assert.ok(names.includes('api-design'));
  assert.ok(names.includes('unit-testing'), 'implementation implies testing');
  assert.ok(names.includes('security-audit'), 'an API implies a security pass');
});

test('discovery: implication is one level deep, so a short request stays narrow', () => {
  const result = D.analyze('deploy it');
  assert.ok(result.categories.length <= D.MAX_CATEGORIES);
  const implied = result.categories.filter((c) => c.evidence.some((e) => e.startsWith('implied by')));
  for (const entry of implied) {
    // Nothing implied by an implied category: every implication's source must
    // itself have been matched directly.
    const source = entry.evidence.find((e) => e.startsWith('implied by')).match(/"([^"]+)"/)[1];
    const sourceEntry = result.categories.find((c) => c.category === source);
    assert.ok(sourceEntry.evidence.some((e) => !e.startsWith('implied by')), `${source} was itself only implied`);
  }
});

test('discovery: plural forms match their singular keyword', () => {
  assert.ok(D.containsPhrase('fix the vulnerabilities', 'vulnerability'));
  assert.ok(D.containsPhrase('write tests', 'test'));
  assert.equal(D.containsPhrase('nothing here', 'vulnerability'), false);
});

test('discovery: a model suggestion alone never clears the threshold', () => {
  const result = D.analyze('hello', { provider: {}, providerCategories: ['kubernetes'] });
  assert.equal(result.categories.some((c) => c.category === 'kubernetes'), false);
});

test('discovery: an uncovered category is reported as a gap, not dropped', () => {
  const registry = registryWith([{ id: 'impl', categories: ['implementation'] }]);
  const result = D.discover({ request: 'deploy the app to kubernetes', registry });
  assert.ok(result.missing.some((m) => m.category === 'kubernetes'));
});

// --- ranking -----------------------------------------------------------------

test('ranking: popularity cannot outweigh relevance, trust and reliability', () => {
  const registry = registryWith([
    { id: 'popular', categories: ['implementation'], sourceType: 'skills.sh' },
    { id: 'right', categories: ['implementation'], stats: { runs: 10, successes: 10 } },
  ]);
  const popular = registry.get('popular');
  popular.quality = { installs: 1_000_000, score: 0.5 };
  const ranked = R.rankAll([
    { record: popular, relevance: 3, matchedCategories: ['implementation'] },
    { record: registry.get('right'), relevance: 3, matchedCategories: ['implementation'] },
  ], { registry });
  assert.equal(ranked[0].skillId, 'right');
  assert.ok(ranked[0].contributions.popularity <= R.WEIGHTS.popularity);
});

test('ranking: an unrun skill is unknown, not bad', () => {
  const registry = registryWith([{ id: 'new', categories: ['implementation'] }]);
  assert.equal(R.reliabilityScore(registry.get('new')), R.UNKNOWN_RELIABILITY);
});

test('ranking: one lucky run does not become a 100% track record', () => {
  const registry = registryWith([{ id: 'lucky', categories: ['implementation'], stats: { runs: 1, successes: 1 } }]);
  assert.ok(R.reliabilityScore(registry.get('lucky')) < 1);
});

test('ranking: a blocked or unusable skill is ineligible, not merely lower', () => {
  const registry = registryWith([{ id: 'bad', categories: ['implementation'] }]);
  const record = registry.get('bad');
  record.setSecurity({ scanned: true, findings: [{ id: 'x', severity: 'critical', summary: 's' }], blocked: true });
  const [ranked] = R.rankAll([{ record, relevance: 3, matchedCategories: ['implementation'] }], { registry });
  assert.equal(ranked.eligible, false);
  assert.equal(ranked.score, 0);
  assert.match(ranked.explanation, /not eligible/);
});

test('ranking: every rank explains itself', () => {
  const registry = registryWith([{ id: 'a', categories: ['implementation'] }]);
  const [ranked] = R.rankAll([{ record: registry.get('a'), relevance: 2, matchedCategories: ['implementation'] }], { registry });
  assert.ok(ranked.explanation.length > 10);
  assert.deepEqual(Object.keys(ranked.contributions).sort(), Object.keys(R.WEIGHTS).sort());
});

// --- search ------------------------------------------------------------------

test('search: covering every term beats repeating one', () => {
  const registry = registryWith([
    { id: 'mcp-security', categories: ['mcp-security'], description: 'mcp security review' },
    { id: 'mcp-mcp', categories: ['mcp-client'], description: 'mcp mcp mcp client' },
  ]);
  const rows = Search.searchInstalled(registry, 'mcp security');
  assert.equal(rows[0].id, 'mcp-security');
});

test('search: a remote source failure degrades the result, it does not fail it', async () => {
  const registry = registryWith([{ id: 'local-one', categories: ['implementation'] }]);
  const broken = { id: 'skills.sh', search: async () => { throw new Error('offline'); } };
  const result = await Search.search({ registry, sources: [broken], query: 'implementation' });
  assert.equal(result.installed.length, 1);
  assert.equal(result.errors[0].source, 'skills.sh');
});

test('search: a remote row is never presented as trusted or installed', async () => {
  const registry = registryWith([]);
  const source = { id: 'skills.sh', search: async () => [{ id: 'x', name: 'X', description: 'd', installs: 99 }] };
  const result = await Search.search({ registry, sources: [source], query: 'x' });
  assert.equal(result.available[0].trust, 'untrusted');
  assert.equal(result.available[0].installed, false);
});

// --- recommendation ----------------------------------------------------------

test('recommendation: a skill covering several categories is selected once', () => {
  const registry = registryWith([{ id: 'broad', categories: ['implementation', 'unit-testing', 'code-review'] }]);
  const rec = Rec.recommend({ request: 'implement it, test it and review it', registry });
  assert.equal(rec.selected.length, 1);
  assert.ok(rec.selected[0].coversCategories.length >= 2);
});

test('recommendation: phases run in order and a multi-phase skill takes the earliest', () => {
  assert.equal(Rec.phaseFor('architecture'), 'design');
  assert.equal(Rec.phaseFor('unit-testing'), 'testing');
  assert.equal(Rec.phaseFor('deployment'), 'delivery');
  assert.equal(Rec.leadingPhase(['implementation', 'architecture']), 'design');
  assert.ok(Rec.PHASE_INDEX.research < Rec.PHASE_INDEX.implementation);
  assert.ok(Rec.PHASE_INDEX.testing < Rec.PHASE_INDEX.delivery);
});

test('recommendation: the working set is capped and the weakest are dropped', () => {
  const registry = registryWith(Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, categories: ['implementation'] })));
  const rec = Rec.recommend({ request: 'implement something', registry, maxSkills: 3 });
  assert.ok(rec.selected.length <= 3);
});

// --- benchmarks --------------------------------------------------------------

test('benchmarks: every §21 scenario reaches its expected capabilities', () => {
  const report = B.run();
  const failures = report.results.filter((r) => !r.ok).map((r) => `${r.id} (recall ${r.recall}, missing ${r.missing.join(',')})`);
  assert.deepEqual(failures, [], `scenarios below the recall threshold: ${failures.join('; ')}`);
  assert.ok(report.meanRecall >= 0.8, `mean recall ${report.meanRecall}`);
});

test('benchmarks: the report says what it does not measure', () => {
  const report = B.run();
  assert.match(report.measures, /not execution quality/);
});
