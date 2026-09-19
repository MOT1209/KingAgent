// The session (terminal) tile's right-click menu, and specifically the
// "Keep running in background" toggle that drives closePanel's opt-in
// detach-instead-of-kill behavior (background-sessions.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionMenuItems } from '../src/renderer/session-menu.mjs';

const calls = [];
const ctx = {
  addBrowser: (p) => calls.push(['addBrowser', p.id]),
  toggleKeepRunning: (p) => calls.push(['toggle', p.id]),
};
const labels = (items) => items.map((i) => (typeof i === 'string' ? i : i.label));

test('default state: unchecked label, add browser first', () => {
  const items = sessionMenuItems({ id: 's1' }, ctx);
  assert.deepEqual(labels(items), ['Add browser…', '-', 'Keep running in background']);
});

test('keepRunning true: the label carries a check mark, not a separate row', () => {
  const items = sessionMenuItems({ id: 's1', keepRunning: true }, ctx);
  assert.deepEqual(labels(items), ['Add browser…', '-', '✓ Keep running in background']);
  const toggleItem = items[2];
  assert.equal(toggleItem.kb, 'stays alive on close');
});

test('unchecked item carries no shortcut hint', () => {
  const items = sessionMenuItems({ id: 's1' }, ctx);
  assert.equal(items[2].kb, undefined);
});

test('clicking the toggle row calls ctx.toggleKeepRunning with the panel', () => {
  calls.length = 0;
  const p = { id: 's1' };
  sessionMenuItems(p, ctx)[2].run();
  assert.deepEqual(calls, [['toggle', 's1']]);
});

test('clicking Add browser calls ctx.addBrowser with the panel', () => {
  calls.length = 0;
  const p = { id: 's2' };
  sessionMenuItems(p, ctx)[0].run();
  assert.deepEqual(calls, [['addBrowser', 's2']]);
});
