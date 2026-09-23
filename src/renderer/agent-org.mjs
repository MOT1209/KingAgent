// The organization view's data layer: who exists, who created whom, what each
// one is doing, and what has happened so far.
//
// §41–§42 of the target want a person to look at KingAgent and see an
// organization rather than a list of chats: a tree with real lineage (Rashid
// spawned a security specialist, which spawned nothing), a status per node, and
// a detail panel for whichever node they click. §34 wants the run's timeline.
//
// This module is the folding, not the drawing. It is pure — same inputs, same
// outputs, no DOM, no preload — so the whole view can be asserted in plain node,
// the same trade `agent-activity.mjs` makes. `mountOrgView` at the bottom is the
// thin DOM adapter and nothing else.
//
// Two properties matter as much as the shape:
//
//   * **Lineage is data, not decoration.** The tree is built from
//     `metadata.parentAgentId` / `createdBy` that the factory actually wrote, so
//     what is drawn is what happened.
//   * **Nothing here reveals reasoning.** The timeline is folded from the run's
//     own event summaries, which are operational facts (a step, a tool, a file,
//     an approval) — the same vocabulary `agent-activity.mjs` fixes, and never a
//     model's deliberation.

// How a lifecycle state reads to a person. The core's own states
// (`core/agents/lifecycle.js`) are precise but not what a person wants to scan
// for; these are the five tones a row can have.
const TONES = Object.freeze({
  created: 'idle',
  initializing: 'working',
  ready: 'idle',
  running: 'working',
  paused: 'paused',
  completed: 'done',
  failed: 'failed',
  recovering: 'working',
  stopping: 'paused',
  stopped: 'idle',
  // Not an agent state — it is the run/task state a waiting agent is *in*, and
  // the one a person must act on, so it is surfaced here rather than hidden.
  waiting_for_approval: 'waiting',
});

const TONE_LABELS = Object.freeze({
  idle: 'Idle',
  working: 'Running',
  paused: 'Paused',
  waiting: 'Waiting',
  done: 'Completed',
  failed: 'Failed',
});

function toneOf(status) {
  return TONES[status] || 'idle';
}

function toneLabel(status) {
  return TONE_LABELS[toneOf(status)];
}

function agentName(agent) {
  return agent.name || agent.role || agent.id;
}

function parentOf(agent) {
  const meta = agent.metadata || {};
  return agent.parentAgentId || meta.parentAgentId || null;
}

function isSystemAgent(agent, systemIds) {
  const meta = agent.metadata || {};
  return Boolean(agent.system || meta.system || systemIds.includes(agent.id));
}

