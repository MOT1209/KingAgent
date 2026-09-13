// Cross-platform helpers for the test suite.
//
// The suite was written on macOS: paths are POSIX literals, PATH is joined
// with ':', and symlinks are assumed present. node:test runs the same files on
// Windows in CI, so each of those assumptions gets a home here. Tests that
// exercise the platform's own dialect use these instead of pretending a
// Windows session is a macOS one.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const IS_WINDOWS = process.platform === 'win32';

// A path literal written as '/proj/.claude/agents/x.md' for a POSIX project
// becomes what this platform really joins, so expected and actual compare
// like with like.
export const p = (posix) => posix.split('/').join(path.sep);

// The mirror, for values the code under test returns: fold them back to
// forward slashes so the assertion keeps a readable POSIX literal.
export const posix = (value) => String(value).split(path.sep).join('/');

let symlinkProbe;
// Windows needs Developer Mode or an elevated shell to create symlinks. Probe
// the session once and cache it; tests that genuinely exercise symlink
// behaviour skip when this box cannot grant it.
export async function symlinksSupported() {
  if (symlinkProbe === undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'king-symlink-probe-'));
    let ok = true;
    try {
      fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'dir');
    } catch {
      ok = false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    symlinkProbe = ok;
  }
  return symlinkProbe;
}

// /bin/zsh is macOS's stock shell and not typically installed on Windows or on
// a bare Linux runner. Ask the filesystem instead of assuming: a real probe is
// the only answer that survives every CI image some future workflow runs.
export const HAS_ZSH = (() => {
  try { fs.accessSync('/bin/zsh', fs.constants.X_OK); return true; } catch { return false; }
})();

// Poll `fn` until it returns a truthy value or `timeout` elapses.
export async function waitUntil(fn, { timeout = 6000, interval = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

// A throwaway directory for tests that need real I/O, removed on return.
// Uses fake (never-outward-facing) names so paths never hit the desk.
export function makeTempDir(prefix = 'king-core-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root: dir,
    dispose() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}