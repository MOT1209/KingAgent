// The shared conversation (§13/§38).
//
// The point of this view is that King does not have to think in rooms. One
// objective, one transcript: King asks, Ahmad plans, Rashid executes, specialists
// appear, tools run, something asks for approval, and the result comes back —
// in one readable flow rather than a chat window per agent.
//
// It is deliberately a view *beside* the tile workbench, not a replacement. The
// paper tiles are the shipped way to talk to a CLI directly; this is the way to
// watch an organization work. Neither is asked to be the other.
//
// Two rules decide what appears:
//
//   * **Every line is an event that really happened.** The transcript is folded
//     from the platform's event stream; there is no per-agent chat state, so the
//     conversation cannot drift from the run.
//   * **The vocabulary is the one that already exists.** Text comes from
//     `agent-activity.mjs`'s `describe()` — operational facts only (a step, a
//     tool, a file, an approval). No event type carries a model's deliberation,
//     and this view adds none.

import { describe as describeActivity } from './agent-activity.mjs';

// The organization's two named system agents, plus the human. A specialist is
// named by whatever the registry calls it; an agent the platform has never heard
// of is shown by id rather than hidden.
const SYSTEM_SPEAKERS = Object.freeze({
  king: { name: 'King', badge: '👑', kind: 'human' },
  ahmad: { name: 'Ahmad', badge: '🧠', kind: 'planner' },
  rashid: { name: 'Rashid', badge: '👨💻', kind: 'executive' },
});

const SYSTEM_KINDS = Object.freeze({
  tool: { name: 'Tools', badge: '⚙', kind: 'tool' },
  approval: { name: 'Approvals', badge: '✋', kind: 'approval' },
  system: { name: 'System', badge: '•', kind: 'system' },
});

// Who is speaking, for the events that are not attributable to an agent id.
//
// The rule is "who acted", not "who is mentioned": a plan is Ahmad's act, an
// approval decision is King's, and a lifecycle event with no agent is the
// platform talking about itself.
const BY_TYPE = Object.freeze({
  'run.started': { speaker: 'king', text: (e) => `Wants: ${e.payload.objective || e.payload.request || 'an objective'}` },
  'approval.requested': { speaker: 'system', text: (e) => `Waiting on King: ${e.payload.summary || e.payload.action || 'an approval'}` },
  'approval.required': { speaker: 'system', text: (e) => `Waiting on King: ${e.payload.summary || e.payload.action || 'an approval'}` },
  'approval.approved': { speaker: 'king', text: () => 'Approved' },
  'approval.rejected': { speaker: 'king', text: () => 'Rejected' },
  'agent.created': { speaker: 'rashid', text: (e) => `Created ${e.payload.name || e.payload.role || e.payload.agentId || 'an agent'}` },
  'agent.spawn.denied': { speaker: 'system', text: (e) => `Refused a spawn: ${e.payload.reason || e.payload.code || 'limits'}` },
  // The watchdog's stop. Worth a line of its own: a person watching needs to
  // know an agent was taken down on purpose, not that work quietly vanished.
  'agent.stopped': { speaker: 'system', text: (e) => `Stopped ${e.agentId || e.payload.agentId || 'an agent'}: ${e.payload.reason || e.payload.code || 'over its limits'}` },
  'run.completed': { speaker: 'system', text: () => 'Run complete' },
  'run.failed': { speaker: 'system', text: (e) => `Run failed: ${e.payload.error || ''}` },
});

// A plan is Ahmad's work whether or not the event names him. Two of these have
// no payload to phrase and are still worth a line — "Ahmad is planning" is a
// real beat in a conversation, and the alternative is a silent gap where the
// most important step happens.
const PLANNING_TYPES = Object.freeze({
  'task.planning': 'Planning the work',
  'task.analyzing': 'Analyzing the request',
  'task.replanned': 'Replanning',
  'task.plan.created': null, // phrased from the step count below
});

function agentTable(agents = []) {
  const table = new Map();
  for (const a of agents) {
    if (!a || typeof a.id !== 'string') continue;
    table.set(a.id, {
      name: a.name || a.id,
      badge: a.system ? (a.id === 'ahmad' ? '🧠' : a.id === 'rashid' ? '👨💻' : '★') : '◆',
      kind: a.system ? (a.id === 'ahmad' ? 'planner' : 'executive') : 'specialist',
    });
  }
  return table;
}

