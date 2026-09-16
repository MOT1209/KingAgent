// Phase 7 §41: the research progress display.
//
// The reducer is tested rather than the DOM, because the interesting part is
// what a stream of events *means* — and the property worth pinning is that the
// display cannot quietly turn a bad run into a green one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, renderProgressLines, emptyState } from '../src/renderer/research-progress.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ev = (type, payload = {}) => ({ type, payload });

function run(events) {
  let state = emptyState();
  for (const e of events) state = summarize(state, e);
  return state;
}

test('progress: a clean run reads as §41 describes it', () => {
  const state = run([
    ev('research.started', { taskId: 't1' }),
    ev('research.classified', { category: 'deep_research', degraded: false }),
    ev('research.query.planned', { count: 8 }),
    ...Array.from({ length: 8 }, () => ev('research.query.executed', { status: 'completed' })),
    ev('research.source.deduplicated', { before: 34, after: 25, removed: 9, unusable: 0 }),
    ev('research.evidence.extracted', { count: 21 }),
    ...Array.from({ length: 14 }, () => ev('research.claim.verified', {})),
    ev('research.conflict.detected', {}),
    ev('research.conflict.detected', {}),
    ev('research.citations.validated', { ok: true, errors: 0, warnings: 0 }),
    ev('research.evaluated', { score: 0.8, grade: 'strong', passed: true, targetsMet: true, reasons: [] }),
    ev('research.completed', { partial: false }),
  ]);
  const lines = renderProgressLines(state);
  const text = lines.map((l) => `${l.mark} ${l.text} ${l.note}`).join('\n');

  assert.match(text, /Planned 8 queries/);
  assert.match(text, /Searched 8 of 8/);
  assert.match(text, /Removed 9 duplicates/);
  assert.match(text, /Extracted 21 evidence items/);
  assert.match(text, /Verified 14 claims/);
  assert.match(text, /2 conflicting sources/);
  assert.match(text, /Citations check out/);
  assert.match(text, /Quality: strong/);
  assert.match(text, /Done/);
});

test('progress: an unresolved conflict is a warning, not a tick', () => {
  const state = run([
    ev('research.started', {}),
    ev('research.conflict.detected', {}),
    ev('research.conflict.detected', {}),
    ev('research.conflict.resolved', { resolution: 'prefer_primary' }),
  ]);
  const line = renderProgressLines(state).find((l) => /conflicting sources/.test(l.text));
  assert.equal(line.mark, 'warn');
  assert.match(line.note, /1 unresolved/);
});

test('progress: a citation failure is a failure mark, never a tick', () => {
  const state = run([
    ev('research.started', {}),
    ev('research.citations.validated', { ok: false, errors: 3, warnings: 0 }),
  ]);
  const line = renderProgressLines(state).find((l) => /Citation/.test(l.text));
  assert.equal(line.mark, 'fail');
  assert.match(line.note, /3 error/);
});

test('progress: queries that returned nothing are reported, not rounded away', () => {
  const state = run([
    ev('research.started', {}),
    ev('research.query.planned', { count: 5 }),
    ev('research.query.executed', { status: 'completed' }),
    ev('research.query.executed', { status: 'failed' }),
    ev('research.query.executed', { status: 'skipped' }),
  ]);
  const line = renderProgressLines(state).find((l) => /Searched/.test(l.text));
  assert.equal(line.mark, 'warn');
  assert.match(line.note, /2 returned nothing/);
});

test('progress: a degraded plan says which source types had no provider', () => {
  const state = run([
    ev('research.started', {}),
    ev('research.classified', { degraded: true, unavailable: ['academic', 'github'] }),
    ev('research.query.planned', { count: 3 }),
  ]);
  const line = renderProgressLines(state).find((l) => l.stage === 'plan');
  assert.match(line.note, /no provider for academic, github/);
});

test('progress: a partial finish never reads as done', () => {
  const state = run([ev('research.started', {}), ev('research.completed', { partial: true })]);
  const last = renderProgressLines(state).at(-1);
  assert.equal(last.mark, 'warn');
  assert.match(last.text, /partial results/);
});

