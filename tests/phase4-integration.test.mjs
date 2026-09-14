// Phase 4: integration — the whole pipeline, multi-agent work and review.
//
// §43's path (User → Orchestrator → Router → Agent → Harness → Policy → Sandbox
// → Workspace → Context/Memory → Planning → Tools → Execution → Observation →
// Artifacts → Evaluation → Trace → Completion) exercised through the real
// platform factory: real AgentRuntime, real planner, real tool manager, real
// policy engine, real sandbox manager, real session manager.
//
// Nothing here is mocked except the things a host genuinely owns in production:
// the process spawner and, for external harnesses, the conversation runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { makeTempDir } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const { TYPES } = require('../src/core/events/event-bus');
const { createIpcHandlers } = require('../src/main/agent-platform.js');

// A workspace with something to read, so the deterministic planner can run its
// analyze → read → plan → report loop for real.
async function makeWorkspace() {
  const t = makeTempDir('king-phase4-');
  await fs.writeFile(`${t.root}/README.md`, '# Demo\n\nA small project used by the Phase 4 tests.\n', 'utf8');
  await fs.writeFile(`${t.root}/index.js`, 'export const answer = 42;\n', 'utf8');
  return t;
}

function buildPlatform(t, extra = {}) {
  return createPlatform({
    io: { fs, root: t.root, cwd: () => t.root, ...extra },
    loggerOptions: { level: 'error', sink: { error: () => {}, info: () => {}, warn: () => {}, debug: () => {} } },
  });
}

test('integration: the full pipeline runs a request end to end with correlated events', async () => {
  const t = await makeWorkspace();
  try {
    const platform = buildPlatform(t);
    const events = [];
    platform.bus.on('*', (ev) => events.push(ev));

    const result = await platform.harnessOrchestrator.run('Analyze this project and report what it does', {
      workspace: { root: t.root, cwd: t.root },
      workspaceId: 'demo-workspace',
      strategy: 'capability',
    });

    assert.equal(result.ok, true, JSON.stringify(result.evaluation));
    assert.equal(result.decision.agentId, 'coder');
    assert.equal(result.decision.harnessId, 'kingagent-runtime');
    assert.equal(result.decision.deterministic, true);

    // The task really ran through the Phase 2 runtime.
    const task = platform.runtime.get(result.taskId);
    assert.ok(task);
    assert.equal(task.state, 'completed');
    assert.ok(task.steps.length >= 3);
    assert.equal(task.steps.every((s) => s.status === 'completed'), true);

    // Artifacts carry their provenance.
    assert.ok(result.artifacts.length >= 1, 'a completed run produces at least a report');
    const artifact = result.artifacts[0];
    assert.equal(artifact.taskId, result.taskId);
    assert.equal(artifact.agentId, 'coder');
    assert.equal(artifact.harnessId, 'kingagent-runtime');
    assert.equal(artifact.sessionId, result.sessionId);
    const stored = platform.harnessArtifacts.get(artifact.id);
    assert.ok(stored.content.length > 0);

    // The session is the container: task, agent, artifact and sandbox attached.
    const session = platform.sessions.view(result.sessionId);
    assert.equal(session.state, 'completed');
    assert.ok(session.taskIds.includes(result.taskId));
    assert.ok(session.artifactIds.includes(artifact.id));
    assert.ok(session.agentIds.includes('coder'));
    assert.ok(session.sandboxIds.length >= 1, 'the run happened inside a sandbox');

    // The sandbox is gone, and it never claimed more than it had.
    assert.equal(platform.sandboxes.list().length, 0, 'the sandbox is cleaned up when the run ends');

    // The trace records each orchestration step in order.
    const steps = result.trace.map((e) => e.step);
    for (const expected of ['route', 'policy', 'sandbox', 'runtime.started', 'runtime.settled', 'artifacts', 'evaluate', 'sandbox.stopped']) {
      assert.ok(steps.includes(expected), `trace is missing "${expected}"`);
    }

    // Every PHASE 4 event carries the correlation refs needed to join it back.
    const types = events.map((e) => e.type);
    for (const expected of [TYPES.AGENT_ROUTED, TYPES.POLICY_EVALUATED, TYPES.SANDBOX_CREATED, TYPES.SANDBOX_STARTED, TYPES.SANDBOX_STOPPED, TYPES.SESSION_CREATED, TYPES.SESSION_STARTED, TYPES.SESSION_COMPLETED, TYPES.ARTIFACT_CREATED]) {
      assert.ok(types.includes(expected), `missing ${expected}`);
    }
    const created = events.find((e) => e.type === TYPES.SANDBOX_CREATED);
    assert.equal(created.sessionId, result.sessionId);
    assert.equal(created.agentId, 'coder');
    assert.equal(created.workspaceId, 'demo-workspace');
    assert.ok(created.sandboxId);
    const routed = events.find((e) => e.type === TYPES.AGENT_ROUTED);
    assert.ok(routed.payload.reasons.length > 0, 'the routing decision is explainable after the fact');

    // Nothing was denied on the happy path.
    assert.deepEqual(platform.policy.audit().filter((a) => !a.allowed), []);
    assert.equal(platform.policy.stats().defaultEffect, 'allow');
  } finally {
    t.dispose();
  }
});

