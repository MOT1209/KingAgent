// Shell adapter for the platform's terminal:run tool.
//
// The core layer tools call `io.runShell({ command, cwd, timeoutMs, signal, env })`
// and get `{ exitCode, stdout, stderr }` back. This adapter fulfills that
// contract with child_process, honoring the caller's environment instead of
// hardcoding `/bin/bash` or `C:\...` paths — resolution is via ComSpec on
// Windows and $SHELL (fallback `sh`) elsewhere, exactly like the existing
// terminal does.
//
// It exists only to give core tools a host to run on. The interactive xterm
// sessions powering KingAgent's terminal pane are untouched.

const { spawn } = require('node:child_process');

function createRunShell({ defaultCwd } = {}) {
  return function runShell({ command, cwd, timeoutMs = 60_000, env, signal }) {
    if (typeof command !== 'string' || command.trim() === '') {
      return Promise.reject(new Error('runShell requires a command string'));
    }
    const workdir = cwd || defaultCwd || process.cwd();
    const shellCommand = process.platform === 'win32'
      ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
      : { cmd: process.env.SHELL || 'sh', args: ['-c', command] };

    return new Promise((resolve) => {
      const child = spawn(shellCommand.cmd, shellCommand.args, {
        cwd: workdir,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        shell: false,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (exitCode) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve({ exitCode, stdout, stderr });
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(124); // timeout exit code like `timeout(1)`
      }, timeoutMs);

      const onAbort = () => {
        child.kill('SIGKILL');
        finish(130); // 128 + SIGINT
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      child.stdout.on('data', (d) => { stdout += d.toString(); if (stdout.length > 2_000_000) child.stdout.pause(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (err) => { stderr += `\n${err.message}`; finish(-1); });
      child.on('close', (code) => finish(code == null ? -1 : code));
    });
  };
}

module.exports = { createRunShell };