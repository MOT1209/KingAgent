// Interface translation: a key lookup, nothing more.
//
//   t('settings.title')                         -> 'Settings' | 'الإعدادات'
//   t('confirm.discard.message', { name })      -> '{name}' filled in
//
// English is the default and the fallback: a key missing from the active
// dictionary shows its English text, and a key missing from both shows the key
// itself, so a gap is visible rather than blank. Only the chrome is translated;
// commands, file names and agent output never pass through here.
//
// Language is independent of layout direction (Settings → Look has both): a
// person can read Arabic in a left-to-right layout and the reverse.

import { en } from './i18n-en.mjs';
import { ar } from './i18n-ar.mjs';

export const DICTIONARIES = Object.freeze({ en, ar });
// Names are shown in their own language so a person who cannot read the current
// one can still find theirs.
export const LANGUAGES = Object.freeze([
  { id: 'en', name: 'English' },
  { id: 'ar', name: 'العربية' },
]);
export const DEFAULT_LANGUAGE = 'en';

let current = DEFAULT_LANGUAGE;

export function normalizeLanguage(l) {
  return Object.prototype.hasOwnProperty.call(DICTIONARIES, l) ? l : DEFAULT_LANGUAGE;
}
export function getLanguage() { return current; }
export function setLanguage(l) { current = normalizeLanguage(l); return current; }

export function t(key, params) {
  const raw = DICTIONARIES[current][key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

// Re-translates markup that was built once (the window shell) and so cannot be
// re-rendered by calling t() again. Elements opt in with data-i18n (text),
// data-i18n-title and data-i18n-aria.
export function applyTranslations(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}
