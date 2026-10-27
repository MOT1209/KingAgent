import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { en } from '../src/renderer/i18n-en.mjs';
import { ar } from '../src/renderer/i18n-ar.mjs';
import { t, setLanguage, getLanguage, normalizeLanguage } from '../src/renderer/i18n.mjs';

test('every key exists in both dictionaries', () => {
  const missingInAr = Object.keys(en).filter((k) => !(k in ar));
  const missingInEn = Object.keys(ar).filter((k) => !(k in en));
  assert.deepEqual(missingInAr, [], `keys missing from the Arabic dictionary: ${missingInAr.join(', ')}`);
  assert.deepEqual(missingInEn, [], `keys missing from the English dictionary: ${missingInEn.join(', ')}`);
});

test('no translation is empty, and placeholders match between languages', () => {
  const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of Object.keys(en)) {
    assert.ok(en[k].trim(), `en ${k} is empty`);
    assert.ok(ar[k].trim(), `ar ${k} is empty`);
    assert.equal(holes(ar[k]), holes(en[k]), `placeholders differ for ${k}`);
  }
});

test('every t("key") used in the renderer exists in the dictionaries', () => {
  const dir = new URL('../src/renderer/', import.meta.url);
  const used = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs') || n === 'app.js')) {
    const text = readFileSync(new URL(f, dir), 'utf8');
    for (const m of text.matchAll(/\bt\('([\w.]+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/data-i18n(?:-title|-aria)?="([\w.]+)"/g)) used.add(m[1]);
  }
  const unknown = [...used].filter((k) => !(k in en));
  assert.deepEqual(unknown, [], `keys used but not defined: ${unknown.join(', ')}`);
});

test('English is the default; a missing key falls back to English, then to the key', () => {
  setLanguage('en');
  assert.equal(getLanguage(), 'en');
  assert.equal(t('settings.title'), 'Settings');
  setLanguage('ar');
  assert.equal(t('settings.title'), 'الإعدادات');
  assert.equal(t('__probe'), '__probe');
  setLanguage('en');
});

test('placeholders are filled, unknown ones left visible', () => {
  setLanguage('en');
  assert.equal(t('confirm.discard.message', { name: 'a.js' }), 'a.js has changes that are not saved.');
  assert.equal(t('confirm.discard.message', {}), '{name} has changes that are not saved.');
});

test('an unknown language normalizes to English', () => {
  assert.equal(normalizeLanguage('fr'), 'en');
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(setLanguage('zz'), 'en');
});

test('the main-process language list agrees with the renderer\'s', async () => {
  const { createRequire } = await import('node:module');
  const { LANGUAGES: mainList, normalizeLanguage: mainNormalize } = createRequire(import.meta.url)('../src/main/settings.js');
  const { LANGUAGES } = await import('../src/renderer/i18n.mjs');
  assert.deepEqual(LANGUAGES.map((l) => l.id), mainList);
  assert.equal(mainNormalize('ar'), 'ar');
  assert.equal(mainNormalize('klingon'), 'en');
});
