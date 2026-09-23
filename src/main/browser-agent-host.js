// The adapter that lets an agent drive a KingAgent browser tab.
//
// `core/browser/` owns *whether* an agent may do something (named actions, risk
// levels, the take-control refusal). This file owns *how* — it is the
// `io.browser.host` the core tools call, and it is deliberately the only place
// in the browser subsystem that touches Electron.
//
// Two rules it inherits from the app around it rather than inventing:
//
//   * **Navigation is validated by the same function the address bar uses.**
//     `browserUrl()` refuses anything that is not http/https and strips embedded
//     credentials, so an agent cannot talk the tab into `file:`, `javascript:`
//     or a local document the workspace guard exists to protect.
//   * **Page content is untrusted data.** `read` and `click` return what the
//     page said, and the page gets to say anything. Nothing here evaluates
//     page-provided code or interpolates page text into a script.
//
// Two actions are refused on purpose, and the refusal is the feature:
//
//   * `authenticate` — signing in is a person's act. Credentials live in the
//     profile store and are only ever filled by an explicit trusted action
//     (`browser:profiles` `autofill`). An agent that could authenticate would
//     have a credential-exfiltration primitive with extra steps.
//   * `upload` — sending local files to a remote site needs CDP's
//     `DOM.setFileInputFiles`, which this transport does not carry. Reported as
//     unavailable rather than faked.
//
// Everything takes the `views` map as a dependency, so this module runs and is
// tested in plain node with a fake webContents.

const { browserUrl, clean } = require('./browser-policy');

// Page text is bounded everywhere it is produced. A page can be arbitrarily
// large and a tool result lands in the agent's context.
const MAX_TEXT = 16000;
// A screenshot is inlined only when it fits. Past this it is described, not
// shipped: a retina page capture is megabytes and would be a context bomb.
const MAX_INLINE_IMAGE = 1_500_000;

function browserError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Bounds and normalizes a CSS selector before it reaches the page.
function selectorOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (text.length > 500) throw browserError('BROWSER_INVALID_INPUT', 'That selector is too long.');
  return text;
}

