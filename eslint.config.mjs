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
    ],
  },
  js.configs.recommended,
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
    files: ['src/main/**/*.js', 'src/core/**/*.js', 'scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2024,
      globals: globals.node,
    },
  },
  {
    // renderer: ES modules loaded in the browser context, no bundler.
    files: ['src/renderer/**/*.js', 'src/renderer/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2024,
      globals: globals.browser,
    },
  },
  {
    // tests and build/release scripts: ES modules under plain Node.
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2024,
      globals: globals.node,
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
