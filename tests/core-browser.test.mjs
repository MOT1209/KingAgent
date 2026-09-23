// The browser is the one capability that reaches the live web, so what is under
// test is the control boundary, not the engine:
//
//   - a human who takes control actually stops the agent (a refusal inside the
//     tool call, not a UI hint), and returning control resumes it
//   - a session belongs to one agent at a time
//   - the granular permissions are real: high-risk browser actions need
//     approval and a level the agent may not have
//   - with no engine wired the tools still exist and fail with a nameable code
//     instead of silently doing nothing
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const {
  BrowserControl, BrowserControlError, OWNERS, createBrowserSubsystem, browserToolCatalog,
} = require('../src/core/browser/index.js');
const { EventBus, TYPES } = require('../src/core/events/event-bus.js');
const { ToolDeniedError } = require('../src/core/tools/manager.js');

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ka-browser-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  return dir;
}

// An adapter that records what it was asked to do and answers like a page.
function fakeHost(overrides = {}) {
  const calls = [];
  const record = (key) => async (args) => {
    calls.push({ key, args });
    return { url: args.url || 'https://example.test/', title: 'Example' };
  };
  const host = {
    calls,
    navigate: record('navigate'),
    read: async (args) => { calls.push({ key: 'read', args }); return { url: 'https://example.test/', title: 'Example', text: 'hello world' }; },
    screenshot: async (args) => { calls.push({ key: 'screenshot', args }); return { path: '/tmp/shot.png' }; },
    click: record('click'),
    type: record('type'),
    download: record('download'),
    upload: record('upload'),
    clipboard: record('clipboard'),
    authenticate: record('authenticate'),
    submit: record('submit'),
    ...overrides,
  };
  return host;
}

function agent(overrides = {}) {
  return {
    id: 'agent-1',
    permissions: { levels: ['read_only', 'safe', 'moderate'], ...overrides },
  };
}

// --- control ownership -----------------------------------------------------------

test('browser control: a session starts under the agent and a person can take it', () => {
  const control = new BrowserControl();
  control.open('s1', { agentId: 'agent-1', title: 'Example' });
  assert.equal(control.get('s1').owner, OWNERS.AGENT);
  assert.equal(control.get('s1').agentId, 'agent-1');

  control.takeControl('s1', { by: 'king', reason: 'reviewing the checkout' });
  assert.equal(control.get('s1').owner, OWNERS.HUMAN);
  assert.throws(() => control.assertAgentMayAct('s1', 'agent-1'), (err) => {
    assert.ok(err instanceof BrowserControlError);
    assert.equal(err.code, 'BROWSER_HUMAN_CONTROL');
    return true;
  });

  control.returnControl('s1', { by: 'king' });
  assert.equal(control.get('s1').owner, OWNERS.AGENT);
  assert.equal(control.assertAgentMayAct('s1', 'agent-1').sessionId, 's1');
});

test('browser control: taking control emits paused and a transfer, returning resumes', () => {
  const bus = new EventBus();
  const seen = [];
  bus.on('*', (ev) => seen.push(ev.type));
  const control = new BrowserControl({ bus });
  control.open('s1', { agentId: 'agent-1' });
  control.takeControl('s1');
  control.returnControl('s1');

  assert.deepEqual(seen, [
    TYPES.BROWSER_SESSION_OPENED,
    TYPES.BROWSER_PAUSED,
    TYPES.BROWSER_CONTROL_TRANSFERRED,
    TYPES.BROWSER_RESUMED,
    TYPES.BROWSER_CONTROL_TRANSFERRED,
  ]);
});

test('browser control: reopening a session never hands control back to the agent', () => {
  const control = new BrowserControl();
  control.open('s1', { agentId: 'agent-1' });
  control.takeControl('s1');
  control.open('s1', { title: 'Reloaded' });
  assert.equal(control.get('s1').owner, OWNERS.HUMAN, 'a reload must not defeat take-control');
  assert.equal(control.get('s1').title, 'Reloaded');
});

test('browser control: a session belongs to one agent at a time', () => {
  const control = new BrowserControl();
  control.open('s1', { agentId: 'agent-1' });
  assert.throws(() => control.assertAgentMayAct('s1', 'agent-2'), /belongs to agent agent-1/);
});

