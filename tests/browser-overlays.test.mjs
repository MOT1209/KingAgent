// wireBrowserOverlays (src/main/browser-overlays.js) requires('electron') at
// module scope for BrowserWindow/WebContentsView/dialog — no real Electron
// binary runs under `node --test`. This file installs a Module._load hook
// that substitutes a fake 'electron' only while loading this one module,
// then restores the real loader immediately. This was previously at 0%
// coverage with no precedent in this repo for faking 'electron' at all —
// tests/phase5-architecture.test.mjs's own Module._load hook only tracks
// which files got loaded, it never substitutes a module's contents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../src/main/browser-overlays.js');

function fakeElectron() {
  const showMessageBox = { impl: async () => ({ response: 0 }) };
  class FakeWebContentsView {
    constructor(opts) {
      this.opts = opts;
      const wc = new EventEmitter();
      wc.setWindowOpenHandler = () => {};
      wc.loadFile = (p) => { wc.loadedFile = p; };
      wc.setZoomFactor = (z) => { wc.zoom = z; };
      wc.send = (...args) => { wc.sent = wc.sent || []; wc.sent.push(args); };
      wc.close = () => { wc.destroyed = true; };
      wc.isDestroyed = () => !!wc.destroyed;
      this.webContents = wc;
      this.visible = false;
    }
    setBackgroundColor() {}
    setVisible(v) { this.visible = v; }
    setBounds(b) { this.bounds = b; }
  }
  const electron = {
    BrowserWindow: { fromWebContents: (wc) => wc.__window },
    WebContentsView: FakeWebContentsView,
    dialog: { showMessageBox: (...args) => showMessageBox.impl(...args) },
  };
  return { electron, showMessageBox };
}

function fakeWindow() {
  const wc = new EventEmitter();
  wc.mainFrame = {};
  wc.getZoomFactor = () => 1;
  const w = new EventEmitter();
  w.webContents = wc;
  w.getContentBounds = () => ({ width: 1000, height: 700 });
  wc.__window = w;
  let destroyed = false;
  w.isDestroyed = () => destroyed;
  w.closeCalls = 0;
  w.close = () => { w.closeCalls++; if (!destroyed) { destroyed = true; w.emit('closed'); } };
  const added = new Set();
  w.contentView = { addChildView: (v) => added.add(v), removeChildView: (v) => added.delete(v) };
  w._added = added;
  return w;
}

function fakeIpcMain() {
  const handlers = new Map(), listeners = new Map();
  return { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn), _handlers: handlers, _listeners: listeners };
}

function load() {
  const { electron, showMessageBox } = fakeElectron();
  delete require.cache[modulePath];
  const orig = Module._load;
  Module._load = function (request, _parent, _isMain) {
    if (request === 'electron') return electron;
    return orig.apply(this, arguments);
  };
  let wireBrowserOverlays;
  try { ({ wireBrowserOverlays } = require(modulePath)); } finally { Module._load = orig; }
  const ipcMain = fakeIpcMain();
  wireBrowserOverlays(ipcMain);
  return { ipcMain, showMessageBox };
}

test('browser:confirm-discard refuses a sender that is not the window\'s own main frame', async () => {
  const { ipcMain } = load();
  const w = fakeWindow();
  const other = { mainFrame: {} };
  const result = await ipcMain._handlers.get('browser:confirm-discard')({ sender: w.webContents, senderFrame: other.mainFrame }, { count: 2 });
  assert.equal(result, false);
});

test('browser:confirm-discard reports the dialog\'s answer for a legitimate sender', async () => {
  const { ipcMain, showMessageBox } = load();
  const w = fakeWindow();
  showMessageBox.impl = async () => ({ response: 1 });
  const result = await ipcMain._handlers.get('browser:confirm-discard')({ sender: w.webContents, senderFrame: w.webContents.mainFrame }, { count: 3 });
  assert.equal(result, true);
});

test('browser:overlays refuses a payload from a non-mainframe sender', async () => {
  const { ipcMain } = load();
  const w = fakeWindow();
  const result = await ipcMain._handlers.get('browser:overlays')({ sender: w.webContents, senderFrame: {} }, { items: [] });
  assert.deepEqual(result, { ok: false });
});

