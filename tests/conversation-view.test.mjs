// The shared conversation (§13/§38). What is under test is that one transcript
// can be folded from the real event stream without inventing anything: every
// line is an event that happened, nobody's private reasoning leaks in, and an
// event nobody has decided how to phrase stays out rather than appearing as a
// raw type name a person would have to decode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldConversation, mountConversationView } from '../src/renderer/conversation-view.mjs';

const agents = [
  { id: 'ahmad', name: 'Ahmad', system: true },
  { id: 'rashid', name: 'Rashid', system: true },
  { id: 'agent-sec', name: 'Security Agent' },
];

function conversation() {
  return foldConversation([
    { id: 'e1', type: 'run.started', timestamp: 1, runId: 'run-1', payload: { objective: 'build a web application' } },
    { id: 'e2', type: 'orchestration.routed', timestamp: 2, payload: { mode: 'multi-agent' } },
    { id: 'e3', type: 'task.plan.created', timestamp: 3, payload: { stepCount: 4 } },
    { id: 'e4', type: 'agent.created', timestamp: 4, payload: { role: 'security', createdBy: 'rashid' } },
    { id: 'e5', type: 'tool.called', timestamp: 5, agentId: 'agent-sec', toolId: 'fs:read', payload: { input: {} } },
    { id: 'e6', type: 'approval.requested', timestamp: 6, payload: { summary: 'deploy the site' } },
    { id: 'e7', type: 'approval.approved', timestamp: 7, payload: {} },
    { id: 'e8', type: 'task.completed', timestamp: 8, payload: {} },
  ], { agents });
}

test('conversation: King, Ahmad, Rashid, a specialist and the system all appear in one flow', () => {
  const lines = conversation();
  assert.deepEqual(lines.map((l) => l.name), [
    'King', 'System', 'Ahmad', 'Rashid', 'Security Agent', 'System', 'King', 'System',
  ]);
  assert.equal(lines[0].text, 'Wants: build a web application');
  assert.equal(lines[1].text, 'Routed as multi-agent', 'the routing vocabulary is the one agent-activity already fixed');
  assert.match(lines[2].text, /Plan created/);
  assert.equal(lines[3].text, 'Created security');
  assert.equal(lines[4].kind, 'tool', 'a tool call is the acting agent using a tool');
  assert.match(lines[4].text, /Using fs:read/);
});

test('conversation: an agent nobody has heard of is shown by id, never hidden', () => {
  const lines = foldConversation([
    { id: 'x', type: 'task.step.started', timestamp: 1, agentId: 'dyn-42', payload: { title: 'Audit the API' } },
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].name, 'dyn-42');
  assert.equal(lines[0].kind, 'specialist');
});

test('conversation: a planning step is Ahmad\'s act even when the event does not name him', () => {
  const lines = foldConversation([{ id: 'p', type: 'task.planning', timestamp: 1, payload: {} }]);
  assert.equal(lines[0].name, 'Ahmad');
  assert.equal(lines[0].kind, 'planner');
});

test('conversation: an agent message is carried through, not rephrased', () => {
  const lines = foldConversation([
    { id: 'm', type: 'agent.message', timestamp: 1, agentId: 'rashid', payload: { content: 'I will fix the auth issue.' } },
  ]);
  assert.equal(lines[0].text, 'I will fix the auth issue.');
  assert.equal(lines[0].name, 'Rashid');
});

test('conversation: a refused spawn is said out loud, not swallowed', () => {
  const lines = foldConversation([
    { id: 'd', type: 'agent.spawn.denied', timestamp: 1, payload: { code: 'SPAWN_TOO_DEEP', reason: 'depth 4 exceeds the limit of 3' } },
  ]);
  assert.equal(lines[0].name, 'System');
  assert.match(lines[0].text, /depth 4 exceeds/);
});

test('conversation: an event with no agreed phrasing produces no line', () => {
  const lines = foldConversation([
    { id: 'a', type: 'policy.evaluated', timestamp: 1, payload: {} },
    { id: 'b', type: 'something.brand.new', timestamp: 2, payload: {} },
    { id: 'c', type: 'task.completed', timestamp: 3, payload: {} },
  ]);
  assert.deepEqual(lines.map((l) => l.type), ['task.completed']);
});

