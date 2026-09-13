// Phase 2 core: tool manager, permissions, built-in tools, path guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { makeTempDir } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { EventBus } = require('../src/core/events/event-bus.js');
const { validateToolDefinition, PERMISSIONS } = require('../src/core/tools/definition.js');
const { ToolManager, ToolDeniedError, ToolError } = require('../src/core/tools/manager.js');
const { registerBuiltinTools } = require('../src/core/tools/builtin/index.js');
const { resolveWithin, assertWithin, realContains } = require('../src/core/tools/path-guard.js');

const noopAgent = (over = {}) => ({
  id: 'tester',
  name: 'Tester',
  capabilities: ['read', 'write', 'shell', 'code_search'],
  permissions: { levels: ['read_only', 'safe', 'moderate'], allowDestructive: false, denyTools: [] },
  model: { provider: 'unset', id: 'default' },
  tools: [],
  ...over,
});

function makeManager({ authorize } = {}) {
  const tm = new ToolManager({ bus: new EventBus(), authorize });
  registerBuiltinTools(tm, {
    fs: require('node:fs/promises'),
    root: null,
    cwd: () => process.cwd(),
    runShell: async ({ command }) => ({ exitCode: 0, stdout: `out:${command}`, stderr: '' }),
  });
  return tm;
}

test('definition: validates ids, names and execute presence', () => {
  assert.equal(validateToolDefinition({ id: 'x:y', name: 'n', description: 'd', execute() {} }).ok, true);
  assert.equal(validateToolDefinition({ id: 'No', name: 'n', description: 'd', execute() {} }).ok, false);
  assert.equal(validateToolDefinition({ id: 'fs:read', name: ' ', description: 'd', execute() {} }).ok, false);
  assert.equal(validateToolDefinition({ id: 'fs:read', name: 'n', description: 'd' }).ok, false);
  assert.equal(validateToolDefinition({ id: 'sys:x', name: 'n', description: 'd', execute() {}, permissions: { level: 'system' } }).ok, false);
});

test('tool-manager: builtins register as a closed set (fs+search+git+terminal with runShell)', () => {
  const tm = makeManager();
  const ids = tm.list().map((t) => t.id).sort();
  assert.deepEqual(ids, [
    'fs:delete', 'fs:exists', 'fs:list', 'fs:mkdir', 'fs:read', 'fs:write',
    'git:diff', 'git:log', 'git:status',
    'search:grep', 'terminal:run',
  ]);
});

test('tool-manager: duplicate register throws', () => {
  const tm = new ToolManager({ bus: new EventBus() });
  tm.register({ id: 'dup', name: 'Dup', description: 'd', execute() {} });
  assert.throws(() => tm.register({ id: 'dup', name: 'Dup2', description: 'd', execute() {} }), /already registered/);
});

test('tool-manager: moderate agent misses destructive tools (incl. terminal:run); discovery reflects it', async () => {
  const tm = makeManager();
  const discovered = tm.discover(noopAgent()).sort();
  assert.deepEqual(discovered, [
    'fs:exists', 'fs:list', 'fs:mkdir', 'fs:read', 'fs:write',
    'git:diff', 'git:log', 'git:status', 'search:grep',
  ]);
  await assert.rejects(
    tm.execute({ id: 'fs:delete', input: { path: 'x' }, agent: noopAgent() }),
    (err) => err instanceof ToolDeniedError && err.code === 'TOOL_DENIED',
  );
});

test('tool-manager: destructive tool runs only when the agent grants it AND the authorization gate approves', async () => {
  const t = makeTempDir();
  try {
    const asked = [];
    const tm = new ToolManager({
      bus: new EventBus(),
      authorize: async ({ tool }) => { asked.push(tool.id); return true; },
    });
    registerBuiltinTools(tm, { fs: require('node:fs/promises'), root: t.root, cwd: () => t.root, runShell: null });
    const agent = noopAgent({ permissions: { levels: ['read_only', 'safe', 'moderate', 'destructive'], allowDestructive: true } });
    await tm.execute({ id: 'fs:write', input: { path: 'gone.txt', content: 'x' }, agent });
    const res = await tm.execute({ id: 'fs:delete', input: { path: 'gone.txt' }, agent });
    assert.equal(res.toolId, 'fs:delete');
    assert.deepEqual(asked, ['fs:delete'], 'authorization gate was consulted exactly once for the destructive call');
  } finally {
    t.dispose();
  }
});

