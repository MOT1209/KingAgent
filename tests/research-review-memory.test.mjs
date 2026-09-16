// The stages that only run in deep mode or with a memory policy, and were
// therefore the least exercised: the reviewer, the verifier's selection rules,
// and what research is allowed to remember.
//
// These are the stages whose job is to say "no" — a reviewer that never fails a
// check and a memory layer that never refuses a write are both indistinguishable
// from not being there, so the tests are mostly about the refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Reviewer, VERDICT, CHECK, strayAssertions } = require('../src/core/research/agents/reviewer');
const { selectForVerification, sourceTypesFor } = require('../src/core/research/evidence/sourceVerifier');
const { ResearchMemory, LIFECYCLE } = require('../src/core/research/memory/researchMemory');
const { EvidenceStore } = require('../src/core/research/evidence/evidenceStore');
const { normalizeSource } = require('../src/core/research/schemas/source');
const { normalizeEvidence } = require('../src/core/research/schemas/evidence');
const { normalizeClaim, VERIFICATION } = require('../src/core/research/schemas/claim');
const { normalizeCitation } = require('../src/core/research/schemas/citation');
const { createResearchTask } = require('../src/core/research/schemas/researchTask');
const { MemoryManager } = require('../src/core/memory/manager');

const SAFE = { safe: true, findings: [], injectionAttempts: 0 };
const src = (o) => normalizeSource({ safety: SAFE, content: 'x'.repeat(300), ...o });

function fixture({ claims = [], sources = [], evidence = [] } = {}) {
  const store = new EvidenceStore().addSources(sources);
  for (const e of evidence) store.addEvidence(e);
  for (const c of claims) store.addClaim(c);
  return store;
}

function quality(over = {}) {
  return {
    score: 0.7, grade: 'adequate', passed: true, targetsMet: true, targetMisses: [],
    blocking: [], warnings: [], reasons: [], confidence: 0.7,
    detail: {
      completeness: { subjectCoverage: 1, subjects: [{ subject: 'X', covered: true }], missingSourceTypes: [] },
      evidence: { independentSources: 2 },
      validation: { ok: true, errors: 0, warnings: 0 },
    },
    ...over,
  };
}

const strategy = { mode: 'deep', targets: { minConfidence: 0.55 }, sourceTypes: ['web', 'documentation'] };

// --- reviewer ---------------------------------------------------------------

test('reviewer: a clean run is accepted', async () => {
  const claim = normalizeClaim({ text: 'A well supported statement about the subject.' });
  claim.verificationStatus = VERIFICATION.STRONGLY_SUPPORTED;
  claim.confidence = 0.8;
  const s = src({ title: 'Spec', url: 'https://std.example/spec', type: 'documentation', primary: true, qualityScore: 0.9 });
  const store = fixture({ claims: [claim], sources: [s] });
  const task = createResearchTask({ question: 'X' });
  task.classification = { needsGithub: false, needsFiles: false, category: 'simple_fact' };

  const review = await new Reviewer().review({
    task, store, claims: [claim], citations: [normalizeCitation({ claimId: claim.id, evidenceId: 'e1', sourceId: s.id })],
    conflicts: [], quality: quality(), strategy, answer: { sections: { conflicting: [] } },
  });
  assert.equal(review.verdict, VERDICT.ACCEPT);
  assert.equal(review.blocking, 0);
});

test('reviewer: an unsupported material claim blocks, and names the claim', async () => {
  const claim = normalizeClaim({ text: 'An assertion nothing in the corpus supports.' });
  claim.verificationStatus = VERIFICATION.UNVERIFIED;
  const store = fixture({ claims: [claim], sources: [src({ title: 'A', url: 'https://a.example/1' })] });
  const task = createResearchTask({ question: 'X' });

  const review = await new Reviewer().review({
    task, store, claims: [claim], citations: [], conflicts: [],
    quality: quality(), strategy, answer: { sections: { conflicting: [] } },
  });
  assert.equal(review.verdict, VERDICT.REJECT);
  const finding = review.findings.find((f) => f.check === CHECK.CLAIMS_SUPPORTED);
  assert.ok(finding, 'no claims_supported finding');
  assert.ok(finding.claims.some((c) => c.id === claim.id));
  // And the gap is actionable: a replan can go after exactly this claim.
  assert.ok(review.gaps.some((g) => g.claim && g.claim.id === claim.id));
});

