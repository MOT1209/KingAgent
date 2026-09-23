// The adapter that lets an agent drive a tab. What is under test is the boundary
// rather than the engine:
//
//   - navigation goes through the same validator the address bar uses, so an
//     agent cannot talk a tab into `file:` or a local document
//   - a page that says no, or does not have the element, produces a *named*
//     refusal instead of a generic failure
//   - the two actions that are refused on purpose (authenticate, upload) say so
//     in words, and cannot be mistaken for a transient problem
//   - the classification survives all the way to the core tool's error code
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createBrowserAgentHost, MAX_TEXT } = require('../src/main/browser-agent-host.js');
const { createPlatform } = require('../src/core/index.js');

function fakeTab({ url = 'https://example.test/', title = 'Example', destroyed = false, evalResult = null, evalImpl = null, image = null, fail = null } = {}) {
  const calls = [];
  const wc = {
    calls,
    url,
    title,
    isDestroyed: () => destroyed,
    getURL() { return this.url; },
    getTitle() { return this.title; },
    async loadURL(target) {
      calls.push(['loadURL', target]);
      if (fail === 'loadURL') throw new Error('ERR_CONNECTION_REFUSED');
      this.url = target;
    },
    async executeJavaScript(script, userGesture) {
      calls.push(['script', script, userGesture]);
      if (fail === 'script') throw new Error('Script failed on this page.');
      if (evalImpl) return evalImpl(script);
      return evalResult;
    },
    async capturePage() {
      calls.push(['capturePage']);
      if (fail === 'capture') throw new Error('The page could not be captured.');
      if (image) return image;
      return { isEmpty: () => false, getSize: () => ({ width: 20, height: 10 }), toPNG: () => Buffer.alloc(8) };
    },
    downloadURL(target) { calls.push(['downloadURL', target]); },
  };
  return { wc, entry: { id: 'tab-1', view: { webContents: wc }, filePath: null } };
}

// --- navigation ------------------------------------------------------------------

test('host: navigation uses the address-bar validator, so file: never loads', async () => {
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.navigate({ sessionId: 'tab-1', url: 'file:///etc/passwd' }), (err) => {
    assert.equal(err.code, 'BROWSER_INVALID_INPUT');
    return true;
  });
  await assert.rejects(() => host.navigate({ sessionId: 'tab-1', url: 'javascript:alert(1)' }), /http:\/\/ or https:\/\//);
  assert.equal(tab.wc.calls.filter((c) => c[0] === 'loadURL').length, 0, 'nothing was loaded');
});

test('host: navigation normalizes localhost and reports where it ended up', async () => {
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await host.navigate({ sessionId: 'tab-1', url: 'localhost:3000' });
  assert.deepEqual(tab.wc.calls[0], ['loadURL', 'http://localhost:3000/']);
  const result = await host.navigate({ sessionId: 'tab-1', url: 'https://example.test/path' });
  assert.equal(result.url, 'https://example.test/path');
  assert.equal(result.title, 'Example');
});

test('host: a tab that no longer exists is a named error, not a crash', async () => {
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.read({ sessionId: 'tab-gone' }), (err) => {
    assert.equal(err.code, 'BROWSER_NO_SESSION');
    return true;
  });
});

test('host: a destroyed tab is reported as closed', async () => {
  const tab = fakeTab({ destroyed: true });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.read({ sessionId: 'tab-1' }), /has been closed/);
});

// --- reading ---------------------------------------------------------------------

test('host: read returns the page text and bounds it host-side', async () => {
  const tab = fakeTab({ evalResult: 'x'.repeat(MAX_TEXT * 2) });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  const result = await host.read({ sessionId: 'tab-1' });
  assert.equal(result.text.length, MAX_TEXT, 'a lying page still cannot blow up the context');
  assert.equal(result.text, 'x'.repeat(MAX_TEXT));
});

test('host: a selector that matches nothing is reported as not found', async () => {
  const tab = fakeTab({ evalResult: null });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.read({ sessionId: 'tab-1', selector: '#nope' }), (err) => {
    assert.equal(err.code, 'BROWSER_NOT_FOUND');
    return true;
  });
});

test('host: read does not secretly navigate', async () => {
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.read({ sessionId: 'tab-1', url: 'https://elsewhere.test/' }), /Use browser:navigate/);
  assert.equal(tab.wc.calls.filter((c) => c[0] === 'loadURL').length, 0);
});

test('host: an oversized selector never reaches the page', async () => {
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.click({ sessionId: 'tab-1', selector: '#'.repeat(600) }), /too long/);
  assert.equal(tab.wc.calls.length, 0);
});

// --- acting ----------------------------------------------------------------------

test('host: click needs a selector or a label, and says which element it missed', async () => {
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.click({ sessionId: 'tab-1' }), /Give a selector or the visible text/);

  const missing = fakeTab({ evalResult: { ok: false } });
  const host2 = createBrowserAgentHost({ views: new Map([['tab-1', missing.entry]]) });
  await assert.rejects(() => host2.click({ sessionId: 'tab-1', selector: '#buy' }), /No element matched #buy/);

  const found = fakeTab({ evalResult: { ok: true } });
  const host3 = createBrowserAgentHost({ views: new Map([['tab-1', found.entry]]) });
  const result = await host3.click({ sessionId: 'tab-1', text: 'Buy now' });
  assert.equal(result.clicked, true);
});

test('host: typing into a read-only field is its own refusal', async () => {
  const tab = fakeTab({ evalImpl: () => ({ ok: false, why: 'readonly' }) });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.type({ sessionId: 'tab-1', selector: '#email', text: 'a@b.test' }), (err) => {
    assert.equal(err.code, 'BROWSER_FIELD_READONLY');
    return true;
  });
});

