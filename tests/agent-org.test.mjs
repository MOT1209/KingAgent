// The organization view's data layer. What is under test is that the tree is
// built from lineage that was actually written (not inferred), that a record a
// person would still expect to see cannot become invisible, and that a timeline
// can be narrowed to one agent — which is the question a detail panel asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOrgTree, orgRows, runTimeline, runHeadline, agentDetail, mountOrgView,
  toneOf, toneLabel,
} from '../src/renderer/agent-org.mjs';

const ahmad = { id: 'ahmad', name: 'Ahmad', role: 'chief_planner', metadata: { system: true, role: 'planner' } };
const rashid = { id: 'rashid', name: 'Rashid', role: 'executive', metadata: { system: true } };
const security = {
  id: 'agent-sec',
  name: 'Security Agent',
  metadata: { parentAgentId: 'rashid', createdBy: 'rashid', role: 'security', rootTaskId: 'task-1' },
};
const auditor = {
  id: 'agent-audit',
  name: 'API Security Auditor',
  metadata: { parentAgentId: 'agent-sec', createdBy: 'agent-sec', promoted: true },
};

// --- lineage ---------------------------------------------------------------------

test('org: lineage comes from the recorded parent, and depth follows it', () => {
  const tree = buildOrgTree([ahmad, rashid, security, auditor]);
  assert.deepEqual(tree.roots, ['ahmad', 'rashid']);
  assert.deepEqual(tree.byId.get('rashid').children, ['agent-sec']);
  assert.deepEqual(tree.byId.get('agent-sec').children, ['agent-audit']);
  assert.equal(tree.byId.get('agent-audit').depth, 2);
  assert.equal(tree.byId.get('agent-audit').createdBy, 'agent-sec');
  assert.equal(tree.byId.get('agent-audit').promoted, true);
  assert.deepEqual(tree.orphans, []);
  assert.deepEqual(tree.cycles, []);
});

test('org: system agents are ordered first, then by name, deterministically', () => {
  const other = { id: 'agent-res', name: 'Aardvark Researcher', metadata: { parentAgentId: null } };
  const tree = buildOrgTree([other, rashid, ahmad]);
  assert.deepEqual(tree.roots, ['ahmad', 'rashid', 'agent-res'], 'system agents first even when a name sorts earlier');
  assert.deepEqual(buildOrgTree([other, rashid, ahmad]).roots, tree.roots, 'same input, same order');
});

test('org: an agent whose parent is gone is kept as a flagged root, not hidden', () => {
  const lonely = { id: 'agent-lonely', name: 'Orphan', metadata: { parentAgentId: 'agent-destroyed' } };
  const tree = buildOrgTree([rashid, lonely]);
  assert.ok(tree.roots.includes('agent-lonely'));
  assert.deepEqual(tree.orphans, ['agent-lonely']);
  assert.equal(tree.byId.get('agent-lonely').depth, 0);
});

test('org: a lineage cycle is cut instead of recursed', () => {
  const one = { id: 'a', name: 'A', metadata: { parentAgentId: 'b' } };
  const two = { id: 'b', name: 'B', metadata: { parentAgentId: 'a' } };
  const tree = buildOrgTree([one, two]);
  assert.equal(tree.byId.size, 2, 'both agents survive');
  assert.deepEqual(orgRows(tree).map((r) => r.id).sort(), ['a', 'b'], 'and both are reachable');
  assert.ok(tree.cycles.length >= 1, 'the loop is reported, not silently swallowed');
  // The whole point: this must return rather than hang.
  assert.ok(orgRows(tree).length === 2);
});

test('org: statuses come from the lifecycle when one is supplied', () => {
  const tree = buildOrgTree([rashid, security], { statuses: { 'agent-sec': 'waiting_for_approval' } });
  assert.equal(tree.byId.get('agent-sec').status, 'waiting_for_approval');
  assert.equal(toneOf('waiting_for_approval'), 'waiting');
  assert.equal(toneLabel('waiting_for_approval'), 'Waiting');
});

test('org: every lifecycle state maps to a tone a row can render', () => {
  for (const status of ['created', 'initializing', 'ready', 'running', 'paused', 'completed', 'failed', 'recovering', 'stopping', 'stopped']) {
    assert.ok(['idle', 'working', 'paused', 'waiting', 'done', 'failed'].includes(toneOf(status)), status);
  }
  assert.equal(toneOf('something-new'), 'idle', 'an unknown state degrades to idle rather than throwing');
});

// --- rows ------------------------------------------------------------------------

test('org rows: depth-first display order carries the ancestry of each row', () => {
  const rows = orgRows(buildOrgTree([ahmad, rashid, security, auditor]));
  assert.deepEqual(rows.map((r) => r.id), ['ahmad', 'rashid', 'agent-sec', 'agent-audit']);
  assert.deepEqual(rows.map((r) => r.depth), [0, 0, 1, 2]);
  assert.equal(rows[1].system, true);
  assert.equal(rows[3].promoted, true);
  assert.equal(rows[2].childCount, 1);
});

test('org rows: tolerate a tree with nothing in it', () => {
  assert.deepEqual(orgRows(buildOrgTree([])), []);
  assert.deepEqual(orgRows(), []);
});

// --- run view --------------------------------------------------------------------

