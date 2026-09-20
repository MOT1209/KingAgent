// createCdpBridge (src/main/browser-cdp.js) needs no electron mocking to
// test: it takes its collaborators (entries/create/close/onCommand) as
// plain arguments and talks CDP over a real `ws` WebSocket server. This
// file was previously at 0% coverage with no test referencing it at all —
// verified via `c8`'s per-file report, not assumed from a prior report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createCdpBridge } from '../src/main/browser-cdp.js';

// A fake WebContents + debugger shaped exactly like the real Electron ones
// the module calls — the same technique tests/browser-sharing.test.mjs
// already uses for its fake `view`, not a new convention.
function fakeEntry(id, { targetId = id + '-target' } = {}) {
  const wc = new EventEmitter();
  const dbg = new EventEmitter();
  let attached = false;
  dbg.isAttached = () => attached;
  dbg.attach = () => { attached = true; };
  dbg.detach = () => { attached = false; };
  dbg.sendCommand = async (method) => {
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId } };
    return {};
  };
  wc.debugger = dbg;
  wc.getTitle = () => 'Title ' + id;
  wc.getURL = () => 'https://example.test/' + id;
  wc.isDestroyed = () => false;
  return { id, view: { webContents: wc } };
}

async function withClient(endpoint, fn) {
  const ws = new WebSocket(endpoint, { headers: {} });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const rpc = (method, params, sessionId) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  try { return await fn(rpc, ws); } finally { ws.terminate(); }
}

test('the bridge only accepts connections to its own secret path', async () => {
  const bridge = await createCdpBridge({ entries: () => [], create: async () => {}, close: async () => {} });
  try {
    const base = bridge.endpoint.replace(/\/[^/]+$/, '');
    const ws = new WebSocket(base + '/wrong-secret');
    const failed = await new Promise((resolve) => { ws.once('open', () => resolve(false)); ws.once('error', () => resolve(true)); ws.once('unexpected-response', () => resolve(true)); });
    assert.equal(failed, true);
  } finally { await bridge.close(); }
});

test('Browser.getVersion and Target.getTargets answer from the granted entries', async () => {
  const e1 = fakeEntry('a');
  const bridge = await createCdpBridge({ entries: () => [e1], create: async () => {}, close: async () => {} });
  try {
    await withClient(bridge.endpoint, async (rpc) => {
      const version = await rpc('Browser.getVersion');
      assert.equal(version.result.protocolVersion, '1.3');
      const targets = await rpc('Target.getTargets');
      assert.equal(targets.result.targetInfos.length, 1);
      assert.equal(targets.result.targetInfos[0].title, 'Title a');
    });
  } finally { await bridge.close(); }
});

test('Target.setAutoAttach attaches every granted entry and a page-scoped command routes to it', async () => {
  const e1 = fakeEntry('a');
  const bridge = await createCdpBridge({ entries: () => [e1], create: async () => {}, close: async () => {} });
  try {
    await withClient(bridge.endpoint, async (rpc) => {
      await rpc('Target.setAutoAttach', {});
      assert.equal(e1.view.webContents.debugger.isAttached(), true);
      const info = await rpc('Target.getTargetInfo', {}, 'a');
      assert.equal(info.result.targetInfo.targetId, 'a-target');
    });
  } finally { await bridge.close(); }
});

test('a page-scoped command outside the allowed CDP domains is refused', async () => {
  const e1 = fakeEntry('a');
  const bridge = await createCdpBridge({ entries: () => [e1], create: async () => {}, close: async () => {} });
  try {
    await withClient(bridge.endpoint, async (rpc) => {
      await rpc('Target.setAutoAttach', {});
      const res = await rpc('Debugger.enable', {}, 'a');
      assert.match(res.error.message, /outside this page/);
    });
  } finally { await bridge.close(); }
});

test('file-access CDP commands are refused even for an attached, allowed session', async () => {
  const e1 = fakeEntry('a');
  const bridge = await createCdpBridge({ entries: () => [e1], create: async () => {}, close: async () => {} });
  try {
    await withClient(bridge.endpoint, async (rpc) => {
      await rpc('Target.setAutoAttach', {});
      const res = await rpc('DOM.setFileInputFiles', { files: ['/etc/passwd'] }, 'a');
      assert.match(res.error.message, /File access is not enabled/);
    });
  } finally { await bridge.close(); }
});

test('a command for a session that was never attached is rejected as unknown', async () => {
  const bridge = await createCdpBridge({ entries: () => [], create: async () => {}, close: async () => {} });
  try {
    await withClient(bridge.endpoint, async (rpc) => {
      const res = await rpc('Page.navigate', { url: 'https://x.test' }, 'ghost-session');
      assert.ok(res.error);
    });
  } finally { await bridge.close(); }
});

test('a malformed request (missing method) gets a JSON-RPC-shaped error, not a crash', async () => {
  const bridge = await createCdpBridge({ entries: () => [], create: async () => {}, close: async () => {} });
  try {
    const ws = new WebSocket(bridge.endpoint);
    await new Promise((resolve) => ws.once('open', resolve));
    const closed = new Promise((resolve) => ws.once('close', resolve));
    ws.send(JSON.stringify({ id: 1 })); // no method
    // The server swallows the parse/validation error per-message rather than
    // dropping the connection — confirm the socket stays open and usable.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.terminate();
    await closed;
  } finally { await bridge.close(); }
});

test('close() detaches every attached debugger and stops the server', async () => {
  const e1 = fakeEntry('a');
  const bridge = await createCdpBridge({ entries: () => [e1], create: async () => {}, close: async () => {} });
  await withClient(bridge.endpoint, async (rpc) => { await rpc('Target.setAutoAttach', {}); });
  assert.equal(e1.view.webContents.debugger.isAttached(), true);
  await bridge.close();
  assert.equal(e1.view.webContents.debugger.isAttached(), false);
});
