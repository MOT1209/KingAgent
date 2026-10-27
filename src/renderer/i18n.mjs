// Interface language.
//
// Strings are looked up by key at the moment they are drawn, so a screen
// rendered after a language change is simply in the new language. The static
// shell (built once) carries data-i18n attributes and is repainted by
// applyI18n(). English is the source of truth and the fallback: a key missing
// from Arabic shows the English text rather than a key, and
// tests/i18n.test.mjs fails if Arabic lacks a key that English has, so that
// fallback is a safety net rather than a way to ship half a translation.
//
// Scope, deliberately: the interface chrome and the main flows (shell, Settings,
// confirmations). Commands, file names, agent output and the terminal are never
// translated, and strings in the rest of the app remain English until moved here.

import { en } from './locales/en.mjs';
import { ar } from './locales/ar.mjs';

const DICTS = { en, ar };
export const LANGUAGES = Object.freeze(['en', 'ar']);
let current = 'en';

export function normalizeLanguage(l) { return LANGUAGES.includes(l) ? l : 'en'; }
export function getLanguage() { return current; }
export function setLanguage(l) { current = normalizeLanguage(l); return current; }

// t('key') or t('key', { n: 3 }) for "{n} live". Unknown keys return the key,
// which makes a typo visible instead of blank.
export function t(key, vars) {
  const raw = (DICTS[current] && DICTS[current][key]) ?? en[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : raw;
}

// Repaint every [data-i18n] (text), [data-i18n-title] and [data-i18n-aria] in a
// subtree. The attribute value is the key.
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
}