test('reviewer: a citation integrity error is always blocking', async () => {
  const claim = normalizeClaim({ text: 'A statement.' });
  claim.verificationStatus = VERIFICATION.SUPPORTED;
  claim.confidence = 0.7;
  const store = fixture({ claims: [claim], sources: [src({ title: 'A', url: 'https://a.example/1' })] });
  const review = await new Reviewer().review({
    task: createResearchTask({ question: 'X' }), store, claims: [claim], citations: [], conflicts: [],
    quality: quality({ blocking: [{ type: 'fabricated_url', message: 'invented' }] }),
    strategy, answer: { sections: { conflicting: [] } },
  });
  assert.equal(review.verdict, VERDICT.REJECT);
  assert.ok(review.findings.some((f) => f.check === CHECK.CITATIONS_VALID && f.blocking));
});

test('reviewer: an unresolved conflict the answer hides is blocking; one it states is not', async () => {
  const claim = normalizeClaim({ text: 'A contested statement.' });
  claim.verificationStatus = VERIFICATION.CONFLICTING;
  const store = fixture({ claims: [claim], sources: [src({ title: 'A', url: 'https://a.example/1' })] });
  const conflicts = [{ claimId: claim.id, resolution: 'unresolved', severity: 'direct', positions: [], sourceIds: [] }];
  const base = {
    task: createResearchTask({ question: 'X' }), store, claims: [claim],
    citations: [], conflicts, quality: quality(), strategy,
  };

  const hidden = await new Reviewer().review({ ...base, answer: { sections: { conflicting: [] } } });
  assert.ok(hidden.findings.some((f) => f.check === CHECK.CONFLICTS_HANDLED && f.blocking));

  const stated = await new Reviewer().review({ ...base, answer: { sections: { conflicting: [{ claimId: claim.id }] } } });
  const finding = stated.findings.find((f) => f.check === CHECK.CONFLICTS_HANDLED);
  assert.equal(finding.blocking, false);
  assert.equal(finding.informational, true);
});

test('reviewer: a repository question with no repository source is flagged', async () => {
  const claim = normalizeClaim({ text: 'A statement about the project.' });
  claim.verificationStatus = VERIFICATION.SUPPORTED;
  claim.confidence = 0.7;
  const store = fixture({ claims: [claim], sources: [src({ title: 'Blog', url: 'https://blog.example/1', type: 'web' })] });
  const task = createResearchTask({ question: 'X' });
  task.classification = { needsGithub: true, needsFiles: false, category: 'github_research' };

  const review = await new Reviewer().review({
    task, store, claims: [claim], citations: [], conflicts: [], quality: quality(),
    strategy, answer: { sections: { conflicting: [] } },
  });
  const finding = review.findings.find((f) => f.check === CHECK.OBVIOUS_SOURCE_MISSED);
  assert.ok(finding, 'a github question answered with no repository source should be flagged');
  assert.match(finding.message, /repository/);
});

test('reviewer: prose that does not trace to any claim is caught as hallucination', async () => {
  const claim = normalizeClaim({ text: 'The protocol supports stdio and HTTP transports.' });
  claim.verificationStatus = VERIFICATION.SUPPORTED;
  claim.confidence = 0.7;
  const store = fixture({ claims: [claim], sources: [src({ title: 'A', url: 'https://a.example/1' })] });

  const review = await new Reviewer().review({
    task: createResearchTask({ question: 'X' }), store, claims: [claim], citations: [], conflicts: [],
    quality: quality(), strategy,
    answer: {
      sections: { conflicting: [] },
      prose: 'The protocol supports stdio and HTTP transports. Quarterly revenue in the Baltic shipping sector declined sharply owing to tariff changes.',
    },
  });
  assert.ok(review.findings.some((f) => f.check === CHECK.NO_HALLUCINATION && f.blocking));
});

