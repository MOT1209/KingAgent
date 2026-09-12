// The terminal, as one question: "what shell should this tile run, and how?"
//
// Everything platform-shaped about spawning a shell used to be a decision
// main.js made inline — `process.env.SHELL || (win ? 'powershell.exe' :
// '/bin/zsh')` — which is correct on neither platform half the time: a Windows
// user with pwsh installed got Windows PowerShell 5.1, and a Mac user whose
// SHELL pointed at fish got zsh. This file owns that decision once.
//
// Shells are detected, not assumed: `where.exe` answers what is actually on
// the machine (platform.js windowsShells), pwsh beats powershell 5.1 beats
// cmd.exe, and the answer is memoized for the life of the app — a terminal
// opening must never wait on a probe that already ran. A machine where the
// probe fails entirely still gets cmd.exe, which every Windows has.
//
// Pure where it can be; the probe is injectable so tests never touch a real
// PATH. main.js owns the pty; this owns which program the pty runs.

const {
  windowsShells, defaultTerminalShell, loginShell,
} = require('./platform.js');

// The full decision, injectable end to end:
//   { program, args, kind, id } — program/args go straight to pty.spawn,
//   kind is 'windows' | 'unix', id names the shell for the renderer.
function resolveShell({ platform = process.platform, env = process.env, where = null, probe = null } = {}) {
  if (platform === 'win32') {
    const shells = probe
      ? probe()                                  // tests: precomputed answer
      : windowsShells({ platform, where });      // the real machine
    const program = (shells[0] && shells[0].program) || 'cmd.exe';
    const row = shells.find((s) => s.program === program) || { args: (c) => [c] };
    return { program, args: row.args || ((c) => [c]), kind: 'windows', id: row.id || program };
  }
  // macOS (and Linux): the user's own shell, as KingAgent always did. A GUI
  // launch inherits no SHELL, so zsh is the floor — see platform.js.
  const sh = loginShell(platform, env);
  return { program: sh.file, args: sh.args, kind: 'unix', id: sh.file };
}

// The best shell's id, for the Settings pane and the boot payload. Cheap
// once memoized; wrong never, because it is the same table the pty reads.
let memo = null;
function cachedShell(opts = {}) {
  if (!memo) memo = resolveShell(opts);
  return memo;
}
function resetShellCache() { memo = null; }

module.exports = { resolveShell, cachedShell, resetShellCache, defaultTerminalShell };
