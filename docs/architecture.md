# KingAgent architecture

The agent runtime lives in the core, host-agnostic. The Electron app is just
one host that wires it to the OS and the UI.

## Layered layout

- `src/core/` — the platform. Pure JS, no Electron imports, works in plain
  `node`. Every subsystem is a small module with deterministic fallbacks, so
  the whole thing runs offline and testable without a display.
- `src/main/` — the Electron main process: it constructs a platform with real
  `io` (fs, cwd, shell), then exposes it to the renderer over guarded IPC.
- `src/main/preload.js` — the only bridge the UI gets: `window.kingagent`
  (contextBridge, `contextIsolation: true`).
- `src/renderer/` — the UI, ESM modules loaded by `index.html`.

```
renderer (ESM) ── contextBridge ──> preload ── ipcMain.handle ──> main process
                                                                      │
                                          createPlatform(io) ── src/core (CJS)
```

## The core platform (`src/core/index.js`)

`createPlatform({ io, storeDir })` wires every subsystem to one `EventBus`:

| Subsystem | Path | Responsibility |
| --- | --- | --- |
| events | `events/event-bus.js` | one frozen event stream (`TYPES`) the UI, trace, workflows and auditors all watch |
| logging | `logging/logger.js` | redacted scope-scoped logger (`child()` namespaces) |
| persistence | `persistence/store.js` | atomic JSON store or in-memory store (`taskStore`) |
| agents | `agents/registry.js` | agent definitions + capability presets |
| tools | `tools/manager.js` | register/discover/execute with permission gates |
| planning | `planning/planner.js` | deterministic / structured / autonomous plans |
| reasoning | `reasoning/reasoning.js` | analyze / decide / evaluate / diagnose, CoT-free |
| runtime | `runtime/runtime.js` | the analyze → plan → execute → evaluate loop |
| workflows | `workflows/engine.js` | node-graph workflows with approvals |
| context | `context/context.js` | immutable snapshot of the task world per step |
| memory | `memory/memory.js` | scoped session/task key-value memory |
| execution | `execution/code-exec.js` | sandboxed code execution interface |
| recovery | `recovery/recovery.js` | retry / replan / ask-human decisions |

The style is composition over libraries: `io` adapters (fs, shell, cwd) are
injected, so tests swap them for stubs and the main process injects the real
ones. No hardcoded OS paths — everything resolves through `io`, `node:path` or
`process.env` (e.g. `ComSpec`/`$SHELL` for the shell adapter).

## Mode of transport

- Main is CJS (`"type": "commonjs"`, entry `src/main/main.js`); the renderer is
  ESM (`*.mjs`). The core is CJS so it loads in plain node for tests.
- IPC follows one pattern: `ipcMain.handle('scope:name', (e, payload) => …)`.
- The preload surface is auto-checked against the guarded channel list
  (`src/core/security/ipc-guard.js`) by `tests/core-wiring.test.mjs` and
  `tests/core-security.test.mjs`.

## Deterministic by default

`io.provider` is `null` in a bare platform. Nothing pretends: the planner
builds analysis skeletons, the reasoner analyzes from the task, the evaluator
heuristic-checks tool results. Wiring a provider (see `src/main/agent-platform.js`)
enables structured plans and LLM-as-judge steps through one interface —
`provider.generate({ system, messages, structured, signal })`.