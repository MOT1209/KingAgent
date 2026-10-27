import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');
const files = fs.readdirSync(R).filter((f) => /\.(mjs|js)$/.test(f));

test('no renderer file calls the blocking window.confirm() (U14)', () => {
  const bad = [];
  for (const f of files) {
    fs.readFileSync(path.join(R, f), 'utf8').split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (/(^|[^.\w])(window\.)?confirm\(/.test(code)) bad.push(`${f}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('confirmOutsideOpen answers with a promise at both call sites', () => {
  for (const f of ['terminal-link-tracking.mjs', 'tile-shell.mjs']) {
    assert.match(fs.readFileSync(path.join(R, f), 'utf8'), /confirmOutsideOpen\(st\.abs\)\.then\(/, f);
  }
});

test('the sheet is its own layer, a dialog, and answers no on Escape', () => {
  const s = fs.readFileSync(path.join(R, 'confirm-sheet.mjs'), 'utf8');
  assert.match(s, /makeDialog\(modal\)/);
  assert.match(s, /e\.key === 'Escape'[\s\S]{0,80}finish\(false\)/);
  assert.match(s, /document\.body\.appendChild\(wrap\)/);
});