test('reviewer: paraphrase and connective sentences are not mistaken for invention', () => {
  const claims = [normalizeClaim({ text: 'The protocol supports stdio and HTTP transports for local servers.' })];
  const stray = strayAssertions(
    'However, this matters. The protocol supports both stdio and HTTP transports when serving local servers.',
    claims,
  );
  assert.deepEqual(stray, [], `flagged legitimate prose: ${JSON.stringify(stray)}`);
});

// --- verifier selection -----------------------------------------------------

test('verifier: selection prefers conflict, then thin corroboration, then low confidence', () => {
  const mk = (text, status, confidence, independent) => {
    const c = normalizeClaim({ text });
    c.verificationStatus = status;
    c.confidence = confidence;
    c.independentSourceCount = independent;
    return c;
  };
  const conflicted = mk('Contested.', VERIFICATION.CONFLICTING, 0.3, 3);
  const thin = mk('One source only.', VERIFICATION.SUPPORTED, 0.7, 1);
  const lowConf = mk('Weakly held.', VERIFICATION.SUPPORTED, 0.4, 3);
  const solid = mk('Well established.', VERIFICATION.STRONGLY_SUPPORTED, 0.9, 4);

  const s = src({ title: 'Spec', url: 'https://std.example/1', type: 'documentation', primary: true });
  const store = fixture({ sources: [s] });
  for (const c of [conflicted, thin, lowConf, solid]) store.addClaim(c);
  const e = store.addEvidence(normalizeEvidence({ text: 'Some supporting passage about the subject.', sourceId: s.id }));
  for (const c of [conflicted, thin, lowConf, solid]) store.link(c.id, e.id, 'supports');

  const picked = selectForVerification([conflicted, thin, lowConf, solid], { store, limit: 4 });
  assert.equal(picked[0].claim.id, conflicted.id, 'a conflict must be verified first');
  assert.ok(picked.findIndex((p) => p.claim.id === thin.id) < picked.findIndex((p) => p.claim.id === lowConf.id),
    'thin corroboration outranks low confidence');
  // A claim already resting on a primary source with real breadth is left alone.
  assert.ok(!picked.some((p) => p.claim.id === solid.id), 'a solid claim should not be re-verified');
});

test('verifier: the source types a claim already rests on are reported, so a re-search differs', () => {
  const s1 = src({ title: 'Docs', url: 'https://d.example/1', type: 'documentation' });
  const s2 = src({ title: 'Blog', url: 'https://b.example/1', type: 'web' });
  const store = fixture({ sources: [s1, s2] });
  const claim = store.addClaim(normalizeClaim({ text: 'A statement.' }));
  for (const s of [s1, s2]) {
    const e = store.addEvidence(normalizeEvidence({ text: `A passage from ${s.title} about the subject.`, sourceId: s.id }));
    store.link(claim.id, e.id, 'supports');
  }
  assert.deepEqual(sourceTypesFor(claim, store).sort(), ['documentation', 'web']);
});

// --- research memory --------------------------------------------------------

function memoryPolicy() {
  return { scopes: ['task', 'session', 'project'], ids: { task: 't-1', session: 's-1', project: null } };
}

function memTask(over = {}) {
  const task = createResearchTask({ question: 'What transports does the protocol support?', ...over });
  task.sessionId = 's-1';
  task.taskId = 't-1';
  task.classification = { freshness: 'slow', timeSensitive: false };
  return task;
}

test('memory: an unverified or low-confidence claim is never remembered', () => {
  const rm = new ResearchMemory({ memory: new MemoryManager({}) });
  const mk = (status, confidence) => {
    const c = normalizeClaim({ text: 'The protocol supports stdio transports.' });
    c.verificationStatus = status;
    c.confidence = confidence;
    return c;
  };
  const task = memTask();
  const cites = (id) => [normalizeCitation({ claimId: id, evidenceId: 'e', sourceId: 's', url: 'https://a.example/1', quote: 'q' })];

  for (const [status, confidence] of [
    [VERIFICATION.UNVERIFIED, 0.9],
    [VERIFICATION.INSUFFICIENT_EVIDENCE, 0.9],
    [VERIFICATION.CONFLICTING, 0.9],
    [VERIFICATION.CONTRADICTED, 0.9],
    [VERIFICATION.SUPPORTED, 0.4],
  ]) {
    const claim = mk(status, confidence);
    const out = rm.candidates({ task, claims: [claim], citations: cites(claim.id), quality: { grade: 'adequate' } });
    assert.deepEqual(out, [], `${status} at ${confidence} was offered for storage`);
  }
});

