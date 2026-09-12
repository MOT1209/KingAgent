// Everything Nami assumes about the operating system, in one place.
//
// These assumptions used to be scattered as literals: '/bin/zsh' in four call
// sites, `command -v` inside a template string, three absolute paths where
// Claude Code might live, and a macOS-only titleBarStyle. Each was correct and
// each was invisible — nothing named them as platform decisions, so a port
// meant finding them by failure rather than by reading.
//
// Nami ships macOS-only on purpose (see the shipping spec), so the darwin
// column is the one that is exercised and verified. The win32 column is written
// from the documented install paths of each tool and is NOT verified — it
// exists so that adding Windows is filling in a table rather than an
// excavation, and every entry in it should be treated as a hypothesis until it
// has run on a real Windows machine.
//
// Pure by design: no electron, no fs, no process spawning, and platform is
// always a parameter. That keeps it testable from `node --test`, which cannot
// pretend to be Windows any other way.

const WIN = 'win32';
const MAC = 'darwin';

// "PowerShell" on Windows means five different things, and a terminal that
// guesses wrong ships a shell the user does not have. One table:
//
//   id       what it is                    where it comes from
//   pwsh     PowerShell 7+, standalone     its own installer / winget / scoop
//   powershell  Windows PowerShell 5.1     ships with every Windows, always there
//   cmd      cmd.exe                       ships with every Windows, always there
//
// pwsh is preferred when it exists — it is the maintained one, and PS 5.1 is
// in support mode. `where` is injectable so a test can pretend any machine.
const WINDOWS_SHELLS = [
  { id: 'pwsh', program: 'pwsh.exe', args: (cmd) => ['-NoLogo', '-Command', cmd] },
  { id: 'powershell', program: 'powershell.exe', args: (cmd) => ['-NoLogo', '-Command', cmd] },
  { id: 'cmd', program: 'cmd.exe', args: (cmd) => ['/k', cmd] },
];

// Probe for an executable on PATH, the way a Windows machine answers.
// `where` exits 1 with no output when the name matches nothing, which is
// exactly the "no" we want; anything else is treated as a found path.
function windowsShells({ platform = process.platform, where = null } = {}) {
  if (platform !== WIN) return [];
  const probe = where || ((name) => {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('where.exe', [name], { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
      const first = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      return first || null;
    } catch (_) { return null; }
  });
  return WINDOWS_SHELLS
    .map((s) => ({ ...s, path: probe(s.program) }))
    .filter((s) => s.path);
}

// The program a terminal tile should spawn on this platform, best first.
// macOS keeps the zsh it has always had; Windows gets the best shell that is
// actually installed — and cmd.exe as the floor, which always is.
function defaultTerminalShell({ platform = process.platform, shells = null } = {}) {
  if (platform === MAC) return '/bin/zsh';
  if (platform !== WIN) return '/bin/zsh';
  const list = shells === null ? windowsShells({ platform }) : shells;
  return (list[0] && list[0].program) || 'cmd.exe';
}

// Default user-level folders per platform. app.getPath() is the right answer
// where Electron runs; these name the same places for tests and for code that
// has no app object yet. Every entry is optional — a missing env var drops it.
function userDirs({ platform = process.platform, home = '', env = {} } = {}) {
  const join = (...parts) => parts.filter(Boolean).join(platform === WIN ? '\\' : '/');
  if (platform === WIN) {
    return {
      documents: join(env.USERPROFILE, 'Documents'),
      downloads: join(env.USERPROFILE, 'Downloads'),
      desktop: join(env.USERPROFILE, 'Desktop'),
      home: join(env.USERPROFILE),
    };
  }
  return {
    documents: join(home, 'Documents'),
    downloads: join(home, 'Downloads'),
    desktop: join(home, 'Desktop'),
    home,
  };
}

// app.getPath('cache') does not exist on Windows: Electron maps it to
// %LOCALAPPDATA% there but refuses the name outright on macOS, where the
// per-user cache root is ~/Library/Caches. One function, so the updater cache
// path stops being a platform decision scattered through main.js.
function cacheDir({ platform = process.platform, home = '', env = {}, name = 'kingagent-updater' } = {}) {
  if (platform === WIN) {
    const base = env.LOCALAPPDATA || join(env.USERPROFILE, 'AppData', 'Local');
    return join(base, name);
  }
  return join(home, 'Library', 'Caches', name);
}

// The dot-folder in $HOME where KingAgent keeps masters and bundles. Nami used
// `.nami`; the rename is the brand's, applied deliberately and once.
const APP_DATA_DIRNAME = '.kingagent';

// The product name, wherever a main-process module needs it for UI strings.
// electron-builder's productName is the packaging truth; this is the runtime one.
const APP_NAME = 'KingAgent';

// The string a repo name is turned into for display. Split out so the update
// feed can name a repo without every caller hard-coding it.
const PUBLISH_REPO = 'MOT1209/KingAgent';

// Quote one argument for PowerShell. Windows has no apostrophe trick, so:
//   - wrap in single quotes — the only literal PowerShell carries
//   - double any single quote inside ('' — the SQL-style escape)
//   - a plain-enough argument passes through bare, keeping the common
//     command readable in the tile
// Outside quotes a PowerShell metacharacter would start a sub-expression, a
// variable or a redirect; inside single quotes nothing expands at all.
function psQuote(arg) {
  const s = String(arg == null ? '' : arg);
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-./:=@]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "''") + "'";
}

