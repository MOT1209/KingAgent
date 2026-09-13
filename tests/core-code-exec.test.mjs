// Phase 2 core: code execution — the isolated-process JS engine, registration,
// default-off safety, and the escape/timeout proofs from the 2026-09 security
// audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodeExecutor, CodeExecutionError, runJavaScript } = require('../src/core/execution/code-exec.js');

const HOST_PROBE_KEY = 'KINGAGENT_SANDBOX_PROBE';

test('the executor ships with NO engines registered by default', () => {
  const e = new CodeExecutor();
  assert.deepEqual(e.available(), []);
  assert.equal(e.isEnabled('js'), false);
});

test('registerDefaults: true registers the js engine explicitly', () => {
  const e = new CodeExecutor({ registerDefaults: true });
  assert.ok(e.isEnabled('js'));
  assert.deepEqual(e.available(), ['js']);
});

test('default-off execution fails loudly, not silently', async () => {
  const e = new CodeExecutor();
  await assert.rejects(
    () => e.execute({ lang: 'js', code: '1 + 1' }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_NOT_ENABLED',
  );
});

test('register/unregister swap engines and reject non-functions', () => {
  const e = new CodeExecutor({ registerDefaults: false });
  assert.throws(() => e.register('x', 42), TypeError);
  e.register('x', async () => ({ ok: true }));
  assert.ok(e.isEnabled('x'));
  assert.equal(e.unregister('x'), true);
  assert.equal(e.isEnabled('x'), false);
});

test('execute runs JS and returns a structured result with a real duration', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  const r = await e.execute({ lang: 'js', code: '1 + 2' });
  assert.equal(r.ok, true);
  assert.equal(r.lang, 'js');
  assert.ok(r.result.defined);
  assert.equal(r.result.text, '3');
  assert.equal(typeof r.durationMs, 'number');
});

test('execute captures console output into stdout', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  const r = await e.execute({ lang: 'js', code: 'console.log("hello"); const a = 2; console.log(a * 3)' });
  assert.match(r.stdout, /hello/);
  assert.match(r.stdout, /6/);
});

test('an unregistered language fails loudly, not silently', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  await assert.rejects(
    () => e.execute({ lang: 'python', code: 'print(1)' }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_NOT_ENABLED' && /python/.test(err.message),
  );
});

test('an empty script is rejected before the sandbox opens', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  await assert.rejects(
    () => e.execute({ lang: 'js', code: '   ' }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_EMPTY',
  );
});

test('the default language surface has no require, no process, no host timers', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  const r = await e.execute({ lang: 'js', code: 'JSON.stringify({ require: typeof require, process: typeof process, setTimeout: typeof setTimeout })' });
  assert.equal(r.result.text, '{"require":"undefined","process":"undefined","setTimeout":"undefined"}');
});

// The audit's central finding: vm contexts are escapable via the host functions
// handed to them. The fix is not to "harden" the vm — it is to make the escape
// land in a disposable child process, never the host. These three tests prove
// that containment.
test('a constructor-based escape reaches a CHILD process, never the host', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  // The host never saw this key on purpose: it is NOT in the sandbox env
  // whitelist, so even a successful escape must not be able to read it.
  process.env[HOST_PROBE_KEY] = 'host-only-secret';
  try {
    const code =
      'const F = console.log.constructor;\n' +
      "const p = F('return process')();\n" +
      'JSON.stringify({ pid: p.pid, probe: (p.env && p.env.KINGAGENT_SANDBOX_PROBE) || null });';
    const r = await e.execute({ lang: 'js', code });
    const out = JSON.parse(r.result.text);
    assert.equal(typeof out.pid, 'number');
    assert.notEqual(out.pid, process.pid, 'escaped process is the host process');
    assert.equal(out.probe, null, 'escaped process can read host-only env');
  } finally {
    delete process.env[HOST_PROBE_KEY];
  }
});

test('an escaped sync loop cannot hold the host: the timed-out child is killed', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  const started = Date.now();
  // `new Function` escapes to the child's realm, where vm's timeout cannot
  // interrupt it. Only the parent's kill can. This is exactly the async/escape
  // union from the audit.
  await assert.rejects(
    () => e.execute({ lang: 'js', code: 'const F = console.log.constructor; F("while (true) {}")();', timeout: 250 }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_TIMEOUT',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 8_000, `timeout takes ${elapsed}ms, far beyond a forced kill`);
});

test('a runaway loop is cut off by the wall-clock timeout', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  const started = Date.now();
  await assert.rejects(
    () => e.execute({ lang: 'js', code: 'while (true) {}', timeout: 200 }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_TIMEOUT',
  );
  assert.ok(Date.now() - started < 10_000, 'timeout fires promptly');
});

test('a cancelled signal aborts execution before it starts', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => e.execute({ lang: 'js', code: '1 + 1', signal: ac.signal }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_CANCELLED',
  );
});

test('the sandbox env is injected-only, empty by default, and frozen', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  const base = await e.execute({ lang: 'js', code: 'JSON.stringify(env)' });
  assert.equal(base.result.text, '{}');
  const readonly = await e.execute({ lang: 'js', code: 'env.HACK = "yes"; String(env.HACK)' });
  assert.equal(readonly.result.text, 'undefined');
  const injected = await e.execute({ lang: 'js', code: 'env.MY_INJECTED', env: { MY_INJECTED: '42' } });
  assert.equal(injected.result.text, '42');
});

test('a script that throws surfaces as CODE_EXECUTION_ERROR', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  await assert.rejects(
    () => e.execute({ lang: 'js', code: 'throw new Error("boom")' }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_ERROR' && /boom/.test(err.message),
  );
});

test('runJavaScript is exported and standalone', async () => {
  const r = await runJavaScript({ code: 'new Map([["a", 1]]).get("a")' });
  assert.equal(r.ok, true);
  assert.equal(r.result.text, '1');
});

test('execution result payloads stay small and serialisable', async () => {
  const e = new CodeExecutor({ registerDefaults: true });
  const r = await e.execute({ lang: 'js', code: '({ nested: { deep: [1, 2, { three: 3 }] } })' });
  const json = JSON.stringify(r.result);
  assert.ok(json.length > 0);
  assert.ok(json.length < 5_000, 'result is bounded, not a dump');
});