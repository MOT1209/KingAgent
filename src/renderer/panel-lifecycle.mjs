import { fileKind } from './file-kinds.mjs';
import { resolveOpen } from './peek-core.mjs';
import { isGenericTitle } from './session-name.mjs';
import { isOutsideProject } from './path-guard.mjs';
import { hashText } from './file-sync.mjs';
import { DOC_STEPS } from './tile-zoom.mjs';
import { isFile as isFilePanel, isSession as isSessionPanel, ownerFor, previewToReplace, keep as keepFile, orphan as orphanFiles, moveTo as moveFile, splitAfter, focusSplit, ownerIndexes, resolveOwners } from './desk-view.mjs';

// Extracted from app.js verbatim, as part of splitting that file into
// smaller feature modules.
//
// Every panel (session, editor, viewer, card) that can exist on the desk,
// from birth (startPanel/pinFilePanel/buildFilePanel) through persistence
// (panelSnapshot/savePanels/restorePanels) to death (closePanel).
export function createPanelLifecycle({ api, state, tiles, browsers, toast, uid, code2, baseNameOf, shortHome, q, shorten,
  renderGrid, renderRail, renderHeader, renderAll, syncSplitLayout, openPeek, openCard, refreshTileHead, clearAttention }) {
  const S = state;

  // ---- persistence: the layout survives restarts ---------------------------
  let saveTimer = null;
  function panelSnapshot() {
    // The size a card was dragged to belongs to every kind of tile, so it is
    // added here rather than inside each branch — five branches that each had to
    // remember is five places to forget.
    const size = (p) => {
      const o = { spanX: p.spanX, spanY: p.spanY };
      if(p.companionOf) { const index=S.panels.findIndex(x=>x.id===p.companionOf);if(index>=0)o.companionIndex=index; }
      if (isSessionPanel(p)) { o.imageAttachments = p.imageAttachments || []; }
      if (p.fontSize >= 10 && p.fontSize <= 18) o.fontSize = p.fontSize;
      if (DOC_STEPS.includes(p.docScale)) o.docScale = p.docScale;
      return o;
    };
    // A file names the session it belongs to by that session's position in this
    // list: ids are minted fresh on restore, positions are not (desk-view.mjs).
    const owners = ownerIndexes(S.panels);
    const own = (p) => (owners[p.id] === undefined ? {} : { ownerIndex: owners[p.id] });
    return S.panels.map((p) => {
      if (p.kind === 'browser') return { kind: 'browser', url: p.url, profileId:p.profileId, filePath: p.filePath, title: p.title, ...own(p), ...size(p) };
      if (p.kind === 'editor') return { kind: 'editor', filePath: p.filePath, ...own(p), ...size(p) };
      if (p.kind === 'viewer') return { kind: 'viewer', filePath: p.filePath, ...own(p), ...size(p) };
      if (p.kind === 'card') return { kind: 'card', item: p.item, ...own(p), ...size(p) };
      // A one-shot that has run comes back as a plain terminal, not as its
      // command. Restoring the command re-ran it: leave an install tile on the
      // desk, quit, and KingAgent piped curl into bash again on the next launch, and
      // the one after that. A session is worth restoring; an errand is not.
      if (p.oneShot && (p.commandDone || p.exited)) {
        return { kind: 'shell', title: p.title, titleSource: p.titleSource, code: p.code, chipKind: p.chipKind, cwd: p.cwd, ...size(p) };
      }
      return { kind: p.kind, title: p.title, titleSource: p.titleSource, code: p.code, chipKind: p.chipKind, cwd: p.cwd, command: p.command, program: p.program, args: p.args, sid: p.sid, acpSid: p.acpSid, oneShot: p.oneShot, agentId: p.agentId, watchDone: p.watchDone, ...size(p) };
    });
  }
  function savePanels() {
    if (S.demo) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.savePanels({ panels: panelSnapshot(), folder: S.project ? S.project.path : null });
    }, 400);
  }
  // Write the desk now, under a folder named by the caller. A folder switch can't
  // use savePanels(): it reads S.project, which is about to point somewhere else.
  function flushPanels(folder) {
    if (S.demo) return Promise.resolve();
    clearTimeout(saveTimer);
    return api.savePanels({ panels: panelSnapshot(), folder: folder || null });
  }
  async function restorePanels(snaps) {
    // Each claude panel resumes its own conversation by saved sid. Snapshots from
    // before sids existed can't be told apart, so only the newest of them may use
    // --continue (which always means "the most recent conversation in this cwd") —
    // giving it to all of them is exactly the everything-becomes-one-session bug.
    // A run panel (kimi, codex, …) resumes by its saved acpSid; main checks the
    // agent's store still holds that session and falls back to a fresh spawn.
    const newestLegacy = snaps.find((s) => s.kind === 'claude' && !s.sid);
    const restored = snaps.map(() => null); // snapshot position -> the panel it became
    // open* unshift; walk the list backwards so the restored order matches
    for (const [i, s] of [...snaps.entries()].reverse()) {
      try {
        // Every open* unshifts, so a tile that actually arrived is S.panels[0].
        // Reading the size back off that is exact whatever the kind, and does not
        // depend on five different functions agreeing to return their panel.
        const before = S.panels.length;
        if (s.kind === 'browser') browsers.open(s.url, s.filePath, null, null, true, s.profileId);
        else if (s.kind === 'editor') await openFile(s.filePath, { pin: true });
        else if (s.kind === 'viewer') await openFile(s.filePath, { pin: true });
        else if (s.kind === 'card' && s.item) await openCard(s.item, { pin: true });
        else if (s.kind === 'ai') continue; // retired session kind — nothing to bring back
        else if (s.kind) startPanel({ kind: s.kind, title: s.title, titleSource: s.titleSource, code: s.code, chipKind: s.chipKind, cwd: s.cwd, command: s.command, program: s.program, args: s.args, sid: s.sid, acpSid: s.acpSid, view: s.view, oneShot: s.oneShot, agentId: s.agentId, watchDone: s.watchDone, cont: s.kind === 'claude' ? (!!s.sid || s === newestLegacy) : !!s.acpSid });
        // A snapshot from before spans existed carries none, and a panel with no
        // span renders at the default. That is the whole of the migration.
        if (S.panels.length > before) {
          const n = S.panels[0];
          restored[i] = n;
          if (s.spanX || s.spanY) { n.spanX = s.spanX; n.spanY = s.spanY; }
          if (s.fontSize) n.fontSize = s.fontSize;
          if (s.docScale) n.docScale = s.docScale;
          if (isSessionPanel(n)) {
            n.imageAttachments = Array.isArray(s.imageAttachments) ? s.imageAttachments.filter((a) => a && typeof a.path === 'string' && typeof a.thumbnail === 'string').slice(0, 20) : [];
            const rec = tiles.get(n.id);
            if (rec?.refreshImages) rec.refreshImages();
          }
        }
      } catch (_) {}
    }
    for(let i=0;i<snaps.length;i++){const p=restored[i],owner=Number.isInteger(snaps[i]?.companionIndex)?restored[snaps[i].companionIndex]:null;if(p&&isSessionPanel(p)&&owner&&owner!==p&&isSessionPanel(owner))p.companionOf=owner.id;}
    resolveOwners(restored, snaps); // owners by position, now that every id exists
    browsers.restore();
    S.activeId = S.panels[0] ? S.panels[0].id : null;
    renderAll();
  }

  // Where a new panel's name stands on the ladder (session-name.mjs). Chat cards
  // are built by hand in the agent picker rather than through startPanel, so this
  // is the one place both go through — a card born "Claude Code" must be as
  // nameable as a tile born "Claude session".
  function seedTitleSource(p) {
    if (!['editor', 'viewer', 'card'].includes(p.kind) && isGenericTitle(p.title, (S.agents || []).map((a) => a.name))) {
      p.autoName = true;
      // A generic title cannot have come from a prompt or the agent, whatever a
      // snapshot says: desks saved before bare agent names counted as generic
      // stamped "Codex" as a prompt name, and that stamp tied with the first
      // real prompt. A flow's or your own name is never generic, so it is safe.
      p.titleSource = 'generic';
    } else p.titleSource = p.titleSource || 'prompt';
  }
  function startPanel(opts) {
    // Every session belongs to a folder. Without one the pty falls back to the
    // home directory (main.js term:create), which gives the agent the run of ~ and
    // files its transcript under a project slug no folder can ever resume from.
    // The launcher asks for a folder first; this is the backstop for every other
    // caller.
    const cwd = opts.cwd || (S.project && S.project.path);
    if (!cwd && !['editor', 'viewer', 'card'].includes(opts.kind || 'claude')) {
      toast('Open a folder first — sessions run inside one.');
      return null;
    }
    const p = Object.assign({
      id: uid('p_'), kind: 'claude', chipKind: opts.chipKind, code: opts.code || code2(opts.title || 'SS'),
      title: opts.title || 'Session', cwd, status: 'live',
      attention: false, exited: false, started: false, command: opts.command, program: opts.program, args: opts.args, seed: opts.seed, cont: opts.cont,
    }, opts);
    // Cards is retired. A desk saved with view:'cards' (or any leftover caller)
    // must open as a terminal, not a missing surface.
    if (p.view === 'cards') p.view = 'term';
    // A session born with a generic name ("Claude session") takes its name from
    // the first real prompt the user submits, then from claude itself. Only a
    // flow says 'flow' outright (agentSession) — everything else lands on the
    // weak sources, so a name KingAgent merely guessed is never pushed into claude,
    // and a snapshot saved before any of this existed stays upgradable.
    seedTitleSource(p);
    // Every claude panel owns a conversation id from birth (--session-id), so a
    // restore can bring back that conversation with --resume instead of --continue.
    // A cont-without-sid panel is the legacy --continue migration — minting an id
    // there would turn --continue into --resume <nothing> and break it.
    if (p.kind === 'claude' && !p.sid && !p.cont) p.sid = crypto.randomUUID();
    p.cwd = cwd; // an explicit `cwd: undefined` in opts must not beat the fallback
    S.panels.unshift(p); S.activeId = p.id; S.expandedId = null;
    if (S.view === 'split') { S.split = splitAfter({ ...S.split, panels: S.panels }, { type: 'select-session', id: p.id }); S.splitFull = null; }
    renderGrid(); renderRail(); renderHeader(); savePanels();
    return p;
  }
  const VIEWER_CODES = { image: 'IM', video: 'VI', audio: 'AU', pdf: 'PD', html: 'HT', other: 'FI' };
  function viewerPanel(filePath, sub, note) {
    return { id: uid('p_'), kind: 'viewer', sub, note, chipKind: 'viewer', code: VIEWER_CODES[sub] || 'VW', title: baseNameOf(filePath), filePath, status: 'live', cwd: S.project && S.project.path };
  }
  // Build the right panel for any path: media/pdf as viewer, text as editor,
  // unreadable/binary as an 'other' viewer card carrying the reason.
  async function buildFilePanel(filePath) {
    const kind = fileKind(filePath);
    // html is text underneath: it goes to the editor, which gives it the same
    // Read/Edit tabs markdown has — Read renders the page, Edit is the source.
    if (kind !== 'text' && kind !== 'html') return viewerPanel(filePath, kind);
    const res = await api.rawFile(filePath);
    if (!res.ok) return viewerPanel(filePath, 'other', res.error || 'Could not open');
    // lastHash from the read, not from a save: the first watcher event a file
    // provokes is often the one that opened it, and a panel should know its own
    // bytes from the moment it has them.
    return { id: uid('p_'), kind: 'editor', chipKind: 'editor', code: 'ED', title: baseNameOf(filePath), filePath, text: res.text, lastHash: hashText(res.text), dirty: false, status: 'live', cwd: S.project && S.project.path };
  }
  // A path that came from rendered content (a markdown link, a token printed in
  // the terminal) can point anywhere on disk. Opening one inside the project is
  // normal; opening one outside it asks first, so a benign-looking link can't
  // silently surface an SSH key or credentials file into a tile.
  function confirmOutsideOpen(abs) {
    if (!isOutsideProject(S.project && S.project.path, abs)) return true;
    return confirm('This file is outside your project:\n\n' + shortHome(abs) + '\n\nOpen it anyway?');
  }
  // Looking at a file floats it above the desk; only pinning (or an explicit
  // drop onto the desk, or restore-on-boot) makes it a tile.
  async function openFile(filePath, opts) {
    const r = resolveOpen(S.panels, 'file', filePath);
    if (r.action === 'focus') { const f = S.panels.find((x) => x.id === r.id); if (f && opts && opts.pin && !opts.preview) keepFile(f); focusPanel(r.id); return; }
    const p = await buildFilePanel(filePath);
    if (opts && opts.pin) pinFilePanel(p, opts);
    else openPeek(p);
  }
  // A file changes session by hand: right-click a file row or a file card's
  // head, or drag the row onto a session row. Null is the desk.
  function moveFileTo(p, ownerId) {
    if (!isFilePanel(p) || (p.owner || null) === (ownerId || null)) return;
    moveFile(p, ownerId);
    if (S.view === 'split') { S.split = splitAfter({ ...S.split, panels: S.panels }, { type: 'select-file', id: p.id }); S.splitFull = null; }
    refreshTileHead(p); renderGrid(); renderRail(); savePanels();
  }
  function moveMenu(p) {
    const items = [];
    for (const s of S.panels) {
      if (!isSessionPanel(s)) continue;
      const here = p.owner === s.id;
      items.push({ label: (here ? '● ' : 'Move to ') + shorten(s.title, 28), off: here, kb: here ? 'here' : '', run: () => moveFileTo(p, s.id) });
    }
    if (items.length) items.push('-');
    const loose = !p.owner || !S.panels.some((s) => s.id === p.owner && isSessionPanel(s));
    items.push({ label: loose ? '● Desk' : 'Move to desk', off: loose, kb: loose ? 'here' : '', run: () => moveFileTo(p, null) });
    return items;
  }
  // Every file that lands on the desk comes through here — the tree's pin, a
  // pinned peek, a card, a restore. It joins the session that is active
  // (desk-view.mjs decides which), and as a preview it takes the place of the
  // session's previous preview, so browsing ten files leaves one tab, not ten.
  function pinFilePanel(p, opts = {}) {
    const owner = opts.owner || ownerFor(S.panels, { activeId: S.activeId, view: S.view, sessionId: S.split.sessionId });
    if (owner) p.owner = owner; else delete p.owner;
    if (opts.preview) p.preview = true; else delete p.preview;
    const old = opts.preview ? previewToReplace(S.panels, owner, p) : null;
    if (old) closePanel(old.id, { silent: true });
    S.panels.unshift(p); S.activeId = p.id; S.expandedId = null;
    if (S.view === 'split') S.split = splitAfter({ ...S.split, panels: S.panels }, { type: 'open', id: p.id });
    renderGrid(); renderRail(); renderHeader(); savePanels();
  }
  function focusPanel(id, scroll = true, { preserveLayout = false } = {}) {
    if (preserveLayout && S.activeId !== id) return;
    S.activeId = id;
    if (S.view === 'split') {
      const p = S.panels.find((x) => x.id === id);
      if (p && !preserveLayout) {
        const next = focusSplit({ ...S.split, panels:S.panels }, id, S.splitFull);
        const changed = next.split.sessionId !== S.split.sessionId || next.split.fileId !== S.split.fileId || next.full !== S.splitFull;
        S.split = next.split; S.splitFull = next.full;
        if (changed) renderGrid();
        else { const pv = q('.paneview'); if (pv) syncSplitLayout(pv); }
      }
    }
    renderRail();
    for (const [pid, t] of tiles) t.root.classList.toggle('active', pid === id);
    const t = tiles.get(id); if (t) { const p = S.panels.find((x) => x.id === id); clearAttention(p); if (scroll) t.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); if (t.term) t.term.focus(); else if (t.aiInput) t.aiInput.focus(); else if (t.ta) t.ta.focus(); }
  }
  // A session panel's own opt-in for background-sessions.js: marks it with the
  // backend before the next close. `keepRunning` lives only on the in-memory
  // panel, not in the saved snapshot — it means nothing across a restart, since
  // a fresh launch has no live pty left to keep. The menu rebuilds itself from
  // this flag fresh on every right-click (session-menu.mjs), so no separate
  // repaint is needed. The backend call is fire-and-forget: term:set-persistent
  // only takes effect at the next close (see main.js), so there is nothing to
  // await here yet.
  function toggleKeepRunning(p) {
    p.keepRunning = !p.keepRunning;
    api.termSetPersistent({ id: p.id, persistent: p.keepRunning });
  }
  function closePanel(id, opts = {}) {
    const p = S.panels.find((x) => x.id === id); if (!p) return;
    if ((p.kind==='browser'||isSessionPanel(p)) && !opts.browserConfirmed && browsers.hasPending(p)) { browsers.canClose(p).then(ok=>{if(ok)closePanel(id,{...opts,browserConfirmed:true});}); return; }
    if (p.kind === 'browser') browsers.removeNotes(id); else if(isSessionPanel(p)&&browsers.hasPending(p)) browsers.clearNotes(p);
    if ((p.kind === 'editor' || p.kind === 'card') && p.dirty && !opts.silent && !confirm(`Discard unsaved changes to ${baseNameOf(p.filePath)}?`)) return;
    else if (!isFilePanel(p)) {
      // term:set-persistent already ran when the toggle was clicked; term:kill
      // reads that same flag on the main-process side and detaches instead of
      // killing. Nothing extra to do here — this stays the one call site.
      api.termKill({ id });
    }
    const t = tiles.get(id); if (t) { if (t.disposeRo) t.disposeRo(); if (t.disposeEditor) t.disposeEditor(); if (t.disposeBrowser) t.disposeBrowser(); t.root.remove(); tiles.delete(id); }
    S.panels = S.panels.filter((x) => x.id !== id);
    orphanFiles(S.panels, id); // a closed session's files stay, on the desk
    if (S.activeId === id) S.activeId = S.panels[0] ? S.panels[0].id : null;
    if (S.expandedId === id) S.expandedId = null;
    if (S.view === 'split') S.split = splitAfter({ ...S.split, panels: S.panels }, { type: 'close', id });
    if (opts.silent) return;
    renderGrid(); renderRail(); renderHeader(); savePanels();
  }
  function closeFinished() {
    const gone = S.panels.filter((p) => p.exited || (p.kind === 'editor' && !p.dirty && false));
    for (const p of gone) closePanel(p.id);
    if (!gone.length) toast('Nothing finished to close.');
  }
  function reorderPanels(fromId, toId) {
    if (!fromId || fromId === toId) return;
    const from = S.panels.findIndex((p) => p.id === fromId), to = S.panels.findIndex((p) => p.id === toId);
    if (from < 0 || to < 0) return;
    const [m] = S.panels.splice(from, 1); S.panels.splice(to, 0, m);
    renderGrid(); savePanels();
  }

  return {
    panelSnapshot, savePanels, flushPanels, restorePanels, seedTitleSource, startPanel, viewerPanel,
    buildFilePanel, confirmOutsideOpen, openFile, moveFileTo, moveMenu, pinFilePanel, focusPanel,
    toggleKeepRunning, closePanel, closeFinished, reorderPanels,
  };
}
