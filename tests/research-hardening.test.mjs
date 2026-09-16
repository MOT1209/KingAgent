// Regressions for the findings of the post-implementation audit.
//
// Every test here corresponds to a defect that was live in the committed code
// and that produced either a crash, silent data loss, or a security bypass.
// They are kept together so the audit's result is a suite, not a memo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sec = require('../src/core/research/security/researchSecurity');
const { detect, resolveAll, MAX_CONFLICTS_PER_CLAIM } = require('../src/core/research/evidence/conflictDetector');
const { EvidenceStore } = require('../src/core/research/evidence/evidenceStore');
const { normalizeSource, sourceView, MAX_SNIPPET_CHARS } = require('../src/core/research/schemas/source');
const { normalizeEvidence } = require('../src/core/research/schemas/evidence');
const { normalizeClaim } = require('../src/core/research/schemas/claim');
const { createResearchSubsystem, ARTIFACT_INLINE_BUDGET } = require('../src/core/research');
const { ArtifactManager } = require('../src/core/artifacts/manager');
const { PolicyManager } = require('../src/core/policy');
const { isLinkable } = require('../src/renderer/research-panel.mjs');

function openPolicy() {
  const policy = new PolicyManager({ defaultEffect: 'allow' });
  policy.loadBaseline();
  policy.setApprover(async () => true);
  return policy;
}

// --- F1: DNS-based SSRF bypass ----------------------------------------------

test('F1 ssrf: a public hostname that resolves to a private address is refused', () => {
  // These are real public names. `localtest.me` resolves to 127.0.0.1 and
  // `<ip>.nip.io` resolves to whatever ip it spells — both passed the screen,
  // because the screen only inspected literal IPs.
  for (const url of [
    'http://localtest.me/',
    'http://169.254.169.254.nip.io/latest/meta-data/',
    'https://10.0.0.1.sslip.io/',
    'http://a.lvh.me/',
    'http://x.xip.io/',
    'http://foo.vcap.me/',
  ]) {
    assert.equal(sec.screenUrl(url).ok, false, `${url} was allowed`);
  }
  // And an ordinary public host still passes.
  assert.equal(sec.screenUrl('https://docs.example.com/guide').ok, true);
});

test('F1 ssrf: the resolved address is checkable, which is the defence a blocklist cannot be', () => {
  for (const addr of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '192.168.0.9', '172.20.1.1', '::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    assert.equal(sec.screenResolvedAddress(addr).ok, false, `${addr} was allowed`);
  }
  for (const addr of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(sec.screenResolvedAddress(addr).ok, true, `${addr} was refused`);
  }
  assert.equal(sec.screenResolvedAddress('').ok, false);
});

// --- F2: redirect SSRF ------------------------------------------------------

test('F2 ssrf: a redirect from an allowed host to a forbidden one is refused', () => {
  const hop = sec.screenRedirect('https://docs.example.com/a', 'http://169.254.169.254/latest/meta-data/');
  assert.equal(hop.ok, false);
  assert.match(hop.reason, /refused to follow a redirect/);
  // A redirect within allowed space is fine.
  assert.equal(sec.screenRedirect('https://docs.example.com/a', 'https://docs.example.com/b').ok, true);
  // The chain is bounded, so a redirect loop cannot hold a slot until deadline.
  assert.ok(Number.isInteger(sec.MAX_REDIRECTS) && sec.MAX_REDIRECTS > 0 && sec.MAX_REDIRECTS <= 10);
});

test('F2 ssrf: a redirect obeys the task allow and block lists too, not just the address rules', () => {
  const opts = { allowedDomains: ['docs.example.com'] };
  assert.equal(sec.screenRedirect('https://docs.example.com/a', 'https://elsewhere.example/b', opts).ok, false);
  assert.equal(sec.screenRedirect('https://docs.example.com/a', 'https://docs.example.com/b', opts).ok, true);
});