const run = {
  id: 'run-1',
  objective: 'build a web application',
  status: 'completed',
  startedAt: 1000,
  endedAt: 2500,
  agents: ['rashid', 'agent-sec'],
  tasks: ['task-1', 'task-2'],
  tools: ['fs:read'],
  artifacts: ['art-1'],
  errors: [],
  usage: { tokens: 4200, cost: 0.31, toolCalls: 7, taskCount: 2 },
  events: [
    { at: 1100, type: 'run.started', summary: 'Run started', refs: {} },
    { at: 1200, type: 'agent.created', summary: 'Created Security Agent', refs: { agentId: 'agent-sec' } },
    { at: 1300, type: 'tool.called', summary: 'Using fs:read', refs: { agentId: 'agent-sec', toolId: 'fs:read' } },
    { at: 1400, type: 'task.completed', summary: 'Task done', refs: { agentId: 'rashid', taskId: 'task-2' } },
    { at: 1500, type: 'approval.requested', summary: 'Waiting for approval: deploy', refs: {} },
  ],
};

test('run timeline: narrows to one agent without losing the run around it', () => {
  const all = runTimeline(run);
  assert.equal(all.length, 5);
  const mine = runTimeline(run, { agentId: 'agent-sec' });
  assert.deepEqual(mine.map((e) => e.type), ['agent.created', 'tool.called']);
  assert.equal(mine[1].toolId, 'fs:read');
});

test('run timeline: keeps the most recent entries when it has to cut', () => {
  const kept = runTimeline(run, { limit: 2 });
  assert.deepEqual(kept.map((e) => e.type), ['task.completed', 'approval.requested']);
  assert.equal(runTimeline(null).length, 0);
});

test('run headline: reports what the run spent and how long it took', () => {
  const head = runHeadline(run);
  assert.equal(head.objective, 'build a web application');
  assert.equal(head.durationMs, 1500);
  assert.equal(head.running, false, 'a finished run stops counting');
  assert.deepEqual(head.counts, { agents: 2, tasks: 2, tools: 1, artifacts: 1, errors: 0 });
  assert.equal(head.tokens, 4200);
  assert.equal(head.cost, 0.31);
  assert.equal(runHeadline(null), null);
});

test('run headline: a live run counts up rather than reporting a finished duration', () => {
  const head = runHeadline({ ...run, status: 'running', endedAt: null });
  assert.equal(head.running, true);
  assert.ok(head.durationMs > 0);
  assert.equal(head.tone, 'working');
});

// --- detail panel ----------------------------------------------------------------

test('agent detail: overview, parent, children and only that agent\'s timeline', () => {
  const tree = buildOrgTree([ahmad, rashid, security, auditor]);
  const detail = agentDetail({ agent: security, tree, run });
  assert.equal(detail.name, 'Security Agent');
  assert.equal(detail.parent.id, 'rashid');
  assert.deepEqual(detail.children.map((c) => c.id), ['agent-audit']);
  assert.equal(detail.depth, 1);
  assert.equal(detail.rootTaskId, 'task-1');
  assert.deepEqual(detail.timeline.map((e) => e.type), ['agent.created', 'tool.called']);
  assert.equal(detail.permissions, null, 'no permissions recorded is null, not an empty grant');
});

test('agent detail: a lifecycle record wins over the tree status', () => {
  const tree = buildOrgTree([rashid, security]);
  const detail = agentDetail({ agent: security, tree, lifecycle: { status: 'paused' } });
  assert.equal(detail.status, 'paused');
  assert.equal(detail.statusLabel, 'Paused');
  assert.equal(agentDetail({}), null);
});

// --- DOM adapter -----------------------------------------------------------------

function fakeDom() {
  const make = (tag) => ({
    tagName: tag, children: [], attributes: {}, dataset: {}, listeners: {},
    className: '', textContent: '',
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener(t, fn) { this.listeners[t] = fn; },
    appendChild(c) { this.children.push(c); },
    click() { if (this.listeners.click) this.listeners.click(); },
  });
  const document = { createElement: make, createDocumentFragment: () => make('fragment') };
  const root = make('div');
  root.ownerDocument = document;
  // `replaceChildren()` with no argument clears the element, which is the real
  // DOM contract destroy() relies on.
  root.replaceChildren = (frag) => { root.children = frag ? frag.children.slice() : []; };
  return { root };
}

test('org DOM adapter: renders a row per agent and reports the one clicked', () => {
  const { root } = fakeDom();
  const picked = [];
  const view = mountOrgView(root, { onSelect: (id) => picked.push(id) });

  view.render({ tree: buildOrgTree([ahmad, rashid, security]), selected: 'rashid' });
  assert.equal(root.children.length, 3);
  assert.equal(root.children[0].dataset.agentId, 'ahmad');
  assert.equal(root.children[2].dataset.depth, '1');
  assert.equal(root.children[1].attributes['aria-current'], 'true');

  root.children[2].click();
  assert.deepEqual(picked, ['agent-sec']);
  view.destroy();
  assert.equal(root.children.length, 0);
});

test('org DOM adapter: no host element is a no-op, not a crash', () => {
  const view = mountOrgView(null);
  assert.doesNotThrow(() => view.render({}));
  assert.doesNotThrow(() => view.destroy());
});
