// Frame one wears the saved theme. app.js is a deferred module, so its
// applyThemeAttrs() lands well after first paint — without this, every launch
// on a non-paper theme flashes the cream base stylesheet first. Mirrors
// applyThemeAttrs() in app.js; the theme list and the 'glass' default must stay
// in step with it and with src/main/settings.js.
//
// Loaded as a head script WITH defer from index.html so it runs after the body
// exists (the pre-defer inline version ran before <body> was created and its
// try/catch silently swallowed the null-body errors — the flash prevention it
// existed to provide never fired).
(function () {
  try {
    var t = localStorage.getItem('kingagent-theme') || 'glass';
    if (t !== 'paper' && ['operator', 'glass', 'graphite', 'soft', 'dusk'].indexOf(t) >= 0) document.body.dataset.theme = t;
    if (t === 'glass' || t === 'graphite') document.body.setAttribute('data-glass', '');
    if (t === 'soft' || t === 'dusk') document.body.setAttribute('data-soft', '');
  } catch (_) {
    // localStorage may be unavailable (file:// privacy modes): fall back to the
    // default theme rather than failing the window.
  }
})();