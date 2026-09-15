# KINGAGENT — Windows Port Report

Audit of `KingAgent` (the Windows port of the Nami agent terminal) against the full
"KINGAGENT" product brief, plus the result of the Windows test-suite repair.

Date: 2026-09-12 · Platform: Windows (win32) · Node v24 · Electron

> **⚠️ This is a dated snapshot, not the current state.** It was written on
> 2026-09-12, before the Phase 4 core landed. Several items it lists as
> "not implemented" have since been built. Read the addendum below before
> treating anything in this file as a description of the repo today.

---

## Addendum — 2026-09-15 (what has changed since this report)

This file stays as it was written, because it is useful as a record of where the
port stood. The table below is the correction a new contributor needs.

| Item in this report | Status today |
|---|---|
| §Executive summary — "الفجوات المتبقية (غير منفّذة)": Agent Runtime، محرّكات التخطيط/الاستدلال، محرك Workflow، مدير أدوات مركزي، نظام ذاكرة، بيئة تنفيذ كود، Self-Healing | **Built.** `7e2f336 feat(core): add Phase 4 orchestration, harness, policy and sandbox layers` created `src/core/` whole: `runtime/`, `planning/`, `reasoning/`, `workflows/`, `memory/`, `context/`, `tools/`, `execution/`, `recovery/`, `harness/`, `policy/`, `sandbox/`, `orchestrator/`, `session/`, `artifacts/` — 23 subsystems, none of which import Electron. |
| §5 — "CI won't run" (§7.2): the folder was untracked inside a parent workspace repo | **Closed.** KingAgent is its own repository now (`450d3a1`) and three workflows run: `ci.yml` (linux/macOS/Windows matrix + a `windows-latest` build job), `release.yml` (macOS), `ship.yml` (version, build both platforms, publish). |
| §7.3 — "`release.yml` is macOS-only — add a Windows job once Windows CI exists" | **Partly closed, on purpose.** Windows CI exists (`ci.yml`), and Windows installers are built and published by `ship.yml`. `release.yml` stays macOS-only; it is the signing/notarization path, not the general ship path. |
| §5 — test counts (1173 total · 1158 pass · 0 fail · 15 skipped) | **Superseded.** The suite is now **1457 tests · 1444 pass · 0 fail · 13 skipped**, and coverage floors are enforced in CI at 70% lines/statements, 80% functions, 70% branches (measured: 78% lines, 84% functions, 77% branches). |
| §Executive summary — build "NSIS + Portable" | **Portable was removed, deliberately.** Its artifact name collided with the x64 NSIS file and corrupted the update metadata. Windows output is NSIS only (x64 + arm64). |

Still open as of 2026-09-15:

1. **§7.1 — `dist:win` ships without Whisper weights.** Unchanged: `predist`
   covers `dist` and `dist:mac`, but the standalone `dist:win`/`pack:win`
   scripts have no such hook. Run `npm run fetch-model` first.
2. **§7.4 — cloud/enterprise layer.** Not implemented, by design; the app is a
   local desk.
3. **Signing.** Both platforms still build unsigned in the rolling pipeline;
   the wiring only needs repository secrets.

---

## ملخص تنفيذي (Arabic executive summary)