// Build the organization.
//
// Two cases a naive parent lookup gets wrong, and both happen in practice:
//
//   * **An orphan.** A dynamic agent whose parent has since been destroyed (or
//     belongs to another project) would simply disappear from a child-only view.
//     It is kept, as a root, and flagged, so an agent can never be invisible.
//   * **A cycle.** Lineage is written by the factory and the factory has guards,
//     but a hand-edited or restored record could still name a loop. A tree that
//     recurses on a cycle hangs the window; so the loop is cut, the node is
//     promoted to a root, and it is flagged.
function buildOrgTree(agents, { systemIds = [], statuses = {} } = {}) {
  const list = Array.isArray(agents) ? agents.filter((a) => a && typeof a.id === 'string') : [];
  const byId = new Map();
  const orphans = [];
  const cycles = [];

  for (const agent of list) {
    byId.set(agent.id, {
      id: agent.id,
      name: agentName(agent),
      role: agent.role || (agent.metadata && agent.metadata.role) || null,
      system: isSystemAgent(agent, systemIds),
      status: statuses[agent.id] || agent.status || 'created',
      parentId: parentOf(agent),
      children: [],
      depth: 0,
      model: agent.model || null,
      provider: agent.provider || null,
      tools: Array.isArray(agent.tools) ? [...agent.tools] : [],
      taskId: agent.currentTaskId || agent.taskId || null,
      promoted: Boolean((agent.metadata && agent.metadata.promoted) || agent.promoted),
      createdBy: agent.createdBy || (agent.metadata && agent.metadata.createdBy) || null,
      rootTaskId: (agent.metadata && agent.metadata.rootTaskId) || null,
    });
  }

  // A node whose parent is itself, or which cannot reach a top without
  // revisiting a node, is a cycle. Cut it once, at the node that closes the loop.
  const inCycle = new Set();
  for (const node of byId.values()) {
    const seen = new Set([node.id]);
    let cursor = node.parentId;
    while (cursor) {
      if (seen.has(cursor)) { inCycle.add(node.id); break; }
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      cursor = parent.parentId;
    }
  }

  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent && !inCycle.has(node.id)) {
      parent.children.push(node.id);
      continue;
    }
    if (node.parentId) {
      if (parent && inCycle.has(node.id)) cycles.push(node.id);
      else if (!parent) orphans.push(node.id);
    }
  }

  // Deterministic order: system agents first (Ahmad over Rashid), then name, so
  // two refreshes of the same organization never reshuffle the tree.
  const rank = (id) => {
    const node = byId.get(id);
    if (node && node.system) return 0;
    return 1;
  };
  const compare = (a, b) => rank(a) - rank(b) || agentName(byId.get(a)).localeCompare(agentName(byId.get(b)));
  const roots = [...byId.values()]
    .filter((n) => !n.parentId || !byId.has(n.parentId) || inCycle.has(n.id))
    .map((n) => n.id)
    .sort(compare);
  for (const node of byId.values()) node.children.sort(compare);

  // Depth is computed after the tree is settled, so a promoted orphan is
  // measured against the root it was actually attached to. The visited set is
  // belt-and-braces: the parent graph is acyclic by now, and a walk that could
  // still loop would hang the window rather than fail loudly.
  const seen = new Set();
  const walk = (id, depth) => {
    if (seen.has(id)) return;
    seen.add(id);
    const node = byId.get(id);
    if (!node) return;
    node.depth = depth;
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const id of roots) walk(id, 0);

  return { byId, roots, orphans, cycles, size: byId.size };
}

// The tree as flat rows in display order — what a list actually renders, and
// what makes the ancestry of a dynamic agent legible without a graph widget.
function orgRows(tree = {}) {
  const byId = tree.byId || new Map();
  const orphans = tree.orphans || [];
  const cycles = tree.cycles || [];
  const rows = [];
  const visit = (id) => {
    const node = byId.get(id);
    if (!node) return;
    rows.push({
      id: node.id,
      name: node.name,
      role: node.role,
      depth: node.depth,
      tone: toneOf(node.status),
      status: node.status,
      statusLabel: toneLabel(node.status),
      system: node.system,
      model: node.model,
      childCount: node.children.length,
      promoted: node.promoted,
      orphan: orphans.includes(node.id),
      cycle: cycles.includes(node.id),
    });
    for (const child of node.children) visit(child);
  };
  for (const id of tree.roots || []) visit(id);
  return rows;
}

// The run's timeline (§34), folded from the run record the platform already
// keeps. Filtering by agent is what turns one long run into "what did *this*
// agent do", which is the question a detail panel is asked.
function runTimeline(run, { limit = 200, agentId = null } = {}) {
  const events = Array.isArray(run && run.events) ? run.events : [];
  const out = [];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const refs = ev.refs || {};
    if (agentId && refs.agentId !== agentId) continue;
    out.push({
      at: ev.at || null,
      type: ev.type || 'unknown',
      text: ev.summary || ev.type || '',
      agentId: refs.agentId || null,
      taskId: refs.taskId || null,
      toolId: refs.toolId || null,
    });
  }
  return out.length > limit ? out.slice(-limit) : out;
}

