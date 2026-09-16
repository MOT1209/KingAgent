// Phase 7 §44 (unit): the pieces that decide things, tested in isolation.
//
// Every test here exists because the behaviour it pins was got wrong at least
// once during implementation, or because getting it wrong would produce a
// confident answer rather than a visible failure — which is the whole class of
// bug a research engine has to be defended against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = (p) => require(`../src/core/research/${p}`);

const { classify, CATEGORY } = R('planner/queryClassifier');
const { planQueries, extractSubjects } = R('planner/queryPlanner');
const { buildStrategy } = R('planner/researchStrategy');
const { route } = R('router/searchRouter');
const { allocate } = R('router/sourceRouter');
const { routeRequest, ROUTE } = R('router/researchRouter');
const { normalizeResults } = R('retrieval/resultNormalizer');
const { deduplicate, independentCount, jaccard, containment } = R('retrieval/deduplicator');
const { rerank, evidenceDensity } = R('retrieval/reranker');
const { createRetrievalCache, FRESHNESS } = R('retrieval/retrievalCache');
const { EvidenceStore } = R('evidence/evidenceStore');
const { EvidenceExtractor, stanceToward, splitSentences } = R('evidence/evidenceExtractor');
const { rankEvidence, aggregateStrength } = R('evidence/evidenceRanker');
const { extractClaims, linkEvidenceToClaims, analyzeAll, VERIFICATION } = R('evidence/claimAnalyzer');
const { detect, resolveAll, valuesDisagree } = R('evidence/conflictDetector');
const { CitationEngine } = R('citations/citationEngine');
const { validateAll } = R('citations/citationValidator');
const { formatEntry } = R('citations/citationFormatter');
const { scoreSource, scoreSources } = R('quality/sourceQuality');
const { assess } = R('quality/evidenceQuality');
const { normalizeSource } = R('schemas/source');
const { normalizeQuery } = R('schemas/researchQuery');
const { normalizeCitation } = R('schemas/citation');
const { createResearchTask, transition, spend } = R('schemas/researchTask');
const { tokenize, stem } = R('text');

const SAFE = { safe: true, findings: [], injectionAttempts: 0 };
const src = (o) => normalizeSource({ safety: SAFE, ...o });

// --- classifier -------------------------------------------------------------

test('classifier: an imperative with no question is not research', () => {
  for (const q of ['refactor src/core/index.js to use async iterators', 'run the build', 'write a test for the reranker']) {
    assert.equal(classify(q).category, CATEGORY.NO_RESEARCH, q);
  }
});

test('classifier: a question about a codebase IS research even though it starts with a verb', () => {
  assert.equal(classify('Explain how this codebase handles policy').category, CATEGORY.CODEBASE_RESEARCH);
});

test('classifier: an opinion question never collapses to a single lookup', () => {
  const c = classify('What do people think about Rust for web backends?');
  assert.notEqual(c.category, CATEGORY.SIMPLE_FACT);
  assert.ok(c.sourceTypes.includes('discussion'));
  assert.ok(c.suggestedQueries > 1);
});

test('classifier: a news question is never cacheable', () => {
  assert.equal(classify('What news was announced this week?').freshness, FRESHNESS.REALTIME);
});

test('classifier: a host refinement may narrow but can never clear needsResearch', () => {
  const c = classify('Compare Postgres and MySQL', {
    refine: () => ({ category: CATEGORY.NO_RESEARCH, needsVerification: false, confidence: 0.99 }),
  });
  assert.equal(c.needsResearch, true);
  assert.equal(c.needsCitations, true);
  assert.notEqual(c.category, CATEGORY.NO_RESEARCH);
});

// --- query planning ---------------------------------------------------------

test('planner: a colon-introduced list becomes separate subjects', () => {
  assert.deepEqual(
    extractSubjects('Compare the best open-source agent frameworks: LangGraph, CrewAI and AutoGen.'),
    ['LangGraph', 'CrewAI', 'AutoGen'],
  );
});

test('planner: decomposition is breadth-first, so a truncated plan still covers every subject', () => {
  const task = createResearchTask({ question: 'Compare Alpha, Beta and Gamma', mode: 'deep', maxQueries: 4 });
  const queries = planQueries({ task, classification: classify(task.question), available: ['web', 'documentation'] });
  const text = queries.map((q) => q.text).join(' | ');
  for (const s of ['Alpha', 'Beta', 'Gamma']) assert.match(text, new RegExp(s), `${s} missing from ${text}`);
});