test('tool-manager: a denied requiresAuth decision surfaces as a denial and asked exactly once', async () => {
  const asked = [];
  const tm = new ToolManager({ bus: new EventBus(), authorize: async ({ tool }) => { asked.push(tool.id); return false; } });
  tm.register({
    id: 'cust:auth',
    name: 'Auth tool',
    description: 'd',
    permissions: { level: PERMISSIONS.READ_ONLY, requiresAuth: true },
    async execute() { return { ok: true }; },
  });
  await assert.rejects(
    tm.execute({ id: 'cust:auth', input: {}, agent: noopAgent() }),
    (err) => err instanceof ToolDeniedError && err.reason === 'authorization denied',
  );
  assert.deepEqual(asked, ['cust:auth']);
});

test('tool-manager: an approved requiresAuth call proceeds', async () => {
  const tm = new ToolManager({ bus: new EventBus(), authorize: async () => true });
  tm.register({
    id: 'cust:auth2',
    name: 'Auth tool 2',
    description: 'd',
    permissions: { level: PERMISSIONS.READ_ONLY, requiresAuth: true },
    execute() { return 'did it'; },
  });
  const res = await tm.execute({ id: 'cust:auth2', input: {}, agent: noopAgent() });
  assert.equal(res.data, 'did it');
});

test('tool-manager: tool timeouts classify as TOOL_TIMEOUT', async () => {
  const tm = new ToolManager({ bus: new EventBus() });
  tm.register({
    id: 'slow:t',
    name: 'Slow',
    description: 'd',
    timeoutMs: 40,
    async execute() { await new Promise((r) => setTimeout(r, 500)); return 1; },
  });
  await assert.rejects(
    tm.execute({ id: 'slow:t', input: {}, agent: noopAgent() }),
    (err) => err.code === 'TOOL_TIMEOUT',
  );
});

test('tool-manager: input validation rejects a missing required field with TOOL_INVALID_INPUT', async () => {
  const tm = new ToolManager({ bus: new EventBus() });
  tm.register({
    id: 'in:req',
    name: 'Req',
    description: 'd',
    inputSchema: { type: 'object', properties: { path: { type: 'string', required: true } } },
    execute() { return 1; },
  });
  await assert.rejects(
    tm.execute({ id: 'in:req', input: {}, agent: noopAgent() }),
    (err) => err.code === 'TOOL_INVALID_INPUT',
  );
});

test('builtin: fs:list/read/write/delete round-trip inside a real temp dir', async () => {
  const t = makeTempDir();
  try {
    const tm = new ToolManager({ bus: new EventBus(), authorize: async () => true });
    registerBuiltinTools(tm, { fs: require('node:fs/promises'), root: t.root, cwd: () => t.root, runShell: null });
    const agent = noopAgent();

    await tm.execute({ id: 'fs:write', input: { path: 'a/b.txt', content: 'hello\nworld\n' }, agent });
    const listed = await tm.execute({ id: 'fs:list', input: { path: '.', recursive: true }, agent });
    const files = listed.data.entries.filter((e) => e.type === 'file');
    assert.ok(files.some((e) => e.path === 'a/b.txt' || e.path === 'a\\b.txt'), JSON.stringify(files));

    const read = await tm.execute({ id: 'fs:read', input: { path: 'a/b.txt' }, agent });
    assert.equal(read.data.content, 'hello\nworld\n');

    await tm.execute({ id: 'fs:delete', input: { path: 'a/b.txt' }, agent: noopAgent({ permissions: { levels: ['read_only', 'safe', 'moderate', 'destructive'], allowDestructive: true } }) });
    const exists = await tm.execute({ id: 'fs:exists', input: { path: 'a/b.txt' }, agent });
    assert.equal(exists.data.exists, false);
  } finally {
    t.dispose();
  }
});

test('builtin: search:grep finds matches with line numbers', async () => {
  const t = makeTempDir();
  try {
    const tm = new ToolManager({ bus: new EventBus() });
    registerBuiltinTools(tm, { fs: require('node:fs/promises'), root: t.root, cwd: () => t.root, runShell: null });
    const agent = noopAgent();
    await tm.execute({ id: 'fs:write', input: { path: 'code.js', content: 'const TODO = "fix me";\n' }, agent });
    const res = await tm.execute({ id: 'search:grep', input: { pattern: 'TODO', maxResults: 10 }, agent });
    assert.ok(res.data.matches.length >= 1);
    assert.equal(res.data.matches[0].line, 1);
  } finally {
    t.dispose();
  }
});

