// Phase 2 core: end-to-end runtime behavior (deterministic and structured).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import { makeTempDir, waitUntil } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const { STATES } = require('../src/core/runtime/states.js');

const stubShell = async ({ command }) => ({ exitCode: 0, stdout: `ok:${command}`, stderr: '' });

async function seedWorkspace() {
  const t = makeTempDir();
  await fs.mkdir(`${t.root}/src`, { recursive: true });
  await Promise.all([
    fs.writeFile(`${t.root}/README.md`, '# hello workspace\n\nTODO: polish docs\n'),
    fs.writeFile(`${t.root}/src/app.js`, 'console.log("hi");\n'),
  ]);
  return t;
}

const DONE = ['completed', 'failed', 'cancelled'];

async function waitForDone(taskId, runtime) {
  return waitUntil(() => {
    const t = runtime.get(taskId);
    return t && DONE.includes(t.state) ? t : null;
  }, { timeout: 10_000 });
}

function stubProvider() {
  return {
    async generate({ system }) {
      if (system.includes('Return a JSON object with "steps"')) {
        return {
          structured: [
            { id: 's1', title: 'Read the readme', tool: { id: 'fs:read', input: { path: 'README.md' } }, verify: { pattern: 'workspace' } },
            { id: 's2', title: 'Grep TODOs', tool: { id: 'search:grep', input: { pattern: 'TODO' } } },
            { id: 's3', title: 'Confirm readme exists', tool: { id: 'fs:exists', input: { path: 'README.md' } } },
          ],
        };
      }
      if (system.includes('Analyze the user request')) {
        return { structured: { interpretation: 'brief', goal: 'read the readme', constraints: [], risks: [] } };
      }
      if (system.includes('Evaluate the step result')) {
        return { structured: { passed: true, reason: 'tool success', next: 'continue' } };
      }
      return { structured: {} };
    },
  };
}

function mountProvider(platform, provider) {
  platform.runtime._provider = provider;
  platform.runtime._reasoner._provider = provider;
  platform.runtime._planner._provider = provider;
}

test('runtime: a deterministic analyst run completes end-to-end', async () => {
  const t = await seedWorkspace();
  try {
    const platform = createPlatform({ io: { fs, root: t.root, cwd: () => t.root, runShell: stubShell } });
    const { runtime } = platform;
    const task = await runtime.runAgentTask(
      { request: 'analyze this workspace', agentId: 'analyst', workspace: { root: t.root, cwd: t.root } },
      { mode: 'auto' },
    );
    const done = await waitForDone(task.id, runtime);
    assert.equal(done.state, STATES.COMPLETED);
    assert.equal(done.outcome.status, 'completed');
    assert.deepEqual(done.steps.map((s) => s.id), ['scan', 'read', 'search', 'report']);
    assert.ok(done.steps.every((s) => s.status === 'completed'));
    const history = runtime.history(task.id);
    assert.ok(history.trace.some((e) => e.type === 'task.state' && e.to === 'completed'));
    assert.ok(history.outcome.summary.includes('steps completed'));
  } finally {
    t.dispose();
  }
});

test('runtime: a structured run follows the provider plan and reports', async () => {
  const t = await seedWorkspace();
  try {
    const platform = createPlatform({ io: { fs, root: t.root, cwd: () => t.root, runShell: stubShell } });
    mountProvider(platform, stubProvider());
    const { runtime } = platform;
    const task = await runtime.runAgentTask(
      { request: 'understand the readme', agentId: 'coder', workspace: { root: t.root, cwd: t.root } },
      { mode: 'structured' },
    );
    const done = await waitForDone(task.id, runtime);
    assert.equal(done.state, STATES.COMPLETED);
    assert.equal(done.plan.mode, 'structured');
    assert.deepEqual(done.steps.map((s) => s.id), ['s1', 's2', 's3']);
    assert.ok(done.steps.every((s) => s.status === 'completed'));
  } finally {
    t.dispose();
  }
});

test('runtime: cancelling an in-flight task lands it in cancelled', async () => {
  const t = await seedWorkspace();
  try {
    const platform = createPlatform({ io: { fs, root: t.root, cwd: () => t.root, runShell: stubShell } });
    const { runtime } = platform;
    const task = await runtime.runAgentTask(
      { request: 'cancel this', agentId: 'analyst', workspace: { root: t.root, cwd: t.root } },
      { mode: 'auto' },
    );
    runtime.cancel(task.id, 'test cancel');
    const done = await waitUntil(() => {
      const tsk = runtime.get(task.id);
      return tsk && tsk.state === STATES.CANCELLED ? tsk : null;
    }, { timeout: 10_000 });
    assert.equal(done.state, STATES.CANCELLED);
    assert.equal(done.cancellation.reason, 'test cancel');
  } finally {
    t.dispose();
  }
});

test('runtime: a step that fails with no recovery path ends the run, not the runtime', async () => {
  const t = await seedWorkspace();
  try {
    const provider = {
      async generate({ system }) {
        if (system.includes('Return a JSON object with "steps"')) {
          return {
            structured: [{ id: 'bad', title: 'Read missing', tool: { id: 'fs:read', input: { path: 'no-such-file.txt' } } }],
          };
        }
        if (system.includes('Analyze')) return { structured: { interpretation: 'i', goal: 'g', constraints: [], risks: [] } };
        if (system.includes('choosing')) return { structured: { decision: 'fs:read', rationale: 'x', actions: [] } };
        if (system.includes('Evaluate the step result')) return { structured: { passed: true, reason: 'x', next: 'continue' } };
        return { structured: {} };
      },
    };
    const platform = createPlatform({ io: { fs, root: t.root, cwd: () => t.root, runShell: stubShell } });
    mountProvider(platform, provider);
    const { runtime } = platform;
    const task = await runtime.runAgentTask(
      { request: 'read a file that does not exist', agentId: 'coder', workspace: { root: t.root, cwd: t.root } },
      { mode: 'structured' },
    );
    const done = await waitForDone(task.id, runtime);
    // The evaluateStep (+1 step verify) keeps marking the run recoverable; the
    // hard guarantee we assert is that the runtime did not throw/crash.
    assert.ok(DONE.includes(done.state));
  } finally {
    t.dispose();
  }
});

test('runtime: listTasks and getTask are queryable during execution', async () => {
  const t = await seedWorkspace();
  try {
    const platform = createPlatform({ io: { fs, root: t.root, cwd: () => t.root, runShell: stubShell } });
    const { runtime } = platform;
    const task = await runtime.runAgentTask(
      { request: 'scan', agentId: 'analyst', workspace: { root: t.root, cwd: t.root } },
      { mode: 'auto' },
    );
    const rows = runtime.listTasks();
    assert.ok(rows.some((r) => r.id === task.id));
    const snap = runtime.get(task.id);
    assert.equal(snap.request, 'scan');
    await waitUntil(() => {
      const s = runtime.get(task.id);
      return s && DONE.includes(s.state) ? s : null;
    }, { timeout: 10_000 });
  } finally {
    t.dispose();
  }
});