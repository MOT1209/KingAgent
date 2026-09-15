# KingAgent on Windows

Everything platform-specific the Windows build does, in one place. The macOS
behaviour is unchanged from upstream Nami; this file documents the other half.

## Shells and the terminal

Session tiles run one of three shells, detected on the machine at first use —
never assumed:

| Priority | Shell | Where it comes from |
|----------|-------|---------------------|
| 1 | `pwsh.exe` (PowerShell 7+) | its own installer / winget / scoop |
| 2 | `powershell.exe` (Windows PowerShell 5.1) | ships with every Windows |
| 3 | `cmd.exe` | ships with every Windows |

Detection runs `where.exe` for each candidate (see `windowsShells()` in
`src/main/platform.js`); the first present wins. `cmd.exe` is the floor — a
terminal tile always opens. The chosen shell is printed in Settings and is the
same one every tile spawns; there is no per-tile shell selection yet.

macOS keeps upstream behaviour exactly: the user's `$SHELL` when it names a
real login shell, `/bin/zsh` otherwise.

The Windows shell is started *without* `-NoProfile`: profiles are where PATH
lines land, and an install tile must see what an installer just wrote.

## PATH

Windows PATH is `;`-separated and case-preserving; the app splits and joins on
the platform's own separator everywhere (`user-path.js`, `platform.js`), so a
PATH assembled on one OS never leaks into the other's dialect. Detection asks
PowerShell `$env:PATH` rather than `printf %s "$PATH"`.

macOS's GUI-launch PATH problem (launchd handing out a four-directory stump)
does not exist on Windows, where the registry already carries a user PATH; the
same probe runs anyway, which is harmless.

## Agents

`agents-detect.js` carries two install routes per agent: `install` (the
macOS/Unix curl-pipe line from the vendor's docs) and `installWin` (the
npm/winget route). The setup sheet shows the one for the running platform and
gates the "Install it for me" button on `installAvailable` — an agent with no
documented Windows route shows the doc link instead of a dead command.

Detection itself is platform-agnostic: `Get-Command` on Windows,
`command -v` through the user's login shell on macOS, with the same
known-directories fallback (npm prefix, `%LOCALAPPDATA%\Programs`, `~\.local\bin`,
`~\.bun\bin`).

The Windows route to a CLI is almost always npm or winget rather than a
curl-pipe, so `installWin` names the package-manager command and the launcher
tile it runs in; the `PATH` it needs afterwards is the one a just-finished
installer wrote, which is why the app re-reads the user PATH after any install
(it asks PowerShell for `$env:PATH` instead of reading the registry directly).
If an agent has no documented Windows route, the sheet shows the upstream doc
link and no "Install it for me" button — a dead command is worse than a link.
Worth knowing when a contributor reports an agent missing: detection and
execution read the same memo, so a stale tile PATH and a genuinely missing
binary look identical until the app is restarted or a fresh tile is opened.

## Model weights and dictation

`onnxruntime-node` ships per-OS native binaries. `electron-builder.yml` now
excludes *the other platforms'* ORT binaries per build instead of hard-excluding
Windows from every build, so a Windows installer keeps the DirectML/CPU binaries
dictation needs. Native modules stay unpacked from asar (`asarUnpack`).

Microphone access uses Chromium's own permission flow on Windows — no
TCC-equivalent prompt is needed; first dictation asks in-app.

## MCP

Bundle extraction (`services:pickBundle`) uses `/usr/bin/unzip` on macOS and
`Expand-Archive` through PowerShell on Windows (`src/main/unzip.js`). MCP
servers spawn through the same platform rules as agents — argv arrays, no
shell interpolation, `.cmd` shims resolvable through the scanned PATH.

## Packaging

```bash
npm run pack:win    # unpacked build into release/win-unpacked
npm run dist:win    # NSIS installers only (x64 + arm64)
npm run dist:mac    # DMG + zip on a Mac (signing + notarization as upstream)
```

There is no `portable` build, and that is deliberate. Its artifact name
collides with the x64 NSIS file — same `${arch}`, same `.exe` — so the later
build silently overwrote the earlier one and `latest.yml` then recorded a size
the surviving file never had. Every auto-update checks its checksum against
that dead number, so the portable target is left out of `electron-builder.yml`
rather than pinned around.

`npm run dist` and `npm run dist:mac` fetch the Whisper weights first through
their `predist` hook. `npm run dist:win` has no such hook, so run
`npm run fetch-model` once yourself beforehand — otherwise the installer is
built with an empty `build/models` and ships without offline dictation.

The Windows installer is per-user NSIS (`perMachine: false`): no admin rights,
installable without elevation, and — the reason it matters — the auto-updater
can swap a per-user install in place. File associations (`.md`, `.txt`) are
offered at rank `Alternate`, so Explorer lists KingAgent in "Open with" without
ever stealing a default. That matches the macOS `rank: Alternate` choice
upstream made.

The taskbar identity is set via `app.setAppUserModelId('ai.kingagent.app')`.

## Updater

The update feed is this repo's GitHub releases (`MOT1209/KingAgent`,
draft releases; publish is a human click). `update-check.js` picks the asset
for the running platform: `.dmg` (arm64-aware) on macOS, x64 `.exe` on
Windows, falling back to the release page. electron-updater handles the
download+swap on Windows NSIS installs exactly as it does with the macOS zip.

## Troubleshooting

- **Tile says "could not start"** — no shell was found. Install PowerShell or
  check that `where pwsh` / `where powershell` / `where cmd` answers.
- **Agent "installed" but tiles say command not found** — the scan's PATH and
  the shell's PATH disagree; open a fresh tile (the PATH memo refreshes after
  any installer run) or restart the app.
- **Dictation fails to load the engine** — the ONNX binaries did not ship.
  Rebuild with `npm run pack:win` and confirm
  `resources/app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v3/win32`
  exists in the output.
- **Unicode paths** — fully supported (NTFS is UTF-16 internally); report any
  path that renders mojibake as a bug.

## Architecture notes

Platform decisions live in one pure module, `src/main/platform.js`
(shell table, PATH rules, window chrome, user dirs, quoting), consumed through
`src/main/terminal.js` (which shell a tile runs) and the per-feature modules.
The pattern upstream established — platform is always a parameter, so every
branch is testable from any machine — is preserved; see `tests/platform.test.mjs`.
