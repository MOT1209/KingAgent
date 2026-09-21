import { usagePaneHtml, wireUsagePane as wireUsageContent } from './usage-pane.mjs';
import { OPEN_OUTPUT_COPY, SHORTCUT_GROUPS } from './shortcuts.mjs';
import { GROK_API_KEY } from './grok-auth.mjs';

// Extracted from app.js verbatim, as part of splitting that file into
// smaller feature modules.
//
// The Settings sheet: Voice, Look, Keys, Shortcuts, Browser (delegates to
// browser-pane.mjs), Usage (delegates to usage-pane.mjs), Updates, About.
export function createSettingsPanes({ api, state, toast, esc, helpIcon, q, overlay, closeOverlay, renderOverlay,
  rememberHelpFocus, getHelpFocusKey, refreshSttInfo, setSttInfo, transcribeBlob, setTheme, currentTheme, getThemeOptions,
  browsers, updateBar, REPO_URL, DOCS, makerUrl, teamsUrl }) {
  const S = state;

  const SET_SECTIONS = [
    { id: 'voice', name: 'Voice', lead: 'how KingAgent hears you' },
    { id: 'look', name: 'Look', lead: 'how KingAgent looks on this desk' },
    { id: 'keys', name: 'Keys', lead: 'keys every session can use' },
    { id: 'shortcuts', name: 'Shortcuts', lead: 'small moves that make your desk easier to use' },
    { id: 'browser', name: 'Browser', lead: 'browser views your sessions can use' },
    { id: 'usage', name: 'Usage', lead: 'remaining allowance by connected account' },
    { id: 'updates', name: 'Updates', lead: 'how KingAgent checks for and installs new versions' },
    { id: 'about', name: 'About', lead: 'about this copy of KingAgent' },
  ];
  function openSettings(section) {
    rememberHelpFocus();
    S.overlay = { type: 'settings', section: section || 'voice', draft: {}, test: null };
    renderOverlay();
    // both are cheap and let the sheet paint immediately with what we already know
    refreshSttInfo().then(() => { if (isSettingsOpen()) renderOverlay(); });
    api.settingsGet().then((s) => { if (isSettingsOpen()) { S.overlay.saved = s; renderOverlay(); } });
  }
  function isSettingsOpen() { return !!S.overlay && S.overlay.type === 'settings'; }

  function renderSettings() {
    const o = S.overlay;
    const sec = SET_SECTIONS.find((s) => s.id === o.section) || SET_SECTIONS[0];
    const modal = overlay('modal modal--settings' + (sec.id === 'shortcuts' ? ' modal--shortcuts' : ''), `
      <div class="modal-head"><span class="col">
        <span class="title">Settings</span>
        <span class="sub">${esc(sec.lead)}</span></span></div>
      <div class="modal-body"><div class="set-wrap">
        <div class="set-nav">${SET_SECTIONS.map((s) =>
          `<button class="rail-tab${s.id === sec.id ? ' active' : ''}" data-sec="${s.id}"${s.id === sec.id ? ' aria-current="page"' : ''}>${helpIcon(s.id)}<span>${esc(s.name)}</span></button>`).join('')}</div>
        <div class="set-pane" id="set-pane">${
          sec.id === 'voice' ? voicePaneHtml()
            : sec.id === 'look' ? lookPaneHtml()
              : sec.id === 'browser' ? browsers.settingsHtml() : sec.id === 'usage' ? usagePaneHtml()
                : sec.id === 'updates' ? updatesPaneHtml() : sec.id === 'about' ? aboutPaneHtml() : sec.id === 'shortcuts' ? shortcutsPaneHtml() : keysPaneHtml()}</div>
      </div></div>
      <div class="modal-foot">${sec.id === 'voice' ? voiceFootHtml() : sec.id === 'shortcuts' ? '<span class="note">⌘ Command · ⌥ Option · ⇧ Shift</span><button class="shortcuts-link" id="shortcuts-guide">Full guide ↗</button>' : '<span class="note">Saved on this Mac only, nothing syncs.</span>'}
        <button class="btn btn--go" id="set-done">Done</button></div>`);

    modal.querySelectorAll('.set-nav .rail-tab').forEach((b) => {
      b.onclick = () => { keepDraft(modal); o.section = b.dataset.sec; renderOverlay(); };
    });
    q('#set-done', modal).onclick = async () => { await saveVoiceDraft(modal); closeOverlay(); };
    if (sec.id === 'voice') wireVoicePane(modal);
    if (sec.id === 'look') wireLookPane(modal);
    if (sec.id === 'keys') wireKeysPane(modal);
    if (sec.id === 'about') wireAboutPane(modal);
    if (sec.id === 'browser') browsers.wireSettings(modal);
    if (sec.id === 'usage') wireUsageContent(modal, { api, toast });
    if (sec.id === 'updates') wireUpdatesPane(modal);
    if (sec.id === 'shortcuts') {
      q('#shortcuts-back', modal).onclick = closeOverlay;
      q('#shortcuts-guide', modal).onclick = () => api.openUrl(DOCS.home);
    }
    wireHelpDialog(modal);
  }

  // Settings and Quick Start are keyboard-accessible help surfaces. Preserve the
  // focused control across async Settings refreshes and return to the invoker.
  function wireHelpDialog(modal) {
    const title = q('.title', modal);
    title.id = 'help-dialog-title';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', title.id);
    modal.tabIndex = -1;
    q('.ov-x', modal).setAttribute('aria-label', 'Close dialog');
    modal.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const controls = Array.from(modal.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'))
        .filter((el) => el.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === modal)) { e.preventDefault(); first.focus(); }
    });
    const helpFocusKey = getHelpFocusKey();
    let target = helpFocusKey && helpFocusKey.id ? document.getElementById(helpFocusKey.id) : null;
    if ((!target || !modal.contains(target)) && helpFocusKey && helpFocusKey.section) {
      target = Array.from(modal.querySelectorAll('[data-sec]')).find((b) => b.dataset.sec === helpFocusKey.section);
    }
    (target && modal.contains(target) ? target : modal).focus({ preventScroll: true });
  }

  function shortcutsPaneHtml() {
    const row = ([label, keys, sub]) => `<div class="shortcut-row"><span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
      <span class="shortcut-keys">${keys.map((key) => key === 'click' ? '<span>+ click</span>' : `<kbd>${esc(key)}</kbd>`).join('')}</span></div>`;
    return `<h1 class="shortcuts-title">Shortcuts &amp; gestures</h1>
      <p class="shortcuts-intro">Small moves that make your desk easier to use.</p>
      <div class="shortcuts-hero">${helpIcon('link')}<div><h2>Open what your agent makes.</h2>
        <p>${esc(OPEN_OUTPUT_COPY)}</p><button class="shortcuts-link" id="shortcuts-back">Back to my desk →</button></div></div>
      ${SHORTCUT_GROUPS.map((group) => `<section class="shortcut-group"><h2>${helpIcon(group.icon)}${esc(group.title)}</h2>
        ${group.rows.map(row).join('')}${group.note ? `<p class="shortcuts-note">${esc(group.note)}</p>` : ''}</section>`).join('')}
      <p class="shortcuts-note">Shortcuts inside an agent’s terminal can vary by agent. This reference covers KingAgent’s controls.</p>`;
  }

  // ---- Voice -----------------------------------------------------------------
  function voiceRows() {
    return ((S.sttInfo && S.sttInfo.providers) || []).slice();
  }
  // No explicit choice yet means the app is running on whatever resolved first;
  // show that as picked so the sheet never looks like nothing is selected.
  function pickedVoiceId() {
    const o = S.overlay, info = S.sttInfo || {};
    const want = (o && o.pick) || info.chosen || info.active || 'local';
    // a retired choice (old 'custom' / 'clipboard' settings) falls back gracefully
    return voiceRows().some((p) => p.id === want) ? want : (info.active || 'local');
  }

  function voicePaneHtml() {
    const picked = pickedVoiceId();
    const rows = voiceRows().map((p) => {
      const on = p.id === picked;
      return `<div class="set-opt-wrap">
        <button class="theme-opt set-opt${on ? ' picked' : ''}" data-p="${esc(p.id)}">
          <span class="theme-dot"></span>
          <span class="set-opt-col"><span class="theme-name">${esc(p.label)}</span>
            <span class="set-opt-desc">${esc(p.blurb || '')}</span></span>
          <span class="set-flag ${p.ready ? 'ok' : 'wait'}">${esc(voiceFlag(p))}</span>
        </button>
        ${on ? voiceRowBodyHtml(p) : ''}</div>`;
    }).join('');
    // no heading here — the sheet's subtitle already says what this pane is
    return rows;
  }
  // The proof lives in the footer so it is on screen whatever the list is doing.
  function voiceFootHtml() {
    const o = S.overlay, active = voiceRows().find((p) => p.id === pickedVoiceId());
    return `<button class="btn" id="set-mic" ${active && active.ready ? '' : 'disabled'}>◉ Test the mic</button>
      <span class="set-result" id="set-result">${esc(o.test || 'say something and KingAgent will type it back')}</span>`;
  }
  function voiceFlag(p) {
    // Ready on a key KingAgent never saved means the key arrived on the environment
    // this run was launched with. That is true right now and worth saying, but it
    // is not durable: user-path.js merges the login shell's PATH into a Dock
    // launch and nothing else, so from the Dock the variable is absent and this
    // same provider reports "no API key". Saying only "ready" is what made Voice
    // and Keys look like they disagreed about the same key.
    if (p.ready && p.needsKey && !p.keySaved) return 'ready · from your shell';
    if (p.ready) return 'ready';
    if (p.downloadBytes) return mb(p.downloadBytes) + ' to download';
    return p.reason || 'not set up';
  }
  function mb(bytes) { return Math.round(bytes / 1e6) + ' MB'; }

  // What a download is doing, said in the units the event actually carries.
  // stt-model counts FILES: { phase: 'download', done: 3, total: 7 }. This used
  // to read that 7 as a byte total and print `mb(0) of mb(7)` — "0 MB of 0 MB",
  // for the entire download, alongside a `loaded` field that has never existed.
  // Real byte progress would mean streaming each file against its content-length;
  // it is not worth it here, because two of the seven files are ~95% of the bytes,
  // so a byte counter would stall twice for a long time and say less than this.
  // Returns null when there is nothing to say, so the caller leaves the note as is.
  function dlProgressText(ev) {
    if (!ev) return null;
    if (ev.phase === 'load') return 'Getting the model ready…';
    if (!ev.total) return null;
    return `${ev.done || 0} of ${ev.total} files…`;
  }

  // The picked row is the only one that opens: a pointer to the Keys tab when the
  // key is missing, or a download button. Keys are typed in exactly one place —
  // the Keys tab — so a ready provider shows nothing extra at all.
  function voiceRowBodyHtml(p) {
    if (p.needsKey && !p.ready) {
      return `<div class="set-opt-body"><div class="setup-note">needs your ${esc(p.keyEnv)} —
          <span class="sv-help go-keys" data-keyenv="${esc(p.keyEnv)}">add it in Keys</span></div>
        ${p.keyHelpUrl ? `<div class="sv-help" data-url="${esc(p.keyHelpUrl)}">where do I find my key?</div>` : ''}</div>`;
    }
    // Usable, but on a key KingAgent is not holding. The row says where it came from
    // and what would make it survive the next launch.
    if (p.needsKey && p.ready && !p.keySaved) {
      return `<div class="set-opt-body"><div class="setup-note">Working from ${esc(p.keyEnv)} in the environment KingAgent was started in.
          Open KingAgent from the Dock and it will not be there.
          <span class="sv-help go-keys" data-keyenv="${esc(p.keyEnv)}">Save it in Keys</span> to make it stick.</div></div>`;
    }
    if (p.id === 'local' && !p.ready && p.downloadBytes) {
      return `<div class="set-opt-body">
        <button class="btn" id="set-dl">Download the model (${esc(mb(p.downloadBytes))})</button>
        <div class="setup-note" id="set-dl-note">One time. After this, dictation works with no network and no account.</div></div>`;
    }
    return '';
  }

  // Inputs are read back before any re-render, because the sheet is rebuilt whole.
  function keepDraft(modal) {
    const o = S.overlay; if (!o || o.type !== 'settings') return;
    modal.querySelectorAll('.set-key').forEach((inp) => { o.draft[inp.dataset.k] = inp.value.trim(); });
  }
  async function saveVoiceDraft(modal) {
    const o = S.overlay; if (!o) return;
    keepDraft(modal);
    const patch = {};
    for (const [k, v] of Object.entries(o.draft)) patch[k] = v === '' ? null : v;
    if (o.pick) patch.sttProvider = o.pick;
    if (!Object.keys(patch).length) return;
    const res = await api.settingsSet(patch);
    if (res && res.ok) { setSttInfo(res.sttInfo); o.draft = {}; }
    else toast('Could not save: ' + (res && res.error || '?'));
  }

  function wireVoicePane(modal) {
    const o = S.overlay;
    modal.querySelectorAll('.set-opt').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.p === pickedVoiceId()) return;
        keepDraft(modal); o.pick = b.dataset.p; o.test = null;
        await saveVoiceDraft(modal);
        renderOverlay();
      };
    });
    modal.querySelectorAll('.sv-help[data-url]').forEach((el) => { el.onclick = () => api.openUrl(el.dataset.url); });
    // "add it in Keys" jumps to the Keys tab with that key's row already open
    modal.querySelectorAll('.go-keys').forEach((el) => {
      el.onclick = () => {
        o.section = 'keys'; o.editKey = el.dataset.keyenv; renderOverlay();
        const i = q('#key-edit-val'); if (i) i.focus();
      };
    });
    const dl = q('#set-dl', modal);
    if (dl) dl.onclick = async () => {
      dl.disabled = true; dl.textContent = 'Downloading…';
      const off = api.onSttProgress((ev) => {
        const note = q('#set-dl-note', modal);
        const line = dlProgressText(ev);
        if (note && line) note.textContent = line;
      });
      const res = await api.sttPrepare();
      off();
      await refreshSttInfo();
      if (!res || !res.ok) toast('Download failed: ' + (res && res.error || '?'));
      if (isSettingsOpen()) renderOverlay();
    };
    const mic = q('#set-mic', modal);
    if (mic) mic.onclick = () => toggleSettingsMic(modal);
  }

  // Record here in the sheet and show the words. It is the whole proof that voice
  // works, without having to open a session first.
  let settingsRec = null;
  function toggleSettingsMic(modal) {
    const o = S.overlay, btn = q('#set-mic', modal), out = q('#set-result', modal);
    if (settingsRec) { try { settingsRec.stop(); } catch (_) {} return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const rec = new MediaRecorder(stream), chunks = [];
      settingsRec = rec;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        settingsRec = null;
        stream.getTracks().forEach((t) => t.stop());
        if (btn) { btn.textContent = '◉ Test the mic'; btn.classList.remove('rec'); }
        if (out) out.textContent = 'transcribing…';
        const res = await transcribeBlob(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        o.test = res && res.ok ? (res.text || '(silence)') : 'failed — ' + (res && res.error || '?');
        if (isSettingsOpen()) renderOverlay();
      };
      rec.start();
      if (btn) { btn.textContent = '■ Stop'; btn.classList.add('rec'); }
      if (out) out.textContent = 'listening — say something, then stop.';
      // a forgotten recording shouldn't run forever
      setTimeout(() => { if (settingsRec === rec) { try { rec.stop(); } catch (_) {} } }, 15000);
    }).catch((e) => { o.test = 'Mic error: ' + e.message; renderOverlay(); });
  }

  // ---- Look ------------------------------------------------------------------
  function lookPaneHtml() {
    return `<div class="field-label">appearance</div>` + getThemeOptions().map((t) =>
      `<button class="theme-opt set-opt${currentTheme() === t.id ? ' picked' : ''}" data-theme-id="${t.id}" aria-pressed="${currentTheme() === t.id}">
        <span class="theme-dot"></span>
        <span class="set-opt-col"><span class="theme-name">${esc(t.name)}</span>
          <span class="set-opt-desc">${esc(t.desc)}</span></span></button>`).join('');
  }
  function wireLookPane(modal) {
    modal.querySelectorAll('[data-theme-id]').forEach((b) => {
      b.onclick = () => {
        const theme = b.dataset.themeId;
        setTheme(theme);
        // setTheme rebuilds Settings; keep keyboard navigation on the new row.
        q(`.set-opt[data-theme-id="${theme}"]`)?.focus({ preventScroll: true });
      };
    });
  }

  // ---- Updates — Settings → Updates, spec section 27 --------------------------
  // Every toggle here reads/writes through the same settings:get / settings:set
  // round trip Voice and Look already use — no new storage, no new IPC surface,
  // just four more keys in WRITABLE_SETTINGS (src/main/main.js). The two rules
  // updater.js was built around stay defaults here too: nothing downloads and
  // nothing installs unasked unless a person turns that on for themselves.
  function updatesPaneHtml() {
    const saved = (S.overlay && S.overlay.saved) || {};
    const autoCheck = saved.updatesAutoCheck !== false;        // default on
    const autoDownload = !!saved.updatesAutoDownload;           // default off
    const installOnLaunch = !!saved.updatesInstallOnLaunch;     // default off
    const rawHours = Number(saved.updatesReminderHours);
    const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : 24;
    return `<div class="field-label">checking</div>
      <label class="browser-check"><input type="checkbox" id="upd-auto-check"${autoCheck ? ' checked' : ''}><span>Automatically check for updates</span></label>
      <label class="browser-check"><input type="checkbox" id="upd-auto-download"${autoDownload ? ' checked' : ''}><span>Automatically download updates<small>Off by default — nothing moves over the network without you asking, until you turn this on.</small></span></label>
      <div class="field-label section-gap">reminder</div>
      <div class="upd-hours-row"><span>Remind me later, after</span>
        <input type="number" min="1" max="168" step="1" id="upd-reminder-hours" class="text-input" value="${hours}" />
        <span>hours</span></div>
      <div class="field-label section-gap">installing</div>
      <label class="browser-check"><input type="checkbox" id="upd-install-launch"${installOnLaunch ? ' checked' : ''}><span>Install updates automatically on next launch<small>Only ever runs before you have any session open, and still refuses if one is already running by then.</small></span></label>
      <p class="setup-note">A critical update is never installed silently — KingAgent still asks every time, and still refuses while work is running, whatever is set above.</p>`;
  }
  function wireUpdatesPane(modal) {
    async function save() {
      const patch = {
        updatesAutoCheck: q('#upd-auto-check', modal).checked,
        updatesAutoDownload: q('#upd-auto-download', modal).checked,
        updatesInstallOnLaunch: q('#upd-install-launch', modal).checked,
        updatesReminderHours: Math.max(1, Math.min(168, Number(q('#upd-reminder-hours', modal).value) || 24)),
      };
      const res = await api.settingsSet(patch);
      if (res && res.ok) { S.overlay.saved = { ...(S.overlay.saved || {}), ...patch }; }
      else toast('Could not save: ' + (res && res.error || '?'));
    }
    modal.querySelectorAll('#upd-auto-check, #upd-auto-download, #upd-install-launch').forEach((el) => { el.onchange = save; });
    const hoursInput = q('#upd-reminder-hours', modal);
    if (hoursInput) hoursInput.onchange = save;
  }

  // ---- About — which copy is this, and is it behind? -------------------------
  // The version was nowhere in the app, which made two builds of the same number
  // indistinguishable from inside it. The date is when this copy landed in
  // Applications, not when it was compiled: the same release installs on two
  // machines weeks apart, and "when did I last update" is the question people
  // actually ask.
  //
  // Checking by hand matters beyond reassurance. Dismissing the update bar writes
  // that version off for good, and until now there was no way back to it.
  // Pressing the button clears the mark.
  function updatedOn(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    // hour12 forced: the machine's locale decides otherwise, and "18:55" next to a
    // handwritten heading reads as a log line rather than a date on a page.
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
      .toLowerCase().replace(/\s+/g, '');
    return `updated ${day} at ${time}`;
  }
  // Four states, and the difference between the last two is the whole point:
  // GitHub said no, versus GitHub never answered.
  function aboutLine(a) {
    if (!a || !a.state) return { dot: 'off', text: 'Not checked yet', act: 'Check now' };
    if (a.state === 'checking') return { dot: 'off', text: 'Checking…', act: 'Check now', busy: true };
    // a.latest is the one on offer; a.version stays the one running
    if (a.state === 'update') return { dot: 'new', text: `KingAgent ${a.latest} is out`, act: 'Download', get: a.url };
    if (a.state === 'offline') return { dot: 'off', text: "Couldn't reach GitHub", act: 'Try again' };
    return { dot: 'ok', text: 'Up to date', act: 'Check now' };
  }
  function aboutPaneHtml() {
    const a = (S.overlay && S.overlay.about) || null;
    const version = (a && a.version) || S.version || '';
    const line = aboutLine(a);
    const notes = version ? `${REPO_URL}/releases/tag/v${encodeURIComponent(version)}` : `${REPO_URL}/releases`;
    return `<div class="ab-name">KingAgent${version ? ' ' + esc(version) : ''}</div>
      <div class="ab-built">${esc(updatedOn((a && a.updatedAt) || S.updatedAt) || 'this copy')}</div>
      <hr class="ab-rule" />
      <div class="ab-state">
        <span class="ab-status"><span class="ab-dot ab-dot--${line.dot}"></span>${esc(line.text)}</span>
        <button class="btn" id="ab-act"${line.busy ? ' disabled' : ''}>${esc(line.act)}</button>
      </div>
      <div class="ab-star">
        <button class="btn btn--go" data-url="${REPO_URL}">★ Star KingAgent on GitHub</button>
      </div>
      <div class="ab-links">
        <a class="ab-link" href="#" data-url="${esc(notes)}">What's new${version ? ' in ' + esc(version) : ''} <span class="arr">↗</span></a>
        <a class="ab-link" href="#" data-url="${REPO_URL}">Source on GitHub <span class="arr">↗</span></a>
        <a class="ab-link" href="#" data-url="${REPO_URL}/blob/master/LICENSE">MIT licence <span class="arr">↗</span></a>
      </div>
      <hr class="ab-rule" />
      <div class="ab-made">Made by <a class="ab-link" href="#" data-url="${makerUrl('about')}">Cal</a>, in KingAgent.</div>
      <div class="ab-copy">© 2026 KingAgent · MIT licensed</div>
      <div class="ab-team">
        <button class="btn btn--quiet" data-url="${teamsUrl('about')}">Want KingAgent for your team? →</button>
      </div>`;
  }
  function wireAboutPane(modal) {
    const o = S.overlay;
    // [data-url] rather than .ab-link[data-url]: the star and team buttons carry
    // the same attribute, and a selector that only matched the text links would
    // have left both of them silently dead.
    modal.querySelectorAll('[data-url]').forEach((el) => {
      el.onclick = (e) => { e.preventDefault(); api.openUrl(el.dataset.url); };
    });
    const act = q('#ab-act', modal);
    if (!act) return;
    act.onclick = async () => {
      const a = o.about;
      // Downloading from here is the same download as the bar's, not a second
      // one: re-arm the bar with what the pane is showing and let the progress
      // land there, so closing Settings does not lose sight of it.
      if (a && a.state === 'update' && a.url) {
        updateBar.setOffered({ version: a.latest, url: a.url });
        updateBar.paintUpdate('downloading', { percent: 0, version: a.latest });
        await api.downloadUpdate();
        return;
      }
      o.about = { ...(a || {}), state: 'checking' };
      renderOverlay();
      const res = await api.updateStatus();
      // Asking by hand un-dismisses: whatever was waved away before is fair game
      // again, or the bar could never come back for that version.
      if (res && res.state === 'update') localStorage.removeItem(updateBar.SKIPPED_UPDATE);
      if (isSettingsOpen()) { S.overlay.about = res || { state: 'offline' }; renderOverlay(); }
    };
  }

  // ---- Keys — named secrets every session inherits ---------------------------
  // One obvious place to paste API keys. Each saved key is exported into the
  // environment of every session KingAgent spawns (shell env still wins), and the
  // Voice providers read the same store — never a second place to paste.
  // Agent CLIs (Claude Code, OpenCode…) carry their own logins — no API key here,
  // except Grok, whose API-key path is the XAI_API_KEY env var.
  const SUGGESTED_KEYS = [
    { name: 'OPENAI_API_KEY', hint: 'backs Voice · OpenAI Whisper' },
    { name: 'ELEVENLABS_API_KEY', hint: 'backs Voice · ElevenLabs Scribe' },
    { name: GROK_API_KEY, hint: 'backs Grok · console.x.ai' },
  ];
  function keyRowHtml({ name, value, sub, actions }) {
    return `<div class="key-row" data-key="${esc(name)}">
      <span class="k-name" title="${esc(name)}">${esc(name)}</span>
      <span class="k-val${sub ? ' k-sub' : ''}">${esc(value)}</span>
      ${actions.map((a) => `<button class="k-act" data-act="${a}">${a}</button>`).join('')}</div>`;
  }
  // Edit mode keeps the row: the current (masked) value stays visible above the
  // input, and cancel / Escape put everything back exactly as it was.
  function keyEditRowHtml(name, current) {
    return `<div class="key-row" data-key="${esc(name)}"><span class="k-name">${esc(name)}</span>
      <span class="k-val${current ? '' : ' k-sub'}">${esc(current || 'not set yet')}</span>
      <input class="text-input k-input" id="key-edit-val" type="password" placeholder="paste the ${current ? 'new ' : ''}secret…" spellcheck="false" />
      <button class="k-act k-save" data-act="save">save</button>
      <button class="k-act" data-act="cancel">cancel</button></div>`;
  }
  function keysPaneHtml() {
    const o = S.overlay;
    if (!o.keys) return '<p class="setup-copy">Looking for your keys…</p>';
    const stored = o.keys.stored, have = new Set(stored.map((k) => k.name));
    const rows = [];
    for (const k of stored) {
      if (o.editKey === k.name) {
        rows.push(keyEditRowHtml(k.name, k.masked));
      } else if (o.reveal && o.reveal.name === k.name) {
        rows.push(keyRowHtml({ name: k.name, value: o.reveal.value, actions: ['hide', 'edit', 'remove'] }));
      } else {
        rows.push(keyRowHtml({ name: k.name, value: k.masked, actions: ['show', 'edit', 'remove'] }));
      }
    }
    for (const s of SUGGESTED_KEYS) {
      if (have.has(s.name)) continue;
      if (o.editKey === s.name) rows.push(keyEditRowHtml(s.name, ''));
      else rows.push(keyRowHtml({ name: s.name, value: 'not set — ' + s.hint, sub: true, actions: ['add'] }));
    }
    return `<p class="setup-copy">Paste a key once and it lands in the environment of every session KingAgent
      starts — agents, terminals, harnesses. Voice reads the same keys.</p>
      ${rows.join('')}
      <div class="key-row key-row--new">
        <input class="text-input k-input k-name-input" id="key-new-name" placeholder="MY_SERVICE_KEY" spellcheck="false" />
        <input class="text-input k-input" id="key-new-val" type="password" placeholder="paste the secret…" spellcheck="false" />
        <button class="k-act k-save" id="key-new-save">save</button></div>
      <div class="key-note">saved in <span class="k-open" id="key-note-open">settings.json</span> — click to see the file</div>`;
  }
  function refreshKeys() {
    return api.keysGet().then((res) => {
      if (isSettingsOpen()) { S.overlay.keys = res; renderOverlay(); }
    });
  }
  function wireKeysPane(modal) {
    const o = S.overlay;
    if (o.keys === undefined) { o.keys = null; refreshKeys(); }
    const saveKey = async (name, input) => {
      const v = input.value.trim();
      if (!v) { toast('Paste the secret first.'); return; }
      const res = await api.keysSet(name, v);
      if (!res.ok) { toast(res.error || 'Could not save it.'); return; }
      o.editKey = null; o.reveal = null;
      toast(`${name} saved — every new session gets it.`);
      refreshKeys(); refreshSttInfo(); // Voice's ready flags read the same store
    };
    modal.querySelectorAll('.key-row .k-act').forEach((b) => {
      const name = b.closest('.key-row').dataset.key;
      const act = b.dataset.act;
      b.onclick = async () => {
        if (act === 'add' || act === 'edit') { o.editKey = name; o.reveal = null; renderOverlay(); const i = q('#key-edit-val'); if (i) i.focus(); }
        else if (act === 'save') saveKey(name, q('#key-edit-val', modal));
        else if (act === 'cancel') { o.editKey = null; renderOverlay(); }
        else if (act === 'show') { const r = await api.keysReveal(name); o.reveal = { name, value: r.value }; renderOverlay(); }
        else if (act === 'hide') { o.reveal = null; renderOverlay(); }
        else if (act === 'remove') { o.reveal = null; await api.keysDelete(name); toast(`${name} removed.`); refreshKeys(); refreshSttInfo(); }
      };
    });
    const editInput = q('#key-edit-val', modal);
    if (editInput) editInput.onkeydown = (e) => {
      if (e.key === 'Enter') saveKey(o.editKey, editInput);
      if (e.key === 'Escape') { e.stopPropagation(); o.editKey = null; renderOverlay(); }
    };
    const noteOpen = q('#key-note-open', modal);
    if (noteOpen) noteOpen.onclick = () => api.settingsReveal();
    const newSave = q('#key-new-save', modal);
    if (newSave) {
      const doNew = () => {
        const name = q('#key-new-name', modal).value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
        if (!name) { toast('Name it like AN_ENV_VAR first.'); return; }
        saveKey(name, q('#key-new-val', modal));
      };
      newSave.onclick = doNew;
      q('#key-new-val', modal).onkeydown = (e) => { if (e.key === 'Enter') doNew(); };
    }
  }

  return { openSettings, renderSettings, wireHelpDialog };
}
