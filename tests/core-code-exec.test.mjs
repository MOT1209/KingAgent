// Phase 2 core: code execution — the sandbox JS engine, registration, safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodeExecutor, CodeExecutionError, runJavaScript } = require('../src/core/execution/code-exec.js');

test('executor is enabled for js by default and reports availability', () => {
  const e = new CodeExecutor();
  assert.ok(e.isEnabled('js'));
  assert.deepEqual(e.available(), ['js']);
  assert.equal(e.isEnabled('python'), false);
});

test('constructor flag can leave an executor empty', () => {
  const e = new CodeExecutor({ registerDefaults: false });
  assert.deepEqual(e.available(), []);
  assert.equal(e.isEnabled('js'), false);
});

test('register/unregister swap engines and reject non-functions', () => {
  const e = new CodeExecutor({ registerDefaults: false });
  assert.throws(() => e.register('x', 42), TypeError);
  e.register('x', async () => ({ ok: true }));
  assert.ok(e.isEnabled('x'));
  assert.equal(e.unregister('x'), true);
  assert.equal(e.isEnabled('x'), false);
});

test('execute runs JS and returns a structured result', async () => {
  const e = new CodeExecutor();
  const r = await e.execute({ lang: 'js', code: '1 + 2' });
  assert.equal(r.ok, true);
  assert.equal(r.lang, 'js');
  assert.ok(r.result.defined);
  assert.equal(r.result.text, '3');
});

test('execute captures console output into stdout', async () => {
  const e = new CodeExecutor();
  const r = await e.execute({ lang: 'js', code: 'console.log("hello"); const a = 2; console.log(a * 3)' });
  assert.match(r.stdout, /hello/);
  assert.match(r.stdout, /6/);
});

test('an unregistered language fails loudly, not silently', async () => {
  const e = new CodeExecutor();
  await assert.rejects(
    () => e.execute({ lang: 'python', code: 'print(1)' }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_NOT_ENABLED' && /python/.test(err.message),
  );
});

test('an empty script is rejected before the sandbox opens', async () => {
  const e = new CodeExecutor();
  await assert.rejects(
    () => e.execute({ lang: 'js', code: '   ' }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_EMPTY',
  );
});

test('the sandbox has no require and no host process', async () => {
  const e = new CodeExecutor();
  const r = await e.execute({ lang: 'js', code: 'typeof require' });
  assert.equal(r.result.text, 'undefined');
  const r2 = await e.execute({ lang: 'js', code: 'typeof process' });
  assert.equal(r2.result.text, 'undefined');
});

test('a script that throws surfaces as CODE_EXECUTION_ERROR', async () => {
  const e = new CodeExecutor();
  await assert.rejects(
    () => e.execute({ lang: 'js', code: 'throw new Error("boom")' }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_ERROR' && /boom/.test(err.message),
  );
});

test('a runaway loop is cut off by the wall-clock timeout', async () => {
  const e = new CodeExecutor();
  const started = Date.now();
  await assert.rejects(
    () => e.execute({ lang: 'js', code: 'while (true) {}', timeout: 200 }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_TIMEOUT',
  );
  assert.ok(Date.now() - started < 10_000, 'timeout fires promptly');
});

test('a cancelled signal aborts execution before it starts', async () => {
  const e = new CodeExecutor();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => e.execute({ lang: 'js', code: '1 + 1', signal: ac.signal }),
    (err) => err instanceof CodeExecutionError && err.code === 'CODE_EXECUTION_CANCELLED',
  );
});

test('runJavaScript is exported and standalone', async () => {
  const r = await runJavaScript({ code: 'new Map([["a", 1]]).get("a")' });
  assert.equal(r.ok, true);
  assert.equal(r.result.text, '1');
});

test('execution result payloads stay small and serialisable', async () => {
  const e = new CodeExecutor();
  const r = await e.execute({ lang: 'js', code: '({ nested: { deep: [1, 2, { three: 3 }] } })' });
  const json = JSON.stringify(r.result);
  assert.ok(json.length > 0);
  assert.ok(json.length < 5_000, 'result is bounded, not a dump');
});