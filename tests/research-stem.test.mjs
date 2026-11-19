import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { stem } = require('../src/core/research/text.js');

test('stem strips a plural or third-person -s', () => {
  assert.equal(stem('transports'), 'transport');
  assert.equal(stem('supports'), 'support');
});

test('stem handles -ies and sibilant -es endings', () => {
  assert.equal(stem('queries'), 'query');
  assert.equal(stem('searches'), 'search');
  assert.equal(stem('boxes'), 'box');
});

test('stem leaves short tokens and guarded endings alone', () => {
  for (const w of ['bus', 'is', 'class', 'status', 'analysis', 'tools'.slice(0, 3)]) {
    assert.equal(stem(w), w);
  }
});

test('stem leaves tokens with internal punctuation alone', () => {
  for (const w of ['modelcontextprotocol.io', 'src/core/files', 'my-tools', 'v1.2.0s']) {
    assert.equal(stem(w), w);
  }
});

test('stem returns an empty string unchanged', () => {
  assert.equal(stem(''), '');
});

test('stem leaves tokens without a plural ending alone', () => {
  assert.equal(stem('stdio'), 'stdio');
});