test('browser control: unknown and malformed sessions are refused, not invented', () => {
  const control = new BrowserControl();
  assert.throws(() => control.assertAgentMayAct('nope'), /unknown browser session/);
  assert.throws(() => control.open(''), /needs an id/);
  assert.throws(() => control.open('x'.repeat(201)), /needs an id/);
  assert.equal(control.close('nope'), false);
  control.open('s1');
  assert.equal(control.close('s1'), true);
  assert.equal(control.get('s1'), undefined);
});

test('browser control: list filters by owner and returns copies, not live records', () => {
  const control = new BrowserControl();
  control.open('s1');
  control.open('s2');
  control.takeControl('s2');
  assert.equal(control.list().length, 2);
  assert.deepEqual(control.list({ owner: OWNERS.HUMAN }).map((s) => s.sessionId), ['s2']);
  control.list()[0].owner = 'tampered';
  assert.equal(control.get('s1').owner, OWNERS.AGENT, 'callers must not be able to mutate the store');
});

// --- the catalogue ----------------------------------------------------------------

test('browser tools: the granular actions §24 asks for are all present', () => {
  const actions = new Set(browserToolCatalog().map((t) => t.action));
  for (const action of [
    'browser.navigate', 'browser.read', 'browser.click', 'browser.type',
    'browser.upload', 'browser.download', 'browser.clipboard',
    'browser.authentication', 'browser.external_submit',
  ]) {
    assert.ok(actions.has(action), `missing ${action}`);
  }
});

test('browser tools: sending data out or changing remote state is never a moderate action', () => {
  const byAction = Object.fromEntries(browserToolCatalog().map((t) => [t.action, t]));
  for (const action of ['browser.upload', 'browser.authentication', 'browser.external_submit']) {
    assert.equal(byAction[action].level, 'destructive', `${action} must be destructive`);
    assert.equal(byAction[action].requiresAuth, true, `${action} must need per-call approval`);
  }
  assert.equal(byAction['browser.read'].level, 'read_only');
  assert.equal(byAction['browser.click'].level, 'moderate');
});

// --- through the platform ---------------------------------------------------------

test('browser: the subsystem registers with the platform and exposes no host object', async () => {
  const dir = await tempProject();
  const platform = createPlatform({ io: { root: dir, cwd: () => dir } });
  assert.ok(platform.browser);
  assert.equal(platform.browser.available, false, 'no engine wired');
  assert.equal(platform.tools.list({ capability: 'browser' }).length, 10);

  const snapshot = platform.browser.snapshot();
  assert.equal(typeof snapshot.available, 'boolean');
  assert.deepEqual(snapshot.sessions, []);
  assert.equal(JSON.stringify(snapshot).includes('function'), false, 'snapshot must be serializable');
});

test('browser: without an engine the tool fails with a nameable code, not silence', async () => {
  const dir = await tempProject();
  const platform = createPlatform({ io: { root: dir, cwd: () => dir } });
  platform.browser.open('s1', { agentId: 'agent-1' });
  await assert.rejects(
    () => platform.tools.execute({ id: 'browser:read', input: { sessionId: 's1' }, agent: agent() }),
    (err) => {
      assert.equal(err.code, 'BROWSER_UNAVAILABLE');
      return true;
    },
  );
});

test('browser: a wired host drives the page through the tool gate', async () => {
  const dir = await tempProject();
  const host = fakeHost();
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host } } });
  platform.browser.open('s1', { agentId: 'agent-1' });

  const res = await platform.tools.execute({
    id: 'browser:navigate',
    input: { sessionId: 's1', url: 'https://example.test/' },
    agent: agent(),
  });
  assert.equal(res.ok, true);
  assert.equal(host.calls[0].key, 'navigate');
  assert.equal(host.calls[0].args.sessionId, 's1');
  assert.equal(platform.browser.get('s1').url, 'https://example.test/', 'the session follows the page');
});

