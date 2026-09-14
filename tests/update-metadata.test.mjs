import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeMetadata, validateMetadata, extractStructuredMetadata } = require('../src/main/updater/update-metadata.js');

// --- the structured block, when a release author wrote one -------------------

const fencedBody = (obj) => `Some prose about the release.\n\n\`\`\`kingagent-update\n${JSON.stringify(obj)}\n\`\`\`\n\nMore prose after.`;

test('a well-formed fence is read as structured metadata', () => {
  const doc = extractStructuredMetadata(fencedBody({ summary: 'x', importance: 'critical' }));
  assert.deepEqual(doc, { summary: 'x', importance: 'critical' });
});

test('no fence at all reads as no structured metadata', () => {
  assert.equal(extractStructuredMetadata('just some release notes'), null);
});

test('a broken fence reads as no structured metadata, never as an error', () => {
  assert.equal(extractStructuredMetadata('```kingagent-update\nnot json{\n```'), null);
});

test('a fence holding an array rather than an object is rejected', () => {
  assert.equal(extractStructuredMetadata('```kingagent-update\n["a","b"]\n```'), null);
});

// --- normalizeMetadata: structured wins ---------------------------------------

test('structured metadata is trusted over release name and notes', () => {
  const meta = normalizeMetadata({
    tag_name: 'v0.6.0',
    name: 'Release name nobody reads',
    body: fencedBody({
      summary: 'Major Agent Runtime improvements',
      importance: 'important',
      highlights: ['Improved Agent Runtime', 'Faster tool execution'],
      features: ['Faster tool execution'],
      bugFixes: ['Fixed a crash on empty folders'],
      securityFixes: [],
      breakingChanges: false,
      requiresRestart: true,
    }),
  });
  assert.equal(meta.version, '0.6.0');
  assert.equal(meta.summary, 'Major Agent Runtime improvements');
  assert.equal(meta.importance, 'important');
  assert.deepEqual(meta.highlights, ['Improved Agent Runtime', 'Faster tool execution']);
  assert.deepEqual(meta.features, ['Faster tool execution']);
  assert.deepEqual(meta.bugFixes, ['Fixed a crash on empty folders']);
  assert.equal(meta.source, 'structured');
});

// --- the fallback hierarchy ----------------------------------------------------

test('with no structured block, the release name is the title', () => {
  const meta = normalizeMetadata({ tag_name: 'v0.6.0', name: 'KingAgent 0.6.0 — Faster everything' });
  assert.equal(meta.title, 'KingAgent 0.6.0 — Faster everything');
  assert.equal(meta.source, 'release-name');
});

test('with no name either, the release notes become the summary', () => {
  const meta = normalizeMetadata({ tag_name: 'v0.6.0', body: 'Fixed a bug.\n\nAnd another thing.' });
  assert.equal(meta.summary, 'Fixed a bug.');
  assert.equal(meta.source, 'release-notes');
});

test('with nothing at all, a generic message is used, never fabricated detail', () => {
  const meta = normalizeMetadata({ tag_name: 'v0.6.0' });
  assert.equal(meta.summary, 'A new version of KingAgent is available.');
  assert.equal(meta.title, 'KingAgent 0.6.0');
  assert.equal(meta.source, 'generic');
});

test('a long release-notes paragraph is trimmed, not silently truncated mid-sentence-reader-unaware', () => {
  const long = 'x'.repeat(500);
  const meta = normalizeMetadata({ tag_name: 'v0.6.0', body: long });
  assert.ok(meta.summary.endsWith('…'));
  assert.ok(meta.summary.length <= 400);
});

// --- optional metadata never breaks the update -----------------------------

test('missing metadata never throws and always returns every field', () => {
  const meta = normalizeMetadata(null);
  assert.equal(meta.version, null);
  assert.deepEqual(meta.highlights, []);
  assert.equal(meta.requiresRestart, true);
});

test('malformed structured fields are ignored rather than trusted blindly', () => {
  const meta = normalizeMetadata({
    tag_name: 'v0.6.0',
    body: fencedBody({ importance: 'urgent!!', category: 'nonsense', highlights: 'not an array', estimatedDownloadSize: -5 }),
  });
  assert.equal(meta.importance, null);
  assert.equal(meta.category, null);
  assert.deepEqual(meta.highlights, []);
  assert.equal(meta.estimatedDownloadSize, 0);
});

// --- validateMetadata ---------------------------------------------------------

test('a well-formed metadata object validates clean', () => {
  assert.deepEqual(validateMetadata({ importance: 'critical', category: 'security', highlights: [] }), []);
});

test('invalid importance and category are both reported', () => {
  const errs = validateMetadata({ importance: 'nope', category: 'nope' });
  assert.equal(errs.length, 2);
});

test('non-array change lists are reported', () => {
  const errs = validateMetadata({ bugFixes: 'not an array' });
  assert.deepEqual(errs, ['bugFixes must be an array']);
});

test('not an object at all is reported without throwing', () => {
  assert.deepEqual(validateMetadata(null), ['metadata must be an object']);
  assert.deepEqual(validateMetadata('nope'), ['metadata must be an object']);
});
