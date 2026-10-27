import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { wireAcpLive, AGENT_LAUNCH } = require('../src/main/acp-live.js');

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle: (ch, fn) => handlers.set(ch, fn) };
}
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { writable: true, write() {} };
  proc.killed = 0;
  proc.kill = () => { proc.killed++; };
  return proc;
}
function fakeSender(id) {
  const wc = new EventEmitter();
  wc.id = id;
  wc.sent = [];
  wc.destroyed = false;
  wc.isDestroyed = () => wc.destroyed;
  wc.send = (ch, payload) => { if (wc.destroyed) throw new Error('Object has been destroyed'); wc.sent.push([ch, payload]); };
  return wc;
}
function wire() {
  const ipc = fakeIpcMain();
  const spawned = [];
  wireAcpLive(ipc, { spawn: (cmd, args) => { const p = fakeProc(); spawned.push({ cmd, args, proc: p }); return p; } });
  return { ipc, spawned };
}

test('acp:start runs nothing for an agent it has no launch line for', async () => {
  const { ipc, spawned } = wire();
  const r = await ipc.handlers.get('acp:start')({ sender: fakeSender(1) }, { id: 'a1', agentId: 'evil', command: '/bin/sh', args: ['-c', 'id'] });
  assert.equal(r.ok, false);
  assert.equal(spawned.length, 0);
});

test('acp:start ignores a command and args sent by the renderer', async () => {
  const { ipc, spawned } = wire();
  const r = await ipc.handlers.get('acp:start')({ sender: fakeSender(2) }, { id: 'a2', agentId: 'kimi', command: '/bin/sh', args: ['-c', 'id'] });
  assert.equal(r.ok, true);
  assert.equal(spawned.length, 1);
  assert.notEqual(spawned[0].cmd, '/bin/sh');
  assert.deepEqual(spawned[0].args, ['acp']);
  await ipc.handlers.get('acp:kill')({}, { id: 'a2' });
});

test('output arriving after the window closed does not throw, and the child is ended', async () => {
  const { ipc, spawned } = wire();
  const wc = fakeSender(3);
  await ipc.handlers.get('acp:start')({ sender: wc }, { id: 'a3', agentId: 'opencode' });
  const { proc } = spawned[0];
  proc.stdout.emit('data', Buffer.from('{"jsonrpc":"2.0"}\nnot json\n'));
  assert.deepEqual(wc.sent.map(([ch]) => ch), ['acp:msg', 'acp:err']);
  wc.destroyed = true;
  wc.emit('destroyed');
  assert.equal(proc.killed, 1, 'closing the window ends its ACP children');
  assert.doesNotThrow(() => proc.stdout.emit('data', Buffer.from('{"late":1}\n')));
  assert.doesNotThrow(() => proc.stderr.emit('data', Buffer.from('late stderr')));
  assert.doesNotThrow(() => proc.emit('exit', 0));
});

test('a line with no break is dropped past the cap instead of growing forever', async () => {
  const { ipc, spawned } = wire();
  const wc = fakeSender(4);
  await ipc.handlers.get('acp:start')({ sender: wc }, { id: 'a4', agentId: 'grok' });
  spawned[0].proc.stdout.emit('data', Buffer.alloc(5 * 1024 * 1024, 'x'));
  assert.equal(wc.sent.length, 1);
  assert.equal(wc.sent[0][0], 'acp:err');
  assert.match(wc.sent[0][1].text, /dropped/);
  await ipc.handlers.get('acp:kill')({}, { id: 'a4' });
});

test("the renderer's Chat list and main's launch table name the same agents", () => {
  const src = readFileSync(new URL('../src/renderer/acp-pane.mjs', import.meta.url), 'utf8');
  const m = /export const CHAT_READY = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'CHAT_READY is a literal list');
  const ids = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(ids.sort(), Object.keys(AGENT_LAUNCH).sort());
});