// Resolves a session id to the live tab. Every method starts here, so a stale
// id is a named error rather than a crash inside Electron.
function createBrowserAgentHost({ views, logger = null, now = Date.now } = {}) {
  if (!views || typeof views.get !== 'function') throw new Error('createBrowserAgentHost requires the views map');

  function entryOf(sessionId) {
    const entry = views.get(sessionId);
    if (!entry) throw browserError('BROWSER_NO_SESSION', `That browser tab is no longer open (${sessionId}).`);
    const wc = entry.view && entry.view.webContents;
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      throw browserError('BROWSER_NO_SESSION', `That browser tab has been closed (${sessionId}).`);
    }
    return { entry, wc };
  }

  function describe(entry, wc) {
    let title = '';
    try { title = String(wc.getTitle() || '').slice(0, 200); } catch { /* a destroyed tab has no title */ }
    return { url: entry.filePath || String(wc.getURL() || ''), title };
  }

  // Runs a page script and returns its JSON value. The script is always one of
  // the literals below — never built from page or agent text — so no agent input
  // is ever evaluated as code.
  async function evaluate(wc, script) {
    return wc.executeJavaScript(script, true);
  }

  const handlers = {
    async navigate({ sessionId, url }) {
      const { entry, wc } = entryOf(sessionId);
      let href;
      try { href = browserUrl(url); } catch (err) {
        throw browserError('BROWSER_INVALID_INPUT', err.message);
      }
      await wc.loadURL(href);
      return describe(entry, wc);
    },

    async read({ sessionId, selector, url }) {
      const { entry, wc } = entryOf(sessionId);
      // `url` is accepted by the tool schema for symmetry; navigation is
      // navigate's job, and silently navigating here would make "read" a write.
      if (url) throw browserError('BROWSER_INVALID_INPUT', 'Use browser:navigate to move the tab, then read it.');
      const sel = selectorOf(selector);
      const script = sel
        ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? String(el.innerText || el.textContent || '').slice(0, ${MAX_TEXT}) : null; })()`
        : `String((document.body && document.body.innerText) || '').slice(0, ${MAX_TEXT})`;
      const text = await evaluate(wc, script).catch((err) => {
        throw browserError('BROWSER_PAGE_ERROR', `The page could not be read: ${err.message}`);
      });
      if (sel && text === null) throw browserError('BROWSER_NOT_FOUND', `No element matched ${sel} on this page.`);
      // The page is asked to bound its own text, and the result is bounded again
      // here: the page gets to return whatever it likes, and a tool result lands
      // in an agent's context.
      return { ...describe(entry, wc), text: String(text || '').slice(0, MAX_TEXT) };
    },

    async screenshot({ sessionId, fullPage }) {
      const { entry, wc } = entryOf(sessionId);
      const image = await wc.capturePage().catch((err) => {
        throw browserError('BROWSER_PAGE_ERROR', `The page could not be captured: ${err.message}`);
      });
      if (image.isEmpty()) throw browserError('BROWSER_PAGE_ERROR', 'The tab has no visible content to capture.');
      const size = image.getSize();
      const png = image.toPNG();
      const base = { ...describe(entry, wc), format: 'png', width: size.width, height: size.height, bytes: png.length, fullPage: Boolean(fullPage), capturedAt: now() };
      if (png.length > MAX_INLINE_IMAGE) return { ...base, inlined: false };
      return { ...base, inlined: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    },

    async click({ sessionId, selector, text }) {
      const { entry, wc } = entryOf(sessionId);
      const sel = selectorOf(selector);
      const label = typeof text === 'string' && text.trim() ? clean(text, 200) : null;
      if (!sel && !label) throw browserError('BROWSER_INVALID_INPUT', 'Give a selector or the visible text of the element to click.');
      const script = sel
        ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false }; el.click(); return { ok: true }; })()`
        : `(() => {
            const wanted = ${JSON.stringify(label)};
            const all = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,label')];
            const el = all.find(n => (n.innerText || n.value || n.getAttribute('aria-label') || '').trim() === wanted)
              || all.find(n => (n.innerText || n.value || n.getAttribute('aria-label') || '').includes(wanted));
            if (!el) return { ok: false };
            el.click(); return { ok: true };
          })()`;
      const result = await evaluate(wc, script).catch((err) => {
        throw browserError('BROWSER_PAGE_ERROR', `The page could not be clicked: ${err.message}`);
      });
      if (!result || result.ok !== true) {
        throw browserError('BROWSER_NOT_FOUND', sel ? `No element matched ${sel} on this page.` : `No clickable element reads "${label}" on this page.`);
      }
      return { ...describe(entry, wc), clicked: true };
    },

    async type({ sessionId, selector, text, submit }) {
      const { entry, wc } = entryOf(sessionId);
      const sel = selectorOf(selector);
      if (!sel) throw browserError('BROWSER_INVALID_INPUT', 'browser:type needs a selector.');
      const value = typeof text === 'string' ? text.slice(0, 4000) : '';
      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return { ok: false, why: 'missing' };
        if (el.disabled || el.readOnly) return { ok: false, why: 'readonly' };
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        // The native setter, so frameworks that track the value see the change —
        // assigning to .value directly leaves React's state stale and the field
        // reads as empty when the form is submitted.
        if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      })()`;
      const result = await evaluate(wc, script).catch((err) => {
        throw browserError('BROWSER_PAGE_ERROR', `The field could not be filled: ${err.message}`);
      });
      if (!result || result.ok !== true) {
        if (result && result.why === 'readonly') throw browserError('BROWSER_FIELD_READONLY', `The field ${sel} is not editable.`);
        throw browserError('BROWSER_NOT_FOUND', `No field matched ${sel} on this page.`);
      }
      if (submit) await handlers.submit({ sessionId, selector: sel, external: true });
      return { ...describe(entry, wc), typed: true };
    },

    async submit({ sessionId, selector }) {
      const { entry, wc } = entryOf(sessionId);
      const sel = selectorOf(selector);
      const script = sel
        ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false }; const form = el.form || el.closest('form'); if (!form) return { ok: false, why: 'noform' }; if (form.requestSubmit) form.requestSubmit(); else form.submit(); return { ok: true }; })()`
        : `(() => { const form = document.querySelector('form'); if (!form) return { ok: false, why: 'noform' }; if (form.requestSubmit) form.requestSubmit(); else form.submit(); return { ok: true }; })()`;
      const result = await evaluate(wc, script).catch((err) => {
        throw browserError('BROWSER_PAGE_ERROR', `The form could not be submitted: ${err.message}`);
      });
      if (!result || result.ok !== true) throw browserError('BROWSER_NOT_FOUND', 'No form was found to submit on this page.');
      return { ...describe(entry, wc), submitted: true };
    },

    async download({ sessionId, url }) {
      const { entry, wc } = entryOf(sessionId);
      let href;
      try { href = browserUrl(url); } catch (err) {
        throw browserError('BROWSER_INVALID_INPUT', err.message);
      }
      if (typeof wc.downloadURL !== 'function') throw browserError('BROWSER_UNAVAILABLE', 'This build cannot download from an agent-driven tab.');
      wc.downloadURL(href);
      return { url: href, title: entry.filePath ? null : String(wc.getTitle() || ''), started: true };
    },

    async clipboard({ sessionId, action, text }) {
      const { wc } = entryOf(sessionId);
      if (action === 'write') {
        const value = typeof text === 'string' ? text.slice(0, 4000) : '';
        const ok = await evaluate(wc, `navigator.clipboard.writeText(${JSON.stringify(value)}).then(() => true).catch(() => false)`);
        if (ok !== true) throw browserError('BROWSER_PAGE_ERROR', 'The page refused clipboard access.');
        return { action: 'write', written: true };
      }
      if (action === 'read') {
        const value = await evaluate(wc, 'navigator.clipboard.readText().then(t => String(t || "").slice(0, 4000)).catch(() => null)');
        if (value === null) throw browserError('BROWSER_PAGE_ERROR', 'The page refused clipboard access.');
        return { action: 'read', text: value };
      }
      throw browserError('BROWSER_INVALID_INPUT', 'browser:clipboard needs action "read" or "write".');
    },

    // Refused by design, not by omission. See the header.
    async authenticate({ sessionId }) {
      entryOf(sessionId);
      throw browserError(
        'BROWSER_HUMAN_ACTION_REQUIRED',
        'Signing in is a person’s act. Use the tab’s own sign-in and credential autofill; an agent is never given the credential.',
      );
    },

    async upload({ sessionId }) {
      entryOf(sessionId);
      throw browserError(
        'BROWSER_UNAVAILABLE',
        'Attaching local files to a page needs CDP file-input support, which this transport does not carry.',
      );
    },
  };

  // The core tools call `host[key]` and expect it to exist or be absent; a
  // missing key is what produces BROWSER_UNAVAILABLE, so nothing here is
  // optional. Wrapped so an unexpected throw is classified rather than crashing
  // the tool with a bare Electron error.
  const host = {};
  for (const [key, fn] of Object.entries(handlers)) {
    host[key] = async (args) => {
      try {
        return await fn(args);
      } catch (err) {
        if (err && typeof err.code === 'string' && err.code.startsWith('BROWSER_')) throw err;
        if (logger) logger.warn(`browser ${key} failed`, { error: err && err.message });
        throw browserError('BROWSER_PAGE_ERROR', `The browser could not complete ${key}: ${(err && err.message) || 'unknown error'}`);
      }
    };
  }

  return host;
}

module.exports = { createBrowserAgentHost, MAX_TEXT, MAX_INLINE_IMAGE };