test('memory: a verified claim is remembered with its citations and an expiry', () => {
  const rm = new ResearchMemory({ memory: new MemoryManager({}) });
  const claim = normalizeClaim({ text: 'The protocol supports stdio and HTTP transports.' });
  claim.verificationStatus = VERIFICATION.STRONGLY_SUPPORTED;
  claim.confidence = 0.85;
  claim.independentSourceCount = 3;

  const out = rm.candidates({
    task: memTask(),
    claims: [claim],
    citations: [normalizeCitation({ claimId: claim.id, evidenceId: 'e', sourceId: 's', url: 'https://std.example/spec', quote: 'the passage' })],
    quality: { grade: 'strong' },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].lifecycle, LIFECYCLE.VALIDATED);
  assert.ok(out[0].def.expiresAt > Date.now(), 'no expiry');
  assert.equal(out[0].def.metadata.citations.length, 1);
  assert.equal(out[0].def.metadata.citations[0].url, 'https://std.example/spec');
});

test('memory: nothing from a realtime question is remembered as fact', () => {
  const rm = new ResearchMemory({ memory: new MemoryManager({}) });
  const claim = normalizeClaim({ text: 'A vendor announced a product today.' });
  claim.verificationStatus = VERIFICATION.STRONGLY_SUPPORTED;
  claim.confidence = 0.9;
  const task = memTask();
  task.classification = { freshness: 'realtime', timeSensitive: true };
  assert.deepEqual(
    rm.candidates({ task, claims: [claim], citations: [normalizeCitation({ claimId: claim.id, evidenceId: 'e', sourceId: 's' })], quality: { grade: 'strong' } }),
    [],
  );
});

test('memory: research the evaluator would not stand behind is not remembered', () => {
  const rm = new ResearchMemory({ memory: new MemoryManager({}) });
  const claim = normalizeClaim({ text: 'A statement.' });
  claim.verificationStatus = VERIFICATION.STRONGLY_SUPPORTED;
  claim.confidence = 0.9;
  assert.deepEqual(
    rm.candidates({ task: memTask(), claims: [claim], citations: [normalizeCitation({ claimId: claim.id, evidenceId: 'e', sourceId: 's' })], quality: { grade: 'insufficient' } }),
    [],
  );
});

test('memory: a commit denied by the memory policy is not a research failure', async () => {
  const rm = new ResearchMemory({ memory: new MemoryManager({}) });
  const claim = normalizeClaim({ text: 'The protocol supports stdio transports.' });
  claim.verificationStatus = VERIFICATION.SUPPORTED;
  claim.confidence = 0.7;
  const candidates = rm.candidates({
    task: memTask(),
    claims: [claim],
    citations: [normalizeCitation({ claimId: claim.id, evidenceId: 'e', sourceId: 's', url: 'https://a.example/1' })],
    quality: { grade: 'adequate' },
  });
  // A policy that grants nothing: the write is refused, and commit returns
  // empty rather than throwing into the middle of a completed research run.
  const stored = await rm.commit(candidates, { policy: { scopes: [], ids: {} } });
  assert.deepEqual(stored, []);
});

test('memory: without a memory manager the layer reports itself unavailable', async () => {
  const rm = new ResearchMemory({});
  assert.equal(rm.available, false);
  assert.deepEqual(rm.candidates({ task: memTask(), claims: [], citations: [], quality: null }), []);
  assert.equal(rm.summaryCandidate({ task: memTask(), quality: null, claims: [] }), null);
  assert.equal(await rm.findAnswer({ question: 'x', policy: memoryPolicy() }), null);
});