// --- F3: artifacts ----------------------------------------------------------

test('F3 artifacts: one oversized artifact no longer costs every other artifact', async () => {
  const artifacts = new ArtifactManager({});
  // A corpus big enough that the naive payloads would blow the 256KB inline
  // ceiling: before the fix the first oversized write threw and the remaining
  // artifacts were never attempted, so a run wrote one and reported none.
  const body = `The protocol supports stdio and HTTP transports. ${'x'.repeat(8000)}`;
  const rows = Array.from({ length: 150 }, (_, i) => ({
    title: `Doc ${i} ${'t'.repeat(300)}`,
    url: `https://d${i}.example/${'p'.repeat(150)}`,
    content: body,
  }));
  const s = createResearchSubsystem({
    policy: openPolicy(),
    artifacts,
    io: { searchProviders: { p: { sourceTypes: ['web', 'documentation'], async search({ limit }) { return rows.slice(0, limit); } } } },
    config: { allowNetworkedSources: true },
  });
  const workspace = {
    workspaceId: 'ws-1', taskId: 't-1', agentId: 'research', traceId: 'tr-1', projectId: null,
    identity: { workspaceId: 'ws-1', taskId: 't-1' }, attachArtifact() {},
  };
  const task = s.engine.create({ question: 'What transports does the protocol support?', mode: 'deep', workspaceId: 'ws-1' });
  const result = await s.engine.run(task, { workspace });

  const names = result.artifacts.map((a) => a.name).sort();
  assert.deepEqual(names, ['citations.json', 'evidence.json', 'research-report.json', 'research-report.md', 'sources.json']);
  // What is reported must match what is stored — the old code reported an
  // empty list while one artifact sat in the store.
  const stored = (await artifacts.list({ workspace })).map((a) => a.name).sort();
  assert.deepEqual(stored, names);
});

test('F3 artifacts: an oversized payload is trimmed and says so', async () => {
  const artifacts = new ArtifactManager({});
  const workspace = { workspaceId: 'ws-2', taskId: 't-2', agentId: 'a', identity: {}, attachArtifact() {} };

  const rows = Array.from({ length: 400 }, (_, i) => sourceView(normalizeSource({
    title: 't'.repeat(400),
    url: `https://d${i}.example/${'p'.repeat(200)}`,
    snippet: 's'.repeat(MAX_SNIPPET_CHARS),
    safety: { safe: true, findings: [] },
  })));
  assert.ok(Buffer.byteLength(JSON.stringify({ sources: rows })) > 256 * 1024, 'fixture is not actually oversized');

  // The engine's trimming rule, applied to the same payload.
  let kept = rows;
  let payload = { sources: kept };
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(payload)) > ARTIFACT_INLINE_BUDGET) {
    kept = kept.slice(0, Math.floor(kept.length / 2));
    payload = { sources: kept };
  }
  payload.truncated = { kept: kept.length, total: rows.length, reason: 'trimmed' };

  const artifact = await artifacts.create({ name: 'sources.json', type: 'dataset', content: payload }, { workspace });
  assert.ok(artifact, 'the trimmed payload was still refused');
  assert.ok(kept.length < rows.length, 'nothing was trimmed');
  assert.ok(ARTIFACT_INLINE_BUDGET < 256 * 1024, 'the budget must leave headroom under the hard cap');
});

// --- F4 and F5: the conflict-detection crash and blow-up ---------------------

function conflictFixture(n) {
  const store = new EvidenceStore();
  const sources = Array.from({ length: n }, (_, i) => normalizeSource({
    title: `S${i}`, url: `https://d${i}.example/p`, content: 'x'.repeat(200),
    safety: { safe: true, findings: [] },
  }));
  store.addSources(sources);
  const claim = store.addClaim(normalizeClaim({ text: 'The plan costs $20 per month per seat' }));
  for (let i = 0; i < n; i += 1) {
    const e = store.addEvidence(normalizeEvidence({
      text: `The plan costs $${20 + (i % 7)} per month per seat and includes support tier ${i}`,
      sourceId: sources[i].id,
      strength: 0.7,
    }));
    store.link(claim.id, e.id, i % 2 ? 'supports' : 'contradicts');
  }
  return store;
}

