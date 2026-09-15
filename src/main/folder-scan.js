// Scanning one folder: the `.claude/` agents and skills it carries, the shallow
// tree a desk opens on, and the Recents rows the popover renders.
//
// Extracted from main.js, which had grown to carry the whole application. The
// split is along the line the rest of this directory already uses: pure folder
// logic lives here and knows nothing about Electron or app state, and main.js
// passes the recents list in and owns persistence. That is what makes any of it
// testable — see tests/folder-scan.test.mjs.
//
// The filesystem is read directly rather than through an injected io object,
// because every caller wants the real disk. What is injected is the small set of
// *primitives* a test needs to re-point: the home directory (which `~` is
// relative to) and the tree reader. Defaults are parameters, not globals.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { readTree } = require('./workspace-tree');
const { sortRecents } = require('./recents');

// '~' for anything under home, the path itself otherwise. This is shown to the
// person looking at the desk, and an absolute /Users/someone path is noise in a
// tile head. `home` is a parameter so a test can state which home it means.
function homeShort(p, home = os.homedir()) {
  return p && home && String(p).startsWith(home) ? '~' + String(p).slice(home.length) : p;
}

// The last path segment on either separator. Filtering empties first is what
// makes '/a/b/' and 'C:\\a\\b\\' both answer 'b' — what follows a trailing slash
// is not a name.
function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// `name:` and `description:` out of an agent file or a SKILL.md, and nothing
// cleverer than that: a YAML parser would be a dependency for four keys, and
// these files are frontmatter plus prose. Only the first 4000 characters are
// read — a body is not frontmatter, and an agent file with a 200 KB prompt
// should not be pulled into memory twice to look at its head.
function readFrontmatter(file, read = fs.readFileSync) {
  try {
    const txt = read(file, 'utf8').slice(0, 4000);
    const m = txt.match(/^---\s*\n([\s\S]*?)\n---/);
    const out = {};
    if (m) {
      for (const line of m[1].split('\n')) {
        const mm = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (mm) out[mm[1]] = mm[2].replace(/^["']|["']$/g, '').trim();
      }
    }
    return out;
  } catch (_) { return {}; }
}

// Everything a desk needs to describe a folder. Never throws: a folder that
// cannot be read answers with an empty skeleton, because this runs on every
// open and a permissions error is not a reason to fail the window.
function scanFolder(folder, {
  home = os.homedir(),
  tree = readTree,
  exists = fs.existsSync,
  readdir = fs.readdirSync,
  frontmatter = readFrontmatter,
} = {}) {
  const info = {
    path: folder,
    pathShort: homeShort(folder, home),
    name: baseName(folder) || folder,
    tree: [],
    agents: [],
    skills: [],
    hasClaude: false,
  };
  try {
    const claudeDir = path.join(folder, '.claude');
    info.hasClaude = exists(claudeDir);

    const agentsDir = path.join(claudeDir, 'agents');
    if (exists(agentsDir)) {
      for (const f of readdir(agentsDir)) {
        if (!f.endsWith('.md')) continue;
        const full = path.join(agentsDir, f);
        const meta = frontmatter(full);
        info.agents.push({
          slug: f.replace(/\.md$/, ''),
          name: meta.name || f.replace(/\.md$/, ''),
          desc: meta.description || '',
          tools: meta.tools || '',
        });
      }
    }

    // A skill is a directory with a SKILL.md in it, not a file: anything else
    // in skills/ is scratch (a script the skill runs, a fixture) and is not an
    // entry on the shelf.
    const skillsDir = path.join(claudeDir, 'skills');
    if (exists(skillsDir)) {
      for (const d of readdir(skillsDir)) {
        const skillMd = path.join(skillsDir, d, 'SKILL.md');
        if (exists(skillMd)) {
          const meta = frontmatter(skillMd);
          info.skills.push({ slug: d, name: meta.name || d });
        }
      }
    }

    info.tree = tree(folder, 0, 2);
  } catch (_) { /* an unreadable folder is an empty folder, not a crash */ }
  return info;
}

// The renderer's copy of the recents list. `missing` is computed here rather
// than in the window so every window agrees about a folder that has gone since
// the list was written, and the menu can drop exactly the rows the popover
// greys out.
function recentsForRenderer(folders, { home = os.homedir(), exists = fs.existsSync } = {}) {
  // `pinned` is normalised before the sort, not after it. sortRecents compares
  // Number(b.pinned) - Number(a.pinned), so a row that never got the field — a
  // state.json written by hand, or by a much older build — makes that NaN, which
  // is falsy: the pin is silently ignored and a pinned folder lands wherever
  // recency happens to put it.
  const rows = (Array.isArray(folders) ? folders : []).map((r) => ({ ...r, pinned: !!r.pinned }));
  return sortRecents(rows).map((r) => ({
    path: r.path,
    pathShort: homeShort(r.path, home),
    name: baseName(r.path),
    at: r.at,
    pinned: !!r.pinned,
    missing: !exists(r.path),
  }));
}

module.exports = { homeShort, baseName, readFrontmatter, scanFolder, recentsForRenderer };