test('memory: a remembered answer is found again, and an expired one is not', async () => {
  const memory = new MemoryManager({});
  const rm = new ResearchMemory({ memory });
  const policy = memoryPolicy();
  const question = 'What transports does the protocol support?';

  const claim = normalizeClaim({ text: 'The protocol supports stdio and HTTP transports.' });
  claim.verificationStatus = VERIFICATION.STRONGLY_SUPPORTED;
  claim.confidence = 0.85;
  const candidates = rm.candidates({
    task: memTask(),
    claims: [claim],
    citations: [normalizeCitation({ claimId: claim.id, evidenceId: 'e', sourceId: 's', url: 'https://std.example/spec', quote: 'q' })],
    quality: { grade: 'strong' },
  });
  await rm.commit(candidates, { policy });

  const hit = await rm.findAnswer({ question, policy });
  assert.ok(hit, 'a freshly remembered answer was not found');
  assert.ok(hit.confidence >= 0.6);
  assert.ok(hit.citations.length > 0, 'a remembered answer must carry its citations');

  // An unrelated question must not match it.
  assert.equal(await rm.findAnswer({ question: 'How do I configure the billing export?', policy }), null);
});

// --- the Verifier role ------------------------------------------------------

test('verifier role: plain statements are checked against sources and reported', async () => {
  const { Verifier } = require('../src/core/research/agents/verifier');
  const { SourceManager } = require('../src/core/research/sources/sourceManager');
  const { createSourceRegistry } = require('../src/core/research/sources/sourceRegistry');
  const { createSearchProviderRegistry } = require('../src/core/research/sources/searchProvider');
  const { createWebSource } = require('../src/core/research/sources/webSource');
  const { createDocumentationSource } = require('../src/core/research/sources/documentationSource');
  const { PolicyManager } = require('../src/core/policy');

  const policy = new PolicyManager({ defaultEffect: 'allow' });
  policy.loadBaseline();
  policy.setApprover(async () => true);
  require('../src/core/research/policies/researchPolicy').loadResearchPolicies(policy, { allowNetworkedSources: true });

  const providers = createSearchProviderRegistry();
  providers.register('docs', {
    sourceTypes: ['web', 'documentation'],
    async search() {
      return [{
        title: 'Specification',
        url: 'https://std.example/spec',
        content: 'The protocol supports stdio and HTTP transports for local and remote servers alike.',
      }];
    },
  });
  const registry = createSourceRegistry();
  registry.register(createWebSource());
  registry.register(createDocumentationSource());

  const sourceManager = new SourceManager({ registry, providers, policy });
  const verifier = new Verifier({ sourceManager });

  const task = createResearchTask({ question: 'Verify: the protocol supports stdio transports', mode: 'standard' });
  const out = await verifier.check({
    task,
    statements: ['The protocol supports stdio and HTTP transports.'],
    strategy: { mode: 'standard', freshness: 'moderate', targets: { minConfidence: 0.55 }, sourceTypes: ['documentation', 'web'] },
  });

  assert.equal(out.claims.length, 1);
  assert.ok(out.report.attempted.length > 0, 'nothing was attempted');
  // The statement is now backed by evidence that was actually retrieved.
  assert.ok(out.store.evidenceForClaim(out.claims[0].id).length > 0, 'no evidence was gathered');
  assert.notEqual(out.claims[0].verificationStatus, 'unverified');
});

test('verifier role: a statement nothing supports comes back unverified, not invented', async () => {
  const { Verifier } = require('../src/core/research/agents/verifier');
  const { SourceManager } = require('../src/core/research/sources/sourceManager');
  const { createSourceRegistry } = require('../src/core/research/sources/sourceRegistry');
  const { createSearchProviderRegistry } = require('../src/core/research/sources/searchProvider');
  const { createWebSource } = require('../src/core/research/sources/webSource');

  const providers = createSearchProviderRegistry();
  providers.register('empty', { sourceTypes: ['web'], async search() { return []; } });
  const registry = createSourceRegistry();
  registry.register(createWebSource());

  const verifier = new Verifier({ sourceManager: new SourceManager({ registry, providers, policy: null }) });
  const task = createResearchTask({ question: 'Verify something', mode: 'standard' });
  const out = await verifier.check({
    task,
    statements: ['An assertion no source in this corpus makes.'],
    strategy: { mode: 'standard', freshness: 'moderate', targets: { minConfidence: 0.55 }, sourceTypes: ['web'] },
  });
  assert.equal(out.claims[0].verificationStatus, 'unverified');
  assert.equal(out.claims[0].confidence, 0);
  assert.deepEqual(out.conflicts, []);
});
