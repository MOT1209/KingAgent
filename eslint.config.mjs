import js from '@eslint/js';
import globals from 'globals';

// Minimal on purpose: this project has never been linted, and going straight
// to a strict ruleset here would surface a pile of pre-existing issues in one
// unrelated commit. Just the recommended set, scoped per area so `require` in
// src/main and `import` in src/renderer don't fight each other's parser mode.
export default [
  {
    ignores: [
      'node_modules/**',
      'release/**',
      'release-review/**',
      'build/**',
      'dist/**',
      'shots/**',
      'src/renderer/vendor/**',
      // Where .gitignore tells people to keep working notes, scratch scripts
      // and review reports. Linting it contradicts that: a throwaway .cjs with a
      // console.log in it failed this config, which is a rule enforcing the
      // opposite of the instruction right beside it. Nothing in here ships.
      '_local/**',
    ],
  },
  js.configs.recommended,
  {
    // `_` is this codebase's deliberate placeholder for positional params,
    // catch and promise bindings the handler does not need (e.g. error
    // swallowing in .catch((_) => record 'done')). no-unused-vars must not flag
    // it, or every intentional placeholder becomes a lecture. Everything that
    // is NOT underscore-prefixed stays linted, hard.
    rules: {
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // Empty catch blocks with an underscore binding are the codebase's
      // documented "this failure is ignored on purpose" idiom; look at the
      // binding for the why. Empty blocks WITHOUT a binding still fail.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Terminal/ANSI handling is core to this app (OSC title parsing, PTY
    // output), and \x1b/\x07 in a regex is the point, not a mistake —
    // src/main/osc-title.js, run-done.js, seed-gate.js all match escape
    // sequences on purpose. The rule exists for code that stumbled into a
    // control character by accident; this codebase does it deliberately.
    rules: { 'no-control-regex': 'off' },
  },
  {
    // main-process and host-agnostic core: CommonJS, Node globals.
    files: ['src/main/**/*.js', 'src/core/**/*.js', 'src/core/**/*.cjs', 'scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2024,
      globals: globals.node,
    },
  },
  {
    // Electron preloads are CommonJS that ALSO see the browser page: window,
    // document, CSS, crypto et al. are real globals there, not mistakes — so
    // they get Node and browser globals merged, or every preload files a
    // no-undef for innerWidth and crypto.
    files: ['src/main/*preload*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2024,
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // renderer: ES modules loaded in the browser context, no bundler. `process`
    // is not a mistake in the page: Electron's sandboxed renderers polyfill a
    // small read-only subset (platform, versions, type) that term-menu.mjs and
    // shortcuts.mjs lean on directly.
    files: ['src/renderer/**/*.js', 'src/renderer/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2024,
      globals: { ...globals.browser, process: 'readonly' },
    },
  },
  {
    // tests and build/release scripts: ES modules under plain Node.
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs', 'brand/**/*.mjs', 'docs/media/*.mjs', 'docs/media/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2024,
      globals: globals.node,
    },
  },
  {
    // the markdown editor page runs inside a document it edits, so document,
    // MutationObserver, rAF etc. are real (milkdown is a DOM editor). Same
    // module parser as the general scripts rule; it just also sees the page.
    files: ['scripts/markdown-editor-entry.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2024,
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // a handful of tests are CommonJS (.cjs) or plain .js helpers, still Node.
    files: ['tests/**/*.cjs', 'tests/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2024,
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
