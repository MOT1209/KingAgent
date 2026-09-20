// The visible-failure path for agent-platform-boot.mjs: mountAgentPlatform()
// returning null is the normal "not installed" case (silent, correct); only
// a thrown error means something broke, and that used to go to console.error
// alone. bannerHtml is the pure, DOM-free half of the fix — the actual
// document.body.appendChild wiring needs a real renderer window, consistent
// with how this codebase splits renderer testing (see package.json's c8 note).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bannerHtml } from '../src/renderer/agent-platform-boot.mjs';

test('bannerHtml names the failure in the message', () => {
  const html = bannerHtml(new Error('preload missing'));
  assert.match(html, /Agent platform failed to load: preload missing/);
});

test('bannerHtml escapes HTML in the error message', () => {
  const html = bannerHtml(new Error('<img src=x onerror=alert(1)>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
});

test('bannerHtml handles a non-Error thrown value', () => {
  const html = bannerHtml('plain string failure');
  assert.match(html, /plain string failure/);
});
