import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { analyzeRelease, deriveHighlights, extractBullets, classifyCategory } = require('../src/main/updater/update-analyzer.js');
const { normalizeMetadata, FIELD_DEFAULTS } = require('../src/main/updater/update-metadata.js');

const meta = (over = {}) => ({ ...FIELD_DEFAULTS, version: '0.6.0', ...over });

// --- highlights, in the order the spec's fallback expects --------------------

test('a curated highlights list is used as-is', () => {
  assert.deepEqual(deriveHighlights(meta({ highlights: ['A', 'B'] })), ['A', 'B']);
});

test('without highlights, the change lists are combined, security first', () => {
  const m = meta({ securityFixes: ['Patched a thing'], features: ['New thing'], bugFixes: ['Fixed a thing'] });
  assert.deepEqual(deriveHighlights(m), ['Patched a thing', 'New thing', 'Fixed a thing']);
});

test('without any lists, bullet lines are pulled out of the summary verbatim', () => {
  const m = meta({ summary: 'Notes:\n- one thing\n* two thing\nnot a bullet\n• three thing' });
  assert.deepEqual(deriveHighlights(m), ['one thing', 'two thing', 'three thing']);
});

test('nothing usable anywhere yields an empty list, never an invented one', () => {
  assert.deepEqual(deriveHighlights(meta({ summary: 'Just a sentence, no bullets.' })), []);
});

test('highlights are capped rather than overflowing the dialog', () => {
  const m = meta({ highlights: Array.from({ length: 20 }, (_, i) => `item ${i}`) });
  assert.equal(deriveHighlights(m).length, 6);
});

test('extractBullets ignores non-bullet lines', () => {
  assert.deepEqual(extractBullets('hello\n- a\nworld\n- b'), ['a', 'b']);
});

// --- category inference --------------------------------------------------------

test('an explicit category is trusted over inference', () => {
  assert.equal(classifyCategory(meta({ category: 'performance' })), 'performance');
});

test('a breaking change outranks a security fix in category, per the priority list', () => {
  assert.equal(classifyCategory(meta({ breakingChanges: true, securityFixes: ['x'] })), 'breaking');
});

test('with nothing else to go on, compatibility is the fallback category', () => {
  assert.equal(classifyCategory(meta()), 'compatibility');
});

// --- the whole analysis ---------------------------------------------------------

test('analyzeRelease counts stats straight off the arrays, never invents a number', () => {
  const a = analyzeRelease(meta({ features: ['a', 'b'], bugFixes: ['c'], securityFixes: [] }));
  assert.deepEqual(a.stats, { features: 2, bugFixes: 1, securityFixes: 0 });
});

test('requiresRestart defaults true, matching the spec default', () => {
  assert.equal(analyzeRelease(meta()).requiresRestart, true);
});

test('requiresRestart can be turned off by the metadata', () => {
  assert.equal(analyzeRelease(meta({ requiresRestart: false })).requiresRestart, false);
});

test('a real normalized release feeds straight into the analyzer', () => {
  const m = normalizeMetadata({
    tag_name: 'v0.6.0',
    body: '```kingagent-update\n' + JSON.stringify({
      summary: 'Major Agent Runtime improvements',
      features: ['Improved Agent Runtime', 'Faster tool execution'],
      bugFixes: ['Fixed a crash on empty folders'],
      securityFixes: ['Patched a path-traversal bug'],
    }) + '\n```',
  });
  const a = analyzeRelease(m);
  assert.equal(a.version, '0.6.0');
  assert.deepEqual(a.stats, { features: 2, bugFixes: 1, securityFixes: 1 });
  assert.equal(a.category, 'security');
  assert.equal(a.highlights[0], 'Patched a path-traversal bug');
});
