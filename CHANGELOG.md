# Changelog

KingAgent ships **rolling releases**: every push to `main` publishes a new patch
version, and an installed copy is offered it as an update. This file is therefore
a map of what changed, not a promise about when. For the exact contents of a
given build, read the release for its tag — `git log <previous-tag>..<tag>` is
the authoritative record, and the built-in update bar shows the same notes.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions are application-level semver, and the version in `package.json` is
always the newest one below.

## [Unreleased]

### Fixed

- The `kingagent-doc://` HTML/browser viewer never rendered anything on
  Windows: its `net.fetch` URL was hand-built as `'file://' + file.split('/')`,
  which has no `/` to split a Windows path on and turned the whole
  `C:\Users\...` string into a garbage `file://C%3A%5CUsers...` URL. Replaced
  with `pathToFileURL` (`src/main/doc-protocol.js`'s new `docFileUrl`),
  covered for both path styles.
- The `fs:newFile`/`fs:newFolder`/`fs:move`/`fs:rename`/`fs:import`/
  `fs:duplicate`/`fs:trash` IPC handlers took their confinement `root` from
  the renderer's own IPC payload; fs-actions.js's inside-root guard is only
  as strong as the root it is handed, so a compromised renderer could name
  any folder as `root` and walk outside the open project. Each handler now
  overwrites `root` with the window's own tracked folder (`winFolders`)
  before calling into fs-actions.js.
- API keys (`openaiKey`, `elevenKey`, `sttKey`, and every name under
  `envKeys`) were written to `settings.json` as plain text; the file's
  `0o600` mode is a no-op on Windows and protects nothing once the file
  leaves the machine. They are now encrypted at rest with Electron's
  `safeStorage` (OS keychain / libsecret-backed) when available, decrypted
  transparently on read so no caller needed to change, and fall back to the
  previous plain-text behavior — same as before — on a machine with no
  keyring. An older KingAgent's plain-text settings.json still reads back
  correctly and is encrypted on the next write.
- The main window ran without `sandbox: true`, unlike every other
  `webContents` this app creates (the in-app browser and overlays). Its
  preload only ever touches `contextBridge`/`ipcRenderer`/`webUtils`, all
  still available sandboxed, so this closes off OS-syscall surface a
  renderer compromise could otherwise reach at no functional cost.
- `npm audit` flagged two high-severity libvips/libheif CVEs in `sharp`
  (GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c), pulled in transitively by
  `@huggingface/transformers@3.8.1`. Unlike the transformers/onnxruntime-node
  bump noted below (blocked by this environment's proxy), sharp's own
  postinstall fetches from the npm registry, not a raw GitHub releases URL,
  so it could be pinned above transformers' requested range via `overrides`
  without touching the pinned transformers/onnxruntime-node versions.
  `npm audit` now reports zero vulnerabilities.

## [0.5.6] — 2026-09-19

### Added

- Opt-in per-session persistence (`term:set-persistent`, `background:list`,
  `background:kill`, `background:forget` — `src/main/background-sessions.js`),
  plus a "Keep running in background" toggle on a session tile's right-click
  menu (`src/renderer/session-menu.mjs`): a session marked persistent is
  detached instead of killed when its tile or window closes, while KingAgent
  itself keeps running — verified with a real headless launch, `ps` confirms
  the process survives. It does **not** survive quitting KingAgent: the pty's
  file descriptor belongs to that process, and the OS closes it (SIGHUP to
  the child) on exit regardless of this flag — measured directly, the process
  is gone within ~1s of quitting. Every other session keeps the existing
  kill-on-close behavior. Does not reattach a terminal either. See
  `docs/external-projects-review.md` for the reasoning and what was
  deliberately left out.
- `doc:convert` and `diagram:generate` builtin tools
  (`src/core/tools/builtin/`): convert workspace `.docx`/`.csv`/`.tsv`/
  `.txt`/`.md`/`.json` to Markdown (with a from-scratch minimal ZIP reader
  for `.docx`, `zip-reader.js`), and render a typed node/edge graph as a
  self-contained HTML+SVG diagram artifact. Two new `domain-modeling` and
  `diagnosis-loop` builtin skills adapted from the community. A `priority`
  routing strategy on `AgentRouter` (`agent.metadata.harnessPriority`). See
  `docs/external-projects-review.md` for what these came from and, just as
  importantly, what was deliberately not adopted.
- The skill ecosystem and MCP capability layer: `src/core/skills/` (discovery,
  ranking, evaluation, lifecycle, registry, runtime, security scanning, four
  sources), `src/core/mcp/` (registry, inspection, classification, bridge),
  `npm run skills`, and `docs/skills/`.
- The Phase 3 foundation — `src/core/agents/`, `workspace/`, `context/`,
  `memory/`, `approval/`, `trace/`, `state/`, `project/` — and the consolidated
  Phase 5 control plane in `src/core/harness-orchestrator/`.
- `CHANGELOG.md` (this file) and `CODE_OF_CONDUCT.md`.
- `src/main/folder-scan.js` and `src/main/update-polling.js`, both covered by new
  tests, so folder scanning and the update schedule are no longer untested code
  inside `main.js`.
- `npm run test:coverage:renderer`: the renderer's coverage, which the gate never
  counted. Report-only, and the `.c8rc.renderer.json` note says why — most of the
  renderer needs a DOM and `app.js` needs an Electron window, so gating on it
  would mean lowering the thresholds until passing stopped meaning anything.

### Changed

- Coverage floors raised from 55/55/65/60 to 70/70/80/70 (lines/statements/
  functions/branches). The old floors sat far under the measured figure and let a
  silent regression through; CI now fails closer to where the code actually is.
- Every packaging entry point now fetches the Whisper weights through a hook of
  its own (`prepack:win`, `prepack:mac`, `predist:win`), and CI checks the packed
  output for an `.onnx` file. A build without the offline model is now a failed
  build rather than a silent one.
- `README.md` states what needs no network or account, real install sizes, and
  the fork's policy toward upstream Nami.
- The dead `exclude` in the `c8` block is gone. It named
  `src/renderer/vendor/**` while the `include` listed only `src/main` and
  `src/core`, so it could not match a file that was being measured — a leftover
  from a renderer scope that was intended and never wired. The vendor exclude now
  sits on the renderer scope, which is the only one whose include set reaches it.
- `eslint.config.mjs` ignores `_local/`. `.gitignore` sends working notes and
  scratch scripts there, and linting the folder contradicted the file next to it:
  a throwaway `.cjs` failed `npm run lint` for using `console`.

### Security

- **A skill's integrity digest covered only its instructions, not the resources
  they point at.** A skill is pinned to a digest of its instructions *and* every
  file listed under `entry.resources`, and both are prompt text the model reads.
  Hashing the entry document alone left the resources an approved-but-unmeasured
  side channel: leave `SKILL.md` byte-identical, rewrite one resource it
  references into an instruction the scanner refuses, and the recorded digest
  still matched — so the load was treated as the content that was approved, and
  the new text went to the model under the old verdict. The installer's idempotent
  path compared the same single-file digest, so a changed resource could also
  install as "identical content".
- The digest is now `digestOfSkill({ content, resources })`
  (`cache/SkillCache.js`), used by all four sources, the loader, the cache's own
  default and therefore the installer. Resources are visited in sorted name order
  and every part is length-framed, so neither the order a source read them in nor
  an added-and-empty resource can collide with another skill's bytes.
- The scheme version (`kingagent-skill-digest/v2`) is hashed in first, so widening
  what a digest covers is a change of digest rather than a silent change of
  meaning: an existing skill is re-scanned and re-pinned once on its next load,
  and a pin recorded by the old scheme can never pass as current.
- Covered from the attack side by three tests: `loader: a resource that turned
  hostile after installation is refused` (quarantined, with the findings named),
  `loader: a benign resource change is re-scanned and re-pinned`, and
  `cache: the digest a skill is pinned to covers every resource`.

### Fixed

- Two delegation tests no longer depend on how busy the machine is. The
  multi-agent fixture rooted its workspaces and tools at `process.cwd()`, so a
  "find TODOs" delegation walked this entire repository including
  `node_modules` — work none of those tests assert anything about, and enough of
  it to sit a couple of seconds from the 15s delegation deadline. They passed
  alone and failed under `npm run test:coverage`, where every test file runs at
  once and the instrumented run is several times slower: `DELEGATION_TIMEOUT`
  instead of the `DELEGATION_BAD_RESULT` under test. The fixture now roots at a
  small temp project with a TODO in it (`core-orchestrator.test.mjs` already did
  this, and says why). That file went from ~11s to ~1.1s and the coverage run
  from 240s to 83s, with the assertions unchanged.
- Recents could sort a pinned folder below a newer plain one. The sort compares
  `Number(pinned)` on both sides, so a row written without that field — a
  hand-edited `state.json`, or one from an older build — produced `NaN`, which is
  falsy, and the pin was ignored. `pinned` is now normalised before the sort.
- `docs/windows.md` no longer claims a portable Windows build. `portable` was
  removed from `electron-builder.yml` on purpose (its artifact name collided with
  the x64 NSIS file and corrupted `latest.yml`), so the docs were describing an
  artifact that is not produced.
- `KINGAGENT-WINDOWS-PORT-REPORT.md` carries an addendum marking the gaps it
  lists that have since been closed and the ones that have not, so it cannot be
  misread as a current state of the repository.

## [0.5.4] — 2026-09-14

### Added

- **Phase 4 core.** An independent control layer above the runtime: orchestration
  and routing, harness adapters and registry, a scoped policy engine, sandbox
  workspaces, sessions, and artifacts. None of it imports Electron — the whole
  platform runs in plain Node with deterministic fallbacks, so it is testable
  without a display.
- **Smart Update Center** on top of the existing updater, so what a new version
  holds is visible before it is accepted.

### Changed

- Code execution runs in a forked sandbox rather than in-process.
- ESLint and c8 are the project's tooling, and CI is gated on lint and coverage.
- Every README screenshot reshoot on the KingAgent identity.

### Fixed

- The `path-guard` and `harness` tests no longer depend on which runner they
  happen to be on.

## [0.5.3] — 2026-09-13

### Changed

- The rolling version is derived from tags.
- CI verifies a complete artifact set before publishing, fetches the Whisper
  model on the Windows leg, and rebuilds only when the artifact actually changes.

## [0.5.2] — 2026-09-13

### Fixed

- Dropped the `portable` Windows target: its artifact name collided with the x64
  NSIS file, the later build overwrote the earlier one, and `latest.yml` then
  recorded a size the surviving file never had.
- Greened the CI gate and shipped the first rolling release.

## Earliest — 2026-09-12

Grouped, because the bumps before 0.5.2 are not all in this repository's history:

- First publish of KingAgent as a standalone repository — the Windows port of
  Nami (see [LICENSE](LICENSE) and the README for provenance).
- JavaScript sandbox code executor.
- Rebrand from Nami to KingAgent: all user-visible strings renamed; internal
  `nami` identifiers (data directory, MIME types, `doc:` protocol, tool ids,
  `NAMI_PING_URL`) deliberately kept so existing installs and agent configs keep
  working.