test('progress: a replan reopens the stages it is redoing', () => {
  const state = run([
    ev('research.started', {}),
    ev('research.query.planned', { count: 3 }),
    ev('research.query.executed', { status: 'completed' }),
    ev('research.evaluated', { score: 0.3, grade: 'weak', passed: true, targetsMet: false, reasons: ['thin'] }),
    ev('research.replanned', { round: 0, queries: ['more'], gaps: ['thin'] }),
  ]);
  assert.equal(state.stages.search, 'running');
  assert.match(renderProgressLines(state).map((l) => l.text).join('\n'), /Researching further \(round 2\)/);
});

test('progress: a live status poll wins over a stale event stream', () => {
  // A window opened mid-run saw none of the earlier events; the poll's counts
  // must be what is displayed rather than the zeros the reducer holds.
  const lines = renderProgressLines(emptyState(), {
    progress: { queries: { total: 8, completed: 6, running: 2 }, sources: 19, evidence: 12, claims: 5, citations: 7, conflicts: 0, failures: 0 },
  });
  const text = lines.map((l) => l.text).join('\n');
  assert.match(text, /Searched 6 of 8/);
  assert.match(text, /Retrieved 19 sources/);
  assert.match(text, /Extracted 12 evidence items/);
});

test('progress: the reducer is pure — folding an event never mutates the input', () => {
  const before = run([ev('research.started', {}), ev('research.query.planned', { count: 3 })]);
  const snapshot = JSON.stringify(before);
  summarize(before, ev('research.query.executed', { status: 'completed' }));
  assert.equal(JSON.stringify(before), snapshot);
});

// Comments are stripped first: this checks what the panel *renders*, and the
// module comments explaining the invariant naturally name the thing they forbid.
function code(file) {
  return fs.readFileSync(path.join(ROOT, 'src', 'renderer', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('ui: the panel renders no field that could carry deliberation', () => {
  const src = code('research-panel.mjs') + code('research-progress.mjs');
  for (const forbidden of ['reasoning', 'chainOfThought', 'chain_of_thought', 'thoughts', 'scratchpad', 'systemPrompt', 'rawPrompt', 'deliberation']) {
    assert.ok(!src.includes(forbidden), `the research UI references ${forbidden}`);
  }
});

test('ui: the panel reaches the platform only through the guarded preload surface', () => {
  const src = code('research-panel.mjs');
  // No direct ipcRenderer, no fetch, no require: the renderer talks to
  // `window.kingagent.agentPlatform` and nothing else.
  assert.ok(!src.includes('ipcRenderer'), 'the panel reaches ipcRenderer directly');
  assert.ok(!/(?:await|return|=|\(|,)\s*fetch\s*\(/.test(src), 'the panel calls fetch directly');
  assert.ok(!src.includes('require('), 'the panel uses require');
  for (const method of ['startResearch', 'researchStatus', 'cancelResearch', 'getResearch']) {
    assert.ok(src.includes(`api.${method}`), `the panel does not use api.${method}`);
  }
});

test('ui: the research section is mounted into the agent platform panel', () => {
  const src = code('agent-platform.mjs');
  assert.match(src, /import \{ mountResearch \}/, 'the panel does not import the research view');
  assert.match(src, /attachResearch\(panel\.querySelector\('\.agent-platform-scroll'\)\)/,
    'the research section is not attached after a render');
  // The panel rebuilds itself with innerHTML; the research view owns a live
  // subscription and a poll, so it must be re-attached rather than re-created.
  assert.match(src, /if \(!researchSection\) researchSection = buildResearchSection\(\)/,
    'the research section is rebuilt on every render');
  assert.match(src, /if \(!ev\.type\.startsWith\('research\.'\)\) render\(\)/,
    'a research event triggers a full panel render');
});

test('ui: a build without research says so rather than offering a dead button', () => {
  const src = code('agent-platform.mjs');
  assert.match(src, /Research is not available in this build/);
});