test('planner: redundant queries are never admitted twice', () => {
  const task = createResearchTask({ question: 'What is MCP and what is MCP?', mode: 'standard' });
  const queries = planQueries({ task, classification: classify(task.question), available: ['web'] });
  const keys = queries.map((q) => q.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('planner: a query is never planned against a source type nothing can serve', () => {
  const task = createResearchTask({ question: 'Compare Alpha and Beta', mode: 'deep' });
  const queries = planQueries({ task, classification: classify(task.question), available: ['web'] });
  for (const q of queries) assert.deepEqual(q.sourceTypes, ['web']);
});

// --- strategy ---------------------------------------------------------------

test('strategy: deep research on a one-provider install downgrades and says so', () => {
  const task = createResearchTask({ question: 'Comprehensive deep dive comparing Alpha and Beta', mode: 'deep' });
  const s = buildStrategy({ task, classification: classify(task.question), available: ['web'] });
  assert.equal(s.stages.crossVerify, false);
  assert.equal(s.degraded, true);
  assert.ok(s.downgrades.some((d) => d.what === 'crossVerify'));
});

test('strategy: an explicit source preference is an instruction, not a hint', () => {
  // The classifier would suggest `web` for this question; the task can only
  // reach `mcp`. Refusing would be obeying a guess over what was asked for.
  const task = createResearchTask({ question: 'What is MCP?', sourcePreferences: ['mcp'] });
  const s = buildStrategy({ task, classification: classify(task.question), available: ['mcp'] });
  assert.deepEqual(s.sourceTypes, ['mcp']);
});

// --- routing ----------------------------------------------------------------

test('router: each of §8\'s examples reaches the source it names', () => {
  const strategy = {
    sourceTypes: ['web', 'documentation', 'github', 'discussion', 'news', 'academic'],
    sourceOrder: ['documentation', 'github', 'academic', 'web', 'news', 'discussion'],
  };
  const lead = (text, intent = 'discovery') =>
    route({ query: normalizeQuery({ text, intent, sourceTypes: ['web'] }), strategy }).lead;
  assert.equal(lead('What does this API endpoint do?'), 'documentation');
  assert.equal(lead('How does the community feel about X?'), 'discussion');
  assert.equal(lead('What was announced this week?'), 'news');
  assert.equal(lead('Compare these GitHub repositories by license'), 'github');
});

test('router: routing narrows and can never reach a type the strategy excluded', () => {
  const strategy = { sourceTypes: ['web'], sourceOrder: ['web'] };
  // The query asks for documentation; the strategy allows only web. The route
  // falls back to web rather than routing nowhere — but it never yields
  // documentation, which is the property that matters.
  const r = route({ query: normalizeQuery({ text: 'What does this API endpoint do?', sourceTypes: ['documentation'] }), strategy });
  assert.deepEqual(r.sourceTypes, ['web']);
  assert.ok(!r.sourceTypes.includes('documentation'));
});

test('router: the source budget holds some back for verification', () => {
  const task = createResearchTask({ question: 'q', maxSources: 20 });
  const alloc = allocate({ task, query: normalizeQuery({ text: 'q', maxResults: 10 }), sourceTypes: ['web', 'documentation'] });
  const total = alloc.reduce((a, b) => a + b.limit, 0);
  assert.ok(total < 20, `allocated ${total} of 20 with nothing reserved`);
});

test('research router: a time-sensitive question is never served from memory', async () => {
  const memory = async () => ({ answer: 'old news', confidence: 0.9, verifiedAt: Date.now() - 1000 });
  const fresh = await routeRequest({ request: 'What was announced this week?', lookupMemory: memory });
  assert.equal(fresh.route, ROUTE.PIPELINE);
  const stable = await routeRequest({ request: 'What is MCP?', lookupMemory: memory });
  assert.equal(stable.route, ROUTE.MEMORY);
});

// --- text -------------------------------------------------------------------

test('text: trailing punctuation does not break a match, but paths and versions survive', () => {
  assert.deepEqual(tokenize('It supports stdio and HTTP transports.'), ['support', 'stdio', 'http', 'transport']);
  assert.deepEqual(tokenize('see src/core/index.js and v1.2.0'), ['see', 'src/core/index.js', 'v1.2.0']);
});

test('text: the stemmer does not eat real words', () => {
  for (const w of ['class', 'address', 'status', 'bus', 'analysis']) assert.equal(stem(w), w);
  assert.equal(stem('transports'), 'transport');
  assert.equal(stem('libraries'), 'library');
});

// --- normalization and dedup ------------------------------------------------

test('dedup: the same page under two urls is one source', () => {
  const body = 'The protocol is an open standard for connecting assistants to data sources across many tools.';
  const { kept } = deduplicate([
    src({ title: 'Spec', url: 'https://x.dev/spec', content: body, primary: true }),
    src({ title: 'Spec', url: 'http://www.x.dev/spec?utm_source=t', content: body }),
  ]);
  assert.equal(kept.length, 1);
});

test('dedup: syndicated copy with added commentary is caught by containment, not Jaccard', () => {
  const body = 'The Model Context Protocol is an open standard that lets applications provide context to large language models in a consistent way across tools.';
  const withCommentary = `${body} In my view this changes how we build agents and it is a big deal for interoperability going forward.`;
  const a = new Set(require('../src/core/research/retrieval/deduplicator').shingles(body));
  const b = new Set(require('../src/core/research/retrieval/deduplicator').shingles(withCommentary));
  assert.ok(jaccard(a, b) < 0.82, 'Jaccard should NOT have caught this');
  assert.ok(containment(a, b) >= 0.9, 'containment should catch it');
  const { kept } = deduplicate([
    src({ title: 'Original', url: 'https://a.dev/1', content: body, primary: true }),
    src({ title: 'Reposted with thoughts', url: 'https://b.dev/2', content: withCommentary }),
  ]);
  assert.equal(kept.length, 1);
});

test('dedup: ten copies of one story are one independent source', () => {
  const body = 'A vendor announced a new product today and the announcement covers pricing, availability and supported regions.';
  const day = Date.parse('2025-05-05');
  const sources = Array.from({ length: 10 }, (_, i) => src({
    title: 'Vendor announces product', url: `https://news${i}.example/${i}`, content: body, publishedAt: day,
  }));
  const { kept, clusterOf } = deduplicate(sources);
  assert.equal(kept.length, 1);
  const byId = new Map(sources.map((s) => [s.id, s]));
  assert.equal(independentCount(sources.map((s) => s.id), { clusterOf, sourcesById: byId }), 1);
});

test('normalizer: the same source found by two queries is one source with both queries recorded', () => {
  const rows = [
    { queryId: 'q1', source: src({ title: 'A', url: 'https://a.dev/1', content: 'a body long enough to be usable here' }) },
    { queryId: 'q2', source: src({ title: 'A', url: 'https://a.dev/1', content: 'a body long enough to be usable here' }) },
  ];
  const { sources } = normalizeResults(rows);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].metadata.queryHits, 2);
});

// --- reranking --------------------------------------------------------------

test('reranker: a specification outranks a blog, and a second post from the same domain is demoted', () => {
  const spec = 'The protocol v1.2.0 is defined as a JSON-RPC 2.0 layer. It requires a transport and supports stdio and HTTP. Released 2024. '.repeat(5);
  const ranked = rerank([
    src({ title: 'Blog one', url: 'https://blog.x.com/1', type: 'web', content: 'Some thoughts about the protocol and why it matters to people.' }),
    src({ title: 'Blog two', url: 'https://blog.x.com/2', type: 'web', content: 'More thoughts about the protocol with no specifics at all.' }),
    src({ title: 'Specification', url: 'https://std.example/spec', type: 'documentation', primary: true, content: spec }),
  ], { query: 'what is the protocol specification' });
  assert.equal(ranked[0].source.title, 'Specification');
  assert.ok(ranked.some((r) => r.penalties.some((p) => p.kind === 'domain-repeat')));
});

test('reranker: a short snippet cannot score maximum evidence density', () => {
  assert.ok(evidenceDensity('MCP is interesting and people are talking about it.') < 0.5);
});

// --- cache ------------------------------------------------------------------

test('cache: a realtime question is never written or read', async () => {
  const cache = createRetrievalCache({});
  const key = cache.key({ query: 'news today', sourceType: 'news', freshness: FRESHNESS.REALTIME });
  assert.equal(await cache.set(key, [1], { freshness: FRESHNESS.REALTIME }), false);
  assert.equal(await cache.get(key, { freshness: FRESHNESS.REALTIME }), null);
});

test('cache: an expired entry is not served', async () => {
  let now = 1000;
  const cache = createRetrievalCache({ clock: () => now });
  const key = cache.key({ query: 'q', sourceType: 'web', freshness: FRESHNESS.FAST });
  await cache.set(key, [1], { freshness: FRESHNESS.FAST });
  assert.deepEqual(await cache.get(key, { freshness: FRESHNESS.FAST }), [1]);
  now += 60 * 60 * 1000;
  assert.equal(await cache.get(key, { freshness: FRESHNESS.FAST }), null);
});

// --- evidence ---------------------------------------------------------------

test('extractor: sentence splitting survives abbreviations, versions and urls', () => {
  assert.deepEqual(
    splitSentences('Version 1.2.3 shipped. See e.g. the docs at https://a.com/x.html for more. Done!').map((s) => s.text),
    ['Version 1.2.3 shipped.', 'See e.g. the docs at https://a.com/x.html for more.', 'Done!'],
  );
});

test('extractor: every span is verbatim, with offsets that locate it', () => {
  const source = src({
    title: 'Spec', url: 'https://x.dev/spec', type: 'documentation',
    content: 'Cookie policy applies here. The protocol is an open standard for connecting assistants to data. It supports stdio and HTTP transports. Subscribe to our newsletter.',
  });
  const out = new EvidenceExtractor().extract({ source, question: 'what transports does the protocol support' });
  assert.ok(out.length > 0, 'nothing extracted');
  for (const e of out) {
    assert.ok(source.content.includes(e.text), `not verbatim: ${e.text}`);
    assert.equal(source.content.slice(e.location.start, e.location.end).trim(), e.text);
  }
});

test('extractor: boilerplate is never evidence', () => {
  const source = src({ title: 'X', url: 'https://x.dev/1', content: 'Cookie policy applies to this site and to all subdomains of the site. Subscribe to our newsletter for updates.' });
  const out = new EvidenceExtractor().extract({ source, question: 'cookie policy subscribe newsletter' });
  for (const e of out) assert.doesNotMatch(e.text, /^Cookie policy|^Subscribe/);
});

test('extractor: a source that was never security-screened cannot become evidence', () => {
  const unscreened = normalizeSource({ title: 'X', url: 'https://x.dev/1', content: 'a'.repeat(200) });
  assert.equal(unscreened.safety, null);
  assert.throws(() => new EvidenceExtractor().extract({ source: unscreened, question: 'anything' }), /never security-screened/);
});

test('stance: a different number contradicts however affirmative the sentence is', () => {
  assert.equal(stanceToward('The current version is v1.2.0 and it is stable.', 'The current version is v0.9.0'), 'contradicts');
  assert.equal(stanceToward('The plan costs $35 per month per seat.', 'The plan costs $20 per month per seat.'), 'contradicts');
  assert.equal(stanceToward('The plan costs $20 per month per seat.', 'The plan costs $20 per month per seat.'), 'supports');
});

test('stance: anything unclear stays neutral rather than inventing a sign', () => {
  assert.equal(stanceToward('Unrelated text about gardening and soil.', 'MCP supports stdio transports'), 'neutral');
});

test('ranker: corroboration has diminishing returns, and one source is capped', () => {
  const one = aggregateStrength([{ stance: 'supports', strength: 0.9 }], { independentSources: 1 });
  const nine = aggregateStrength(Array.from({ length: 9 }, () => ({ stance: 'supports', strength: 0.9 })), { independentSources: 1 });
  assert.ok(one.support <= 0.7, `one source reached ${one.support}`);
  assert.ok(nine.support <= 0.72, `nine copies of one source reached ${nine.support}`);
});

// --- store ------------------------------------------------------------------

test('store: evidence for a source that was never retrieved is refused', () => {
  const store = new EvidenceStore();
  assert.throws(
    () => store.addEvidence(require('../src/core/research/schemas/evidence').normalizeEvidence({ text: 'x'.repeat(40), sourceId: 'src-nope' })),
    /never retrieved/,
  );
});

test('store: stance belongs to the link, so one span can support A and contradict B', () => {
  const { normalizeEvidence } = require('../src/core/research/schemas/evidence');
  const { normalizeClaim } = require('../src/core/research/schemas/claim');
  const s = src({ title: 'X', url: 'https://x.dev/1', content: 'a'.repeat(200) });
  const store = new EvidenceStore().addSources([s]);
  const e = store.addEvidence(normalizeEvidence({ text: 'The version is v1.2.0 and transports are stdio and HTTP.', sourceId: s.id }));
  const a = store.addClaim(normalizeClaim({ text: 'transports are stdio and HTTP' }));
  const b = store.addClaim(normalizeClaim({ text: 'the version is v0.9.0' }));
  store.link(a.id, e.id, 'supports');
  store.link(b.id, e.id, 'contradicts');
  assert.equal(store.evidenceForClaim(a.id)[0].stance, 'supports');
  assert.equal(store.evidenceForClaim(b.id)[0].stance, 'contradicts');
});

test('store: the same span from the same source is one evidence record', () => {
  const { normalizeEvidence } = require('../src/core/research/schemas/evidence');
  const s = src({ title: 'X', url: 'https://x.dev/1', content: 'a'.repeat(200) });
  const store = new EvidenceStore().addSources([s]);
  store.addEvidence(normalizeEvidence({ text: 'The same sentence extracted twice over.', sourceId: s.id }));
  store.addEvidence(normalizeEvidence({ text: 'The same sentence extracted twice over.', sourceId: s.id }));
  assert.equal(store.allEvidence().length, 1);
});

test('store: a source re-retrieved under a new id folds into its cluster', () => {
  const a = src({ title: 'X', url: 'https://x.dev/1', content: 'a'.repeat(200) });
  const b = src({ title: 'X', url: 'https://x.dev/1', content: 'a'.repeat(200) });
  assert.notEqual(a.id, b.id);
  const store = new EvidenceStore().addSources([a]).addSources([b]);
  assert.equal(store.canonicalIdFor(b.id), a.id);
});

// --- claims and conflicts ---------------------------------------------------

function corpusStore(sources, question) {
  const store = new EvidenceStore().addSources(sources);
  const ex = new EvidenceExtractor();
  let evidence = [];
  for (const s of sources) evidence.push(...ex.extract({ source: s, question }));
  evidence = rankEvidence(evidence, { store, question });
  store.addAllEvidence(evidence);
  const claims = extractClaims({ question, evidence: store.allEvidence(), store });
  linkEvidenceToClaims({ claims, evidence: store.allEvidence(), store });
  const conflicts = resolveAll(detect({ store, claims }), { store });
  return { store, claims: analyzeAll({ store, conflicts }), conflicts };
}

test('claims: two independent sources give strong support; one good source does not', () => {
  const q = 'what transports does the protocol support';
  const two = corpusStore([
    src({ title: 'Spec', url: 'https://std.example/spec', type: 'documentation', primary: true, qualityScore: 0.9, content: 'The protocol supports stdio and HTTP transports for local and remote servers.' }),
    src({ title: 'Vendor blog', url: 'https://vendor.example/blog', type: 'web', qualityScore: 0.7, content: 'The protocol supports stdio and HTTP transports in every current release.' }),
  ], q);
  assert.equal(two.claims[0].verificationStatus, VERIFICATION.STRONGLY_SUPPORTED);

  const one = corpusStore([
    src({ title: 'Spec', url: 'https://std.example/spec', type: 'documentation', primary: true, qualityScore: 0.95, content: 'The protocol supports stdio and HTTP transports for local and remote servers.' }),
  ], q);
  assert.notEqual(one.claims[0].verificationStatus, VERIFICATION.STRONGLY_SUPPORTED);
});

test('conflicts: two affirmative sentences with different numbers are a conflict', () => {
  assert.ok(valuesDisagree({ kind: 'currency', unit: '', num: 20 }, { kind: 'currency', unit: '', num: 35 }));
  assert.ok(!valuesDisagree({ kind: 'duration', unit: 'ms', num: 50 }, { kind: 'duration', unit: 'ms', num: 51 }));

  // Two sources of comparable standing: nothing resolves it, so the claim is
  // reported as contested rather than silently taking one of the numbers.
  const even = corpusStore([
    src({ title: 'Site A pricing', url: 'https://a.example/pricing', type: 'web', publishedAt: Date.now() - 30 * 86400000, content: 'The Pro plan costs $20 per month per seat and includes priority support.' }),
    src({ title: 'Site B pricing', url: 'https://b.example/pricing', type: 'web', publishedAt: Date.now() - 30 * 86400000, content: 'The Pro plan costs $35 per month per seat and includes priority support.' }),
  ], 'how much does the Pro plan cost per month');
  assert.equal(even.conflicts.length, 1, 'one disagreement should produce exactly one conflict');
  assert.equal(even.conflicts[0].resolution, 'report_uncertainty');
  assert.equal(even.claims[0].verificationStatus, VERIFICATION.CONFLICTING);
});

test('conflicts: the vendor\'s own pricing page beats a review site, and the loser is superseded', () => {
  const out = corpusStore([
    src({ title: 'Official pricing', url: 'https://vendor.example/pricing', type: 'documentation', primary: true, publishedAt: Date.now() - 30 * 86400000, content: 'The Pro plan costs $20 per month per seat and includes priority support.' }),
    src({ title: 'Review site', url: 'https://reviews.example/pro', type: 'web', publishedAt: Date.now() - 60 * 86400000, content: 'The Pro plan costs $35 per month per seat and includes priority support.' }),
  ], 'how much does the Pro plan cost per month');
  assert.equal(out.conflicts.length, 1);
  assert.equal(out.conflicts[0].resolution, 'prefer_primary');
  assert.ok(out.conflicts[0].supersededEvidenceIds.length > 0, 'the losing side must be recorded');
  // Resolved in the primary source's favour, so the claim is no longer
  // contested — but it now rests on one source, and says so.
  assert.notEqual(out.claims[0].verificationStatus, VERIFICATION.CONFLICTING);
  assert.equal(out.claims[0].independentSourceCount, 1);
});

test('conflicts: resolution has consequences — the losing side stops supporting', () => {
  const out = corpusStore([
    src({ title: 'Specification', url: 'https://std.example/spec', type: 'documentation', primary: true, qualityScore: 0.95, publishedAt: Date.now() - 30 * 86400000, content: 'The current version is v1.2.0 and it requires a JSON-RPC 2.0 layer underneath.' }),
    src({ title: 'Old tutorial', url: 'https://tutorial.example/x', type: 'web', qualityScore: 0.4, publishedAt: Date.now() - 900 * 86400000, content: 'The current version is v0.9.0 and it requires a JSON-RPC 2.0 layer underneath.' }),
  ], 'what version is current');
  const stale = out.claims.find((c) => /v0\.9\.0/.test(c.text));
  if (stale) assert.notEqual(stale.verificationStatus, VERIFICATION.STRONGLY_SUPPORTED);
  assert.ok(out.conflicts.length >= 1);
  assert.ok(out.conflicts.every((c) => c.resolution !== undefined));
});

test('conflicts: one source contradicting itself is not a conflict between sources', () => {
  const out = corpusStore([
    src({ title: 'One page', url: 'https://x.dev/1', type: 'web', content: 'The tool supports Windows. The tool does not support Windows on ARM devices at this time.' }),
  ], 'does the tool support windows');
  assert.equal(out.conflicts.length, 0);
});

// --- citations --------------------------------------------------------------

test('citations: a citation cannot be built without real evidence', () => {
  const { normalizeClaim } = require('../src/core/research/schemas/claim');
  const store = new EvidenceStore();
  const claim = store.addClaim(normalizeClaim({ text: 'something' }));
  const engine = new CitationEngine({ store });
  assert.throws(() => engine.cite({ claimId: claim.id, evidenceId: 'ev-nope' }), /unknown evidence/);
});

test('citations: a fabricated url and a fabricated quote are both caught', () => {
  const out = corpusStore([
    src({ title: 'Spec', url: 'https://std.example/spec', type: 'documentation', primary: true, content: 'The protocol supports stdio and HTTP transports for local and remote servers.' }),
  ], 'what transports are supported');
  const engine = new CitationEngine({ store: out.store });
  const real = engine.citeAll(out.claims);
  assert.ok(real.length > 0);
  assert.equal(validateAll({ claims: out.claims, citations: real, store: out.store }).ok, true);

  const fake = normalizeCitation({
    claimId: real[0].claimId, evidenceId: real[0].evidenceId, sourceId: real[0].sourceId,
    url: 'https://invented.example/page', title: 'Invented', quote: 'The protocol supports quantum transports.', quoteDigest: 'deadbeef',
  });
  const bad = validateAll({ claims: out.claims, citations: [...real, fake], store: out.store });
  assert.equal(bad.ok, false);
  const types = bad.errors.map((e) => e.type);
  assert.ok(types.includes('fabricated_url'));
  assert.ok(types.includes('quote_mismatch'));
});

test('citations: one ordinal per source, so three quotes from one page are all [n]', () => {
  const out = corpusStore([
    src({ title: 'Spec', url: 'https://std.example/spec', type: 'documentation', primary: true, content: 'The protocol supports stdio transports. The protocol supports HTTP transports. The protocol requires JSON-RPC 2.0.' }),
  ], 'what does the protocol support and require');
  const engine = new CitationEngine({ store: out.store });
  const cites = engine.citeAll(out.claims);
  assert.equal(new Set(cites.map((c) => c.ordinal)).size, 1);
  assert.equal(engine.bibliography().length, 1);
});

test('citations: a bibliography entry never invents a field the source lacked', () => {
  const line = formatEntry({ ordinal: 1, title: 'A page', url: 'https://x.dev/1', publisher: null, author: null, publishedAt: null, retrievedAt: null, primary: false });
  assert.equal(line, '[1] A page — https://x.dev/1');
});

// --- quality ----------------------------------------------------------------

test('quality: a source that tried to inject instructions loses authority', () => {
  const clean = scoreSource(src({ title: 'X', url: 'https://x.dev/1', type: 'web', content: 'a'.repeat(600) }));
  const dirty = scoreSource(normalizeSource({
    title: 'X', url: 'https://x.dev/1', type: 'web', content: 'a'.repeat(600),
    safety: { safe: true, findings: [{ kind: 'injection' }], injectionAttempts: 2 },
  }));
  assert.ok(dirty.score < clean.score);
  assert.ok(dirty.reasons.some((r) => /instruction-shaped/.test(r)));
});

test('quality: an open publishing platform lends no authority to its authors', () => {
  const vendor = scoreSource(src({ title: 'X', url: 'https://vendor.example/docs/api', type: 'documentation', primary: true, content: 'a'.repeat(600) }));
  const medium = scoreSource(src({ title: 'X', url: 'https://medium.com/@someone/post', type: 'documentation', primary: true, content: 'a'.repeat(600) }));
  assert.ok(medium.score < vendor.score);
});

test('quality: evidence concentrated in one document is reported as such', () => {
  const s = src({ title: 'X', url: 'https://x.dev/1', content: 'a'.repeat(600) });
  const { normalizeEvidence } = require('../src/core/research/schemas/evidence');
  const store = new EvidenceStore().addSources([s]);
  for (let i = 0; i < 5; i += 1) {
    store.addEvidence(normalizeEvidence({ text: `Sentence number ${i} from the only document we have.`, sourceId: s.id, strength: 0.8, stance: 'supports' }));
  }
  const a = assess({ store, claims: [] });
  assert.equal(a.independentSources, 1);
  assert.ok(a.reasons.some((r) => /single independent source/.test(r)));
});

test('quality: source scores are applied back onto the sources', () => {
  const scored = scoreSources([src({ title: 'X', url: 'https://x.dev/1', type: 'web', content: 'a'.repeat(600) })]);
  assert.equal(typeof scored[0].qualityScore, 'number');
  assert.equal(typeof scored[0].authorityScore, 'number');
});

// --- task model -------------------------------------------------------------

test('task: an illegal transition throws instead of silently rewriting history', () => {
  const task = createResearchTask({ question: 'q' });
  transition(task, 'planning');
  assert.throws(() => transition(task, 'completed'), /illegal research transition/);
});

test('task: the budget stops at the ceiling and never reports more than it allowed', () => {
  const task = createResearchTask({ question: 'q', mode: 'quick' });
  for (let i = 0; i < task.limits.maxQueries; i += 1) spend(task, 'queries');
  assert.throws(() => spend(task, 'queries'), /budget exhausted/);
  assert.equal(task.usage.queries, task.limits.maxQueries);
});