test('integration: a workspace is mandatory, and the boundary holds inside it', async () => {
  const t = await makeWorkspace();
  try {
    const platform = buildPlatform(t);
    await assert.rejects(
      () => platform.harnessOrchestrator.run('do something', {}),
      /authorized workspace is required/,
    );
    await assert.rejects(() => platform.harnessOrchestrator.run('', { workspace: t.root }), /a request is required/);
  } finally {
    t.dispose();
  }
});

test('integration: policy can refuse the whole run before anything is created', async () => {
  const t = await makeWorkspace();
  try {
    const platform = buildPlatform(t);
    platform.policy.register({
      id: 'no-runs',
      scope: 'workspace',
      scopeId: 'locked',
      rules: [{ id: 'r', action: 'agent.run', effect: 'deny', reason: 'runs are disabled for this workspace' }],
    }, { source: 'system' });

    const result = await platform.harnessOrchestrator.run('Analyze this project', { workspace: t.root, workspaceId: 'locked' });
    assert.equal(result.ok, false);
    assert.match(result.denied.reason, /runs are disabled/);
    assert.equal(result.taskId, null);
    assert.equal(platform.sandboxes.list().length, 0, 'a denied run never creates a sandbox');
    assert.equal(platform.sessions.list()[0].state, 'failed');

    const audit = platform.policy.audit();
    assert.ok(audit.some((a) => a.action === 'agent.run' && a.allowed === false));
  } finally {
    t.dispose();
  }
});

test('integration: an external harness runs through the same brackets and yields artifacts', async () => {
  const t = await makeWorkspace();
  try {
    const runs = [];
    const platform = buildPlatform(t, {
      harness: {
        transports: {
          codex: {
            start: async (ctx) => { runs.push(['start', ctx.runId, ctx.workspaceId]); return { pid: 1234 }; },
            send: async () => ({ ok: true }),
            stop: async () => { runs.push(['stop']); },
          },
        },
        runner: async ({ harness, workspaceRoot, sandbox }) => {
          runs.push(['run', harness.id, workspaceRoot, sandbox ? sandbox.id : null]);
          return {
            ok: true,
            diff: '--- a/index.js\n+++ b/index.js\n-export const answer = 41;\n+export const answer = 42;\n',
            testResults: { passed: 3, failed: 0, summary: '3 passing' },
            result: { summary: 'fixed the constant' },
          };
        },
      },
    });

    const result = await platform.harnessOrchestrator.run('Fix the bug in index.js', {
      workspace: t.root,
      harnessId: 'codex',
      strategy: 'manual',
      agentId: 'coder',
    });

    assert.equal(result.ok, true, JSON.stringify(result.evaluation));
    assert.equal(result.decision.harnessId, 'codex');
    assert.deepEqual(runs[0][0], 'start');
    assert.deepEqual(runs[1].slice(0, 3), ['run', 'codex', t.root]);
    assert.ok(runs[1][3], 'the harness ran inside a sandbox');
    assert.deepEqual(runs[runs.length - 1], ['stop'], 'the harness run is stopped when it finishes');

    const types = result.artifacts.map((a) => a.type).sort();
    assert.deepEqual(types, ['diff', 'test-result']);
    assert.equal(platform.harnessArtifacts.list({ taskId: result.taskId }).length, 2);
    assert.equal(platform.sandboxes.list().length, 0);
  } finally {
    t.dispose();
  }
});

