// ACP live bridge — PROTOTYPE (demo mode only).
// Spawns an ACP agent process (the official claude adapter) and shuttles
// newline-delimited JSON-RPC between its stdio and the renderer. No protocol
// logic lives here; the renderer is the ACP client.

const { spawn: nodeSpawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { resolveSpawnProgram } = require('./bin-cache');
const { userPath } = require('./user-path');

// One launch line per agent — probed on this machine (tools/acp-probe.mjs)
// before its row earns the Chat badge. It lives here, not in the renderer: the
// renderer names an agent and main decides what runs, so a compromised page
// cannot hand this bridge an arbitrary program or argv to spawn.
const CLAUDE_ADAPTER = path.join(__dirname, '..', '..', 'acp-tools', 'node_modules', '.bin', 'claude-agent-acp');
const AGENT_LAUNCH = {
  claude: { command: CLAUDE_ADAPTER, args: [] },
  kimi: { command: 'kimi', args: ['acp'] },
  codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
  opencode: { command: 'opencode', args: ['acp'] },
  grok: { command: 'grok', args: ['agent', 'stdio'] },
  hermes: { command: 'hermes', args: ['acp'] },
};
// An agent that prints megabytes without a newline is broken, not chatty; past
// this the partial line is dropped rather than held for the life of the process.
const MAX_LINE = 4 * 1024 * 1024;

const procs = new Map();      // id -> { proc, wcId }
const watched = new Set();    // webContents ids whose 'destroyed' is already hooked

// A send to a closed window throws, and every send here runs inside a child's
// event callback — where a throw is uncaught. One guarded path for all of them.
function emitter(wc) {
  return (channel, payload) => {
    try { if (!wc.isDestroyed || !wc.isDestroyed()) wc.send(channel, payload); } catch (_) {}
  };
}

function killEntry(id) {
  const entry = procs.get(id);
  if (!entry) return;
  procs.delete(id);
  try { entry.proc.kill(); } catch (_) {}
}
// A child outlives the window that started it unless something ends it; PTYs
// are reaped on close, and this is the ACP twin of that.
function killAllFor(wcId) {
  for (const [id, entry] of procs) if (entry.wcId === wcId) killEntry(id);
}

function wireAcpLive(ipcMain, { spawn = nodeSpawn } = {}) {
  ipcMain.handle('acp:start', async (e, { id, cwd, agentId } = {}) => {
    if (procs.has(id)) return { ok: true };
    const launch = Object.prototype.hasOwnProperty.call(AGENT_LAUNCH, agentId || 'claude') ? AGENT_LAUNCH[agentId || 'claude'] : null;
    if (!launch) return { ok: false, error: 'no chat launch for ' + String(agentId) };
    let cmd = resolveSpawnProgram(launch.command), cmdArgs = launch.args.slice();
    // the claude bridge may not be installed locally — fetch-and-run instead
    if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) {
      if (cmd.includes('claude-agent-acp')) { cmd = 'npx'; cmdArgs = ['-y', '@agentclientprotocol/claude-agent-acp']; }
      else return { ok: false, error: 'not installed: ' + path.basename(cmd) };
    }
    const runCwd = cwd && fs.existsSync(cwd) ? cwd : process.env.HOME;
    const envPath = await userPath();
    let proc;
    try {
      proc = spawn(cmd, cmdArgs, {
        cwd: runCwd,
        env: { ...process.env, PATH: envPath || ('/opt/homebrew/bin:/usr/local/bin:' + (process.env.PATH || '')) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return { ok: false, error: String(err && err.message) };
    }
    const wc = e.sender;
    const emit = emitter(wc);
    procs.set(id, { proc, wcId: wc.id });
    if (!watched.has(wc.id) && typeof wc.once === 'function') {
      watched.add(wc.id);
      const wcId = wc.id;
      wc.once('destroyed', () => { watched.delete(wcId); killAllFor(wcId); });
    }
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { emit('acp:err', { id, text: line }); continue; }
        emit('acp:msg', { id, msg });
      }
      if (buf.length > MAX_LINE) {
        emit('acp:err', { id, text: '(dropped ' + buf.length + ' bytes of output with no line break)' });
        buf = '';
      }
    });
    proc.stderr.on('data', (d) => emit('acp:err', { id, text: d.toString() }));
    const forget = () => { if (procs.get(id) && procs.get(id).proc === proc) procs.delete(id); };
    proc.on('exit', (code) => { forget(); emit('acp:exit', { id, code }); });
    proc.on('error', (err) => { forget(); emit('acp:err', { id, text: String(err && err.message) }); });
    return { ok: true };
  });
  ipcMain.handle('acp:send', (_e, { id, payload }) => {
    const entry = procs.get(id);
    if (!entry || !entry.proc.stdin.writable) return { ok: false };
    entry.proc.stdin.write(JSON.stringify(payload) + '\n');
    return { ok: true };
  });
  ipcMain.handle('acp:kill', (_e, { id }) => {
    killEntry(id);
    return { ok: true };
  });
}

module.exports = { wireAcpLive, killAllFor, AGENT_LAUNCH };
