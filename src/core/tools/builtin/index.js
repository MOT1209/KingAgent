// Built-in tools, adapted to whatever I/O the host provides.
//
// These are not Electron objects and not OS-specific paths: the platform
// supplies `io` with fs, shell and cwd adapters and the tools stay pure logic.
// The same code runs in the Electron main process (real fs/terminal) and in
// tests (in-memory fs / fake shell).

const path = require('node:path');
const { PERMISSIONS } = require('../definition');
const { ToolError } = require('../manager');
const { assertWithin } = require('../path-guard');
const { convertToMarkdown, SUPPORTED: DOC_CONVERT_FORMATS } = require('./doc-convert');
const { generateDiagram } = require('./diagram-generate');

function registerBuiltinTools(tm, io) {
  const fs = io.fs || require('node:fs/promises');
  const root = io.root || null;
  const runShell = io.runShell || null;
  const commandPolicy = io.commandPolicy || DEFAULT_COMMAND_POLICY;

  // --- filesystem (path-guarded when a root is configured) ----------------
  tm.register({
    id: 'fs:read',
    name: 'Read file',
    description: 'Read a text file (or a portion of it) from the workspace.',
    category: 'filesystem',
    capabilities: ['read', 'filesystem'],
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', required: true }, limit: { type: 'number' }, offset: { type: 'number' } },
    },
    permissions: { level: PERMISSIONS.READ_ONLY },
    async execute(input) {
      const target = assertWithin(root, input.path);
      const buf = await fs.readFile(target, 'utf8');
      let text = buf;
      if (input.offset || input.limit) {
        let start = 0;
        const lines = text.split(/\n/);
        if (input.offset) start = Math.max(0, input.offset);
        const end = input.limit ? Math.min(lines.length, start + input.limit) : lines.length;
        text = lines.slice(start, end).join('\n');
      }
      return { path: input.path, content: text, bytes: buf.length };
    },
  });

  tm.register({
    id: 'fs:list',
    name: 'List directory',
    description: 'List entries in a directory (optionally recursive).',
    category: 'filesystem',
    capabilities: ['read', 'filesystem'],
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' }, maxDepth: { type: 'number' } },
    },
    permissions: { level: PERMISSIONS.READ_ONLY },
    async execute(input) {
      const target = root ? assertWithin(root, input.path || '.') : path.resolve(input.path || '.');
      const entries = await walk(fs, target, {
        recursive: Boolean(input.recursive),
        maxDepth: input.maxDepth || 0,
        depth: 0,
        skip: new Set(['.git', 'node_modules']),
      });
      return { path: input.path || '.', entries };
    },
  });

  tm.register({
    id: 'fs:exists',
    name: 'File exists',
    description: 'Check whether a path exists and what it is.',
    category: 'filesystem',
    capabilities: ['read', 'filesystem'],
    inputSchema: { type: 'object', properties: { path: { type: 'string', required: true } } },
    permissions: { level: PERMISSIONS.READ_ONLY },
    async execute(input) {
      const target = assertWithin(root, input.path);
      try {
        const stat = await fs.stat(target);
        return { path: input.path, exists: true, type: stat.isDirectory() ? 'directory' : 'file' };
      } catch {
        return { path: input.path, exists: false };
      }
    },
  });

  tm.register({
    id: 'fs:write',
    name: 'Write file',
    description: 'Write or replace a text file inside the workspace.',
    category: 'filesystem',
    capabilities: ['write', 'filesystem'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', required: true },
        content: { type: 'string', required: true },
        append: { type: 'boolean' },
      },
    },
    permissions: { level: PERMISSIONS.MODERATE },
    async execute(input) {
      if (typeof input.content !== 'string') throw new ToolError('fs:write requires string content', { code: 'TOOL_INVALID_INPUT', toolId: 'fs:write' });
      const target = assertWithin(root, input.path);
      await ensureDir(fs, path.dirname(target));
      const flags = input.append ? 'a' : 'w';
      await fs.writeFile(target, input.content, { encoding: 'utf8', flag: flags });
      return { path: input.path, bytes: Buffer.byteLength(input.content, 'utf8'), append: Boolean(input.append) };
    },
  });

  tm.register({
    id: 'fs:mkdir',
    name: 'Create directory',
    description: 'Create a directory (and parents) inside the workspace.',
    category: 'filesystem',
    capabilities: ['write', 'filesystem'],
    inputSchema: { type: 'object', properties: { path: { type: 'string', required: true } } },
    permissions: { level: PERMISSIONS.MODERATE },
    async execute(input) {
      const target = assertWithin(root, input.path);
      await fs.mkdir(target, { recursive: true });
      return { path: input.path, created: true };
    },
  });

  tm.register({
    id: 'fs:delete',
    name: 'Delete path',
    description: 'Delete a file or (recursively) a directory. Irreversible.',
    category: 'filesystem',
    capabilities: ['write', 'filesystem'],
    inputSchema: { type: 'object', properties: { path: { type: 'string', required: true }, recursive: { type: 'boolean' } } },
    // Declares the policy action it presents as, so a policy document can say
    // `filesystem.delete` and mean it. The action is a name, not a permission:
    // core/policy still decides the outcome.
    policyAction: 'filesystem.delete',
    permissions: { level: PERMISSIONS.DESTRUCTIVE, note: 'irreversible' },
    async execute(input) {
      const target = assertWithin(root, input.path);
      if (input.recursive) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
      return { path: input.path, deleted: true };
    },
  });

  // --- documents (office/text -> Markdown, no shell-out, no new deps) ------
  tm.register({
    id: 'doc:convert',
    name: 'Convert document to Markdown',
    description: `Convert a workspace document (${DOC_CONVERT_FORMATS.join(', ')}) to Markdown so an agent can read it as text.`,
    category: 'document',
    capabilities: ['read', 'document'],
    inputSchema: { type: 'object', properties: { path: { type: 'string', required: true } } },
    permissions: { level: PERMISSIONS.READ_ONLY },
    async execute(input) {
      const target = assertWithin(root, input.path);
      try {
        const markdown = await convertToMarkdown(fs, target);
        return { path: input.path, markdown };
      } catch (err) {
        throw new ToolError(`doc:convert failed for ${input.path}: ${err.message}`, { code: 'TOOL_FAILURE', toolId: 'doc:convert' });
      }
    },
  });

  // --- diagrams (typed node/edge graph -> self-contained HTML+SVG) ---------
  tm.register({
    id: 'diagram:generate',
    name: 'Generate architecture diagram',
    description: 'Render a directed graph of named nodes and edges as a self-contained HTML+SVG diagram artifact.',
    category: 'document',
    capabilities: ['document', 'architecture'],
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        nodes: { type: 'array', required: true },
        edges: { type: 'array' },
      },
    },
    permissions: { level: PERMISSIONS.READ_ONLY },
    async execute(input) {
      try {
        return generateDiagram(input);
      } catch (err) {
        throw new ToolError(`diagram:generate failed: ${err.message}`, { code: 'TOOL_INVALID_INPUT', toolId: 'diagram:generate' });
      }
    },
  });

  // --- search --------------------------------------------------------------
  tm.register({
    id: 'search:grep',
    name: 'Grep',
    description: 'Search file contents in a directory (skips .git and node_modules).',
    category: 'search',
    capabilities: ['code_search', 'repository_analysis', 'read'],
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', required: true },
        dir: { type: 'string' },
        include: { type: 'string' },
        maxResults: { type: 'number' },
        caseSensitive: { type: 'boolean' },
      },
    },
    permissions: { level: PERMISSIONS.READ_ONLY },
    async execute(input) {
      const target = root ? assertWithin(root, input.dir || '.') : path.resolve(input.dir || '.');
      const matches = await grep(fs, target, {
        pattern: input.pattern,
        include: input.include,
        maxResults: input.maxResults || 50,
        caseSensitive: Boolean(input.caseSensitive),
      });
      return { root: input.dir || '.', matches };
    },
  });

  // --- git (read-only via the injected shell) ------------------------------
  if (runShell) {
    for (const [id, name, args] of [
      ['git:status', 'Git status', ['status', '--short']],
      ['git:log', 'Git log', ['log', '--oneline', '-25']],
      ['git:diff', 'Git diff', ['diff', '--stat']],
    ]) {
      tm.register({
        id,
        name,
        description: `Read-only ${name.replace('Git ', 'git ').toLowerCase()} in the workspace.`,
        category: 'git',
        capabilities: ['git', 'repository_analysis', 'read'],
        inputSchema: { type: 'object', properties: { cwd: { type: 'string' }, args: { type: 'array' } } },
        permissions: { level: PERMISSIONS.READ_ONLY },
        async execute(input) {
          const cwd = input.cwd ? assertWithin(root, input.cwd) : (root || io.cwd ? io.cwd() : process.cwd());
          const res = await runShell({ command: 'git', args: input.args || args, cwd, signal: this.signal });
          if (res.exitCode !== 0 && res.stderr && !res.stderr.includes('fatal: not a git repository')) {
            throw new ToolError(`${id} failed (${res.exitCode}): ${(res.stderr || '').slice(0, 400)}`, { code: 'TOOL_FAILURE', toolId: id });
          }
          return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
        },
      });
    }
  }

  // --- terminal (the shell KingAgent already owns; adapted, not duplicated) --
  if (runShell) {
    tm.register({
      id: 'terminal:run',
      name: 'Run command',
      description: 'Run a shell command in the workspace and return its output.',
      category: 'terminal',
      capabilities: ['shell', 'run_tests', 'terminal'],
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', required: true },
          cwd: { type: 'string' },
          timeoutMs: { type: 'number' },
          env: { type: 'object' },
        },
      },
      // An arbitrary shell command is not MODERATE: it can delete, exfiltrate
      // over the network, install packages and edit files outside the workspace
      // (`cd .. && rm -rf` passes any cwd containment). So it is DESTRUCTIVE,
      // budgets per-call approval, and is additionally screened by the command
      // policy below.
      policyAction: 'command.run',
      permissions: { level: PERMISSIONS.DESTRUCTIVE, requiresAuth: true, note: 'arbitrary shell command — per-call approval required' },
      async execute(input) {
        const violation = checkCommandPolicy(String(input.command || ''), commandPolicy);
        if (violation) {
          throw new ToolError(`command denied by policy: ${violation}`, { code: 'COMMAND_DENIED', toolId: 'terminal:run' });
        }
        const cwd = input.cwd ? assertWithin(root, input.cwd) : (root || (io.cwd ? io.cwd() : null));
        const res = await runShell({
          command: input.command,
          cwd,
          timeoutMs: input.timeoutMs || 60_000,
          env: input.env,
          signal: this.signal,
        });
        return { cwd, exitCode: res.exitCode, stdout: (res.stdout || '').slice(0, 20_000), stderr: (res.stderr || '').slice(0, 5_000) };
      },
    });
  }

  return tm;
}

