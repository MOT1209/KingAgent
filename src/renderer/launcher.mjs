import { chipHtml, iconKeyFor, iconSvg, treeIcon } from './icons.mjs';
import { resolveTool, originLine, sortKey, isMaster, reachOf } from './agent-reach.mjs';
import { isPickerAgent } from './library-groups.mjs';
import { knowsCopy } from './receivers.mjs';
import { agentLaunch } from './agent-launch.mjs';
import { buildCreateSeed, buildImproveSeed, targetDirFor } from './seed-text.mjs';
import { grokAuthActions, GROK_API_KEY } from './grok-auth.mjs';
import { CHAT_READY } from './acp-pane.mjs';
import { createMcpSetup } from './mcp-setup.mjs';
import { isSession as isSessionPanel } from './desk-view.mjs';
import { OPEN_OUTPUT_COPY } from './shortcuts.mjs';
import { tailPath } from './file-kinds.mjs';

// Extracted from app.js verbatim, as part of splitting that file into
// smaller feature modules.
//
// Everything under the old "Launcher" banner EXCEPT the generic overlay
// dispatch table and toast, which stayed in app.js: `overlay`/`closeOverlay`/
// `renderOverlay` route to browser overlays, Settings and Quick Start too,
// not just the sheets here, and four already-committed modules depend on
// them as plain (unthunked) constructor arguments — moving them would force
// retrofitting thunks into working files for something that was never really
// Launcher's to own. "Peek" (float a file above the desk) stayed too, for
// the same reason: it shares mutable overlay state (`peekRec`,
// `overlayDispose`) directly with `renderOverlay`.
export function createLauncher({ api, state, tiles, browsers, toast, overlay, closeOverlay, renderOverlay, rememberHelpFocus,
  openSettings, wireHelpDialog, getTypeChip, REPO_URL, DOCS,
  startPanel, closePanel, openFile, savePanels, flushPanels, restorePanels, seedTitleSource,
  esc, q, shortHome, baseNameOf, uid, code2,
  refreshTileHead, refreshRail, renderRail, renderHeader, renderGrid, renderAll, attachCompanion, EVERGREEN_ROWS,
  watchProject, refreshServices, makeFolderDialog,
  loadLibrary, refreshPointer, installedAgentIds, agentNameOf, openCard }) {
  const S = state;

  // A session runs inside a folder. With one open, launch straight away; without,
  // the folder-first card asks where — recents are one click, and the OS dialog
  // only appears from its "another folder" row. The continuation rides on the
  // overlay itself: Esc / ✕ / click-out use the generic dismiss and simply drop
  // it, so nothing awaits and nothing can hang.
  function withFolder(run, who) {
    if (S.project) return run();
    S.overlay = { type: 'folder-first', run, who };
    renderOverlay();
  }
  function renderFolderFirst() {
    const o = S.overlay;
    const who = o.who || 'this session';
    const recents = (S.recents || []).filter((r) => !r.missing);
    const modal = overlay('picker-box', `<div class="picker-input"><span class="prompt-mark">＋</span>
      <span style="font-weight:700">Where should ${esc(who)} work?</span>
      <span style="margin-left:auto;font-size:11px;color:var(--muted)">then your session starts</span></div>
      ${recents.length
    ? `<div class="ff-lead">a session runs inside a folder. Pick one and ${esc(who)} starts there</div>
        <div class="picker-list" id="ff-list">${recents.map((r, i) => `
          <div class="picker-row" data-i="${i}" title="${esc(r.path)}">
            <span class="folder-glyph">${treeIcon('', 'dir', false)}</span>
            <span class="col"><span class="name">${esc(r.name)}</span><span class="desc">${esc(r.pathShort)}</span></span>
            ${r.pinned ? '<span class="ff-pin">pinned</span>' : ''}
          </div>`).join('')}</div>
        <button class="ff-other" id="ff-pick"><span class="plus">＋</span><span>Choose another folder…</span><span class="kbd">opens the Mac dialog</span></button>`
    : `<div class="ff-empty">
          <div class="ff-msg">No folders here yet</div>
          <div class="ff-sub">a folder is where your files and the session live. One of your projects, or an empty one to start in</div>
          <button class="btn btn--go" id="ff-pick">Choose a folder…</button>
          <div class="ff-hint">opens the Mac folder dialog</div>
        </div>`}`, { top: true });
    // A pick has to outlive the overlay: closeOverlay() nulls S.overlay, so the
    // continuation is captured before anything closes.
    const run = o.run;
    modal.querySelectorAll('.picker-row').forEach((row) => {
      row.onclick = async () => {
        const r = recents[+row.dataset.i]; if (!r) return;
        closeOverlay();
        await openFolder(r.path);
        if (S.project) run();
      };
    });
    q('#ff-pick', modal).onclick = async () => {
      const info = await api.pickFolder(); if (!info) return;
      closeOverlay();
      await switchToFolder(info);
      if (S.project) run();
    };
  }

  // Callers await this, so a scan already in flight must hand back the SAME
  // promise rather than an instantly-resolved undefined — otherwise the second
  // caller runs before S.agents exists and sees no agents at all.
  let agentsInflight = null;
  function refreshAgents() {
    if (agentsInflight) return agentsInflight;
    S.agentsLoading = true;
    agentsInflight = agentsScan().finally(() => { agentsInflight = null; S.agentsLoading = false; });
    return agentsInflight;
  }
  async function agentsScan() {
    try { S.agents = await api.detectAgents(); } catch (_) { S.agents = S.agents || []; }
    repaintAgentOverlays();
    // Identity is read after the list paints, one agent at a time in parallel:
    // a slow CLI delays only its own second line, never the whole sheet.
    for (const a of (S.agents || [])) if (a.found) refreshAgentStatus(a.id);
  }
  function repaintAgentOverlays() {
    const ot = S.overlay && S.overlay.type;
    if (['launcher', 'agent-setup', 'agent-remove', 'connect-form', 'connect-custom', 'connect-own', 'create', 'improve-item'].includes(ot)) renderOverlay();
  }
  async function refreshAgentStatus(id) {
    try { S.agentStatus[id] = await api.agentStatus(id); } catch (_) { S.agentStatus[id] = null; }
    repaintAgentOverlays();
  }
  // One agent's second line. Identity when we have it, the registry blurb until
  // then — the row never says less than it does today.
  function statusLineFor(a) {
    const st = S.agentStatus[a.id];
    if (!st || st.signedIn === null) return { dot: 'ok', text: a.sub };
    if (st.signedIn === false) return { dot: 'warn', text: 'signed out' };
    return { dot: 'ok', text: st.label || a.sub };
  }
  function openLauncher() { S.overlay = { type: 'launcher' }; renderOverlay(); refreshAgents(); }
  function renderLauncher() {
    const companionOf = S.overlay.companionOf;
    const prevList = q('#lc-list');
    const prevScroll = prevList ? prevList.scrollTop : 0;
    const modal = overlay('picker-box', `<div class="picker-input"><span class="prompt-mark">＋</span><span style="font-weight:700">New session</span>
      <span style="margin-left:auto;font-size:11px;color:var(--muted)">${S.project ? esc(S.project.name) : 'no folder'}</span></div>
      <div class="picker-list" id="lc-list"></div>`, { top: true });
    const list = q('#lc-list', modal);
    if (prevScroll) requestAnimationFrame(() => { list.scrollTop = prevScroll; });
    // The one just added sorts to the top. Anything else and the user is handed
    // back a list and asked to find their own new thing in it.
    const ready = (S.agents || []).filter((a) => a.found)
      .sort((x, y) => (y.id === S.justAdded) - (x.id === S.justAdded)
        || (CHAT_READY.includes(y.id) - CHAT_READY.includes(x.id)));
    const missing = (S.agents || []).filter((a) => !a.found);

    if (!S.agents) {
      const row = document.createElement('div'); row.className = 'picker-row';
      row.innerHTML = `<span class="col"><span class="desc">looking for agents on this Mac…</span></span>`;
      list.appendChild(row);
    }
    for (const a of ready) {
      const row = document.createElement('div'); row.className = 'picker-row';
      const st = statusLineFor(a);
      const manageable = !!a.lifecycle;
      // The one just installed says so, and says it here — this list is where the
      // install sends you back to, and an agent that arrived thirty seconds ago
      // looks exactly like one that has been there for months without it.
      const fresh = S.justAdded === a.id;
      if (fresh) row.classList.add('picker-row--new');
      row.innerHTML = `${chipHtml({ key: iconKeyFor(a.id), code: code2(a.name), kind: 'agent' })}
        <span class="col"><span class="name">${esc(a.name)}</span>
        <span class="desc"><span class="ok${st.dot === 'warn' ? ' ok--warn' : ''}">●</span> ready · ${esc(st.text)}</span></span>
        ${fresh ? '<span class="row-new">just added</span>' : ''}
        ${manageable ? '<span class="chev" title="Manage this agent">›</span>' : ''}`;
      const launch = () => {
        closeOverlay();
        withFolder(() => {
          const p = a.kind === 'claude' ? startPanel({ kind:'claude', title:'Claude session', code:'CC' }) : startPanel({ kind:'run', title:a.name, code:code2(a.name), command:a.bin });
          attachCompanion(p,companionOf);
        }, a.name);
      };
      // Prototype (demo only): agents with an ACP mode default to the cowork
      // surface; "as terminal" keeps today's launch one click away.
      // Chat lights up per agent as its bridge passes the probe (acp-probe.mjs).
      const demoAcp = CHAT_READY.includes(a.id);
      if (demoAcp) {
        const tail = document.createElement('span');
        tail.className = 'lc-acp';
        tail.innerHTML = '<button class="lc-chat">Chat<span class="lc-beta">beta</span></button>';
        row.appendChild(tail);
      }
      row.onclick = async (e) => {
        if (manageable && e.target.closest('.chev')) { openAgentSheet(a); return; }
        if (demoAcp && e.target.closest('.lc-chat')) {
          closeOverlay();
          // claude goes LIVE — real ACP through the official adapter
          const live = CHAT_READY.includes(a.id);
          // a chat session stands where your other sessions stand — the project
          const liveCwd = (!S.demo && S.project && S.project.path) ? S.project.path
            : decodeURIComponent(new URL('../../../../', location.href).pathname).replace(/\/$/, '');
          const np = { id: uid('p_'), kind: 'acp', chipKind: 'agent', code: code2(a.name), title: a.name, agentId: a.id, cwd: live ? liveCwd : ((S.project && S.project.path) || '~'), status: 'live', started: true, attention: false, acpLive: live };
          seedTitleSource(np);
          S.panels.unshift(np); S.activeId = np.id;
          renderGrid(); renderRail(); renderHeader();
          attachCompanion(np,companionOf);
          toast(a.name + ' — new chat session');
          return;
        }
        launch();
      };
      list.appendChild(row);
    }
    for (const h of EVERGREEN_ROWS) {
      const row = document.createElement('div'); row.className = 'picker-row';
      row.innerHTML = `<span class="code" data-kind="${esc(h.chipKind || 'shell')}">${esc(h.code)}</span>
        <span class="col"><span class="name">${esc(h.name)}</span><span class="desc">${esc(h.sub)}</span></span>`;
      row.onclick = () => { closeOverlay(); withFolder(async () => { const p=await launchHarness(h); attachCompanion(p,companionOf); }, 'the terminal'); };
      list.appendChild(row);
    }
    // add section: every not-yet-installed agent from the curated registry
    if (missing.length) {
      const div = document.createElement('div'); div.className = 'picker-divider';
      div.textContent = 'add an agent to this Mac'; list.appendChild(div);
      const grid = document.createElement('div'); grid.className = 'add-grid'; list.appendChild(grid);
      for (const a of missing) {
        const card = document.createElement('div'); card.className = 'add-card'; card.tabIndex = 0;
        card.innerHTML = `${chipHtml({ key: iconKeyFor(a.id), code: code2(a.name), kind: 'agent' })}
          <span class="ac-name">${esc(a.name)}</span><span class="ac-desc">${esc(a.sub)}</span><span class="ac-go">set up →</span>`;
        card.onclick = () => { closeOverlay(); openAgentSetup(a); };
        grid.appendChild(card);
      }
    }
  }
  async function launchHarness(_h) {
    return startPanel({ kind: 'shell', title: 'Terminal', code: '❯', chipKind: 'shell' });
  }
  function openAgentSetup(agent) { S.overlay = { type: 'agent-setup', agent }; renderOverlay(); }
  // Same sheet, two faces. Not installed → the install command, exactly as before.
  // Installed → who it runs as, and everything you can do about that.
  function openAgentSheet(agent) { S.overlay = { type: 'agent-setup', agent }; renderOverlay(); refreshAgentStatus(agent.id); }
  function renderAgentSetup() {
    const a = S.overlay.agent;
    return a.found ? renderAgentInstalled(a) : renderAgentInstall(a);
  }

  // Every lifecycle action is the CLI's own command, run in the tile that already
  // runs installs. When it exits we re-read status, so the sheet is never stale.
  function runAgentCommand(agent, command, title) {
    closeOverlay();
    startPanel({
      kind: 'run', title, code: code2(agent.name), command,
      onExit: () => { refreshAgents(); },
    });
  }

  // On this Mac — who it runs as, and everything you can do about that.
  function renderAgentInstalled(a) {
    const lc = a.lifecycle || {};
    const st = S.agentStatus[a.id] || null;
    const grok = a.id === 'grok';
    const ga = grok ? grokAuthActions(st) : null;
    const editingKey = grok && S.overlay.editGrokKey;
    const line = st && st.signedIn === true ? esc(st.label)
      : st && st.signedIn === false ? 'signed out'
        : 'checking…';
    const rows = (st && st.rows) || [];
    const scan = rows.map((r) =>
      `<div class="scan-row"><span class="mark">✓</span><span class="label2">${esc(r.k)}</span><span class="value">${esc(r.v)}</span></div>`).join('');
    // A button only exists when the registry has a real command behind it, so an
    // unverified CLI shows identity and nothing that could fail.
    const btn = (id, label, on) => on ? `<button class="btn" id="${id}">${esc(label)}</button>` : '';
    const actions = grok ? `
        ${btn('ag-in', 'Sign in with xAI account', ga.signInAccount)}
        ${btn('ag-out', 'Sign out', ga.signOutAccount)}
        ${btn('ag-key-switch', 'Switch to API key', ga.switchToKey)}
        ${btn('ag-key', ga.pasteLabel, ga.pasteKey && !editingKey)}
        ${btn('ag-health', "Check it's healthy", lc.health)}`
      : `
        ${btn('ag-switch', lc.switchLabel || 'Switch account', lc.switchCmd || (lc.login && lc.logout))}
        ${btn('ag-out', 'Sign out', lc.logout && (!st || st.signedIn !== false))}
        ${btn('ag-in', 'Sign in', lc.login && st && st.signedIn === false)}
        ${btn('ag-setup', 'Run setup again', lc.setup)}
        ${btn('ag-health', "Check it's healthy", lc.health)}`;
    const pasteRow = editingKey ? `
      <div class="key-row" data-key="${esc(GROK_API_KEY)}">
        <span class="k-name">${esc(GROK_API_KEY)}</span>
        <input class="text-input k-input" id="grok-key-val" type="password" placeholder="paste the secret…" spellcheck="false" />
        <button class="k-act k-save" id="grok-key-save">save</button>
        <button class="k-act" id="grok-key-cancel">cancel</button>
      </div>` : '';

    const modal = overlay('setup-box', `
      <div class="setup-head"><button class="t-btn su-back" title="Back to new session">←</button>
        ${chipHtml({ key: iconKeyFor(a.id), code: code2(a.name), kind: 'agent' })}
        <span class="col"><span class="name">${esc(a.name)}</span>
        <span class="desc"><span class="ok${st && st.signedIn === false ? ' ok--warn' : ''}">●</span> ${line}</span></span></div>

      <div class="scan-box ag-scan">
        <div class="label">this Mac${st && st.source ? `<span class="scan-src">${esc(st.source)}</span>` : ''}</div>
        ${scan}
        <div class="scan-row"><span class="mark">✓</span><span class="label2">Program</span><span class="value">${esc(a.pathShort || a.path || 'installed')}</span></div>
      </div>

      <div class="setup-actions">${actions}
      </div>
      ${pasteRow}
      <div class="ag-links">
        ${a.configFile ? '<span class="action" id="ag-config">Open its settings file</span>' : ''}
        ${lc.accountUrl ? '<span class="action" id="ag-account">Manage account online</span>' : ''}
        ${grok ? '<span class="action" id="ag-key-docs">Get an API key</span>' : ''}
        <span class="action" id="ag-docs">Read the guide</span>
      </div>
      <div class="ag-danger">
        <button class="btn btn--ghost" id="ag-remove">Remove from this Mac</button>
        <span class="why">Asks first, and names every file it would delete.</span>
      </div>`);

    q('.su-back', modal).onclick = () => openLauncher();
    const on = (id, fn) => { const el = q('#' + id, modal); if (el) el.onclick = fn; };
    on('ag-switch', () => runAgentCommand(a, lc.switchCmd || `${lc.logout} && ${lc.login}`, `${a.name} · sign in`));
    on('ag-out', () => runAgentCommand(a, lc.logout, `${a.name} · sign out`));
    on('ag-in', () => runAgentCommand(a, lc.login, `${a.name} · sign in`));
    on('ag-key-switch', () => runAgentCommand(a, lc.logout, `${a.name} · switch to API key`));
    on('ag-key', () => { S.overlay.editGrokKey = true; renderOverlay(); });
    on('ag-setup', () => runAgentCommand(a, lc.setup, `${a.name} · setup`));
    on('ag-health', () => runAgentCommand(a, lc.health, `${a.name} · check`));
    on('ag-config', () => { closeOverlay(); openFile(a.configFile, { pin: true }); });
    on('ag-account', () => api.openUrl(lc.accountUrl));
    on('ag-key-docs', () => api.openUrl('https://console.x.ai'));
    on('ag-docs', () => api.openUrl(a.docs));
    on('ag-remove', () => openAgentRemove(a));
    const keyInput = q('#grok-key-val', modal);
    const saveKey = async () => {
      const v = keyInput && keyInput.value.trim();
      if (!v) { toast('Paste the secret first.'); return; }
      const res = await api.keysSet(GROK_API_KEY, v);
      if (!res.ok) { toast(res.error || 'Could not save it.'); return; }
      S.overlay.editGrokKey = false;
      toast(`${GROK_API_KEY} saved — every new session gets it.`);
      // Grok prefers a session token over the env key. Logging out is what
      // makes the key the one the next tile actually uses.
      if (ga && ga.logoutAfterSave && lc.logout) {
        runAgentCommand(a, lc.logout, `${a.name} · switch to API key`);
      } else {
        await refreshAgentStatus(a.id);
        renderOverlay();
      }
    };
    if (keyInput) {
      keyInput.focus();
      keyInput.onkeydown = (e) => {
        if (e.key === 'Enter') saveKey();
        if (e.key === 'Escape') { e.stopPropagation(); S.overlay.editGrokKey = false; renderOverlay(); }
      };
    }
    on('grok-key-save', saveKey);
    on('grok-key-cancel', () => { S.overlay.editGrokKey = false; renderOverlay(); });
  }

  // The only action here that destroys anything, so it is the only one that stops
  // and asks — and it names the real paths before it touches them.
  function openAgentRemove(agent) {
    S.overlay = { type: 'agent-remove', agent, plan: null, busy: false };
    renderOverlay();
    api.agentRemovalPlan(agent.id, agent.path).then((plan) => {
      if (S.overlay && S.overlay.type === 'agent-remove') { S.overlay.plan = plan; renderOverlay(); }
    });
  }
  function renderAgentRemove() {
    const o = S.overlay; const a = o.agent; const plan = o.plan;
    const body = !plan ? '<p class="setup-copy">Working out what this would delete…</p>'
      : plan.mode === 'none'
        ? `<p class="setup-copy">${esc(plan.reason)}</p>`
        : `<div class="warn-box">
             <div class="wb-head">This ${plan.mode === 'uninstall' ? 'runs' : 'deletes, on this Mac'}:</div>
             <ul>${(plan.describe || []).map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
           </div>
           <p class="setup-copy">Your projects and files are untouched. You can install ${esc(a.name)} again later,
             but you would sign in from scratch.</p>`;

    const modal = overlay('setup-box', `
      <div class="setup-head">${chipHtml({ key: iconKeyFor(a.id), code: code2(a.name), kind: 'agent' })}
        <span class="col"><span class="name">Remove ${esc(a.name)}?</span>
        <span class="desc">this cannot be undone</span></span></div>
      ${body}
      <div class="setup-actions">
        ${plan && plan.mode !== 'none' ? `<button class="btn btn--red" id="ar-go"${o.busy ? ' disabled' : ''}>${o.busy ? 'Removing…' : 'Yes, remove it'}</button>` : ''}
        <button class="btn" id="ar-keep">${plan && plan.mode === 'none' ? 'Close' : 'Keep it'}</button>
      </div>`);

    q('#ar-keep', modal).onclick = () => openAgentSheet(a);
    const go = q('#ar-go', modal);
    if (go) go.onclick = async () => {
      if (plan.mode === 'uninstall') return runAgentCommand(a, plan.command, `remove ${a.name}`);
      o.busy = true; renderOverlay();
      const res = await api.agentRemove(a.id, a.path);
      o.busy = false;
      if (res.ok) { closeOverlay(); refreshAgents(); toast(`${a.name} removed.`); }
      else { renderOverlay(); toast(res.error || `Could not remove ${a.name}.`); }
    };
  }

  // Not installed yet. The command shown is the one this platform can run:
  // detection marks `installAvailable` false when the docs offer nothing here
  // (a mac curl-pipe-bash line on Windows), and then the sheet offers the doc
  // page instead of a dead command.
  function renderAgentInstall(a) {
    const cmd = a.installCommand || a.install;
    const canRun = a.installAvailable !== false;
    const modal = overlay('setup-box', `
      <div class="setup-head"><button class="t-btn su-back" title="Back to new session">←</button>
        ${chipHtml({ key: iconKeyFor(a.id), code: code2(a.name), kind: 'agent' })}
        <span class="col"><span class="name">${esc(a.name)}</span><span class="desc">${esc(a.sub)}</span></span></div>
      <p class="setup-copy">${esc(a.name)} is not installed yet.${canRun ? ' One command installs it, and I can run that for you in a terminal right here.' : ' No one-line installer is available on this platform yet — the official guide has the current route.'} The first time it starts, it will ask you to sign in, right in the tile.</p>
      <div class="setup-cmd">${esc(cmd)}</div>
      <div class="setup-actions">
        ${canRun ? '<button class="btn btn--go" id="su-run">Install it for me</button>' : ''}
        <button class="btn" id="su-copy">Copy the command</button>
        <button class="btn" id="su-docs">Read the guide</button>
      </div>
      <p class="setup-note">${canRun ? 'Install it for me opens a terminal tile and runs the line above. ' : ''}Copy puts it on
        your clipboard. Read the guide opens the official ${esc(a.name)} page in your browser.</p>`);
    q('.su-back', modal).onclick = () => openLauncher();
    if (canRun) q('#su-run', modal).onclick = () => {
      closeOverlay();
      // oneShot + watchDone: this tile exists to run one command the app chose, and
      // the tile itself reports when that command lands. Before, the only signal
      // was the shell dying — which for an install is never — so the toast asked
      // the user to go and press ⌘N themselves.
      withFolder(() => startPanel({
        kind: 'run', title: `install ${a.name}`, code: code2(a.name), command: cmd,
        oneShot: true, watchDone: true, agentId: a.id,
        onExit: () => refreshAgents(),
      }), 'this install');
    };
    q('#su-copy', modal).onclick = async () => { await api.copyText(cmd); toast('Copied.'); };
    q('#su-docs', modal).onclick = () => api.openUrl(a.docs);
  }

  // ---- an install that finished ----------------------------------------------
  // The old ending was a shell prompt and a toast asking the user to press ⌘N and
  // go find the agent. Nothing had told the app the install was over, so nothing
  // could offer anything better. Now the tile knows, so it can say what happened
  // and hand back the one list the user came from.

  // A strip under the tile body. Deliberately not a toast: a toast is gone in
  // four seconds and this is the tile's own state, which should still be there
  // when someone looks back at it.
  function setTileNote(p, html, kind) {
    const t = tiles.get(p.id); if (!t) return;
    let note = q('.tile-note', t.root);
    if (!html) { if (note) note.remove(); return; }
    if (!note) {
      note = document.createElement('div');
      note.className = 'tile-note';
      t.root.appendChild(note);
    }
    note.className = 'tile-note' + (kind ? ' tile-note--' + kind : '');
    note.innerHTML = html;
    return note;
  }

  // One place both the live channel and --scene=install go through, so what gets
  // screenshotted is what a user gets.
  function runCommandFinished(p, code) {
    if (p.commandDone) return;
    p.commandDone = true; p.commandCode = code;
    // Snapshot now: from here the tile is an ordinary shell and must never be
    // restored as a command to run again.
    savePanels();
    // head, rail and the live badge all read the same status — refreshing one of
    // them left the rail saying "running" beside a tile saying "installed".
    refreshTileHead(p); refreshRail(); renderHeader();
    if (p.agentId) finishAgentInstall(p, code);
  }

  async function finishAgentInstall(p, code) {
    const agent = () => (S.agents || []).find((x) => x.id === p.agentId);
    const name = (agent() && agent().name) || p.agentId;
    refreshTileHead(p);

    // The scan decides, not the exit code. `curl … | bash` — four of the six
    // install commands — reports the status of bash, and a curl that never
    // reached the host still leaves bash reading an empty script and exiting 0
    // (measured against a real pty). A zero means the shell got to the end. Only
    // finding the program means it installed.
    if (code === 0) await refreshAgents();
    const found = !!(agent() && agent().found);
    const ok = code === 0 && found;
    p.installOk = ok;
    refreshTileHead(p); refreshRail();

    if (!ok) {
      setTileNote(p, `<span class="tn-tx"><b>${esc(name)} is still not on this Mac.</b>
        ${code === 0 ? 'The command ran to the end but left nothing KingAgent can find — the output above should say why.'
    : `The install exited with <b>${esc(String(code))}</b>.`}</span>
        <span class="tn-bt"><button class="btn btn--small" id="tn-docs">Read the guide</button>
        <button class="btn btn--small" id="tn-retry">Try again</button></span>`, 'warn');
      const t = tiles.get(p.id); if (!t) return;
      const docs = q('#tn-docs', t.root), retry = q('#tn-retry', t.root);
      if (docs) docs.onclick = () => { const a = agent(); if (a) api.openUrl(a.docs); };
      if (retry) retry.onclick = () => { const a = agent(); if (a) { closePanel(p.id); openAgentSetup(a); } };
      return;
    }

    const a = agent();
    S.justAdded = a.id;
    const signedOut = !(S.agentStatus[a.id] && S.agentStatus[a.id].signedIn);
    setTileNote(p, `<span class="tn-tx"><b>${esc(a.name)} is on this Mac.</b>
      ${signedOut ? 'Signed out — your first session signs you in.' : 'Signed in and ready.'}</span>
      <span class="tn-bt"><button class="btn btn--go btn--small" id="tn-go">Back to New session</button></span>`, 'ok');
    const t = tiles.get(p.id); if (!t) return;
    const go = q('#tn-go', t.root);
    // Back to the list they came from, with the new agent in it — rather than
    // dropping them into a session they did not ask for yet. The finished install
    // terminal closes on the way out: it has nothing left to say.
    if (go) go.onclick = () => { closePanel(p.id); openLauncher(); };
  }

  // ---- agent picker (⌘K) — fed by the library scan ---------------------------
  // ⌘N answers which tool runs. This answers what it runs as — every agent on the
  // shelf, whatever tool it speaks, with two ways out of every row: into the
  // session you are looking at, or into a fresh one.
  function pickerAgents() {
    // One agent, one row — the rule the drawer has followed since it landed. A
    // file sitting where a master's copy would land is that master shadowed on
    // one tool, not a second agent, and the master's tool list says so as ◐.
    // ⌘K is this folder only: masters and hand-made in-project files.
    return (S.library.items || [])
      .filter(isPickerAgent)
      .sort((a, b) => sortKey(a) - sortKey(b) || String(a.slug).localeCompare(String(b.slug)));
  }
  function toolNameOf(id) { const a = (S.agents || []).find((x) => x.id === id); return a ? a.name : id; }
  function toolById(id) { return (S.agents || []).find((x) => x.id === id) || null; }

  // Which tool a live tile is running, as a detected agent id.
  function panelTool(p) {
    if (!p) return null;
    if (p.kind === 'claude') return 'claude';
    if (p.kind === 'run') {
      const c = String(p.command || '').trim();
      const a = (S.agents || []).find((x) => x.bin === c);
      return a ? a.id : null;
    }
    return null;
  }
  function focusedPanel() { return S.panels.find((x) => x.id === S.activeId) || null; }

  // One string per agent, so a habit is remembered per agent rather than globally
  // — the same shape as the launcher's Cards/Terminal memory.
  const TOOL_KEY = (item) => 'kingagent.agenttool.' + item.id;
  function rememberedTool(item) { try { return localStorage.getItem(TOOL_KEY(item)) || ''; } catch (_) { return ''; } }
  function rememberTool(item, toolId) { try { localStorage.setItem(TOOL_KEY(item), toolId); } catch (_) {} }

  function rowTool(item) {
    const p = focusedPanel();
    return resolveTool({
      item,
      remembered: rememberedTool(item),
      focusedTool: p ? panelTool(p) : null,
      installed: installedAgentIds(),
    });
  }

  // Any agent that is not a master is one copy away from being one. A markdown
  // file the project owns is lifted — the original becomes a marked copy that
  // regenerates from the new master. Everything else — plugins, user-scope
  // files, Codex TOML — is imported, and the source is read, never written.
  async function copyToMaster(item) {
    if (!S.project) { toast('Open a folder first — the master lands in it.'); return; }
    const args = { projectPath: S.project.path, agentIds: installedAgentIds() };
    const lift = item.scope === 'project' && !item.readOnly && /\.(md|markdown)$/i.test(item.filePath || '');
    const res = lift
      ? await api.adoptAgent({ ...args, filePath: item.filePath, platform: item.platform })
      : await api.importAgent({ ...args, filePath: item.filePath });
    if (!res || !res.ok) { toast((res && res.error) || 'Could not copy it.'); return; }
    await loadLibrary(true); // force — the scan must see the new master
    toast(`${item.slug} lives in agents/${item.slug}.md now.`);
    if (S.overlay && S.overlay.type === 'agents') {
      // Reopen as the master it just became, so the delivery dots light up in
      // place — openToolList toggles, so the slot must be cleared first.
      S.overlay.open = null; S.overlay.delivery = null;
      const master = pickerAgents().find((a) => a.slug === item.slug && isMaster(a));
      if (master) await openToolList(master); else renderOverlay();
    }
  }

  // Make sure this agent has a copy on the tool about to run it. Delivery is
  // tool-scoped, not agent-scoped — one pass regenerates every master for that
  // one tool — which is what keeps ⌘K from quietly rewriting five other folders.
  async function ensureDelivered(item, toolId) {
    if (!isMaster(item) || !S.project) return null;
    const before = await api.agentDelivery({ projectPath: S.project.path, slug: item.slug, agentIds: [toolId] });
    const was = (before && before[0]) || null;
    // `here` is not a skip: the copy regenerates so a dialect fix (opencode's
    // mode, say) reaches copies delivered before it. Marked files are KingAgent's to
    // rewrite; `theirs` and `none` stay untouched as ever.
    if (!was || was.state === 'theirs' || was.state === 'none' || was.state === 'via') return was;
    // Report what delivery actually did, not what it was asked to do. Saying
    // "delivered just now" about a write that failed is the same false claim this
    // whole surface exists to avoid — and deliverAgents already answers per pair.
    //
    // It answers per pair for a refusal; a read-only folder is not a refusal but a
    // throw, straight out of writeFileSync and through the ipc call. Uncaught, it
    // would abort the launch after the overlay had closed: no session, no tile, no
    // word. The session is worth having even when the copy could not be written.
    //
    // And a throw is not evidence about *this* agent: delivery runs every master
    // against the tool in one pass, so an unrelated master's unwritable file
    // rejects the whole call while ours may well have landed. Ask the disk again
    // rather than deny a copy that is sitting there.
    let done;
    try { done = await api.deliverAgents({ projectPath: S.project.path, agentIds: [toolId] }); }
    catch (_) {
      try {
        const after = await api.agentDelivery({ projectPath: S.project.path, slug: item.slug, agentIds: [toolId] });
        const now = (after && after[0]) || null;
        if (now && now.state === 'here') return was;   // ours landed; the throw was somebody else's
        // A file appeared at the target that is not ours — a hand-edit between
        // the two reads, or a partial write. Whatever it is, the tool will read
        // it, so this is the `theirs` note and not the failure one.
        if (now && now.state === 'theirs') return { ...was, state: 'theirs', file: now.file };
        return { ...was, state: 'failed', file: (now && now.file) || was.file };
      } catch (_) { return { ...was, state: 'failed' }; }
    }
    const mine = (done || []).find((r) => r.slug === item.slug && r.agent === toolId);
    if (mine && mine.ok === false) return { ...was, state: mine.theirs ? 'theirs' : 'failed', file: mine.file || was.file };
    if (!mine) return { ...was, state: 'failed' };
    return was;
  }

  // What the session says about how it got here. Never silent about a file having
  // been written, never claiming one that was not. Card notes are plain text —
  // setTileNote sets innerHTML from announce(); the text itself is escaped.
  function deliveryNote(item, toolId, was) {
    const tool = toolNameOf(toolId);
    if (!isMaster(item)) return `${item.slug} — ${tool}'s own agent, from ${shortHome(item.filePath)}.`;
    if (!was) return `${item.slug} on ${tool}.`;
    if (was.state === 'theirs') {
      return `${item.slug} on ${tool} — your own ${baseNameOf(was.file)} is there and KingAgent left it alone, `
        + `so this runs your file, not agents/${item.slug}.md.`;
    }
    if (was.state === 'failed') {
      return `${item.slug} could not be delivered to ${tool}${was.file ? ' at ' + shortHome(was.file) : ''} — `
        + `it will run without the agent file unless you put one there yourself.`;
    }
    if (was.state === 'soon') return `Delivered ${item.slug} to ${was.file ? shortHome(was.file) : tool} just now.`;
    return `${item.slug} on ${tool} — the copy was already there.`;
  }

  function announce(p, text) {
    setTileNote(p, `<span class="tn-tx">${esc(text)}</span>`, 'ok');
  }

  // New session. Seed, surface and title are master's `useAgent` exactly, widened
  // to any installed tool: the seed rides the pty seeder, the panel is a terminal,
  // and the title is the weak generic one that the first prompt later replaces.
  // What is new around them is delivery and the note that reports it.
  //
  function launchAgent(item, toolId) {
    closeOverlay();
    withFolder(() => reallyLaunchAgent(item, toolId), item.slug);
  }
  async function reallyLaunchAgent(item, toolId) {
    const worker = toolById(toolId);
    if (!worker || !worker.found) { toast(`${toolNameOf(toolId)} is not on this Mac.`); return; }
    rememberTool(item, toolId);
    const was = await ensureDelivered(item, toolId);
    // How the session becomes the agent comes from the launch table, which knows
    // two mechanics and never blurs them: flag tools (claude, opencode,
    // antigravity) launch with --agent and the session opens already being the
    // agent; seed tools (codex, kimi) get one summoning sentence typed in their
    // own idiom. Both are probe-backed — see agent-launch.mjs.
    const launch = agentLaunch(toolId, item.slug);
    // `"<Name> session"` rather than the slug, because isGenericTitle keys on
    // that word: a name KingAgent merely assembled has to stay weak enough for the
    // first prompt, and then Claude's own transcript name, to replace it. Calling
    // the tile `ui-polisher` froze every ⌘K session under a name nothing could
    // improve. Not agentSession(): that stamps titleSource 'flow', the rung that
    // does the freezing.
    const p = startPanel({
      kind: worker.kind === 'claude' ? 'claude' : 'run',
      command: worker.kind === 'claude' ? undefined
        : launch.kind === 'flag' ? worker.bin + ' ' + launch.argv.join(' ') : worker.bin,
      args: worker.kind === 'claude' && launch.kind === 'flag' ? [...launch.argv] : undefined,
      title: item.name + ' session', code: code2(item.name),
      seed: launch.kind === 'seed' ? launch.seed : undefined,
    });
    if (!p) return;
    // Calvin's call: a launch that went right explains nothing — the session
    // speaking as the agent is its own receipt. The note survives only where
    // silence would lie: the copy could not be written, or a hand-made file won
    // and the session is running that file, not the master.
    if (was && (was.state === 'theirs' || was.state === 'failed')) {
      announce(p, deliveryNote(item, toolId, was));
    }
  }

  async function openAgentPicker() {
    await loadLibrary();
    S.overlay = { type: 'agents', query: '', hi: 0, open: null, delivery: null };
    renderOverlay();
    if (!S.agents) refreshAgents().then(() => { if (S.overlay && S.overlay.type === 'agents') renderOverlay(); });
  }

  // The ›: where this agent's copies stand across every installed tool. Read-only
  // — asking never writes.
  async function openToolList(item) {
    const o = S.overlay;
    if (o.open === item.slug) { o.open = null; o.delivery = null; renderOverlay(); return; }
    o.open = item.slug; o.delivery = null; renderOverlay();
    // A non-master's list is local arithmetic — where the file sits is the whole
    // answer — so there is nothing to ask the disk.
    if (!isMaster(item) || !S.project) return;
    const rows = await api.agentDelivery({
      projectPath: S.project.path, slug: item.slug, agentIds: installedAgentIds(),
    });
    if (S.overlay && S.overlay.type === 'agents' && S.overlay.open === item.slug) {
      S.overlay.delivery = rows; renderOverlay();
    }
  }

  const DELIVERY_DOT = { here: '●', soon: '○', theirs: '◐', via: '●', none: '—' };
  const DELIVERY_CLASS = { here: 'on', soon: 'soon', theirs: 'theirs', via: 'on', none: '' };
  function deliveryLine(row) {
    if (row.state === 'here') return 'delivered · ' + shortHome(row.file);
    if (row.state === 'soon') return 'delivered as ' + baseNameOf(row.file) + ' when it launches';
    if (row.state === 'theirs') return 'your own ' + baseNameOf(row.file) + ' is here — it wins, the master stays out';
    if (row.state === 'via') return 'reads ' + toolNameOf(row.via) + "'s copy";
    return row.reason || 'runs no custom agents';
  }

  function toolListHtml(item) {
    const o = S.overlay;
    // Not a master: the file sits in one tool's folder and that tool is the whole
    // answer. The other rows say what would change it — a copy into agents/ —
    // which is the drawer's Copy action, not a delivery that will never happen.
    if (!isMaster(item)) {
      const reach = reachOf(item);
      const act = `<div class="tool-row co-act" data-copy role="button" tabindex="0"
          title="Copy into agents/ — becomes a master that runs on every tool">
        <span class="tl-mark">＋</span>
        <span class="tl-name">Copy to this folder</span>
        <span class="tl-note">becomes agents/${esc(item.slug)}.md and runs on every tool below</span>
        <span class="tl-dot on">›</span></div>`;
      const rows = installedAgentIds().map((id) => {
        const runs = reach.includes(id);
        return `<div class="tool-row${runs ? ' picked' : ' dead'}">
          <span class="tl-mark">${iconSvg(iconKeyFor(id) || '') || esc(code2(toolNameOf(id)))}</span>
          <span class="tl-name">${esc(toolNameOf(id))}</span>
          <span class="tl-note">${runs ? 'runs here — its own folder' : 'after the copy, runs here too'}</span>
          <span class="tl-dot ${runs ? 'on' : ''}">${runs ? '●' : '—'}</span></div>`;
      }).join('');
      return `<div class="tool-list">${act}${rows}
        <div class="tool-foot">${item.scope === 'plugin'
    ? 'The plugin\'s own file is read, never written.'
    : 'The original file is never touched.'}</div></div>`;
    }
    if (!o.delivery) return '<div class="tool-list"><div class="tool-foot">looking…</div></div>';
    const rows = o.delivery.map((r) => {
      const dead = r.state === 'none';
      return `<div class="tool-row${dead ? ' dead' : ''}${rowTool(item) === r.agent ? ' picked' : ''}"
          ${dead ? '' : `data-tool="${esc(r.agent)}" role="button" tabindex="0"`}>
        <span class="tl-mark">${iconSvg(iconKeyFor(r.agent) || '') || esc(code2(toolNameOf(r.agent)))}</span>
        <span class="tl-name">${esc(toolNameOf(r.agent))}</span>
        <span class="tl-note">${esc(deliveryLine(r))}</span>
        <span class="tl-dot ${DELIVERY_CLASS[r.state] || ''}">${DELIVERY_DOT[r.state] || '—'}</span></div>`;
    }).join('');
    return `<div class="tool-list">${rows}
      <div class="tool-foot">Copies are regenerated from <b>agents/${esc(item.slug)}.md</b>.
        Files without KingAgent's marker are somebody's hand work and are never touched.</div></div>`;
  }

  const PICKER_SECTIONS = ['Project agents', 'In this project'];

  function renderAgentPickerSheet() {
    const o = S.overlay; const agents = pickerAgents();
    const query = o.query.toLowerCase();
    const filtered = agents.filter((a) => (a.slug + ' ' + a.name + ' ' + (a.description || '')).toLowerCase().includes(query));
    const modal = overlay('picker-box', `<div class="picker-input"><span class="prompt-mark">❯</span>
        <input id="ap-input" placeholder="Start a session with which agent?" value="${esc(o.query)}" /></div>
      <div class="picker-list" id="ap-list"></div>
      <div class="picker-foot"><span>click a row → a session as that agent</span>
        <span><b>›</b> → run it on another tool</span></div>`, { top: true });
    const groups = [[], []];
    filtered.forEach((a) => {
      const k = sortKey(a);
      if (k === 0 || k === 1) groups[k].push(a);
    });
    const visible = groups[0].concat(groups[1]);
    if (o.hi > visible.length - 1) o.hi = Math.max(0, visible.length - 1);
    const input = q('#ap-input', modal); setTimeout(() => input.focus(), 30);
    input.oninput = () => { o.query = input.value; o.hi = 0; o.open = null; renderOverlay(); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const a = visible[o.hi]; const t = a && rowTool(a);
        if (a && t) launchAgent(a, t);
        else if (a) toast(`Nothing installed can run ${a.slug}.`);
      }
      if (e.key === 'ArrowDown') { o.hi = Math.min(visible.length - 1, o.hi + 1); renderOverlay(); }
      if (e.key === 'ArrowUp') { o.hi = Math.max(0, o.hi - 1); renderOverlay(); }
    });
    const list = q('#ap-list', modal);
    if (!filtered.length) {
      list.innerHTML = agents.length
        ? '<div class="rail-empty" style="padding:14px">No match.</div>'
        : `<div class="rail-empty" style="padding:16px 14px"><b>No agents in this folder yet.</b><br>
          A project agent lives in <b>agents/&lt;name&gt;.md</b>. Make one with
          ＋ in the Library tab, or drop a file in that folder yourself.</div>`;
      return;
    }
    let vi = 0;
    groups.forEach((g, gi) => {
      if (!g.length) return;
      const head = document.createElement('div');
      head.className = 'picker-sec';
      head.textContent = PICKER_SECTIONS[gi];
      list.appendChild(head);
      g.forEach((a) => {
        const i = vi++;
        const tool = rowTool(a);
        const row = document.createElement('div');
        row.className = 'picker-row picker-row--go' + (i === o.hi ? ' hilite' : '') + (tool ? '' : ' dead');
        row.title = tool ? `Start a session as ${a.slug} on ${toolNameOf(tool)}` : 'Nothing installed can run this agent';
        row.innerHTML = `${chipHtml({ key: null, code: code2(a.slug), kind: 'agent' })}
          <span class="col"><span class="name">${esc(a.slug)}</span>
          <span class="desc">${esc(a.description || originLine(a, toolNameOf))}</span></span>
          <span class="row-tool">${tool
    ? (iconSvg(iconKeyFor(tool) || '') || '') + '<span>' + esc(toolNameOf(tool)) + '</span>'
    : '<span>no tool for it</span>'}</span>
          <span class="chev" role="button" tabindex="0" title="${isMaster(a) ? 'Run it on another tool' : 'Where this agent can run'}">›</span>`;
        row.onclick = (e) => {
          if (e.target.closest('.chev')) { openToolList(a); return; }
          if (tool) launchAgent(a, tool);
          else toast(`Nothing installed can run ${a.slug}.`);
        };
        list.appendChild(row);
        if (o.open === a.slug) {
          const wrap = document.createElement('div');
          wrap.innerHTML = toolListHtml(a);
          const block = wrap.firstElementChild;
          block.querySelectorAll('.tool-row[data-tool]').forEach((tr) => {
            tr.onclick = () => { rememberTool(a, tr.dataset.tool); o.open = null; o.delivery = null; renderOverlay(); };
            tr.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); tr.click(); } };
          });
          const cp = block.querySelector('[data-copy]');
          if (cp) {
            cp.onclick = () => copyToMaster(a);
            cp.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); cp.click(); } };
          }
          list.appendChild(block);
        }
      });
    });
  }

  // ---- create an agent or a skill (Library ＋ buttons) ------------------------
  // An agent takes three steps, one decision each: where it lives, whose it is,
  // what it is. A skill takes one sheet, because two of those three questions have
  // no honest answer for it — its content is identical whichever agent follows it,
  // and it can only be announced to agents that open this folder. See
  // renderCreateSkill below.
  //
  // Same overlay type throughout, so the sheet holds its place and does not replay
  // its entrance between steps. State lives on S.overlay and the sheet is rebuilt
  // on every change, so inputs must be flushed into it before any re-render — same
  // discipline as the connect flow.
  // One screen for everything. The brand question died with the drawers: a new
  // agent is a master in agents/ (Builds 1–2 made that the answer), a new skill
  // is a folder in skills/ — nothing left to ask but "what is it?".
  function openCreate(kind) {
    S.overlay = { type: 'create', kind, platform: kind === 'agent' ? 'project' : 'claude',
      scope: 'project', name: '', desc: '' };
    renderOverlay(); if (!S.agents) refreshAgents();
  }
  function createHeadHtml(o) {
    return `<div class="picker-input"><span class="prompt-mark">＋</span>
      <span style="font-weight:700">New ${esc(o.kind)}</span>
      <span class="ni-step">one screen</span></div>`;
  }
  function renderCreateSheet() { return renderCreateStep3(S.overlay); }
  // Who ends up knowing about a new skill or agent: only the CLIs we actually
  // write to (receivers.mjs). Skills are announced in AGENTS.md; agents are copies.
  function knowsLine(kind) {
    const text = knowsCopy({
      kind,
      installed: installedAgentIds(),
      nameOf: agentNameOf,
      stubCount: stubCount(),
    });
    return text ? esc(text) : '';
  }
  function stubCount() {
    return (S.agents || []).filter((a) => a.found && a.contextFile && a.contextFile !== 'AGENTS.md').length;
  }
  function renderCreateStep3(o) {
    const worker = chosenAgent(o);
    // the path already says which platform and whose it is — repeating them just wraps the line
    const dir = shortHome(targetDirFor({ type: o.kind, platform: o.platform, scope: o.scope, projectPath: S.project && S.project.path }));
    const skill = o.kind === 'skill';
    // The description placeholder is two paragraphs: a worked example, then the
    // reason the box is big. &#10; keeps the break inside the attribute.
    const descPh = 'e.g. keeps the README honest after a batch of features lands: reads the merged'
      + ' diffs, rewrites the affected doc sections, and flags anything it isn’t sure about.'
      + '&#10;&#10;The more you write here, the better the first draft.';
    const modal = overlay('picker-box create', `${createHeadHtml(o)}
      <div class="ni-ask">What is it?</div>
      <div class="ni-field">
        <input id="ni-name" placeholder="Name your ${skill ? 'skill' : 'agent'}" value="${esc(o.name)}" /></div>
      <div class="ni-field"><span class="lbl">What should it do?</span>
        <textarea id="ni-desc" placeholder="${descPh}">${esc(o.desc)}</textarea></div>
      <div class="ni-where">it lands in <b>${esc(dir)}</b></div>
      ${knowsLine(o.kind) ? `<div class="ni-where ni-knows">${knowsLine(o.kind)}</div>` : ''}
      <div class="ni-agent" style="margin:10px 18px 0">${worker
    ? `a new session with <select class="agent-pick" id="ni-agent-sel">${agentOptionsHtml(worker.id)}</select> builds it with you`
    : 'No agent is installed yet. Press ⌘N to add one first.'}</div>
      <div class="ni-row ni-actions"><button class="btn btn--go" id="ni-create" ${worker ? '' : 'disabled'}>Build it with my agent</button>
        <span class="action" id="ni-blank" role="button" tabindex="0">write it myself</span></div>`, { top: true });
    const nameInput = q('#ni-name', modal), descInput = q('#ni-desc', modal);
    const keep = () => { o.name = nameInput.value; o.desc = descInput.value; };
    // agent detection can land mid-typing and re-render this sheet; keeping o in sync on every
    // keystroke means a rebuild never eats what was typed.
    nameInput.oninput = keep; descInput.oninput = keep;
    const agentSel = q('#ni-agent-sel', modal);
    if (agentSel) agentSel.onchange = () => { o.workerId = agentSel.value; };
    if (!o.focused) { o.focused = true; setTimeout(() => descInput.focus(), 30); }
    q('#ni-create', modal).onclick = () => {
      keep();
      const w = chosenAgent(o);
      if (!o.desc.trim()) { toast('Describe what it should do first.'); return; }
      if (!w) { toast('No agent is installed yet. Press ⌘N to add one first.'); return; }
      if (!S.project) { toast(`Open a folder first — ${skill ? 'skills' : 'agents'} live in the project.`); return; }
      const seed = buildCreateSeed({ type: o.kind, platform: o.platform, scope: o.scope, name: o.name, desc: o.desc, projectPath: S.project && S.project.path });
      closeOverlay();
      // The agent writes the file, so the follow-through can only run afterwards.
      // On exit is the honest moment; and if the session never exits, the rail
      // still shows the item, just not yet announced or delivered.
      const onExit = o.kind === 'skill'
        ? () => { loadLibrary(true); api.pointerWrite({ dir: S.project.path, agentIds: installedAgentIds() }).then(() => refreshPointer(true)); }
        : () => { loadLibrary(true); api.deliverAgents({ projectPath: S.project.path, agentIds: installedAgentIds() }); };
      agentSession(w, { title: 'build: ' + (o.name.trim() || o.kind), code: 'BD', seed, onExit });
      toast('Your agent has a few questions first — check the new tile.');
    };
    const blankLink = q('#ni-blank', modal);
    blankLink.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); blankLink.onclick(); } });
    blankLink.onclick = async () => {
      keep();
      if (!o.name.trim()) { toast('Give it a name first.'); return; }
      if (!S.project) { toast(`Open a folder first — ${skill ? 'skills' : 'agents'} live in the project.`); return; }
      const res = await api.libraryCreate({ projectPath: S.project.path, type: o.kind, platform: o.platform, scope: o.scope, name: o.name.trim(), agentIds: installedAgentIds() });
      if (!res.ok) { toast(res.error || 'Could not create'); return; }
      closeOverlay();
      // An item nobody has been told about is just a file. Announce or deliver
      // in the same breath as writing it, or "write it myself" leaves you half done.
      if (o.kind === 'skill') {
        const w = await api.pointerWrite({ dir: S.project.path, agentIds: installedAgentIds() });
        toast(w && w.ok ? `Created ${o.name.trim()} — ${(w.written || []).length ? w.written.join(', ') + ' updated' : 'already announced'}.` : 'Created ' + o.name.trim());
        refreshPointer(true);
      } else {
        const copies = (res.delivered || []).filter((r) => r.ok && r.file).length;
        toast(`Created ${o.name.trim()}${copies ? ` — ${copies} ${copies === 1 ? 'copy' : 'copies'} delivered` : ''}.`);
      }
      S.railTab = 'library'; loadLibrary(true).then(() => renderRail());
      openCard(res.item);
    };
    // The description is a writing box now, so Enter belongs to it: a newline,
    // never a submit — Enter-submits was the reason it could never grow. Build
    // is ⌘/Ctrl+Enter from either field; a bare Enter on the name still just
    // moves you into the description.
    const submitKey = (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey);
    nameInput.addEventListener('keydown', (e) => {
      if (submitKey(e)) { e.preventDefault(); q('#ni-create', modal).onclick(); return; }
      if (e.key === 'Enter') { e.preventDefault(); descInput.focus(); }
    });
    descInput.addEventListener('keydown', (e) => {
      if (submitKey(e)) { e.preventDefault(); q('#ni-create', modal).onclick(); }
    });
  }

  // ---- improve an existing library item with the user's own agent ------------
  function openImproveItem(item) { S.overlay = { type: 'improve-item', item, text: '' }; renderOverlay(); if (!S.agents) refreshAgents(); }
  function renderImproveItem() {
    const o = S.overlay, item = o.item;
    const worker = chosenAgent(o);
    const TYPE_CHIP = getTypeChip();
    const modal = overlay('setup-box', `
      <div class="setup-head"><span class="code" data-kind="${esc((TYPE_CHIP[item.type] || TYPE_CHIP.agent).kind)}">${esc(code2(item.name))}</span>
        <span class="col"><span class="name">Improve ${esc(item.name)}</span><span class="desc">${esc(item.platform + ' ' + item.type)}</span></span></div>
      <input class="text-input" id="imp-ask" placeholder="what should change? e.g. give it a real description and sharper instructions" spellcheck="false" />
      <div class="ni-agent">${worker
    ? `a new session with <select class="agent-pick" id="imp-agent">${agentOptionsHtml(worker.id)}</select> edits it for you`
    : 'No agent is installed yet. Press ⌘N to add one first.'}</div>
      <div class="setup-actions" style="margin-top:12px"><button class="btn btn--go" id="imp-go" ${worker ? '' : 'disabled'}>Go</button></div>`);
    const input = q('#imp-ask', modal); input.value = o.text; setTimeout(() => input.focus(), 30);
    input.oninput = () => { o.text = input.value; };
    const agentSel = q('#imp-agent', modal);
    if (agentSel) agentSel.onchange = () => { o.workerId = agentSel.value; };
    const go = () => {
      const w = chosenAgent(o);
      if (!o.text.trim() || !w) { if (!o.text.trim()) toast('Say what should change first.'); return; }
      closeOverlay();
      // An improved master must reach every tool's copy the moment the session
      // ends — the same on-exit rhythm the skills pointer uses.
      const onExit = item.type === 'agent' && item.platform === 'project' && S.project
        ? () => { loadLibrary(true); api.deliverAgents({ projectPath: S.project.path, agentIds: installedAgentIds() }); }
        : undefined;
      agentSession(w, { title: 'improve: ' + item.slug, code: 'IM', seed:
        buildImproveSeed({ platform: item.platform, type: item.type, filePath: item.filePath, ask: o.text }), onExit });
      toast('Your agent is on it. Reopen the card when it finishes.');
    };
    q('#imp-go', modal).onclick = go;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }

  // ---- connect a service ------------------------------------------------------
  // Three small sheets: pick a card, paste one key, see it proven. Copy follows
  // the approved mockup and never assumes which agent the user runs.
  let mcpUi;
  function mcpSetup() {
    if (!mcpUi) mcpUi = createMcpSetup({
      state: S, overlay, q, esc, api, toast, closeOverlay, renderOverlay,
      refreshServices, refreshAgents, loadLibrary, installedAgentIds,
      chosenAgent, agentOptionsHtml, agentSession, bestAgent, startPanel, shortHome, agentNameOf,
    });
    return mcpUi;
  }
  function openConnect() { mcpSetup().openConnect(); }
  // The "already have it" door: an address, a command line, or a .mcpb bundle.
  // All three end as one master entry, then copied into each CLI notebook we can write.
  function openConnectOwn() { return mcpSetup().openConnectOwn(); }
  function openServiceDetails(sv) { return mcpSetup().openServiceDetails(sv); }
  // The factory is the user's own agent, whichever one they have installed.
  function bestAgent() {
    const ready = (S.agents || []).filter((a) => a.found);
    return ready[0] || null; // registry order: claude, codex, opencode, gemini, hermes, kimi
  }
  // Session selector shared by every handoff sheet: the user picks which
  // installed agent does the work; default is the first detected.
  function agentOptionsHtml(selectedId) {
    const ready = (S.agents || []).filter((a) => a.found);
    return ready.map((a) => `<option value="${esc(a.id)}"${a.id === selectedId ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
  }
  function chosenAgent(o) {
    const ready = (S.agents || []).filter((a) => a.found);
    return ready.find((a) => a.id === (o && o.workerId)) || ready[0] || null;
  }
  function agentSession(worker, opts) {
    // A flow names its session for a reason ("build: dark mode") — that name
    // outranks the ones guessed later, and rides down into claude itself.
    startPanel(Object.assign({ kind: worker.kind === 'claude' ? 'claude' : 'run',
      titleSource: 'flow',
      command: worker.kind === 'claude' ? undefined : worker.bin }, opts));
  }

  // ---- quick start -----------------------------------------------------------
  //
  // The one place in the window that answers "what is this and what do I do now".
  // KingAgent had no such place: the Help menu is five outbound links, and the person
  // this is for does not look in the menu bar.
  //
  // A checklist, not a tour. Coach marks have to be maintained across four themes
  // and every layout change, they get skipped, and they teach before anyone has a
  // reason to care — VS Code and Zed both landed on a resumable list instead.
  // Every button here does the real thing rather than describing it, and rows
  // tick off as they are done so leaving and coming back keeps your place.
  // The Supademo walk-throughs the rows link to. Empty until each one is
  // recorded, and a row only grows its Watch button once its URL is filled in —
  // a "▶ Watch · 2 min" that plays nothing is a worse promise than no button.
  // Paste a URL here and the button appears; nothing else needs touching.
  const DEMOS = {
    'getting-started': '',   // first launch → folder → agent → first ask → approve
    'a-real-job': '',        // plain English in, two panes running, a file out
  };
  const QS_DONE = 'kingagent-quickstart-done';
  function qsDone() {
    try { return new Set(JSON.parse(localStorage.getItem(QS_DONE) || '[]')); } catch { return new Set(); }
  }
  function qsMark(n) {
    const done = qsDone(); done.add(n);
    try { localStorage.setItem(QS_DONE, JSON.stringify([...done])); } catch { /* private mode */ }
  }
  function openQuickStart() { rememberHelpFocus(); S.overlay = { type: 'quickstart' }; renderOverlay(); }

  function quickStartRows() {
    return [
      {
        n: 1, title: 'Pick one folder to work in',
        sub: 'KingAgent only ever looks inside it. No folder yet? It will make you one.',
        done: !!S.project,
        acts: S.project ? [] : [{ label: 'Make me a folder', go: true, run: () => { closeOverlay(); makeFolderDialog(); } }],
      },
      {
        n: 2, title: 'Press New session and pick who runs it',
        sub: 'The list shows what is on your Mac. Anything missing installs from the same list.',
        acts: [
          { label: 'New session ⌘N', go: true, run: () => { closeOverlay(); openLauncher(); } },
          { label: '▶ Watch · 2 min', play: 'getting-started' },
        ],
      },
      {
        n: 3, title: 'KingAgent can run multiple agents for you',
        sub: 'Claude Code signs in with your Claude account, Codex with your ChatGPT one. No KingAgent account, no second bill.',
        acts: [{ label: 'Which should I pick?', run: () => api.openUrl(DOCS.pickAgent) }],
      },
      {
        n: 4, title: 'Say what you need, in plain English',
        sub: 'No commands to learn. Here are twelve things people actually ask for.',
        acts: [
          { label: 'See 12 examples', run: () => api.openUrl(DOCS.examples) },
          { label: '▶ Watch · 60s', play: 'a-real-job' },
        ],
      },
      {
        n: 5, title: 'It asks before it does anything real',
        sub: 'An amber “Needs your OK” card means it is waiting on you. Nothing happens behind your back.',
        acts: [{ label: 'How permissions work', run: () => api.openUrl(DOCS.permissions) }],
      },
      {
        n: 6, title: 'Open what your agent makes',
        sub: OPEN_OUTPUT_COPY,
        acts: [{ label: '⌘ Shortcuts & gestures', run: () => openSettings('shortcuts') }],
      },
    ];
  }

  function renderQuickStart() {
    const done = qsDone();
    const rows = quickStartRows();
    const body = rows.map((r) => {
      const ticked = r.done || done.has(r.n);
      // A demo that has not been recorded yet simply is not offered.
      const shown = r.acts.filter((a) => !a.play || DEMOS[a.play]);
      const acts = shown.length
        ? `<div class="qs-acts">${shown.map((a) =>
          `<button class="qs-mini${a.go ? ' qs-mini--go' : ''}${a.play ? ' qs-mini--play' : ''}" data-row="${r.n}" data-act="${r.acts.indexOf(a)}">${esc(a.label)}</button>`).join('')}</div>`
        : '';
      return `<div class="qs-row"${ticked ? ' data-done' : ''}>
        <div class="qs-n">0${r.n}</div>
        <div><div class="qs-t">${esc(r.title)}</div>
        <div class="qs-s">${esc(r.sub)}</div>${acts}</div></div>`;
    }).join('');

    const modal = overlay('qs-box', `<div class="qs-head"><span class="title">Quick start</span></div>
      <div class="qs-body">${body}</div>
      <div class="qs-foot"><span>Stuck? <a class="qs-link" href="#" data-url="${REPO_URL}/issues">Ask on GitHub</a></span>
      <a class="qs-link" href="#" data-url="${DOCS.start}">Full guide ↗</a></div>`, { top: true });

    wireHelpDialog(modal);
    modal.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const row = rows.find((r) => r.n === +b.dataset.row);
        const act = row && row.acts[+b.dataset.act];
        if (!act) return;
        qsMark(row.n);
        if (act.play) { api.openUrl(DEMOS[act.play]); return; }
        act.run();
      };
    });
    modal.querySelectorAll('.qs-link[data-url]').forEach((el) => {
      el.onclick = (e) => { e.preventDefault(); api.openUrl(el.dataset.url); };
    });
  }

  // ---- folders ---------------------------------------------------------------
  // A file opened with KingAgent from Finder. Either it already lives on this desk —
  // then it is just a tile — or the desk has to change folders first. That switch
  // is the one the user is allowed to refuse, so the file waits in S.pendingOpen
  // until the answer is known rather than being forced onto a foreign desk.
  // See src/main/open-with.js for how the window and folder were chosen.
  async function receiveOpenFile(ev) {
    if (!ev || !ev.filePath) return;
    // The launcher is what an empty desk shows. A file answers the question it
    // was asking, so it gets out of the way rather than covering the tile.
    if (S.overlay && S.overlay.type === 'launcher') closeOverlay();
    if (!ev.adopt) return openFile(ev.filePath, { pin: true });
    S.pendingOpen = ev.filePath;
    const info = await api.openFolder(ev.folder, false);
    if (!info || info.missing) {
      S.pendingOpen = null;
      toast('Could not open ' + tailPath(ev.folder) + '.');
      return;
    }
    await switchToFolder(info);
  }

  // Called from every path that ends with the desk standing on the right folder.
  async function drainPendingOpen() {
    const file = S.pendingOpen;
    if (!file) return;
    S.pendingOpen = null;
    await openFile(file, { pin: true });
  }

  async function openFolderDialog() { const info = await api.pickFolder(); if (info) await switchToFolder(info); }
  async function openFolder(path) {
    // Read it, don't adopt it — switchToFolder may still route this folder to a
    // new window, and a switch that never happens must leave Recents untouched.
    const info = await api.openFolder(path, false);
    if (!info) return;
    if (info.missing) { toast('That folder has moved or been deleted.'); return; }
    await switchToFolder(info);
  }
  // This window is now that folder's window: main bumps Recents and records the
  // folder for restore. Called only once a switch is actually going through.
  function adoptFolder(info) { return api.openFolder(info.path); }

  // A window is one folder, so changing the folder has to change the desk with
  // it. Without this the tiles from the folder you left stay on screen under the
  // new name, keep running in the old cwd, and the next savePanels() writes them
  // over the incoming folder's remembered desk.
  async function switchToFolder(info) {
    if (!info) return;
    if (S.project && S.project.path === info.path) { await adoptFolder(info); applyProject(info); await drainPendingOpen(); return; }
    // Nothing on the desk yet — nothing to preserve, so this is just an open.
    if (!S.project && !S.panels.length) { await adoptFolder(info); applyProject(info); await restoreDeskFor(info.path); await drainPendingOpen(); return; }
    // Live work is never torn down to make room. Offer it a window of its own
    // instead — the same ⧉ the popover already has, just asked for at the right
    // moment.
    const live = S.panels.filter((p) => isSessionPanel(p) && p.status === 'live' && !p.exited);
    if (live.length) { openSwitchChoice(info, live); return; }
    await swapDesk(info);
  }

  // Save → clear → restore, in that order. The save has to name the *outgoing*
  // folder explicitly: savePanels() reads S.project, which is about to change.
  async function swapDesk(info) {
    for (const p of S.panels) if (p.kind === 'browser' && browsers.hasPending(p) && !await browsers.canClose(p)) return;
    const from = S.project ? S.project.path : null;
    // flushPanels() itself clears the pending debounce before writing.
    await flushPanels(from);
    clearDesk();
    await adoptFolder(info);
    applyProject(info);
    await restoreDeskFor(info.path);
    await drainPendingOpen();
  }

  // Tear the desk down without the confirm prompts closePanel() runs — the caller
  // has already established there is nothing live and nothing unsaved to lose.
  function clearDesk() {
    for (const p of S.panels) if (isSessionPanel(p)) api.termKill({ id: p.id });
    for (const [, t] of tiles) { if (t.disposeRo) t.disposeRo(); if (t.disposeBrowser) t.disposeBrowser(); t.root.remove(); }
    tiles.clear();
    S.panels = []; S.activeId = null; S.expandedId = null;
    browsers.clearNotes(); browsers.decorate();
  }

  async function restoreDeskFor(folder) {
    let snaps;
    try { snaps = await api.loadPanels(folder); } catch (_) { snaps = []; }
    if (Array.isArray(snaps) && snaps.length) await restorePanels(snaps);
    else renderAll();
  }

  // The launcher's sheet, reused: two exits, neither of which destroys anything.
  function openSwitchChoice(info, live) {
    S.overlay = { type: 'switch-folder', info, live };
    renderOverlay();
  }
  function renderSwitchChoice() {
    const { info, live } = S.overlay;
    const rows = live.slice(0, 4).map((p) => `<div class="sw-live"><span class="mark">✳</span><span>${esc(p.title)}</span></div>`).join('');
    const more = live.length > 4 ? `<div class="sw-live"><span class="mark"> </span><span>and ${live.length - 4} more</span></div>` : '';
    const modal = overlay('switch-box', `
      <div class="modal-head"><div class="title">${esc(S.project ? S.project.name : 'This folder')} still has work running</div></div>
      <div class="sw-body">${live.length === 1 ? 'A session is' : live.length + ' sessions are'} live on this desk. Opening
        ${esc(info.name)} here would leave ${live.length === 1 ? 'it' : 'them'} running with no window to watch from.</div>
      <div class="sw-list">${rows}${more}</div>
      <div class="sw-acts">
        <button class="btn btn--go" id="sw-win">⧉ Open ${esc(info.name)} in a new window</button>
        <button class="btn" id="sw-stay">Stay here</button>
      </div>
      <div class="sw-hint">${esc(info.name)} opens with its own desk. Nothing here is touched.</div>`);
    // The file follows the folder: it was opened for that folder, not this desk.
    q('#sw-win', modal).onclick = () => { const file = S.pendingOpen; S.pendingOpen = null; closeOverlay(); api.newWindow(info.path, file); };
    q('#sw-stay', modal).onclick = () => {
      // Staying means the file is not opened. Say so — a Finder double-click that
      // visibly does nothing reads as a broken app.
      if (S.pendingOpen) { toast(baseNameOf(S.pendingOpen) + ' stayed closed — this desk has work running.'); S.pendingOpen = null; }
      closeOverlay();
    };
    q('#sw-win', modal).focus();
  }

  function applyProject(info) {
    S.project = info; S.tree = {}; S.expanded = new Set();
    S.library.loaded = false; S.library.items = []; S.library.edges = [];
    S.library.macLoaded = false; S.library.macLoading = false; S.library.macGen += 1;
    // The pointer belongs to a folder, so the old folder's answer must not be
    // shown against the new one — clear it and let the next scan refill it.
    S.pointer = null;
    S.recents = [{ path: info.path, pathShort: info.pathShort, name: info.name, at: Date.now(), pinned: !!(S.recents.find((r) => r.path === info.path) || {}).pinned },
      ...S.recents.filter((r) => r.path !== info.path)];
    S.tree[info.path] = info.tree && info.tree.length && info.tree[0].path ? info.tree : null;
    // load root level fresh for the explorer
    api.listDir(info.path, S.treeAll).then((rows) => { S.tree[info.path] = rows; if (S.railTab === 'workspace') refreshRail(); });
    watchProject();
    refreshServices();
    renderAll();
  }

  return {
    openLauncher, openAgentSheet, openAgentRemove, openAgentPicker, refreshAgentStatus, refreshAgents,
    runCommandFinished, openImproveItem, openCreate, openQuickStart,
    openFolderDialog, openFolder, switchToFolder, receiveOpenFile,
    openConnect, openConnectOwn, openServiceDetails, launchAgent, pickerAgents, rowTool, openToolList,
    // renderOverlay's dispatch table stayed in app.js (see the top-of-file
    // note), so every sheet it routes to here has to come back out, the same
    // way renderSettings did for settings-panes.mjs.
    renderLauncher, renderFolderFirst, renderAgentSetup, renderAgentRemove,
    renderAgentPickerSheet, renderCreateSheet, renderImproveItem, renderSwitchChoice,
    renderQuickStart, mcpSetup,
  };
}