// Quote for cmd.exe, which has no quoting of its own — everything is the
// program's problem. Doubled caret only: ^ is cmd's escape character, and
// doubling survives the two parse passes a command line gets.
function cmdQuote(arg) {
  const s = String(arg == null ? '' : arg);
  if (s === '') return '""';
  return s.replace(/\^/g, '^^');
}

// A shell so locked down it cannot run a startup file, so it can never tell us
// where anything is. These are real login shells for service and locked
// accounts, and picking one would silently break every probe.
const DEAD_SHELLS = new Set(['/usr/bin/false', '/bin/false', '/usr/sbin/nologin', '/sbin/nologin', '/usr/bin/true', '/bin/true']);

// The shell used to ask the user's own environment a question — "is claude on
// your PATH", "add this MCP server". It must be a login shell AND an
// interactive one. Login alone is not enough: zsh reads .zshrc only when
// interactive, and .zshrc is where installers write their PATH lines — bun,
// opencode and nvm among them. With `-lc` those lines are never read, so a
// Dock-launched Nami (which inherits no PATH at all) reported perfectly
// well-installed agents as missing. Started from a terminal it looked fine,
// because the inherited PATH was covering for it.
function loginShell(platform = process.platform, env = process.env) {
  if (platform === WIN) {
    // -NoProfile is deliberate and differs from the Unix branch: PowerShell
    // profiles are slow and are not where PATH comes from on Windows.
    return { file: 'powershell.exe', args: (cmd) => ['-NoProfile', '-Command', cmd] };
  }
  // Ask people in their own shell — a bash user's PATH lives in .bashrc, and
  // zsh would never read it. Anything that is not plainly an absolute path to a
  // usable shell falls back, since launchd does not always set SHELL for a GUI
  // app and a wrong guess costs every detection.
  const shell = String((env && env.SHELL) || '');
  const file = shell.startsWith('/') && !DEAD_SHELLS.has(shell) ? shell : '/bin/zsh';
  return { file, args: (cmd) => ['-l', '-i', '-c', cmd] };
}

// Where to look when the shell probe comes back empty — a .zshrc that prints a
// banner, refuses to run without a tty, or does not exist must degrade to a
// worse answer, never to "you have no agents installed". The running PATH goes
// first (it is the truth when Nami *was* started from a terminal), then the
// documented install location of each CLI we know about.
function binSearchDirs({ home = '', env = {}, platform = process.platform } = {}) {
  const win = platform === WIN;
  const sep = win ? '\\' : '/';
  const join = (...parts) => parts.filter(Boolean).join(sep);
  const fromPath = String((env && env.PATH) || '').split(win ? ';' : ':');
  const known = win ? [
    join(home, '.local', 'bin'),
    join(env.APPDATA, 'npm'),
    join(env.LOCALAPPDATA, 'Programs'),
    join(home, '.bun', 'bin'),
  ] : [
    join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.opencode/bin'),   // opencode.ai/install
    join(home, '.bun/bin'),        // bun-installed CLIs
    join(home, '.cargo/bin'),
    join(home, '.npm-global/bin'),
    join(home, '.volta/bin'),
    join(home, '.claude/local'),
    '/usr/bin',
  ];
  return [...new Set([...fromPath, ...known].filter(Boolean))];
}

// "Is this command installed, and where?" — printing the resolved path or
// nothing at all. Must stay silent on failure: a missing agent is an ordinary
// answer here, not an error.
function whichCommand(bin, platform = process.platform) {
  if (platform === WIN) return `(Get-Command ${bin} -ErrorAction SilentlyContinue).Source`;
  return `command -v ${bin}`;
}

// Where a logged-in Claude Code install lands. Order matters: an explicit
// CLAUDE_CODE_EXECUTABLE always wins, then the official installer's location,
// then package managers. Returns candidates only — the caller checks existence,
// because this module does no I/O.
function claudeCandidates({ home = '', env = {}, platform = process.platform } = {}) {
  const sep = platform === WIN ? '\\' : '/';
  const join = (...parts) => parts.filter(Boolean).join(sep);
  if (platform === WIN) {
    return [
      env.CLAUDE_CODE_EXECUTABLE,
      join(home, '.local', 'bin', 'claude.exe'),   // native installer (install.ps1)
      join(env.APPDATA, 'npm', 'claude.cmd'),      // npm -g
      join(home, '.claude', 'local', 'claude.exe'),
    ].filter(Boolean);
  }
  return [
    env.CLAUDE_CODE_EXECUTABLE,
    join(home, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.claude/local/claude'),
  ].filter(Boolean);
}

// Window chrome. macOS hides the title bar but keeps the traffic lights inset
// over our own header; Windows has no equivalent, so it gets a hidden frame
// with an overlay tinted to match the paper header rather than a system bar
// sitting on top of the design.
function windowChrome(platform = process.platform) {
  if (platform === WIN) {
    return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#fffdf6', symbolColor: '#2f2b26', height: 38 } };
  }
  // The sheet is edge-to-edge, so the renderer reserves a 22px lights deck at
  // the top (see .lights-deck in paper.css). y gives the 12px buttons 11px of
  // air above, Chrome-style; they overhang the deck's foot by 1px, which still
  // clears the topbar's centred content by ~11px.
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 11 } };
}

module.exports = {
  loginShell, whichCommand, claudeCandidates, windowChrome, binSearchDirs,
  windowsShells, defaultTerminalShell, userDirs, cacheDir,
  psQuote, cmdQuote, APP_DATA_DIRNAME, APP_NAME, PUBLISH_REPO,
};