test('host: the field is filled with the native setter so frameworks see it', async () => {
  const tab = fakeTab({ evalImpl: () => ({ ok: true }) });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await host.type({ sessionId: 'tab-1', selector: '#email', text: 'a@b.test' });
  const script = tab.wc.calls.find((c) => c[0] === 'script')[1];
  assert.match(script, /getOwnPropertyDescriptor/);
  assert.match(script, /dispatchEvent\(new Event\('input'/);
});

test('host: submit reports a page with no form rather than throwing a raw error', async () => {
  const tab = fakeTab({ evalImpl: () => ({ ok: false, why: 'noform' }) });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.submit({ sessionId: 'tab-1' }), (err) => {
    assert.equal(err.code, 'BROWSER_NOT_FOUND');
    return true;
  });
});

test('host: a page error is classified, not passed through raw', async () => {
  const tab = fakeTab({ fail: 'script' });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.read({ sessionId: 'tab-1' }), (err) => {
    assert.equal(err.code, 'BROWSER_PAGE_ERROR');
    assert.match(err.message, /could not be read/);
    return true;
  });
});

test('host: a load failure is classified too', async () => {
  const tab = fakeTab({ fail: 'loadURL' });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.navigate({ sessionId: 'tab-1', url: 'https://example.test/' }), (err) => {
    assert.equal(err.code, 'BROWSER_PAGE_ERROR');
    return true;
  });
});

// --- screenshots -----------------------------------------------------------------

test('host: a small screenshot is inlined and a huge one is only described', async () => {
  const small = fakeTab();
  const hostSmall = createBrowserAgentHost({ views: new Map([['tab-1', small.entry]]) });
  const inlined = await hostSmall.screenshot({ sessionId: 'tab-1' });
  assert.equal(inlined.inlined, true);
  assert.match(inlined.dataUrl, /^data:image\/png;base64,/);
  assert.equal(inlined.width, 20);

  const huge = fakeTab({ image: { isEmpty: () => false, getSize: () => ({ width: 3000, height: 2000 }), toPNG: () => Buffer.alloc(2_000_000) } });
  const hostHuge = createBrowserAgentHost({ views: new Map([['tab-1', huge.entry]]) });
  const described = await hostHuge.screenshot({ sessionId: 'tab-1' });
  assert.equal(described.inlined, false);
  assert.equal(described.dataUrl, undefined, 'a context bomb is never shipped');
  assert.equal(described.bytes, 2_000_000);
});

test('host: an empty capture is reported rather than returned as a blank image', async () => {
  const tab = fakeTab({ image: { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toPNG: () => Buffer.alloc(0) } });
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.screenshot({ sessionId: 'tab-1' }), /no visible content/);
});

// --- the two refusals that are the feature ---------------------------------------

test('host: authenticate refuses because signing in is a person\'s act', async () => {
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.authenticate({ sessionId: 'tab-1' }), (err) => {
    assert.equal(err.code, 'BROWSER_HUMAN_ACTION_REQUIRED');
    assert.match(err.message, /person’s act/);
    return true;
  });
  assert.equal(tab.wc.calls.length, 0, 'no credential path was touched');
});

test('host: upload says what is missing instead of failing silently', async () => {
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  await assert.rejects(() => host.upload({ sessionId: 'tab-1', selector: '#file', files: ['a.txt'] }), (err) => {
    assert.equal(err.code, 'BROWSER_UNAVAILABLE');
    return true;
  });
});

// --- through the core tools ------------------------------------------------------

async function tempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ka-host-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }));
  return dir;
}

const driver = { id: 'agent-1', permissions: { levels: ['read_only', 'safe', 'moderate'] } };

test('host + core: an agent drives the tab through browser:navigate', async () => {
  const dir = await tempProject();
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host: () => host } } });
  platform.browser.open('tab-1', { agentId: 'agent-1' });

  const res = await platform.tools.execute({
    id: 'browser:navigate',
    input: { sessionId: 'tab-1', url: 'https://example.test/hello' },
    agent: driver,
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.url, 'https://example.test/hello');
  assert.equal(tab.wc.calls[0][0], 'loadURL');
  assert.equal(platform.browser.get('tab-1').url, 'https://example.test/hello');
});

test('host + core: the host\'s classification reaches the caller as the tool code', async () => {
  const dir = await tempProject();
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host: () => host } } });
  platform.browser.open('tab-1', { agentId: 'agent-1' });

  await assert.rejects(
    () => platform.tools.execute({ id: 'browser:read', input: { sessionId: 'tab-1', selector: '#missing' }, agent: driver }),
    (err) => {
      assert.equal(err.code, 'BROWSER_NOT_FOUND', 'a named refusal is not flattened into TOOL_FAILURE');
      return true;
    },
  );
});

test('host + core: a person taking the wheel stops the agent before the page is touched', async () => {
  const dir = await tempProject();
  const tab = fakeTab();
  const host = createBrowserAgentHost({ views: new Map([['tab-1', tab.entry]]) });
  const platform = createPlatform({ io: { root: dir, cwd: () => dir, browser: { host: () => host } } });
  platform.browser.open('tab-1', { agentId: 'agent-1' });
  platform.browser.takeControl('tab-1');

  await assert.rejects(
    () => platform.tools.execute({ id: 'browser:read', input: { sessionId: 'tab-1' }, agent: driver }),
    (err) => {
      assert.equal(err.code, 'BROWSER_HUMAN_CONTROL');
      return true;
    },
  );
  assert.equal(tab.wc.calls.length, 0);
});
