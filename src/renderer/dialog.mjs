// What makes a sheet a dialog, for every sheet.
//
// overlay() builds the one sheet nearly everything in the app uses — the
// launcher, agent setup, connect, create, peek — and it used to set no role at
// all, so only the two sheets that remembered to call wireHelpDialog were
// announced as dialogs or kept Tab inside. Doing it where the sheet is made
// means a sheet written next year is accessible without anyone remembering.
//
// Idempotent, and tolerant of a sheet with no .title (the old code assigned to
// the result of a query that could be null and threw inside renderOverlay, so
// the sheet never mounted).

import { t } from './i18n.mjs';

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]';
let seq = 0;

export function makeDialog(modal) {
  if (!modal || modal.getAttribute('role') === 'dialog') return modal;
  const title = modal.querySelector('.title');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  if (title) {
    if (!title.id) title.id = 'dlg-title-' + (++seq);
    modal.setAttribute('aria-labelledby', title.id);
  } else {
    // No visible heading: name it from its first line of text, never leave a dialog unnamed.
    modal.setAttribute('aria-label', (modal.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) || t('dialog.fallbackName'));
  }
  if (modal.tabIndex < 0 || !modal.hasAttribute('tabindex')) modal.tabIndex = -1;
  const close = modal.querySelector('.ov-x');
  if (close) close.setAttribute('aria-label', t('dialog.close'));
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    // One pass over what is visible, read lazily: a visibility check per
    // control on every Tab would be a layout per control per keypress.
    const controls = Array.from(modal.querySelectorAll(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const first = controls[0], last = controls[controls.length - 1];
    if (!first) { e.preventDefault(); modal.focus(); return; }
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === modal)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === last || at === modal)) { e.preventDefault(); first.focus(); }
  });
  return modal;
}