function speakerFor(event, table) {
  const id = event.agentId || (event.payload && (event.payload.createdBy || event.payload.from || event.payload.sender)) || null;
  if (id && SYSTEM_SPEAKERS[id]) return { id, ...SYSTEM_SPEAKERS[id] };
  if (id && table.has(id)) return { id, ...table.get(id) };
  if (id) return { id, name: id, badge: '◆', kind: 'specialist' };
  return { id: 'system', ...SYSTEM_KINDS.system };
}

// One event → one line, or nothing. Returning nothing for an event is normal:
// an event nobody decided how to phrase should stay out rather than appear as a
// raw type name a person has to decode.
function line(event, table) {
  if (!event || typeof event.type !== 'string') return null;
  const payload = event.payload || {};
  const mapped = BY_TYPE[event.type];

  if (mapped) {
    const actor = mapped.speaker === 'king' ? { id: 'king', ...SYSTEM_SPEAKERS.king }
      : mapped.speaker === 'rashid' ? { id: 'rashid', ...SYSTEM_SPEAKERS.rashid }
        : { id: 'system', ...SYSTEM_KINDS.system };
    return { speaker: actor, text: mapped.text({ ...event, payload }) };
  }

  if (event.type in PLANNING_TYPES) {
    const text = PLANNING_TYPES[event.type] || describeActivity({ ...event, payload });
    if (!text) return null;
    return { speaker: { id: 'ahmad', ...SYSTEM_SPEAKERS.ahmad }, text };
  }

  // A tool call is the acting agent using a tool: the agent is the speaker, the
  // tool is the sentence.
  if (event.type.startsWith('tool.')) {
    const speaker = speakerFor(event, table);
    const text = describeActivity({ ...event, payload });
    return text ? { speaker: { ...speaker, kind: 'tool' }, text } : null;
  }

  // An agent's own message is the most conversational thing in the stream and is
  // never rephrased.
  if (event.type === 'agent.message') {
    const text = payload.content || payload.text || '';
    if (!text) return null;
    return { speaker: speakerFor(event, table), text: String(text).slice(0, 4000) };
  }

  const text = describeActivity({ ...event, payload });
  if (!text) return null;
  return { speaker: speakerFor(event, table), text };
}

// Fold the stream into the transcript. Bounded from the end, because a long run
// produces a lot of lines and the recent ones are the ones a person is reading.
function foldConversation(events, { agents = [], max = 300 } = {}) {
  const table = agentTable(agents);
  const lines = [];
  for (const event of events || []) {
    const built = line(event, table);
    if (!built) continue;
    lines.push({
      id: event.id || `${event.type}-${lines.length}`,
      at: event.timestamp || event.at || null,
      type: event.type,
      speakerId: built.speaker.id,
      name: built.speaker.name,
      badge: built.speaker.badge || '',
      kind: built.speaker.kind || 'system',
      text: built.text,
      runId: event.runId || null,
      taskId: event.taskId || null,
    });
  }
  return lines.length > max ? lines.slice(-max) : lines;
}

