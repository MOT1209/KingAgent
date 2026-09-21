import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
// panelSnapshot and startPanel live in panel-lifecycle.mjs now (extracted
// from app.js), so the two tests that inspect their bodies read this file.
const panelLifecycleSrc = readFileSync(path.join(root, 'src/renderer/panel-lifecycle.mjs'), 'utf8');

test('the card renderer modules are gone', () => {
  for (const f of ['cards-dom.mjs', 'session-cards.mjs', 'agent-commands.mjs']) {
    assert.equal(existsSync(path.join(root, 'src/renderer', f)), false, f);
  }
  assert.doesNotMatch(src, /cards-dom|session-cards|agent-commands/);
});

test('the launcher has no Cards / Terminal birth pair and does not remember a surface', () => {
  assert.doesNotMatch(src, /way--cards/);
  assert.doesNotMatch(src, /nami\.surface\./);
  assert.doesNotMatch(src, /canShowCards|cardAgentFor|enterCards|mountCards/);
});

test('panelSnapshot does not persist view, so no new cards tiles are written', () => {
  const m = panelLifecycleSrc.match(/function panelSnapshot\(\) \{[\s\S]*?\n {2}function savePanels\(/);
  assert.ok(m, 'panelSnapshot must exist');
  assert.doesNotMatch(m[0], /view:\s*p\.view/);
});

test('startPanel coerces a persisted cards view to term', () => {
  const m = panelLifecycleSrc.match(/function startPanel\(opts\) \{[\s\S]*?\n {2}const VIEWER_CODES/);
  assert.ok(m, 'startPanel must exist');
  assert.match(m[0], /view === ['"]cards['"]/);
  assert.match(m[0], /view = ['"]term['"]/);
});
