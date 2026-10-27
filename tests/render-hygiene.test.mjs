// Guards for the leaks and forced layouts the audit measured (U3, U4/U24, U6,
// U7, U19). They read source, like tests/ipc-wiring.test.mjs, because the
// renderer has no DOM under node:test — what they pin is the wiring that made
// each defect possible, not a behaviour a unit could reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const src = (f) => fs.readFileSync(path.join(R, f), 'utf8');

test('a chat tile removes the document listener its composer added (U3)', () => {
  const composer = src('acp-composer.mjs');
  assert.match(composer, /document\.addEventListener\('click', closeMenu\)/);
  assert.match(composer, /dispose: \(\) => \{[^}]*document\.removeEventListener\('click', closeMenu\)/);
  assert.match(src('acp-pane.mjs'), /rec\.disposeRo = \(\) => \{[^}]*composer\.dispose\(\)/);
});

test('every document-level listener in a tile mount has a matching removal', () => {
  for (const f of ['acp-composer.mjs', 'acp-pane.mjs']) {
    const s = src(f);
    const added = (s.match(/document\.addEventListener\(/g) || []).length;
    const removed = (s.match(/document\.removeEventListener\(/g) || []).length;
    assert.ok(removed >= added, `${f}: ${added} added, ${removed} removed`);
  }
});

test('the dead session-sources module stays deleted (U4, U24)', () => {
  assert.equal(fs.existsSync(path.join(R, 'session-sources.mjs')), false);
});

test('the composer measures once per frame, not once per keystroke (U7)', () => {
  const s = src('acp-composer.mjs');
  assert.match(s, /function grow\(\) \{\s*if \(growRaf\) return;\s*growRaf = requestAnimationFrame/);
});

test("the glass tilt's style writes do not trigger a browser layout pass (U6)", () => {
  const s = src('browser-pane.mjs');
  assert.match(s, /classList\.contains\('nav-card'\)/);
  assert.doesNotMatch(s, /new MutationObserver\(schedule\)/);
});

test('terminal fits read for every tile before writing for any (U19)', () => {
  const s = src('tile-shell.mjs');
  const body = s.slice(s.indexOf('function fitBatch'), s.indexOf('function mountTerminal'));
  const at = (re) => body.search(re);
  assert.ok(at(/proposeDimensions/) < at(/term\.resize\(dim\.cols/), 'propose before resize');
  assert.ok(at(/term\.resize\(dim\.cols/) < at(/getBoundingClientRect/), 'resize before the overflow read');
  assert.ok(at(/getBoundingClientRect/) < at(/rec\.term\.resize\(rec\.term\.cols - drop/), 'overflow read before the clip');
  assert.match(s, /function drainFits\(\) \{[^}]*fitBatch\(batch\)/);
});