// The thin DOM adapter: it renders lines, and it sends what King types. Like the
// other panels it fails closed when the platform is not installed in this build.
function mountConversationView({ api, document: injected = null } = {}) {
  if (!api || typeof api.orchestrate !== 'function') return null;
  // Resolved after the guard, not as a default parameter: a build or a test with
  // no DOM should get `null` back, not a ReferenceError thrown at the call site.
  const doc = injected || (typeof document === 'undefined' ? null : document);
  if (!doc) return null;

  const style = doc.createElement('style');
  style.textContent = `
    .ka-conversation-toggle { position: fixed; right: 14px; bottom: 92px; z-index: 9000;
      font: 12px/1 system-ui, sans-serif; padding: 8px 12px; border: 1px solid rgba(127,127,127,.4);
      border-radius: 999px; background: rgba(20,20,30,.85); color: #dfe3ff; cursor: pointer; }
    .ka-conversation { position: fixed; right: 14px; bottom: 130px; z-index: 9001;
      width: 420px; max-height: 64vh; display: flex; flex-direction: column;
      background: rgba(16,18,26,.96); border: 1px solid rgba(127,127,127,.35); border-radius: 12px;
      color: #dbe0ff; font: 12px/1.5 system-ui, sans-serif; box-shadow: 0 18px 60px rgba(0,0,0,.5); }
    .ka-conversation header { padding: 10px 14px; border-bottom: 1px solid rgba(127,127,127,.25);
      display: flex; justify-content: space-between; align-items: center; }
    .ka-conversation h1 { margin: 0; font-size: 13px; font-weight: 600; }
    .ka-conversation .scroll { overflow-y: auto; padding: 10px 14px; }
    .ka-conversation .line { margin-bottom: 8px; }
    .ka-conversation .who { font-weight: 600; }
    .ka-conversation .who.human { color: #9ecbff; }
    .ka-conversation .who.planner { color: #ffd479; }
    .ka-conversation .who.executive { color: #7fe0a6; }
    .ka-conversation .who.specialist { color: #c9a7ff; }
    .ka-conversation .who.tool { color: #9aa3c4; font-weight: 400; }
    .ka-conversation .who.approval { color: #ffa45c; }
    .ka-conversation .text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .ka-conversation .tool .text, .ka-conversation .system .text { color: #8b93b8; }
    .ka-conversation form { display: flex; gap: 6px; padding: 10px 14px;
      border-top: 1px solid rgba(127,127,127,.25); }
    .ka-conversation input { flex: 1; padding: 6px 8px; border-radius: 8px;
      border: 1px solid rgba(127,127,160,.4); background: #10131c; color: #dfe3ff; }
    .ka-conversation button { padding: 6px 12px; border: 0; border-radius: 8px;
      background: #4c5cff; color: #fff; cursor: pointer; }
  `;
  doc.head.appendChild(style);

  const toggle = doc.createElement('div');
  toggle.className = 'ka-conversation-toggle';
  toggle.textContent = '💬 Conversation';
  toggle.setAttribute('role', 'button');
  toggle.setAttribute('aria-expanded', 'false');
  doc.body.appendChild(toggle);

  const panel = doc.createElement('div');
  panel.className = 'ka-conversation';
  panel.style.display = 'none';
  panel.innerHTML = `
    <header><h1>Conversation</h1><button class="ka-conversation-close" title="Close">✕</button></header>
    <div class="scroll"></div>
    <form><input type="text" placeholder="Tell the organization what you want…" aria-label="Objective" />
      <button type="submit">Send</button></form>`;
  doc.body.appendChild(panel);

  const scroll = panel.querySelector('.scroll');
  const input = panel.querySelector('input');
  let agents = [];
  let open = false;
  let pending = [];

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // What King types is shown immediately, attributed to King, before the
  // platform has answered. Without it the panel looks inert for as long as
  // routing takes, which reads as a broken input rather than a working one.
  let said = [];

  function render() {
    if (!open) return;
    const lines = foldConversation([...said, ...pending], { agents });
    scroll.innerHTML = lines.length
      ? lines.map((l) => `<div class="line ${l.kind}">
          <div class="who ${l.kind}">${escapeHtml(l.badge ? `${l.badge} ` : '')}${escapeHtml(l.name)}</div>
          <div class="text">${escapeHtml(l.text)}</div>
        </div>`).join('')
      : '<div class="text" style="color:#8b93b8">Say what you want done. The plan, the agents and the result all appear here.</div>';
    scroll.scrollTop = scroll.scrollHeight;
  }

  function togglePanel() {
    open = !open;
    panel.style.display = open ? 'flex' : 'none';
    toggle.setAttribute('aria-expanded', String(open));
    if (open) render();
  }

  toggle.addEventListener('click', togglePanel);
  panel.querySelector('.ka-conversation-close').addEventListener('click', togglePanel);

  panel.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    const request = input.value.trim();
    if (!request) return;
    input.value = '';
    said.push({ id: `king-${said.length}`, type: 'run.started', payload: { objective: request }, timestamp: Date.now() });
    render();
    api.orchestrate({ request }).catch((err) => {
      pending = pending.concat([{ id: `err-${pending.length}`, type: 'run.failed', payload: { error: err.message }, timestamp: Date.now() }]);
      render();
    });
  });

  if (typeof api.listAgents === 'function') api.listAgents().then((rows) => { agents = rows || []; render(); }).catch(() => {});

  if (typeof api.onPlatformEvent === 'function') {
    api.onPlatformEvent((event) => {
      if (!event || typeof event.type !== 'string') return;
      pending.push(event);
      if (pending.length > 300) pending = pending.slice(-300);
      render();
    });
  }

  return { toggle: togglePanel, render, append: (event) => { pending.push(event); render(); } };
}

export { foldConversation, mountConversationView, SYSTEM_SPEAKERS, SYSTEM_KINDS };
