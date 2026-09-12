// Phase 2 core: workflow engine execution, approvals, conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeTempDir } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { EventBus } = require('../src/core/events/event-bus.js');
const { WorkflowEngine, INSTANCE_STATUS } = require('../src/core/workflows/engine.js');
const { validateWorkflow, NODE_TYPES } = require('../src/core/workflows/definition.js');
const { ToolManager } = require('../src/core/tools/manager.js');
const { registerBuiltinTools } = require('../src/core/tools/builtin/index.js');
const { CodeExecutor } = require('../src/core/execution/code-exec.js');

const stubShell = async ({ command }) => ({ exitCode: 0, stdout: `out:${command}`, stderr: '' });

function buildEngine({ authorize, root }) {
  const bus = new EventBus();
  const tm = new ToolManager({ bus });
  registerBuiltinTools(tm, {
    fs: require('node:fs/promises'),
    root: root || null,
    cwd: () => root || process.cwd(),
    runShell: stubShell,
  });
  const codeExec = new CodeExecutor();
  const engine = new WorkflowEngine({
    bus,
    toolManager: tm,
    runtime: null,
    shellIo: { run: async (command, opts) => stubShell({ command }) },
    execIo: codeExec,
    authorize: authorize || (async () => true),
  });
  return { engine, tm };
}

const simpleWorkflow = {
  id: 'w-simple',
  name: 'Simple',
  nodes: [
    { id: 'start', type: 'start' },
    { id: 'read', type: 'tool', config: { toolId: 'fs:read', input: { path: 'README.md' } } },
    { id: 'end', type: 'end' },
  ],
  edges: [
    { from: 'start', to: 'read' },
    { from: 'read', to: 'end' },
  ],
};

test('definition: NODE_TYPES is exhaustive and validateWorkflow checks it', () => {
  assert.ok(NODE_TYPES.includes('start'));
  assert.ok(NODE_TYPES.includes('approval'));
  assert.ok(NODE_TYPES.includes('loop'));
  assert.ok(NODE_TYPES.includes('parallel'));
  assert.equal(validateWorkflow(simpleWorkflow).ok, true);
  assert.equal(validateWorkflow({ ...simpleWorkflow, nodes: [] }).ok, false);
  assert.equal(validateWorkflow({ ...simpleWorkflow, nodes: simpleWorkflow.nodes.filter((n) => n.type !== 'start') }).ok, false);
  assert.equal(validateWorkflow({ ...simpleWorkflow, edges: [{ from: 'start', to: 'ghost' }] }).ok, false);
  assert.equal(validateWorkflow(null).ok, false);
});

test('engine: runs start → tool → end and records outputs', async () => {
  const t = makeTempDir();
  try {
    await require('node:fs/promises').writeFile(`${t.root}/README.md`, '# hello\n');
    const { engine } = buildEngine({ root: t.root });
    const inst = await engine.run(simpleWorkflow, { inputs: {} });
    assert.equal(inst.status, INSTANCE_STATUS.COMPLETED);
    assert.equal(inst.workflowId, 'w-simple');
    assert.match(inst.id, /^wf-/);
    const read = inst.nodes.find((n) => n.id === 'read');
    assert.equal(read.status, 'completed');
    assert.equal(read.output.data.content, '# hello\n');
    assert.equal(inst.outputs.read.data.content, '# hello\n');
  } finally {
    t.dispose();
  }
});

test('engine: an approval node that is denied fails the instance', async () => {
  const t = makeTempDir();
  try {
    const { engine } = buildEngine({ root: t.root, authorize: async () => false });
    const wf = {
      ...simpleWorkflow,
      id: 'w-approval',
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ok', type: 'approval', config: {} },
        { id: 'end', type: 'end' },
      ],
      edges: [
        { from: 'start', to: 'ok' },
        { from: 'ok', to: 'end' },
      ],
    };
    const inst = await engine.run(wf, { inputs: {} });
    assert.equal(inst.status, INSTANCE_STATUS.FAILED);
    assert.match(inst.error, /approval denied/);
  } finally {
    t.dispose();
  }
});

test('engine: an approval node that is granted completes normally', async () => {
  const t = makeTempDir();
  try {
    const { engine } = buildEngine({ root: t.root, authorize: async () => true });
    const wf = {
      ...simpleWorkflow,
      id: 'w-approval-ok',
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'ok', type: 'approval', config: {} },
        { id: 'end', type: 'end' },
      ],
      edges: [
        { from: 'start', to: 'ok' },
        { from: 'ok', to: 'end' },
      ],
    };
    const inst = await engine.run(wf, { inputs: {} });
    assert.equal(inst.status, INSTANCE_STATUS.COMPLETED);
  } finally {
    t.dispose();
  }
});

test('engine: command nodes route through the shell adapter', async () => {
  const wf = {
    ...simpleWorkflow,
    id: 'w-cmd',
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'cmd', type: 'command', config: { command: 'whoami' } },
      { id: 'end', type: 'end' },
    ],
    edges: [
      { from: 'start', to: 'cmd' },
      { from: 'cmd', to: 'end' },
    ],
  };
  const { engine } = buildEngine({});
  const inst = await engine.run(wf, { inputs: {} });
  assert.equal(inst.status, INSTANCE_STATUS.COMPLETED);
  const cmd = inst.nodes.find((n) => n.id === 'cmd');
  assert.equal(cmd.output.stdout, 'out:whoami');
});

test('engine: condition edges route on the previous node output', async () => {
  const t = makeTempDir();
  try {
    await require('node:fs/promises').writeFile(`${t.root}/README.md`, '# hello world\n');
    const { engine } = buildEngine({ root: t.root });
    const wf = {
      ...simpleWorkflow,
      id: 'w-cond',
      nodes: [
        { id: 'start', type: 'start' },
        { id: 'read', type: 'tool', config: { toolId: 'fs:read', input: { path: 'README.md' } } },
        { id: 'matched', type: 'tool', config: { toolId: 'fs:exists', input: { path: 'README.md' } } },
        { id: 'end', type: 'end' },
      ],
      edges: [
        { from: 'start', to: 'read' },
        { from: 'read', to: 'matched', when: { read: '/hello/' } },
        { from: 'matched', to: 'end' },
      ],
    };
    const inst = await engine.run(wf, { inputs: {} });
    assert.equal(inst.status, INSTANCE_STATUS.COMPLETED);
    assert.ok(inst.nodes.some((n) => n.id === 'matched' && n.status === 'completed'));
  } finally {
    t.dispose();
  }
});

test('engine: get() returns null for unknown instances', async () => {
  const { engine } = buildEngine({});
  assert.equal(engine.get('nope'), null);
});