test('conversation: the transcript is bounded from the end', () => {
  const events = [];
  for (let i = 0; i < 50; i++) events.push({ id: `e${i}`, type: 'task.step.started', timestamp: i, payload: { title: `step ${i}` } });
  const lines = foldConversation(events, { max: 10 });
  assert.equal(lines.length, 10);
  assert.match(lines[9].text, /step 49/, 'the recent end is the end a person is reading');
});

test('conversation: malformed input is ignored rather than thrown', () => {
  assert.deepEqual(foldConversation(null), []);
  assert.deepEqual(foldConversation([null, 42, {}, { type: 7 }]), []);
});

// --- DOM adapter -----------------------------------------------------------------

// A document small enough to read: every element answers querySelector with a
// stable stub per selector, which is all the adapter asks of a DOM.
function fakeDom() {
  const make = (tag) => {
    const el = {
      tagName: tag, children: [], attributes: {}, listeners: {}, style: {},
      className: '', textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 0,
      setAttribute(k, v) { this.attributes[k] = v; },
      addEventListener(t, fn) { this.listeners[t] = fn; },
      appendChild(c) { this.children.push(c); },
      querySelector(sel) {
        if (!this._queries) this._queries = new Map();
        if (!this._queries.has(sel)) this._queries.set(sel, make('div'));
        return this._queries.get(sel);
      },
    };
    return el;
  };
  return { createElement: make, head: make('head'), body: make('body') };
}

function mount(document, api, overrides = {}) {
  const view = mountConversationView({ api, document, ...overrides });
  const panel = document.body.children.find((c) => c.className === 'ka-conversation');
  return { view, panel, scroll: panel.querySelector('.scroll'), input: panel.querySelector('input'), form: panel.querySelector('form') };
}

test('conversation DOM: King\'s objective reaches the orchestrator and shows immediately', () => {
  const document = fakeDom();
  const sent = [];
  const { view, scroll, input, form } = mount(document, {
    orchestrate: (args) => { sent.push(args); return Promise.resolve({}); },
    listAgents: async () => agents,
  });
  view.toggle();
  input.value = 'ship the release';
  form.listeners.submit({ preventDefault() {} });

  assert.deepEqual(sent, [{ request: 'ship the release' }]);
  assert.equal(input.value, '', 'the box clears so the next objective can be typed');
  assert.match(scroll.innerHTML, /King/);
  assert.match(scroll.innerHTML, /ship the release/, 'the panel is not inert while routing happens');
});

test('conversation DOM: platform events join the same transcript', () => {
  const document = fakeDom();
  let push = null;
  const { view, scroll } = mount(document, {
    orchestrate: () => Promise.resolve({}),
    listAgents: async () => agents,
    onPlatformEvent: (cb) => { push = cb; },
  });
  view.toggle();
  push({ id: 'r1', type: 'run.started', payload: { objective: 'build it' } });
  push({ id: 'p1', type: 'task.plan.created', payload: { stepCount: 3 } });
  push({ id: 'noise', type: 'policy.evaluated', payload: {} });

  assert.match(scroll.innerHTML, /build it/);
  assert.match(scroll.innerHTML, /Ahmad/);
  assert.doesNotMatch(scroll.innerHTML, /policy\.evaluated/, 'an unphrased event never reaches a person as a type name');
});

test('conversation DOM: a failed orchestration is shown rather than swallowed', async () => {
  const document = fakeDom();
  const { view, scroll, input, form } = mount(document, {
    orchestrate: () => Promise.reject(new Error('platform unavailable')),
  });
  view.toggle();
  input.value = 'do the thing';
  form.listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(scroll.innerHTML, /platform unavailable/);
});

test('conversation DOM: a submit with nothing typed calls nothing', () => {
  const document = fakeDom();
  const sent = [];
  const { input, form } = mount(document, { orchestrate: (args) => { sent.push(args); return Promise.resolve({}); } });
  input.value = '   ';
  form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(sent, []);
});

test('conversation DOM: no platform installed is a no-op, not a crash', () => {
  assert.equal(mountConversationView({ api: null }), null);
  assert.equal(mountConversationView({ api: { listAgents: () => {} } }), null, 'a platform without the orchestrator cannot start anything');
});