test('browser:overlays creates a bounded overlay view and renders once loaded', async () => {
  const { ipcMain } = load();
  const w = fakeWindow();
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  const item = { id: 'a', html: '<b>hi</b>', x: 10, y: 20, width: 100, height: 40 };
  const result = await ipcMain._handlers.get('browser:overlays')(event, { items: [item] });
  assert.deepEqual(result, { ok: true });
  assert.equal(w._added.size, 1);
  const [view] = w._added;
  view.webContents.emit('did-finish-load');
  assert.equal(view.visible, true);
  assert.ok(view.webContents.sent.some(([ch, msg]) => ch === 'overlay:render' && msg.id === 'a'));
  assert.equal(view.bounds.x, 10);
  assert.equal(view.bounds.y, 20);
});

test('browser:overlays skips malformed items instead of crashing', async () => {
  const { ipcMain } = load();
  const w = fakeWindow();
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  const bad = { id: 'a', html: 'x', x: 0, y: 0, width: -5, height: 10 };
  const result = await ipcMain._handlers.get('browser:overlays')(event, { items: [bad] });
  assert.deepEqual(result, { ok: true });
  assert.equal(w._added.size, 0);
});

test('browser:overlays removes views whose ids drop out of the next payload', async () => {
  const { ipcMain } = load();
  const w = fakeWindow();
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  await ipcMain._handlers.get('browser:overlays')(event, { items: [{ id: 'a', html: 'x', x: 0, y: 0, width: 10, height: 10 }] });
  assert.equal(w._added.size, 1);
  const [view] = w._added;
  await ipcMain._handlers.get('browser:overlays')(event, { items: [] });
  assert.equal(w._added.size, 0);
  assert.equal(view.webContents.destroyed, true);
});

test('overlay:input routes a well-formed event to the owning window, sanitized', async () => {
  const { ipcMain } = load();
  const w = fakeWindow();
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  await ipcMain._handlers.get('browser:overlays')(event, { items: [{ id: 'a', html: 'x', x: 0, y: 0, width: 10, height: 10 }] });
  const [view] = w._added;
  const sent = [];
  w.webContents.send = (...args) => sent.push(args);
  ipcMain._listeners.get('overlay:input')({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { type: 'input', target: 1, value: 'hello', key: 'a' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'browser:overlay-input');
  assert.equal(sent[0][1].value, 'hello');
});

test('overlay:input drops an event with a disallowed type', async () => {
  const { ipcMain } = load();
  const w = fakeWindow();
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  await ipcMain._handlers.get('browser:overlays')(event, { items: [{ id: 'a', html: 'x', x: 0, y: 0, width: 10, height: 10 }] });
  const [view] = w._added;
  const sent = [];
  w.webContents.send = (...args) => sent.push(args);
  ipcMain._listeners.get('overlay:input')({ sender: view.webContents, senderFrame: view.webContents.mainFrame }, { type: 'wheel', target: 1 });
  assert.equal(sent.length, 0);
});

test('closing a window with pending annotations asks first, and discarding proceeds to close', async () => {
  const { ipcMain, showMessageBox } = load();
  const w = fakeWindow();
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  await ipcMain._handlers.get('browser:overlays')(event, { pendingCount: 1, items: [{ id: 'a', html: 'x', x: 0, y: 0, width: 10, height: 10 }] });
  showMessageBox.impl = async () => ({ response: 1 });
  let prevented = false;
  w.emit('close', { preventDefault: () => { prevented = true; } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(prevented, true);
  assert.equal(w.closeCalls, 1);
});

test('closing a window with pending annotations does not close it when the user keeps the notes', async () => {
  const { ipcMain, showMessageBox } = load();
  const w = fakeWindow();
  const event = { sender: w.webContents, senderFrame: w.webContents.mainFrame };
  await ipcMain._handlers.get('browser:overlays')(event, { pendingCount: 1, items: [{ id: 'a', html: 'x', x: 0, y: 0, width: 10, height: 10 }] });
  showMessageBox.impl = async () => ({ response: 0 });
  let prevented = false;
  w.emit('close', { preventDefault: () => { prevented = true; } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(prevented, true);
  assert.equal(w.closeCalls, 0);
});
