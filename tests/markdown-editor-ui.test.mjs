import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/renderer/paper.css'), 'utf8');
// mountEditor (the rich/Markdown editor tabs and block editor mount) lives in
// tile-content.mjs now (extracted from app.js).
const tileContent = fs.readFileSync(path.join(root, 'src/renderer/tile-content.mjs'), 'utf8');

test('plain Markdown cards expose Read, Edit, and Markdown without affecting MDX', () => {
  assert.match(tileContent, /richMarkdownPath\(p\.filePath\)/);
  assert.match(tileContent, /data-m="markdown">Markdown/);
  assert.match(tileContent, /mountMarkdownEditor\(/);
  assert.match(tileContent, /class="ed-rich/);
});

test('media creation is deliberately absent until its interaction is ready', () => {
  assert.doesNotMatch(tileContent, /class="ed-add/);
  assert.doesNotMatch(tileContent, /class="ed-asset-pop/);
  assert.doesNotMatch(tileContent, /api\.chooseFile\(/);
  assert.doesNotMatch(tileContent, /api\.importMarkdownAsset\(/);
});

test('rich and source panes are mutually exclusive and theme-token driven', () => {
  assert.match(css, /editor--rich\[data-mode="edit"\] \.ed-pane/);
  assert.match(css, /editor--rich\[data-mode="markdown"\] \.ed-rich/);
  assert.match(css, /\.ed-rich[^}]*var\(--ink\)/s);
  assert.doesNotMatch(css, /\.ed-rich[^}]*#[0-9a-f]{3,8}/is);
});
