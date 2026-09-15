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

### Added

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

### Fixed

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