// --- helpers ---------------------------------------------------------------

// Defense-in-depth for terminal:run. The real gate is the per-call approval
// (DESTRUCTIVE + requiresAuth); this list is for the patterns that should not
// reach an approval prompt at all. Callers can replace both lists via
// io.commandPolicy = { allow: [...], deny: [...] }.
const DEFAULT_COMMAND_POLICY = {
  // Irreversible / supply-chain damaging commands never get far enough to ask.
  deny: [
    /rm\s+-(?:rf|r)\b/i,
    /(?:^|[;&|]\s*)(?:sudo|doas)\s+/i,
    /(?:^|[;&|]\s*)git\s+push\s*(?:-f|--force)/i,
    /(?:^|[;&|]\s*)(?:rmdir|rd)\s+\/s/i,
    /(?:^|[;&|]\s*)(?:format|fdisk|mkfs)/i,
    /(?:^|[;&|]\s*)(?:chmod|chown)\s+-R\s+(?:7{3}7|0)\b/i,
    /(?:^|[;&|]\s*)(?:mv|move|cp)\s+(?:-\w+\s+)*(?:\/|~)[^\s]*/i,
  ],
  allow: [],
};

// Returns a description of the first policy violation, or null when the
// command passes. If `allow` is non-empty it is a whitelist: the command must
// match one of its patterns. `deny` always blocks first.
function checkCommandPolicy(command, policy) {
  if (!policy) return null;
  const deny = Array.isArray(policy.deny) ? policy.deny : [];
  const allow = Array.isArray(policy.allow) ? policy.allow : [];
  for (const pattern of deny) {
    let re;
    try { re = pattern instanceof RegExp ? pattern : new RegExp(pattern); } catch (_) { continue; }
    if (re.test(command)) return `matches deny pattern ${String(pattern)}`;
  }
  if (allow.length > 0) {
    const ok = allow.some((pattern) => {
      let re;
      try { re = pattern instanceof RegExp ? pattern : new RegExp(pattern); } catch (_) { return false; }
      return re.test(command);
    });
    if (!ok) return 'does not match any allow pattern';
  }
  return null;
}