test('integration: an external harness with no runner explains itself instead of pretending', async () => {
  const t = await makeWorkspace();
  try {
    const platform = buildPlatform(t);
    const result = await platform.harnessOrchestrator.run('Fix the bug', {
      workspace: t.root,
      harnessId: 'codex',
      strategy: 'manual',
      agentId: 'coder',
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /no runner wired/);
    assert.equal(platform.sandboxes.list().length, 0, 'the sandbox is still cleaned up on failure');
  } finally {
    t.dispose();
  }
});

test('integration (IPC): the control center answers the questions the UI asks', async () => {
  const t = await makeWorkspace();
  try {
    const platform = buildPlatform(t);
    const result = await platform.harnessOrchestrator.run('Fix the bug in index.js and run the tests', {
      workspace: t.root,
      workspaceId: 'demo',
    });

    const handlers = new Map();
    createIpcHandlers({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      platform,
      forward: () => {},
    });
    const call = async (channel, payload = {}) => (await handlers.get(channel)({}, payload)).data;

    // §36: the control center, assembled from what each subsystem knows.
    const center = await call('agent:controlCenter', { sessionId: result.sessionId, taskId: result.taskId });
    assert.equal(center.session.state, 'completed');
    assert.equal(center.task.state, 'completed');
    assert.ok(center.task.steps.length >= 3);
    assert.equal(center.harness, 'kingagent-runtime');
    assert.ok(center.trace.some((e) => e.step === 'route'));
    assert.ok(center.policy.length > 0, 'the recent policy decisions ride along');

    // §37: harnesses and their real capabilities.
    const harnessList = await call('agent:harnesses');
    const runtime = harnessList.harnesses.find((h) => h.id === 'kingagent-runtime');
    assert.ok(runtime);
    assert.equal(runtime.supports.supportsFiles, true);
    assert.equal(runtime.supports.supportsStructuredEvents, true);
    assert.equal(harnessList.backends.selected, 'advisory');
    assert.equal(harnessList.backends.enforcement, 'advisory', 'the UI is told this is not kernel isolation');

    // §38: why was something gated or blocked?
    const explain = await call('agent:explainPolicy', { action: 'filesystem.delete' });
    assert.equal(explain.requiresApproval, true);
    assert.match(explain.reason, /irreversib|approval/i);
    assert.equal(explain.scope, 'global');
    assert.ok(explain.chain.includes('global:*'));

    const policies = await call('agent:policies');
    assert.ok(policies.policies.length >= 2);
    assert.equal(policies.stats.defaultEffect, 'allow');
    assert.ok(policies.recent.some((r) => r.action === 'agent.run'));

    // Artifacts: metadata in the list, content only when asked for.
    const listed = await call('agent:artifacts', { taskId: result.taskId });
    assert.ok(listed.length >= 1);
    assert.equal(Object.hasOwn(listed[0], 'content'), false);
    const artifact = await call('agent:artifact', { id: listed[0].id });
    assert.ok(artifact.content.length > 0);

    // A dry-run route creates nothing and explains itself.
    const before = platform.sessions.list().length;
    const dryRun = await call('agent:route', { request: 'Review this repository' });
    assert.ok(dryRun.agentId);
    assert.ok(dryRun.candidates[0].reasons.length > 0);
    assert.equal(platform.sessions.list().length, before, 'a dry run creates no session');
    assert.equal(platform.sandboxes.list().length, 0);

    // Sessions and sandboxes are queryable; nothing is left running.
    assert.ok((await call('agent:sessions')).length >= 1);
    assert.equal((await call('agent:sandboxes')).sandboxes.length, 0);
    assert.deepEqual((await call('agent:delegations', { taskId: result.taskId })).subAgents, []);

    // Cancelling a finished run stops nothing and does not rewrite history.
    const cancelled = await call('agent:cancelTask', { taskId: result.taskId, sessionId: result.sessionId });
    assert.deepEqual(cancelled.harnessRuns, []);
    assert.deepEqual(cancelled.delegations, []);
    assert.equal(platform.sessions.view(result.sessionId).state, 'completed', 'a finished session is not turned into a stopped one');
  } finally {
    t.dispose();
  }
});

test('integration (multi-agent): a lead delegates, collects artifacts, then reviews', async () => {
  const t = await makeWorkspace();
  try {
    const platform = buildPlatform(t);
    const result = await platform.harnessOrchestrator.run('Analyze this project and prepare a technical report', {
      workspace: t.root,
      workspaceId: 'demo',
    });
    const { harnessCoordinator: coordinator, sessions, policy, harnessArtifacts: artifacts } = platform;

    // The lead delegates research and analysis, in parallel, each with its own scope.
    const research = await coordinator.delegate({
      parentTaskId: result.taskId,
      parentAgentId: 'coder',
      childAgentId: 'analyst',
      role: 'research',
      objective: 'Inventory the files and entry points',
      workspaceId: 'demo',
      sessionId: result.sessionId,
      traceId: 'trace-1',
      scope: { paths: ['src/research'] },
    });
    const analysis = await coordinator.delegate({
      parentTaskId: result.taskId,
      parentAgentId: 'coder',
      childAgentId: 'analyst',
      role: 'worker',
      objective: 'Summarize the architecture',
      workspaceId: 'demo',
      sessionId: result.sessionId,
      traceId: 'trace-1',
      scope: { paths: ['src/analysis'] },
    });

    const parallel = await coordinator.runParallel([research.id, analysis.id], {
      runner: async (delegation) => {
        const artifact = artifacts.add({
          type: 'research',
          name: `${delegation.role} notes`,
          content: `${delegation.objective}: done`,
          taskId: result.taskId,
          workspaceId: delegation.workspaceId,
          agentId: delegation.childAgentId,
          sessionId: delegation.sessionId,
          delegationId: delegation.id,
          traceId: delegation.traceId,
        });
        return { artifactId: artifact.id };
      },
    });
    assert.equal(parallel.every((r) => r.status === 'completed'), true);

    for (const row of parallel) {
      coordinator.markComplete(row.delegationId, { summary: 'done', artifactIds: [] });
    }

    // The lead produces the report, then hands it to a reviewer.
    const report = artifacts.add({
      type: 'report',
      name: 'technical report',
      content: 'Findings: two entry points, no tests.',
      taskId: result.taskId,
      workspaceId: 'demo',
      agentId: 'coder',
      sessionId: result.sessionId,
      harnessId: 'kingagent-runtime',
    });
    sessions.attachArtifact(result.sessionId, report.id);

    const bundle = coordinator.buildReview({
      taskId: result.taskId,
      delegationId: analysis.id,
      coderAgentId: 'coder',
      coderHarnessId: 'kingagent-runtime',
      reviewerAgentId: 'analyst',
      diff: '(no diff: analysis only)',
      testResults: { passed: 0, failed: 0 },
      constraints: ['read-only'],
      files: ['README.md', 'index.js'],
    });
    const reviewed = coordinator.recordReview(bundle.reviewId, { verdict: 'accept', notes: 'report is accurate', reviewerAgentId: 'analyst' });
    assert.equal(reviewed.verdict.verdict, 'accept');

    // §44's validate list: permissions, workspace, messages, trace, artifacts, cancellation.
    const view = coordinator.controlView(result.taskId);
    assert.equal(view.subAgents.length, 2);
    assert.deepEqual(view.subAgents.map((s) => s.role).sort(), ['research', 'worker']);
    assert.equal(view.tree.length, 2, 'two independent delegations hang off the task');
    assert.ok(coordinator.messages({ taskId: result.taskId }).length >= 4, 'every exchange went through the protocol');
    assert.ok(view.delegations.every((d) => d.workspaceId === 'demo'), 'each delegation is scoped to the workspace');
    // Children inherit the parent's ceiling and never exceed it: every level a
    // child holds is a level the parent held.
    const parent = platform.agents.get('coder');
    assert.deepEqual(parent.permissions.levels.sort(), ['destructive', 'moderate', 'read_only', 'safe']);
    assert.ok(view.delegations.every((d) => d.permissions.levels.every((l) => parent.permissions.levels.includes(l))));
    assert.ok(view.delegations.every((d) => d.permissions.allowDestructive === parent.permissions.allowDestructive));
    assert.ok(policy.audit().some((a) => a.action === 'agent.delegate'));

    const sessionArtifacts = artifacts.list({ sessionId: result.sessionId });
    assert.ok(sessionArtifacts.length >= 3, 'research, analysis and the report are all attributed to the session');

    // Cancellation only touches work that is still open: the two finished
    // delegations are left alone, the one still running is stopped.
    const stillRunning = await coordinator.delegate({
      parentTaskId: result.taskId,
      parentAgentId: 'coder',
      childAgentId: 'analyst',
      role: 'tester',
      objective: 'Keep verifying until told to stop',
      workspaceId: 'demo',
      scope: { paths: ['src/verify'] },
    });
    coordinator.markRunning(stillRunning.id);
    const cancelled = await coordinator.cancelTask(result.taskId, 'done');
    assert.deepEqual(cancelled, [stillRunning.id]);
    assert.equal(coordinator.getDelegation(stillRunning.id).status, 'cancelled');
    assert.equal(coordinator.getDelegation(research.id).status, 'completed', 'finished work is not retroactively cancelled');
    assert.equal(platform.sandboxes.list().length, 0);
  } finally {
    t.dispose();
  }
});

test('integration (coding agent): implement → review → request fix → re-review → accept', async () => {
  const t = await makeWorkspace();
  try {
    const platform = buildPlatform(t);
    const result = await platform.harnessOrchestrator.run('Fix the bug in index.js, run the tests and review the implementation', {
      workspace: t.root,
      workspaceId: 'demo',
    });
    assert.equal(result.ok, true, JSON.stringify(result.evaluation));

    const { harnessCoordinator: coordinator, harnessArtifacts: artifacts } = platform;

    // First pass: the coder produces a change, the reviewer refuses it.
    const coder = await coordinator.delegate({
      parentTaskId: result.taskId,
      parentAgentId: 'coder',
      childAgentId: 'analyst',
      role: 'worker',
      objective: 'Correct the exported constant',
      workspaceId: 'demo',
      scope: { paths: ['index.js'] },
    });
    coordinator.markRunning(coder.id);
    const diff = artifacts.add({
      type: 'diff',
      name: 'fix attempt 1',
      content: '--- a/index.js\n+++ b/index.js\n+export const answer = 41;\n',
      taskId: result.taskId,
      agentId: 'analyst',
      harnessId: 'claude-code',
      delegationId: coder.id,
    });
    coordinator.markComplete(coder.id, { summary: 'changed the constant', artifactIds: [diff.id] });

    const firstReview = coordinator.buildReview({
      taskId: result.taskId,
      delegationId: coder.id,
      coderAgentId: 'analyst',
      coderHarnessId: 'claude-code',
      reviewerAgentId: 'coder',
      diff: artifacts.get(diff.id).content,
      testResults: { passed: 1, failed: 1, summary: 'expected 42, received 41' },
      constraints: ['the exported value must remain 42'],
    });
    const rejection = coordinator.recordReview(firstReview.reviewId, { verdict: 'request_fix', notes: 'wrong value; tests fail', reviewerAgentId: 'coder' });
    assert.equal(rejection.verdict.verdict, 'request_fix');

    // Recovery: replan and fix, on a different harness — cross-harness review
    // (§32) is nothing more than data, so this needs no special support.
    const retry = await coordinator.delegate({
      parentTaskId: result.taskId,
      parentAgentId: 'coder',
      childAgentId: 'analyst',
      role: 'worker',
      objective: 'Restore the constant to 42',
      workspaceId: 'demo',
      harnessId: 'codex',
      scope: { paths: ['index.js'] },
    });
    const fix = artifacts.add({
      type: 'diff',
      name: 'fix attempt 2',
      content: '--- a/index.js\n+++ b/index.js\n+export const answer = 42;\n',
      taskId: result.taskId,
      agentId: 'analyst',
      harnessId: 'codex',
      delegationId: retry.id,
    });
    const tests = artifacts.add({
      type: 'test-result',
      name: 'suite',
      content: '3 passing',
      taskId: result.taskId,
      agentId: 'analyst',
      harnessId: 'codex',
      delegationId: retry.id,
    });
    coordinator.markComplete(retry.id, { summary: 'constant restored', artifactIds: [fix.id, tests.id] });

    const secondReview = coordinator.buildReview({
      taskId: result.taskId,
      delegationId: retry.id,
      coderAgentId: 'analyst',
      coderHarnessId: 'codex',
      reviewerAgentId: 'coder',
      diff: artifacts.get(fix.id).content,
      testResults: { passed: 3, failed: 0, summary: '3 passing' },
      constraints: ['the exported value must remain 42'],
    });
    const acceptance = coordinator.recordReview(secondReview.reviewId, { verdict: 'accept', notes: 'value restored, tests pass', reviewerAgentId: 'coder' });
    assert.equal(acceptance.verdict.verdict, 'accept');
    assert.equal(secondReview.coder.harnessId, 'codex');

    const attempts = artifacts.list({ taskId: result.taskId, type: 'diff' });
    assert.equal(attempts.length, 2, 'both attempts are preserved with their own provenance');
    assert.deepEqual(attempts.map((a) => a.harnessId).sort(), ['claude-code', 'codex']);

    // A reviewer never received the task history — only evidence.
    const firstBundle = coordinator.getReview(firstReview.reviewId);
    assert.equal(Object.hasOwn(firstBundle, 'history'), false);
    assert.ok(firstBundle.testResults.failed === 1);
  } finally {
    t.dispose();
  }
});

test('integration: cancellation stops task, delegations, harness runs and sandboxes together', async () => {
  const t = await makeWorkspace();
  try {
    const stopped = [];
    const platform = buildPlatform(t, {
      harness: {
        transports: {
          codex: {
            start: async () => { stopped.push('harness-started'); return { pid: 1 }; },
            stop: async () => { stopped.push('harness-stopped'); },
          },
        },
        runner: async () => {
          // Hold the run open so cancellation has something to stop.
          await new Promise((r) => setTimeout(r, 60));
          return { ok: true };
        },
      },
    });

    const running = platform.harnessOrchestrator.run('Fix the bug', {
      workspace: t.root,
      workspaceId: 'demo',
      harnessId: 'codex',
      strategy: 'manual',
      agentId: 'coder',
      taskId: 'task-cancel',
    });
    // Let the sandbox and the harness come up.
    await new Promise((r) => setTimeout(r, 20));
    const cancelled = await platform.harnessOrchestrator.cancel({ sessionId: null, taskId: 'task-cancel', reason: 'user cancelled' });
    await running;

    assert.ok(stopped.includes('harness-started'));
    assert.ok(stopped.includes('harness-stopped'));
    assert.equal(cancelled.harnessRuns.length, 1, 'the harness run that was live is reported as stopped');
    assert.equal(platform.sandboxes.list().length, 0);
    assert.equal(platform.harnessManager.list().length, 0);
  } finally {
    t.dispose();
  }
});