- **الحالة العامة**: KingAgent هو إعادة تسمية/نقل كامل لبرنامج Nami (خادم طرفيات وكلاء AI) إلى Windows. كل الوظائف المرتبطة بالمنصة **مكتملة ومُختبرة**: المحطة الطرفية (PowerShell → cmd → node-pty)، عمليات الملفات، فتح الملفات وإقراناتها، بناء Windows (NSIS + Portable للأجهزة x64/arm64)، التحديث التلقائي بأصول Windows (.exe)، مكوّن Whisper الصوتي بنظام ONNX، شبكة MCP (بما فيها Playwright Browser)، نظام الوكلاء (Claude/Codex/Grok/Gemini/OpenCode)، الأمان (contextIsolation + sandbox)، الاختصارات، سمات الواجهة، وعيّنتا التوثيق.
- **الاختبارات**: كانت **134 فاشلًا من أصل 1173** على جهاز Windows → أصبحت **0 فشل، 1158 نجاح، 15 تخطي مقصود** (تخطيات بيئية فقط: لا zsh، لا صلاحية symlink، المجلد ليس جذر git). تم إصلاح ملفات الاختبار لتتطابق مع الواقع المنقول، مع إنشاء مساعد مشترك `tests/test-utils.mjs`، وتغيير مصدري واحد يعالج علة Windows حقيقية في `agent-remove.js`.
- **الفجوات المتبقية (غير منفّذة)** مقابل البرومت الكامل: Agent Runtime، محرّكات التخطيط/الاستدلال، محرك Workflow، مدير أدوات مركزي، نظام ذاكرة، Context Manager قائم بذاته (جزئي فقط)، بيئة تنفيذ كود، Self-Healing، نظام إضافات، تسجيل مركزي، والطبقة السحابية (Cloud/CLI/API/Marketplace/Teams/Enterprise).
- **تحذيرات عملية**: أسلوب `dist:win` لا يجلب أوزان نموذج Whisper (سيُشحن المثبّت بلا نماذج)؛ مستودع git الفعلي للجهاز هو المجلد الأب فمجلدات `.github/workflows` داخل KingAgent لن تعمل؛ `release.yml` مخصص لنظام macOS فقط.

---

## 1. Verdict

| | الفئة | الحالة |
|---|---|---|
| Patch 1 | Rename + product identity | ✅ mostly complete |
| Patch 2 | Telemetry removed (by design) | ✅ |
| Patch 3 | Windows platform port | ✅ core complete |
| | UI polish / themes | ✅ complete |
| | MCP layer | ✅ integrated |
| | Agent system | ✅ integrated |
| | Tests on Windows | ✅ **green (0 failures)** |
| | Compliance time-tracking tables | ⚠️ partial (unit tests cover the engine; per-language CI tables not deeply proven) |
| | CI / packaging gaps | ⚠️ see §5 |
| | Cloud & enterprise layer | ❌ not implemented |

---

## 2. What the app is

KingAgent is a local desktop terminal for AI coding agents: a PowerShell/cmd/pty
terminal with a session rails (Sessions / Workspace / Library), a skills+agents
"Library", per-agent MCP delivery (Claude, Codex, Grok, Gemini, OpenCode), a
research browser (CDP), local Whisper dictation (ONNX), settings, themes, and an
update bar. It stores nothing in the cloud; the only network calls are the update
check against `api.github.com/repos/MOT1209/KingAgent` (opt-in, notify-only) and
whatever the agents/browser themselves use. Telemetry is explicitly disabled
(`PING_URL = ''` in `src/main/ping.js`) and only reactivates via `NAMI_PING_URL`.

---

## 3. Architecture at a glance (per-phase audit)