test('browser: a human who takes control stops the next agent call', async () => {
  const dir = await tempProject();
  const host = fakeHost();
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host } } });
  platform.browser.open('s1', { agentId: 'agent-1' });

  await platform.tools.execute({ id: 'browser:read', input: { sessionId: 's1' }, agent: agent() });
  platform.browser.takeControl('s1', { reason: 'typing a card number' });

  await assert.rejects(
    () => platform.tools.execute({ id: 'browser:read', input: { sessionId: 's1' }, agent: agent() }),
    (err) => {
      assert.equal(err.code, 'BROWSER_HUMAN_CONTROL');
      return true;
    },
  );
  assert.equal(host.calls.filter((c) => c.key === 'read').length, 1, 'the refused action never reached the page');

  platform.browser.returnControl('s1');
  const resumed = await platform.tools.execute({ id: 'browser:read', input: { sessionId: 's1' }, agent: agent() });
  assert.equal(resumed.ok, true);
  assert.equal(host.calls.filter((c) => c.key === 'read').length, 2);
});

test('browser: the tool gate still applies — an agent without the level is denied', async () => {
  const dir = await tempProject();
  const host = fakeHost();
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host } } });
  platform.browser.open('s1', { agentId: 'reader' });

  await assert.rejects(
    () => platform.tools.execute({
      id: 'browser:click',
      input: { sessionId: 's1', selector: '#buy' },
      agent: { id: 'reader', permissions: { levels: ['read_only'] } },
    }),
    (err) => {
      assert.ok(err instanceof ToolDeniedError);
      return true;
    },
  );
  assert.equal(host.calls.length, 0);
});

test('browser: a destructive action asks for approval and a denial stops it', async () => {
  const dir = await tempProject();
  const host = fakeHost();
  const asked = [];
  const platform = createPlatform({
    io: {
      root: dir,
      cwd: () => dir,
      browser: { host },
      authorize: async ({ tool }) => { asked.push(tool.id); return false; },
    },
  });
  platform.browser.open('s1', { agentId: 'sender' });

  await assert.rejects(
    () => platform.tools.execute({
      id: 'browser:upload',
      input: { sessionId: 's1', selector: '#file', files: ['secrets.txt'] },
      agent: { id: 'sender', permissions: { levels: ['destructive'], allowDestructive: true } },
    }),
    /authorization denied/,
  );
  assert.deepEqual(asked, ['browser:upload']);
  assert.equal(host.calls.length, 0, 'a denied upload must not have sent anything');
});

test('browser: the browser action stream names the session and the action', async () => {
  const dir = await tempProject();
  const host = fakeHost();
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host } } });
  const actions = [];
  platform.bus.on(TYPES.BROWSER_ACTION, (ev) => actions.push(ev));

  platform.browser.open('s1', { agentId: 'agent-1' });
  await platform.tools.execute({ id: 'browser:navigate', input: { sessionId: 's1', url: 'https://example.test/' }, agent: agent() });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].sessionId, 's1');
  assert.equal(actions[0].agentId, 'agent-1');
  assert.equal(actions[0].payload.action, 'browser.navigate');
});

test('browser: a host that does not implement an action reports it, rather than pretending', async () => {
  const dir = await tempProject();
  const partial = fakeHost({ clipboard: undefined });
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host: partial } } });
  platform.browser.open('s1', { agentId: 'agent-1' });
  await assert.rejects(
    () => platform.tools.execute({
      id: 'browser:clipboard',
      input: { sessionId: 's1', action: 'read' },
      agent: { id: 'agent-1', permissions: { levels: ['moderate'], allowDestructive: true } },
      authorize: async () => true,
    }),
    (err) => {
      assert.equal(err.code, 'BROWSER_UNAVAILABLE');
      return true;
    },
  );
});

test('browser: a host can be wired after construction (late binding)', async () => {
  const dir = await tempProject();
  let host = null;
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host: () => host } } });
  platform.browser.open('s1', { agentId: 'agent-1' });

  host = fakeHost();
  await platform.tools.execute({ id: 'browser:read', input: { sessionId: 's1' }, agent: agent() });
  assert.equal(host.calls[0].key, 'read');
});

// --- direct subsystem -------------------------------------------------------------

test('browser subsystem: no ToolManager means no tools, but control still works', () => {
  const subsystem = createBrowserSubsystem({ host: fakeHost() });
  assert.deepEqual(subsystem.tools, []);
  subsystem.open('s1');
  assert.equal(subsystem.list().length, 1);
});
