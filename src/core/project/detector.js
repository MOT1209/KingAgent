// What kind of project is this?
//
// The answer comes from marker files, not from reading the repository. A
// semantic index of a large codebase is expensive, goes stale, and — the part
// that matters here — is not what a first context packet needs. Knowing "npm,
// Node, has a git repo, tests live in tests/" is enough to plan against, and it
// costs one shallow directory read.
//
// Everything is injected (`fs`), so this runs the same in the Electron main
// process and in a test with an in-memory filesystem, on any OS.

const path = require('node:path');

// marker → what it tells us. Order matters: the first match wins for `type`.
const MARKERS = [
  { file: 'package.json', type: 'node', language: 'javascript', packageManager: 'npm' },
  { file: 'pnpm-lock.yaml', type: 'node', language: 'javascript', packageManager: 'pnpm' },
  { file: 'yarn.lock', type: 'node', language: 'javascript', packageManager: 'yarn' },
  { file: 'bun.lockb', type: 'node', language: 'javascript', packageManager: 'bun' },
  { file: 'pyproject.toml', type: 'python', language: 'python', packageManager: 'pip' },
  { file: 'requirements.txt', type: 'python', language: 'python', packageManager: 'pip' },
  { file: 'Pipfile', type: 'python', language: 'python', packageManager: 'pipenv' },
  { file: 'Cargo.toml', type: 'rust', language: 'rust', packageManager: 'cargo' },
  { file: 'go.mod', type: 'go', language: 'go', packageManager: 'go' },
  { file: 'pom.xml', type: 'java', language: 'java', packageManager: 'maven' },
  { file: 'build.gradle', type: 'java', language: 'java', packageManager: 'gradle' },
  { file: 'build.gradle.kts', type: 'java', language: 'kotlin', packageManager: 'gradle' },
  { file: 'Gemfile', type: 'ruby', language: 'ruby', packageManager: 'bundler' },
  { file: 'composer.json', type: 'php', language: 'php', packageManager: 'composer' },
  { file: 'CMakeLists.txt', type: 'cpp', language: 'cpp', packageManager: 'cmake' },
  { file: 'Makefile', type: 'make', language: null, packageManager: 'make' },
];

// Files worth naming in a context packet without being asked.
const INTERESTING = [
  'README.md', 'readme.md', 'CONTRIBUTING.md', 'LICENSE', 'CHANGELOG.md',
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'tsconfig.json', 'Dockerfile', 'docker-compose.yml', 'Makefile',
  '.editorconfig', '.gitignore', 'CLAUDE.md', 'AGENTS.md',
];

// Detected from package.json dependencies / directory names, not from imports.
const FRAMEWORK_DEPS = [
  ['electron', 'electron'], ['react', 'react'], ['vue', 'vue'], ['svelte', 'svelte'],
  ['next', 'next.js'], ['express', 'express'], ['fastify', 'fastify'], ['nest', 'nestjs'],
  ['django', 'django'], ['flask', 'flask'], ['fastapi', 'fastapi'],
  ['@playwright/test', 'playwright'], ['jest', 'jest'], ['vitest', 'vitest'], ['mocha', 'mocha'],
];

const SOURCE_DIRS = ['src', 'lib', 'app', 'packages', 'tests', 'test', '__tests__', 'docs', 'scripts'];

async function exists(fs, target) {
  try { await fs.stat(target); return true; } catch { return false; }
}

async function readJson(fs, target) {
  try { return JSON.parse(await fs.readFile(target, 'utf8')); } catch { return null; }
}

// Walk up from `start` looking for a repository/project boundary. Bounded to
// `maxUp` levels so a detector pointed at a stray path cannot climb to "/".
async function detectRoot(fs, start, { maxUp = 8 } = {}) {
  let dir = path.resolve(start || '.');
  for (let i = 0; i <= maxUp; i += 1) {
    if (await exists(fs, path.join(dir, '.git'))) return dir;
    for (const marker of MARKERS) {
      if (await exists(fs, path.join(dir, marker.file))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start || '.');
}

// One shallow read of the root, plus the marker files it found. Never recursive.
async function detectProject(fs, root) {
  const dir = path.resolve(root || '.');
  let names = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries.map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return emptyDetection(dir);
  }
  const present = new Set(names.map((n) => n.name));

  const matched = MARKERS.filter((m) => present.has(m.file));
  const languages = [...new Set(matched.map((m) => m.language).filter(Boolean))];
  const packageManagers = [...new Set(matched.map((m) => m.packageManager).filter(Boolean))];
  const type = matched.length ? matched[0].type : 'unknown';

  const frameworks = [];
  let name = path.basename(dir);
  let version = null;
  let scripts = [];
  if (present.has('package.json')) {
    const pkg = await readJson(fs, path.join(dir, 'package.json'));
    if (pkg) {
      if (typeof pkg.name === 'string') name = pkg.name;
      if (typeof pkg.version === 'string') version = pkg.version;
      if (pkg.scripts && typeof pkg.scripts === 'object') scripts = Object.keys(pkg.scripts).slice(0, 40);
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const [dep, label] of FRAMEWORK_DEPS) if (deps[dep]) frameworks.push(label);
    }
  }

  return {
    root: dir,
    name,
    version,
    type,
    languages,
    frameworks: [...new Set(frameworks)],
    packageManager: packageManagers[0] || null,
    packageManagers,
    hasGit: present.has('.git'),
    scripts,
    markers: matched.map((m) => m.file),
    configFiles: [...present].filter((n) => /^\.?[\w.-]+rc(\.\w+)?$|\.(?:json|ya?ml|toml|ini)$/i.test(n)).slice(0, 40).sort(),
    importantFiles: INTERESTING.filter((f) => present.has(f)),
    sourceDirs: SOURCE_DIRS.filter((d) => names.some((n) => n.dir && n.name === d)),
    detectedAt: Date.now(),
  };
}

function emptyDetection(dir) {
  return {
    root: dir,
    name: path.basename(dir),
    version: null,
    type: 'unknown',
    languages: [],
    frameworks: [],
    packageManager: null,
    packageManagers: [],
    hasGit: false,
    scripts: [],
    markers: [],
    configFiles: [],
    importantFiles: [],
    sourceDirs: [],
    detectedAt: Date.now(),
  };
}

module.exports = { detectProject, detectRoot, MARKERS, INTERESTING, FRAMEWORK_DEPS, SOURCE_DIRS, emptyDetection };