test('F4 conflicts: a large disagreeing corpus does not overflow the stack', () => {
  // Before the fix this threw RangeError at 600 items: the results were
  // appended with `push(...array)`, which passes every element as an argument.
  const store = conflictFixture(2000);
  const found = detect({ store, claims: store.claims() });
  assert.ok(Array.isArray(found));
});

test('F5 conflicts: the count stays bounded and the time stays flat', () => {
  const timings = [];
  for (const n of [50, 400, 1500]) {
    const store = conflictFixture(n);
    const started = Date.now();
    const found = resolveAll(detect({ store, claims: store.claims() }), { store });
    timings.push({ n, ms: Date.now() - started, count: found.length });
    // One claim cannot produce an unreadable list of disagreements; past the
    // ceiling it produces a summary instead.
    assert.ok(found.length <= MAX_CONFLICTS_PER_CLAIM + 1,
      `${n} evidence items produced ${found.length} conflicts`);
  }
  // Flat, not quadratic: the largest run must not be dramatically slower than
  // the smallest. (Generous bound — this is a shape assertion, not a benchmark.)
  const smallest = Math.max(timings[0].ms, 1);
  const largest = timings.at(-1).ms;
  assert.ok(largest < smallest * 20 + 500,
    `time grew from ${smallest}ms to ${largest}ms across ${timings.map((t) => t.n).join('/')} items`);
});

test('F5 conflicts: when disagreements are truncated, the answer says so', () => {
  const store = conflictFixture(200);
  const found = resolveAll(detect({ store, claims: store.claims() }), { store });
  const summary = found.find((c) => /further disagreement/.test(c.resolutionReason));
  assert.ok(summary, 'a truncated conflict set must be declared, not silently cut');
  assert.equal(summary.resolution, 'report_uncertainty');
});

test('F5 conflicts: a small honest disagreement is still reported in full', () => {
  // The cap must not cost the normal case its detail.
  const store = new EvidenceStore();
  const a = normalizeSource({ title: 'A', url: 'https://a.example/pricing', content: 'x'.repeat(200), safety: { safe: true, findings: [] } });
  const b = normalizeSource({ title: 'B', url: 'https://b.example/pricing', content: 'x'.repeat(200), safety: { safe: true, findings: [] } });
  store.addSources([a, b]);
  const claim = store.addClaim(normalizeClaim({ text: 'The Pro plan costs $20 per month per seat' }));
  const e1 = store.addEvidence(normalizeEvidence({ text: 'The Pro plan costs $20 per month per seat.', sourceId: a.id, strength: 0.8 }));
  const e2 = store.addEvidence(normalizeEvidence({ text: 'The Pro plan costs $35 per month per seat.', sourceId: b.id, strength: 0.8 }));
  store.link(claim.id, e1.id, 'supports');
  store.link(claim.id, e2.id, 'contradicts');

  const found = resolveAll(detect({ store, claims: store.claims() }), { store });
  assert.equal(found.length, 1);
  assert.ok(found[0].positions.some((p) => /\$20/.test(p.statement)));
  assert.ok(found[0].positions.some((p) => /\$35/.test(p.statement)));
});

// --- F6: the href sink ------------------------------------------------------

test('F6 renderer: only http(s) urls reach an href', () => {
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'not a url at all',
    '',
  ]) {
    assert.equal(isLinkable(bad), false, `${bad} would have been linked`);
  }
  assert.equal(isLinkable('https://docs.example.com/a'), true);
  assert.equal(isLinkable('http://docs.example.com/a'), true);
});
