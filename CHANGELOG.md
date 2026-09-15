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

### Changed

- Coverage floors raised from 55/55/65/60 to 70/70/80/70 (lines/statements/
  functions/branches). The old floors sat well under the measured 78% and let a
  silent regression through; CI now fails closer to where the code actually is.

### Fixed

- `docs/windows.md` no longer claims a portable Windows build. `portable` was
  removed from `electron-builder.yml` on purpose (its artifact name collided
  with the x64 NSIS file and corrupted `latest.yml`), so the docs were describing
  an artifact that is not produced.
- `docs/windows.md` states that `npm run dist:win` has no `predist` hook, so
  `npm run fetch-model` must be run by hand first or the installer ships without
  Whisper weights.
- `KINGAGENT-WINDOWS-PORT-REPORT.md` carries an addendum marking the gaps it
  lists that have since been closed, so it cannot be misread as a current state
  of the repository.
- `README.md` documents what needs no network or account, real install sizes, and
  the fork's policy toward upstream Nami.

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
