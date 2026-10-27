// Make a non-button element behave like one for the keyboard.
//
// A row with an onclick and nothing else is invisible to Tab, and one that
// has role="button" tabindex="0" but no key handler is worse: a screen reader
// announces a button, Enter does nothing (WCAG 2.1.1). This is the one place
// that pair is written, extracted from what the file rows already did.
//
// Enter and Space activate, but only when the key was pressed on the element
// itself: a button or link inside the row keeps its own Enter.
export function activateOnKey(el, run) {
  if (!el) return el;
  if (el.tabIndex < 0 || !el.hasAttribute('tabindex')) el.tabIndex = 0;
  if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    run(e);
  });
  return el;
}
