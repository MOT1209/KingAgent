import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guarded, messageOf } from '../src/renderer/guard.mjs';
import { activateOnKey } from '../src/renderer/a11y.mjs';

const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const src = (f) => fs.readFileSync(path.join(R, f), 'utf8');

test('guarded routes a rejection to the reporter, then settles', async () => {
  const seen = [];
  await guarded(async () => { throw new Error('boom'); }, (e) => seen.push(e.message), () => seen.push('settled'))();
  assert.deepEqual(seen, ['boom', 'settled']);
});

test('guarded routes a synchronous throw too, and passes the value through on success', async () => {
  const seen = [];
  guarded(() => { throw new Error('sync'); }, (e) => seen.push(e.message))();
  assert.deepEqual(seen, ['sync']);
  assert.equal(await guarded(async (a, b) => a + b, () => assert.fail('no error expected'))(2, 3), 5);
  assert.equal(guarded((x) => x * 2, () => assert.fail('no error expected'))(4), 8);
});

test('a reporter that throws does not become an unhandled rejection', async () => {
  await guarded(async () => { throw new Error('a'); }, () => { throw new Error('reporter broke'); })();
});

test('messageOf keeps the first line and falls back', () => {
  assert.equal(messageOf(new Error('Error invoking remote method\nstack…')), 'Error invoking remote method');
  assert.equal(messageOf(null), 'Something went wrong.');
  assert.equal(messageOf({}, 'x'), 'x');
});

function fakeEl() {
  const attrs = new Map(), handlers = {};
  return {
    tabIndex: -1, attrs,
    hasAttribute: (k) => attrs.has(k), setAttribute: (k, v) => attrs.set(k, v),
    addEventListener: (t, fn) => { handlers[t] = fn; },
    press(key, target) { let prevented = false; handlers.keydown({ key, target: target === undefined ? this : target, preventDefault: () => { prevented = true; } }); return prevented; },
  };
}

test('activateOnKey makes an element tabbable, a button, and Enter/Space-activated', () => {
  const el = fakeEl(); let runs = 0;
  activateOnKey(el, () => { runs++; });
  assert.equal(el.tabIndex, 0);
  assert.equal(el.attrs.get('role'), 'button');
  assert.equal(el.press('Enter'), true);
  assert.equal(el.press(' '), true);
  assert.equal(el.press('a'), false);
  assert.equal(runs, 2);
});

test('a key pressed inside the row, on a control of its own, is left alone', () => {
  const el = fakeEl(); let runs = 0;
  activateOnKey(el, () => { runs++; });
  assert.equal(el.press('Enter', {}), false);
  assert.equal(runs, 0);
});

test('an existing role is kept', () => {
  const el = fakeEl(); el.setAttribute('role', 'tab'); el.setAttribute('tabindex', '0'); el.tabIndex = 0;
  activateOnKey(el, () => {});
  assert.equal(el.attrs.get('role'), 'tab');
});

test('every sheet is a dialog: overlay() applies it, and the help dialog no longer does its own', () => {
  assert.match(src('app.js'), /makeDialog\(modal\);\s*wrap\.appendChild\(modal\)/);
  const d = src('dialog.mjs');
  assert.match(d, /setAttribute\('role', 'dialog'\)/);
  assert.match(d, /aria-labelledby/);
  assert.match(d, /if \(title\)/, 'a sheet with no .title must not throw (U22)');
  assert.doesNotMatch(src('settings-panes.mjs'), /setAttribute\('role', 'dialog'\)/);
});

test('the handlers the audit named are guarded', () => {
  assert.match(src('workspace-library.mjs'), /row\.onclick = guarded\(\(e\) => \{ e\.stopPropagation\(\); hideMenu\(\); return it\.run\(e\)/);
  assert.match(src('launcher.mjs'), /guarded\(act\.run,/);
  assert.match(src('settings-panes.mjs'), /finally \{ off\(\); dl\.disabled = false; \}/);
  assert.match(src('launcher.mjs'), /agentRemovalPlan\(agent\.id\)[\s\S]*?\.catch\(/);
  assert.match(src('panel-lifecycle.mjs'), /browsers\.canClose\(p\)\.then\([\s\S]*?\.catch\(/);
});

test('rows the keyboard could not reach now use activateOnKey (U15-U18, U46)', () => {
  const lib = src('workspace-library.mjs');
  for (const what of ['toggle, flipTree', 'row, () => focusPanel(p.id)', 'row, () => openCard(i)', 'lab, () => toggleLibGroup', 'add, () => openConnect']) {
    assert.ok(lib.includes('activateOnKey(' + what), what);
  }
  assert.match(src('launcher.mjs'), /activateOnKey\(toolsChev/);
  assert.match(src('mcp-setup.mjs'), /activateOnKey\(el, \(\) => el\.onclick\(\)\)/);
});