test('builtin: fs:read cannot escape the workspace root', async () => {
  const t = makeTempDir();
  try {
    const tm = new ToolManager({ bus: new EventBus() });
    registerBuiltinTools(tm, { fs: require('node:fs/promises'), root: t.root, cwd: () => t.root, runShell: null });
    await assert.rejects(
      tm.execute({ id: 'fs:read', input: { path: '../outside.txt' }, agent: noopAgent() }),
      (err) => err instanceof ToolError || err.code === 'TOOL_FAILURE',
    );
  } finally {
    t.dispose();
  }
});

test('path-guard: containment is exact and OS-correct', () => {
  const t = makeTempDir();
  try {
    const root = t.root;
    assert.equal(resolveWithin(root, 'a.txt'), path.join(root, 'a.txt'));
    assert.equal(resolveWithin(root, '.'), path.resolve(root));
    assert.equal(resolveWithin(root, '..'), null);
    assert.equal(resolveWithin(root, '../x'), null);
    assert.equal(resolveWithin(null, '/abs/anywhere'), path.resolve('/abs/anywhere'));
  } finally {
    t.dispose();
  }
});

test('builtin: terminal:run only exists when a runShell adapter is provided', () => {
  const withShell = makeManager();
  assert.ok(withShell.get('terminal:run'));
  const bare = new ToolManager({ bus: new EventBus() });
  registerBuiltinTools(bare, { fs: require('node:fs/promises'), root: null, cwd: () => process.cwd(), runShell: null });
  assert.equal(bare.get('terminal:run'), undefined);
});

test('builtin: git tools run through the injected shell adapter', async () => {
  const tm = makeManager();
  const res = await tm.execute({ id: 'git:status', input: {}, agent: noopAgent() });
  assert.equal(res.data.stdout, 'out:git');
});

// Phase 2: symlink escape containment
let symlinksWork = true;
{
  const probe = path.join(os.tmpdir(), `pg-probe-${Date.now()}.txt`);
  const link = `${probe}.lnk`;
  try {
    await fs.writeFile(probe, 'probe');
    await fs.symlink(probe, link, 'file');
    await fs.rm(link, { force: true });
  } catch {
    symlinksWork = false; // Windows without Developer Mode / CI runners
  } finally {
    await fs.rm(probe, { force: true });
  }
}

test('path-guard: a symlink pointing outside the root is rejected', async (t) => {
  if (!symlinksWork) return t.skip('symlinks unavailable on this host');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-sym-'));
  const outsideFile = path.join(os.tmpdir(), 'pg-outside.txt');
  await fs.writeFile(outsideFile, 'secret');
  try {
    const link = path.join(tmp, 'escapee');
    await fs.symlink(outsideFile, link, 'file');

    assert.equal(resolveWithin(tmp, 'escapee'), link, 'resolveWithin is lexical; a symlink looks like a sibling');
    await assert.rejects(
      () => assertWithin(tmp, 'escapee'),
      (err) => /symlink/.test(String(err)),
    );

    const insideLink = path.join(tmp, 'inside');
    const innerTarget = path.join(tmp, 'ok.txt');
    await fs.writeFile(innerTarget, 'ok');
    await fs.symlink(innerTarget, insideLink, 'file');
    assert.equal(assertWithin(tmp, 'inside'), innerTarget, 'symlink pointing inside resolves to the real target');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.rm(outsideFile, { force: true });
  }
});

test('path-guard: realContains detects escapes on real paths', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-real-'));
  const real = require('node:fs').realpathSync;
  try {
    const dir = path.join(tmp, 'a', 'b');
    await fs.mkdir(dir, { recursive: true });
    assert.equal(realContains(tmp, path.resolve(tmp, 'a/b'), real), path.resolve(tmp, 'a/b'), 'nested path is inside');

    const file = path.join(tmp, 'out.txt');
    await fs.writeFile(file, 'secret');
    assert.equal(realContains(tmp, path.resolve(tmp, '..', 'out.txt'), real), null, 'path traversal is outside');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});