async function walk(fs, dir, { recursive, maxDepth, depth, skip, base }) {
  const out = [];
  const baseDir = base || dir;
  let items;
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of items) {
    if (skip.has(ent.name)) continue;
    const rel = path.relative(baseDir, path.join(dir, ent.name));
    out.push({ name: ent.name, type: ent.isDirectory() ? 'directory' : 'file', path: rel || ent.name });
    if (recursive && ent.isDirectory() && (maxDepth === 0 || depth < maxDepth)) {
      const sub = await walk(fs, path.join(dir, ent.name), { recursive, maxDepth, depth: depth + 1, skip, base: baseDir });
      out.push(...sub);
    }
  }
  return out;
}

async function ensureDir(fs, dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch { /* exists */ }
}

async function grep(fs, dir, { pattern, include, maxResults, caseSensitive }) {
  const re = new RegExp(pattern, caseSensitive ? '' : 'i');
  const matches = [];
  const includeRe = include ? new RegExp(include) : null;
  async function scan(d) {
    if (matches.length >= maxResults) return;
    let items;
    try { items = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of items) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await scan(full);
      } else if (!includeRe || includeRe.test(ent.name)) {
        try {
          const text = await fs.readFile(full, 'utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) break;
            if (re.test(lines[i])) {
              matches.push({ file: full, line: i + 1, text: lines[i].trim().slice(0, 200) });
            }
          }
        } catch { /* binary / unreadable */ }
      }
      if (matches.length >= maxResults) break;
    }
  }
  await scan(dir);
  return matches;
}

module.exports = { registerBuiltinTools, walk, grep, checkCommandPolicy, DEFAULT_COMMAND_POLICY };