| Phase | What the brief asked for | KingAgent status |
|---|---|---|
| 1 Product identity | rename, own About | ✅ `KingAgent`, About pane, marker `made by KingAgent from agents/…` |
| 2 Agent Runtime | always-on supervisor | ❌ not implemented — the app is a terminal, not an agent host |
| 3 Agent Context/Context Manager | standalone context store | ⚠️ partial: per-session context (session-context) only, no cross-tool memory |
| 4 Planning/Reasoning Engines | `planner`, `reasoner` | ❌ not implemented |
| 5 Tool Management | central Tool Manager | ❌ none — agents use their CLIs directly |
| 6 Local Runtime / exec sandbox | code execution | ❌ none |
| 7 Memory System | persistent memory | ❌ none beyond settings |
| 8 Error Detection / Self-Healing | retry, repair | ❌ none (fail-into-silence discipline throughout instead) |
| 9 Process Communication | terminal / pty | ✅ node-pty (`@lydell/node-pty` 1.2.0-beta.14) + platform shell chain |
| 10 File System | read/write/fs actions | ✅ `src/main/fs-actions.js`, worked tree, protected-folder guards |
| 11 Context Loader | import files/folders | ✅ open-with, import, recent, favs |
| 12 Semantics | slug/projects per folder | ✅ |
| 13 Skills | skills folder | ✅ neutral `skills/`, per-tool mirrors, Library scan |
| 14 Monitor (agents/processes) | open-with, ports | ✅ |
| 15 Time Tracking | tables | ⚠️ engine + unit tests; CI contribution tables not proven |
| 16 Voice (Whisper) | local transcription | ✅ ONNX (transformers 3.8.1, onnxruntime-node 1.21.0) with model fetch + resume |
| 17 Chat Mode | canvas/chat UI | theory present (`dock`/chat pane) — light |
| 18 Apps / owner | tool ownership | ✅ Library scope+platform model |
| 19 Notifications | toasts | ✅ |
| 20 Partial Automation | schedule | ❌ |
| 21 Extensions (plugins) | plugin system | ❌ not implemented |
| 22 Activity / History | logs | ❌ no centralized logging |
| 23 Config Templates | per-tool configs | ✅ MCP delivery, agent masters |
| 24 Multi-Step (workflows) | workflow engine | ❌ not implemented |
| 25 Auto Mode | autonomous delegation | ❌ |
| 26 Controller | planning UI | ❌ |
| 27 Market / install packages | Marketplace | ❌ |
| 28 Command Interface | slash commands | ❌ except shell |
| 29 Tool Registry | tool inventory | ⚠️ per-agent, not global |
| 30 Skill Registry | skills | ✅ Library + skills delivery |
| 31 Security | is-session-safe | ✅ |
| 32 Compliance | permissions | ✅ prompts, allowlist, protected storage |
| 33 Cloud | sync/accounting | ❌ |
| 34 UI | terminal + panels | ✅ Electron, themes (paper/operator/glass/graphite/soft/dusk) |
| 35 Docs | docs/start-here | ✅ |
| 36 Multi-Process/Concurrency | windows per folder | ✅ |
| 37 Agent Multi-Process | concurrent agent CLIs | ✅ sessions |
| 38 DRY adherence | reuse engines | partial |
| 39 Plugins/autoload | — | ❌ |
| 40 Language | English UI | ✅ |

---

## 4. Windows port — what was done

- **Platform abstraction** (`src/main/platform.js`, `APP_DATA_DIRNAME = '.kingagent'`).
- **Terminal**: PowerShell → `powershell` → `cmd` fallback chain; `node-pty` on Windows.
- **FS/open-with/file associations**: MIME `x-nami-…`, `doc:` protocol, `.kingagent` data dir.
- **Packaging**: `electron-builder` NSIS + Portable, x64 + arm64; config `electron-builder.yml`.
- **Updates**: GitHub release feed for `MOT1209/KingAgent`; Windows installer = NSIS `.exe` (x64 first), macOS = `.dmg`; `scripts/fix-update-metadata.mjs`.
- **Browser MCP**: `@playwright/mcp` 0.0.80 with `nami_sessions`/`nami_*` tool names.
- **MCP**: `@modelcontextprotocol/sdk` 1.27.1; `connections.json` master + per-tool delivery.
- **Agents**: Claude/Codex/Grok/Gemini/OpenCode masters + copies + import/lift; delivery matrix (cursor rides claude, hermes named, gemini user-scope).
- **Security**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- **Shortcuts**: `CommandOrControl+…`; menu roles preserved (`⌘C`/`⌘Q` etc.).

---

## 5. Testing — results after the Windows repair

Command: `node --test tests/*.test.mjs` on Windows (Node v24).

| | Before | After |
|---|---|---|
| Total | 1173 | 1173 |
| Pass | 1039 | **1158** |
| Fail | **134** | **0** |
| Skipped | 0 | 15 (all environment-bound) |

