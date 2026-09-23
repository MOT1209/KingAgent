// Minimal Agent Platform UI (Phase 2 foundation, Phase 3 activity view).
//
// A self-contained floating panel: list agents, kick off a task, watch live
// events and tasks stream in. Deliberately not wired into the desk layout or
// panels system — that redesign is out of scope. It mounts on its own node,
// subscribes to the preload's onPlatformEvent stream, and fails closed if the
// main-process platform is not installed.
//
// Phase 3 adds the operational view: progress ticks, files changed, tools used,
// artifacts produced and approvals waiting. The event stream it renders from
// carries no private reasoning (the trace serializer strips it, and no event
// type has a field for it), and agent-activity.mjs renders only from a fixed
// vocabulary of operational facts — so this panel cannot start showing
// deliberation by accident.

import { reduceActivity, renderProgress, statusDot } from './agent-activity.mjs';
import { buildOrgTree, orgRows, agentDetail } from './agent-org.mjs';
import { mountResearch } from './research-panel.mjs';

const PANEL_CLASS = 'agent-platform-panel';

function mountAgentPlatform() {
  const api = window.kingagent && window.kingagent.agentPlatform;
  if (!api) return null; // platform not installed in this build

  const style = document.createElement('style');
  style.textContent = `
    .agent-platform-toggle { position: fixed; right: 14px; bottom: 14px; z-index: 9000;
      font: 12px/1 system-ui, sans-serif; padding: 8px 12px; border: 1px solid rgba(127,127,127,.4);
      border-radius: 999px; background: rgba(20,20,30,.85); color: #dfe3ff; cursor: pointer; }
    .agent-platform-panel { position: fixed; right: 14px; bottom: 52px; z-index: 9001;
      width: 380px; max-height: 60vh; display: flex; flex-direction: column;
      background: rgba(16,18,26,.96); border: 1px solid rgba(127,127,127,.35); border-radius: 12px;
      color: #dbe0ff; font: 12px/1.5 system-ui, sans-serif; box-shadow: 0 18px 60px rgba(0,0,0,.5); }
    .agent-platform-panel header { padding: 10px 14px; border-bottom: 1px solid rgba(127,127,127,.25);
      display: flex; justify-content: space-between; align-items: center; }
    .agent-platform-panel h1 { margin: 0; font-size: 13px; font-weight: 600; }
    .agent-platform-close { border: 0; background: transparent; color: #9aa; cursor: pointer; font-size: 14px; }
    .agent-platform-scroll { overflow-y: auto; padding: 10px 14px; }
    .agent-platform-panel section + section { margin-top: 14px; }
    .agent-platform-panel h2 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #9aa3c4; }
    .agent-platform-panel .row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; }
    .agent-platform-panel .muted { color: #8b93b8; }
    .agent-platform-panel .chip { border-radius: 999px; background: rgba(127,127,160,.16); padding: 1px 8px; font-size: 11px; }
    .agent-platform-panel input[type=text], .agent-platform-panel select {
      width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 8px;
      border: 1px solid rgba(127,127,160,.4); background: #10131c; color: #dfe3ff; margin: 4px 0; }
    .agent-platform-panel button.primary { width: 100%; padding: 7px; border: 0; border-radius: 8px;
      background: #4c5cff; color: #fff; cursor: pointer; margin-top: 6px; }
    .agent-platform-panel .events { font-size: 11px; font-family: ui-monospace, monospace; }
    .agent-platform-panel .events div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .agent-platform-panel .status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
      background: #5f677f; margin-right: 6px; }
    .agent-platform-panel .status-completed { background: #3ddc84; }
    .agent-platform-panel .status-failed, .agent-platform-panel .status-cancelled { background: #ff5f6d; }
    .agent-platform-panel .status-executing, .agent-platform-panel .status-analyzing,
    .agent-platform-panel .status-planning, .agent-platform-panel .status-queued,
    .agent-platform-panel .status-working { background: #ffcf5c; }
    .agent-platform-panel .progress { font-size: 11px; line-height: 1.7; }
    .agent-platform-panel .progress div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .agent-platform-panel .progress .done { color: #7fe0a6; }
    .agent-platform-panel .progress .failed { color: #ff8a94; }
    .agent-platform-panel .progress .running { color: #ffcf5c; }
    .agent-platform-panel .facts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .agent-platform-panel .approval { border: 1px solid rgba(255,207,92,.5); border-radius: 8px;
      padding: 6px 8px; margin-top: 6px; }
    .agent-platform-panel .approval .actions { display: flex; gap: 6px; margin-top: 6px; }
    .agent-platform-panel .approval button { flex: 1; padding: 4px; border: 0; border-radius: 6px; cursor: pointer; }
    .agent-platform-panel .approval .yes { background: #3ddc84; color: #04210f; }
    .agent-platform-panel .approval .no { background: #ff5f6d; color: #2a0206; }
    /* The organization view (§41/§42). Depth is indentation, so lineage reads
       without a graph widget; the tone is a colour per lifecycle state rather
       than a second vocabulary. */
    .agent-platform-panel .org-row { display: flex; align-items: center; gap: 6px; width: 100%;
      border: 0; background: transparent; color: inherit; text-align: left; padding: 3px 6px;
      border-radius: 6px; cursor: pointer; font: inherit; }
    .agent-platform-panel .org-row:hover { background: rgba(127,127,160,.14); }
    .agent-platform-panel .org-row[aria-current='true'] { background: rgba(76,92,255,.28); }
    .agent-platform-panel .org-row .grow { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-platform-panel .tone-done { background: #3ddc84; }
    .agent-platform-panel .tone-failed { background: #ff5f6d; }
    .agent-platform-panel .tone-working { background: #ffcf5c; }
    .agent-platform-panel .tone-waiting { background: #ffa45c; }
    .agent-platform-panel .tone-paused { background: #9aa3c4; }
    .agent-platform-panel .org-detail { border: 1px solid rgba(127,127,160,.35); border-radius: 8px;
      padding: 6px 8px; margin-top: 6px; }
    .agent-platform-panel .org-detail dl { margin: 0; display: grid;
      grid-template-columns: auto 1fr; gap: 2px 8px; }
    .agent-platform-panel .org-detail dt { color: #8b93b8; }
    .agent-platform-panel .org-detail dd { margin: 0; overflow-wrap: anywhere; }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'agent-platform-toggle';
  root.textContent = '🤖 Agent Platform';
  root.setAttribute('role', 'button');
  root.setAttribute('tabindex', '0');
  root.setAttribute('aria-expanded', 'false');
  document.body.appendChild(root);

  const panel = document.createElement('div');
  panel.className = PANEL_CLASS;
  panel.style.display = 'none';
  document.body.appendChild(panel);

  let tasks = [];
  let agents = [];
  let tools = [];
  let events = [];
  let rawEvents = [];
  let approvals = [];
  let selectedAgent = null;
  let open = false;

  function refreshTasks() {
    api.listTasks().then((rows) => { tasks = rows || []; render(); }).catch(() => {});
  }

  function refreshAgents() {
    api.listAgents().then((rows) => { agents = rows || []; render(); }).catch(() => {});
    api.listTools().then((rows) => { tools = rows || []; render(); }).catch(() => {});
  }

  function render() {
    if (!open) return;
    const statusColor = (s) => 'status-' + s;
    const tasksHtml = tasks.length
      ? tasks.map((t) => `<div class="row"><span><span class="status-dot ${statusColor(t.state)}"></span>${escapeHtml(t.request.slice(0, 60))}</span><span class="chip muted">${t.state}</span></div>`).join('')
      : '<div class="muted">No tasks yet.</div>';
    // The organization, not a list. Lineage comes from what the factory wrote
    // when it created the agent, so the tree is what actually happened rather
    // than what a layout inferred.
    const tree = buildOrgTree(agents);
    const orgHtml = orgRows(tree)
      .map((r) => `<button type="button" class="org-row" data-agent-id="${escapeHtml(r.id)}"
        ${r.id === selectedAgent ? 'aria-current="true"' : ''} style="padding-left:${6 + r.depth * 14}px">
        <span class="status-dot tone-${escapeHtml(r.tone)}"></span>
        <span class="grow">${r.system ? '★ ' : ''}${escapeHtml(r.name)}</span>
        <span class="chip muted">${escapeHtml(r.statusLabel)}</span>
      </button>`)
      .join('') || '<div class="muted">No agents registered.</div>';
    const selected = selectedAgent ? agents.find((a) => a.id === selectedAgent) : null;
    const detail = selected ? agentDetail({ agent: selected, tree }) : null;
    const detailHtml = detail ? `
      <div class="org-detail">
        <dl>
          <dt>Role</dt><dd>${escapeHtml(detail.role || '—')}</dd>
          <dt>Status</dt><dd>${escapeHtml(detail.statusLabel)}</dd>
          <dt>Parent</dt><dd>${detail.parent ? escapeHtml(detail.parent.name) : '—'}</dd>
          ${detail.children.length ? `<dt>Reported to it</dt><dd>${detail.children.map((c) => escapeHtml(c.name)).join(', ')}</dd>` : ''}
          <dt>Model</dt><dd>${escapeHtml(modelText(detail.model))}</dd>
          <dt>Tools</dt><dd>${escapeHtml(detail.tools.length ? detail.tools.join(', ') : '—')}</dd>
          ${detail.promoted ? '<dt>Promoted</dt><dd>kept as a reusable agent</dd>' : ''}
        </dl>
      </div>` : '';
    const toolsHtml = `<div class="muted">${tools.length} tools registered: ${tools.map((t) => t.id).join(', ')}</div>`;
    const eventsHtml = events.slice(-12).map((e) => `<div>${escapeHtml(e.type)}</div>`).join('');

    // The Phase 3 operational view, folded from the same event stream.
    const activity = reduceActivity(rawEvents);
    const progressHtml = renderProgress(activity)
      .map((row) => {
        const cls = row.startsWith('✓') ? 'done' : row.startsWith('✗') ? 'failed' : 'running';
        return `<div class="${cls}">${escapeHtml(row)}</div>`;
      })
      .join('') || '<div class="muted">Nothing running.</div>';

    const factsHtml = [
      activity.filesChanged ? `${activity.filesChanged} file${activity.filesChanged === 1 ? '' : 's'} changed` : null,
      activity.tools.length ? `Tools: ${activity.tools.join(', ')}` : null,
      activity.artifacts.length ? `Artifacts: ${activity.artifacts.map((a) => a.name).join(', ')}` : null,
      activity.delegations.length ? `Delegated to ${activity.delegations.map((d) => d.to).join(', ')}` : null,
      activity.memories ? `${activity.memories} memor${activity.memories === 1 ? 'y' : 'ies'} kept` : null,
      activity.currentStep ? `Current step: ${activity.currentStep}` : null,
    ].filter(Boolean).map((f) => `<span class="chip">${escapeHtml(f)}</span>`).join('');

    const approvalsHtml = approvals.length
      ? approvals.map((a) => `
        <div class="approval" data-approval="${escapeHtml(a.id)}">
          <div>${escapeHtml(a.summary || a.action)}</div>
          <div class="muted">risk: ${escapeHtml(a.risk || 'unknown')}</div>
          <div class="actions">
            <button class="yes" data-decide="approve">Approve</button>
            <button class="no" data-decide="reject">Reject</button>
          </div>
        </div>`).join('')
      : '';

    const streamHtml = activity.lines.slice(-14)
      .map((l) => `<div>${escapeHtml(l.text)}</div>`).join('')
      || '<div class="muted">No activity yet.</div>';

    panel.innerHTML = `
      <header><h1>Agent Platform</h1><button class="agent-platform-close" title="Close">✕</button></header>
      <div class="agent-platform-scroll">
        <section>
          <h2>New task</h2>
          <select id="ap-agent"></select>
          <input type="text" id="ap-request" placeholder="Describe a task — e.g. scan this workspace" />
          <button class="primary" id="ap-run">Run task</button>
        </section>
        <section>
          <h2><span class="status-dot status-${escapeHtml(statusDot(activity.status))}"></span>Progress</h2>
          <div class="progress">${progressHtml}</div>
          <div class="facts">${factsHtml}</div>
        </section>
        ${approvals.length ? `<section><h2>Approvals</h2>${approvalsHtml}</section>` : ''}
        <section class="events"><h2>Activity</h2>${streamHtml}</section>
        <section><h2>Tasks</h2><div id="ap-tasks">${tasksHtml}</div></section>
        <section><h2>Agents</h2>${orgHtml}${detailHtml}</section>
        <section><h2>Tools</h2>${toolsHtml}</section>
        <section class="events"><h2>Events</h2>${eventsHtml || '<div class="muted">Listen in live…</div>'}</section>
      </div>`;

    // The research section is a *live* node, not part of the innerHTML rebuild
    // above: it owns its own event subscription and poll, and re-creating it on
    // every render would restart both and lose whatever was on screen. So it is
    // built once and re-attached after each rebuild.
    attachResearch(panel.querySelector('.agent-platform-scroll'));

    // Selecting a node opens its detail panel. The click is the only thing this
    // list does: everything shown in the panel was folded from data the platform
    // already had.
    for (const row of panel.querySelectorAll('.org-row')) {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-agent-id');
        selectedAgent = selectedAgent === id ? null : id;
        render();
      });
    }

    for (const node of panel.querySelectorAll('.approval')) {
      const id = node.getAttribute('data-approval');
      for (const btn of node.querySelectorAll('button[data-decide]')) {
        btn.addEventListener('click', () => {
          const approved = btn.getAttribute('data-decide') === 'approve';
          if (typeof api.decideApproval === 'function') {
            api.decideApproval(id, approved, null).catch(() => {});
          }
          approvals = approvals.filter((a) => a.id !== id);
          render();
        });
      }
    }

    const sel = panel.querySelector('#ap-agent');
    if (sel) {
      for (const a of agents) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        opt.selected = a.id === 'coder';
        sel.appendChild(opt);
      }
    }
    const run = panel.querySelector('#ap-run');
    if (run) run.addEventListener('click', () => {
      const request = panel.querySelector('#ap-request').value.trim();
      if (!request) return;
      api.runTask({ request, agentId: sel ? sel.value : 'coder', workspace: null, mode: 'auto' }).catch((err) => pushEvent({ type: `task.error: ${err.message}` }));
      panel.querySelector('#ap-request').value = '';
    });
    panel.querySelector('.agent-platform-close').addEventListener('click', toggle);
  }

  // --- research (Phase 7) ----------------------------------------------------

  let researchSection = null;
  let researchView = null;

  function buildResearchSection() {
    const section = document.createElement('section');
    const heading = document.createElement('h2');
    heading.textContent = 'Research';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask a question — e.g. what transports does MCP support?';
    const controls = document.createElement('div');
    controls.className = 'facts';
    const go = document.createElement('button');
    go.className = 'primary';
    go.textContent = 'Research';
    const stop = document.createElement('button');
    stop.textContent = 'Cancel';
    stop.disabled = true;
    const host = document.createElement('div');

    const start = () => {
      const question = input.value.trim();
      if (!question || !researchView) return;
      stop.disabled = false;
      input.value = '';
      researchView.start(question).catch(() => {}).finally(() => { stop.disabled = !researchView.taskId; });
    };
    go.addEventListener('click', start);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
    stop.addEventListener('click', () => {
      if (researchView) researchView.cancel().catch(() => {});
      stop.disabled = true;
    });

    controls.append(go, stop);
    section.append(heading, input, controls, host);
    researchView = mountResearch(host, { api });
    // No research in this build: the section says so rather than offering a
    // button that does nothing.
    if (!researchView) host.innerHTML = '<div class="muted">Research is not available in this build.</div>';
    return section;
  }

  function attachResearch(scroll) {
    if (!scroll) return;
    if (!researchSection) researchSection = buildResearchSection();
    // Re-attaching moves the existing node; it is never rebuilt, so the live
    // view keeps its subscription and its state.
    scroll.appendChild(researchSection);
  }

  function pushEvent(ev) {
    events = events.concat([{ type: ev.type, ts: ev.timestamp }]);
    if (events.length > 200) events = events.slice(-200);
    // The activity reducer needs payloads, not just type names. Bounded the
    // same way, so a long session cannot grow the panel without limit.
    rawEvents = rawEvents.concat([ev]);
    if (rawEvents.length > 400) rawEvents = rawEvents.slice(-400);

    if (ev.type === 'approval.requested' && ev.payload) {
      approvals = approvals.concat([{
        id: ev.payload.requestId, action: ev.payload.action,
        summary: ev.payload.summary, risk: ev.payload.risk,
      }]);
    }
    if (['approval.approved', 'approval.rejected', 'approval.expired'].includes(ev.type) && ev.payload) {
      approvals = approvals.filter((a) => a.id !== ev.payload.requestId);
    }
    if (ev.type === 'task.completed' || ev.type === 'task.failed' || ev.type === 'task.cancelled') refreshTasks();
    // The research view has its own subscription and repaints itself; a full
    // panel render on every research tick would tear down and re-attach it
    // dozens of times per run for no benefit.
    if (!ev.type.startsWith('research.')) render();
  }

  function toggle() {
    open = !open;
    panel.style.display = open ? 'flex' : 'none';
    root.setAttribute('aria-expanded', String(open));
    if (open) { refreshAgents(); refreshTasks(); }
  }

  root.addEventListener('click', toggle);
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  api.onPlatformEvent(pushEvent);
  refreshAgents();
  if (typeof api.pendingApprovals === 'function') {
    api.pendingApprovals().then((rows) => { approvals = rows || []; render(); }).catch(() => {});
  }
  return { api, refresh: refreshTasks };
}

// A model is infrastructure, so it is shown as `provider/id` rather than as an
// object — and as an em dash when nothing is bound, which is a different fact
// from a model that failed to load.
function modelText(model) {
  if (!model) return '—';
  if (typeof model === 'string') return model;
  const parts = [model.provider, model.id].filter(Boolean);
  return parts.length ? parts.join('/') : '—';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export { mountAgentPlatform };