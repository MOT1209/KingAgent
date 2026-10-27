// A confirmation that is part of the app, not the operating system.
//
// window.confirm() is synchronous: while it is up the renderer neither paints
// nor runs a frame, so every live terminal tile freezes mid-output, and the
// panel it draws is the system's, ignoring all six themes. This is the same
// question as a themed sheet that returns a promise.
//
// It lives on its own layer rather than in S.overlay: the question is often
// asked FROM an overlay (closing a peek with unsaved edits), and S.overlay holds
// one sheet. Escape and the backdrop answer "no"; focus starts on the safe
// answer so a stray Enter cannot discard anything.

import { makeDialog } from './dialog.mjs';

export function askConfirm({ title = 'Are you sure?', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false, safe = 'cancel' } = {}) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'overlay overlay--confirm';
    const modal = document.createElement('div');
    modal.className = 'modal modal--confirm';
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    modal.innerHTML = `<div class="modal-head"><span class="title">${esc(title)}</span></div>
      <div class="modal-body"><p class="confirm-msg">${esc(message).replace(/\n/g, '<br>')}</p></div>
      <div class="modal-foot"><button class="btn" data-a="no">${esc(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--go'}" data-a="yes">${esc(confirmLabel)}</button></div>`;
    wrap.appendChild(modal);
    makeDialog(modal);
    let done = false;
    const finish = (answer) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      if (previous && previous.focus && document.contains(previous)) { try { previous.focus({ preventScroll: true }); } catch (_) {} }
      resolve(answer);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) finish(false); });
    modal.querySelector('[data-a="no"]').onclick = () => finish(false);
    modal.querySelector('[data-a="yes"]').onclick = () => finish(true);
    document.body.appendChild(wrap);
    modal.querySelector(safe === 'confirm' ? '[data-a="yes"]' : '[data-a="no"]').focus({ preventScroll: true });
  });
}