// The headline a run gets: one objective, and what it has cost so far.
function runHeadline(run) {
  if (!run) return null;
  const startedAt = run.startedAt || null;
  const endedAt = run.endedAt || null;
  const usage = run.usage || {};
  return {
    id: run.id,
    objective: run.objective || '',
    status: run.status || 'created',
    tone: toneOf(run.status),
    startedAt,
    endedAt,
    durationMs: startedAt ? (endedAt || Date.now()) - startedAt : null,
    running: !endedAt,
    counts: {
      agents: (run.agents || []).length,
      tasks: (run.tasks || []).length,
      tools: (run.tools || []).length,
      artifacts: (run.artifacts || []).length,
      errors: (run.errors || []).length,
    },
    tokens: usage.tokens || 0,
    cost: usage.cost || 0,
    toolCalls: usage.toolCalls || 0,
  };
}

// The detail panel (§42) for one node. Every field is presented as "what is
// known", never as a guess: a count the run does not carry is `null`, not 0, so
// "no artifacts" and "artifacts unknown" stay distinguishable.
function agentDetail({ agent, tree = null, run = null, lifecycle = null } = {}) {
  if (!agent) return null;
  const node = (tree && tree.byId.get(agent.id)) || null;
  const parent = node && node.parentId ? (tree && tree.byId.get(node.parentId)) || null : null;
  const meta = agent.metadata || {};
  const status = (lifecycle && lifecycle.status) || (node && node.status) || agent.status || 'created';

  return {
    id: agent.id,
    name: agentName(agent),
    description: agent.description || null,
    role: agent.role || meta.role || null,
    purpose: agent.purpose || meta.purpose || null,
    system: isSystemAgent(agent, []),
    status,
    tone: toneOf(status),
    statusLabel: toneLabel(status),
    createdBy: agent.createdBy || meta.createdBy || null,
    parent: parent ? { id: parent.id, name: parent.name, system: parent.system } : null,
    children: node ? node.children.map((id) => {
      const child = tree.byId.get(id);
      return { id, name: child.name, status: child.status, tone: toneOf(child.status) };
    }) : [],
    depth: node ? node.depth : null,
    model: agent.model || null,
    provider: agent.provider || null,
    tools: Array.isArray(agent.tools) ? [...agent.tools] : [],
    skills: Array.isArray(agent.skills) ? [...agent.skills] : [],
    permissions: agent.permissions ? { ...agent.permissions } : null,
    lifecycle: lifecycle || null,
    currentTask: node && node.taskId ? node.taskId : null,
    promoted: Boolean(node && node.promoted),
    rootTaskId: meta.rootTaskId || null,
    timeline: run ? runTimeline(run, { agentId: agent.id }) : [],
  };
}

// The thin DOM adapter. Kept deliberately dumb: it renders rows and calls back
// with an id. Every decision about *what* to show was made above, where it can
// be tested.
function mountOrgView(root, { onSelect = null } = {}) {
  if (!root || typeof root.replaceChildren !== 'function') return { render: () => {}, destroy: () => {} };
  const nodes = new Map();
  let current = { tree: { byId: new Map(), roots: [] }, selected: null };

  function render(state = {}) {
    const tree = state.tree || current.tree;
    current = { tree, selected: state.selected || null };
    const rows = orgRows(tree);
    nodes.clear();
    const frag = root.ownerDocument.createDocumentFragment();
    for (const row of rows) {
      const el = root.ownerDocument.createElement('button');
      el.type = 'button';
      el.className = 'org-row';
      el.dataset.agentId = row.id;
      el.dataset.tone = row.tone;
      el.dataset.status = row.status;
      el.dataset.depth = String(row.depth);
      el.textContent = `${'  '.repeat(row.depth)}${row.system ? '★ ' : ''}${row.name} — ${row.statusLabel}`;
      if (row.id === current.selected) el.setAttribute('aria-current', 'true');
      el.addEventListener('click', () => { current.selected = row.id; if (onSelect) onSelect(row.id); });
      nodes.set(row.id, el);
      frag.appendChild(el);
    }
    root.replaceChildren(frag);
  }

  return { render, destroy: () => { nodes.clear(); root.replaceChildren(); } };
}

export {
  buildOrgTree, orgRows, runTimeline, runHeadline, agentDetail, mountOrgView,
  TONES, TONE_LABELS, toneOf, toneLabel,
};
