import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { en } from '../src/renderer/locales/en.mjs';
import { ar } from '../src/renderer/locales/ar.mjs';
import { t, setLanguage, getLanguage, normalizeLanguage, LANGUAGES } from '../src/renderer/i18n.mjs';
const require = createRequire(import.meta.url);
const { normalizeLanguage: mainNormalize } = require('../src/main/settings.js');
const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer');

test('Arabic has every key English has, and nothing English lacks', () => {
  const missing = Object.keys(en).filter((k) => !(k in ar));
  const extra = Object.keys(ar).filter((k) => !(k in en));
  assert.deepEqual(missing, [], 'untranslated: ' + missing.join(', '));
  assert.deepEqual(extra, [], 'no English source for: ' + extra.join(', '));
});

test('a leading space survives in Arabic where it is part of a phrase', () => {
  assert.equal(ar['topbar.newSession'][0], '\u00A0');
});

test('placeholders match between the two languages', () => {
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const k of Object.keys(en)) assert.equal(vars(ar[k]), vars(en[k]), k);
});

test('t() looks up, interpolates, falls back to English, and shows an unknown key', () => {
  setLanguage('en');
  assert.equal(t('settings.done'), 'Done');
  assert.equal(t('live.count', { n: 3 }), '3 live');
  setLanguage('ar');
  assert.equal(t('settings.done'), 'تم');
  assert.equal(t('live.count', { n: 3 }), '3 نشطة');
  assert.equal(t('no.such.key'), 'no.such.key');
  setLanguage('en');
});

test('an unsupported language is English, in the renderer and in main', () => {
  for (const v of ['fr', undefined, null, '', 'AR']) { assert.equal(normalizeLanguage(v), 'en'); assert.equal(mainNormalize(v), 'en'); }
  assert.equal(setLanguage('zz'), 'en');
  assert.equal(getLanguage(), 'en');
  assert.deepEqual([...LANGUAGES], ['en', 'ar']);
});

test('every key the app draws exists in English', () => {
  const used = new Set();
  for (const f of fs.readdirSync(R).filter((x) => /\.(mjs|js)$/.test(x) && x !== 'i18n.mjs')) {
    const s = fs.readFileSync(path.join(R, f), 'utf8');
    for (const m of s.matchAll(/\bt\('([a-z][\w.]*)'/g)) used.add(m[1]);
    for (const m of s.matchAll(/data-i18n(?:-title|-aria)?="([\w.]+)"/g)) used.add(m[1]);
  }
  const dynamic = (k) => /^(settings|look\.lang)\./.test(k);
  const unknown = [...used].filter((k) => !(k in en) && !dynamic(k));
  assert.deepEqual(unknown, []);
});