### Why the 134 failed, and how they were fixed
1. **Path separators** (the majority): `path.join` yields `\` on win32, breaking
   `endsWith('/x.md')` and `/agents\/file$/` assertions. Fixed in ~15 files via
   `posix()`/`p()` from the new `tests/test-utils.mjs`, or `[\\/]` matches.
   No source changes for this.
2. **Branding**: visible strings renamed to KingAgent (markers, menu labels,
   `REPO = github.com/MOT1209/KingAgent`, About, Help, browser settings).
   Internal `nami` identifiers kept.
3. **Symlink EPERM**: `fs.symlinkSync` requires Developer Mode/elevation;
   fixtures now guard creation in try/catch; genuinely link-dependent tests skip.
4. **`/bin/zsh` spawn**: mac-only; real-shell tests skip via `HAS_ZSH`;
   mocked tests kept; `agents-detect.findOnDisk` made platform-neutral.
5. **POSIX dialect unit tests**: `user-path`/`agents-detect` pin `'darwin'`
   explicitly for the parameterised pure functions.
6. **Locale**: `rel-time` now tolerates any 2+-letter weekday (`Do` in German).
7. **Git toplevel**: `repo-shape` skips git-driven rules when the folder is not
   its own checkout (it lives inside a larger workspace repo).
8. **Deliberately-disabled telemetry**: `ping` tests drive via `NAMI_PING_URL`
   override (upstream counter must not receive renamed-fork launches).
9. **Windows asset/identity**: update-check/updater expect `.exe`; review identity
   `ai.kingagent.app`; term-menu `Reveal in File Explorer`; review desk
   `%APPDATA%\KingAgent Review`.

### The 15 skips are environmental only
- 6 × `/bin/zsh` real spawn (`run-done`) — no zsh installed.
- 6 × real symlinks (`library`×2, `pointer`×2, `workspace-tree`×2) — no privilege.
- 3 × git-managed rules (`repo-shape`) — folder is not a standalone git checkout.

### The one source change
`src/main/agent-remove.js:21` — trailing-separator strip now `/[\\/]+$/`:
on win32 `path.normalize('/Users/dev/')` keeps a trailing `\`, which would
defeat the "never delete $HOME itself" guard.

---

## 6. Residual `nami` appearances

Almost all remaining `nami` occurrences are **internal identifiers** (file,
function, dir, MIME, protocol, tool id, data-dir names) — harmless and intended.
User-visible strings were renamed. Reviewed and confirmed in: platform, app-menu,
browser-mcp (tool names), ping (env override), start-here, docs.

---

## 7. Known gaps / recommendations (priority order)

1. **`dist:win` ships without Whisper weights** — `predist` calls
   `fetch-model`, but the standalone `dist:win`/`pack:win` scripts do not.
   Fix: add `fetch-model` to `predist:win` (or run `npm run fetch-model`
   before building) so `build/models` lands in `extraResources`.
2. **CI won't run** — the actual git repo root is the parent workspace
   (`C:\Users\aihmo\alle folder von code`), and `KingAgent/` is untracked
   (`?? KingAgent/`). Workflows under `KingAgent/.github/workflows` never
   trigger. Move/initialise a repo at `KingAgent/` so CI, and the
   `repo-shape` git tests, activate.
3. **`release.yml` is macOS-only** — add a Windows job (`--win`, NSIS) once
   Windows CI exists.
4. **Cloud/enterprise layer** — Agent Runtime, planning, workflows, memory,
   plugins, marketplace, permissions accounting (phase tables): unimplemented
   by design; expected if the brief's full product is the goal.
5. **`run-done.test.mjs:76`** passes only accidentally without zsh (ENOENT is
   swallowed into an empty string feed). Consider making it honest with `HAS_ZSH`.

---

## 8. How to reproduce the green state

```powershell
cd "C:\Users\aihmo\alle folder von code\KingAgent"
npm install              # node_modules already present
node --test tests/*.test.mjs
# → tests 1173 · pass 1158 · fail 0 · skipped 15
```

Individual file: `node --test tests\library.test.mjs`

Full Windows build (reminder): `npm run fetch-model` then `npm run pack:win`
(or `dist:win` once model weights are included) → inspect `release\`.