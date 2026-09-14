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
| context | `context/context.js` | immutable snapshot of the task world per step (Phase 2) |
| memory | `memory/memory.js` | in-process session/task key-value memory (Phase 2) |
| execution | `execution/code-exec.js` | sandboxed code execution interface |
| recovery | `recovery/recovery.js` | retry / replan / ask-human decisions for a failed **step** |

The style is composition over libraries: `io` adapters (fs, shell, cwd) are
injected, so tests swap them for stubs and the main process injects the real
ones. No hardcoded OS paths — everything resolves through `io`, `node:path` or
`process.env` (e.g. `ComSpec`/`$SHELL` for the shell adapter).

## Phase 3: the world a run happens inside

Phase 2 answers "how does an agent execute a task?" (analyze → plan → execute →
evaluate → recover). Phase 3 answers the question above that: **what is an
agent running inside, and what does it leave behind?** Nothing in Phase 2 is
replaced — the `AgentRuntime`, `Planner`, `ToolManager`, `WorkflowEngine` and
`EventBus` are constructed exactly as before. Phase 3 adds a layer that
composes them:

```
                         Orchestrator
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
            AgentCoordinator        WorkflowEngine  (Phase 2, unchanged)
                    │
                    ▼
              AgentRuntime  (Phase 2, unchanged: analyze → plan → execute → evaluate)
                    │
                    ▼
             AgentWorkspace
        ┌────────────┼─────────────┐
        ▼             ▼            ▼
   ContextManager  MemoryManager  ToolManager (Phase 2)
        └────────────┬─────────────┘
                      ▼
              ExecutionTrace ── ArtifactManager ── ApprovalManager
                      │
                      ▼
             StateRecoveryManager (snapshots, pause/resume, crash recovery)
```

| Subsystem | Path | Responsibility | Doc |
| --- | --- | --- | --- |
| orchestrator | `orchestrator/orchestrator.js` | routes a request to a shape, builds the world it runs in, calls the runtime/coordinator/workflow engine | [orchestrator.md](./orchestrator.md) |
| workspace | `workspace/workspace.js`, `workspace/manager.js` | the execution boundary: identity, root containment, policy, file tracking, environment | [workspace.md](./workspace.md) |
| context | `context/manager.js` | layered, selected, budgeted `ContextPacket` — never the whole repository | [context.md](./context.md) |
| memory | `memory/manager.js` | scoped, importance-scored, searched — never dumped; candidates before persistence | [memory.md](./memory.md) |
| project | `project/indexer.js` | marker-based detection + a bounded, cached tree — not a semantic index | [architecture.md](#phase-3-the-world-a-run-happens-inside) (below) |
| trace | `trace/store.js` | correlated, bounded, scrubbed operational telemetry | [execution-trace.md](./execution-trace.md) |
| artifacts | `artifacts/manager.js` | owned, typed outputs agents exchange instead of prose | [artifacts.md](./artifacts.md) |
| approval | `approval/manager.js` | auditable human-approval records; supplies the Phase 2 tool-authorize gate | [approvals.md](./approvals.md) |
| agents (multi) | `agents/coordinator.js`, `agents/messaging/` | selection, delegation (narrowing-only), handoff, messaging | [multi-agent.md](./multi-agent.md) |
| state | `state/recovery.js` | snapshots, pause/resume, crash recovery — never blind replay of a mutation | [state-recovery.md](./state-recovery.md) |

Every one of these takes its storage as a *collection*
(`persistence/collections.js`), a namespaced wrapper over the same
`{ get, set, delete, keys, clear }` store contract Phase 2 already defined —
so the whole set can move from the local JSON store to SQLite or a remote
backend by changing construction in `core/index.js` alone; no subsystem knows
what backs it.

### Identity (`workspace/identity.js`)

Every Phase 3 record — a workspace, a context packet, a memory entry, a trace
event, an artifact, a message — carries the same six correlation keys:
`workspaceId`, `projectId`, `taskId`, `sessionId`, `agentId`, `traceId`. A
delegated child mints its own `workspaceId`/`taskId` but inherits
`projectId`/`sessionId`/`traceId` from its parent and records
`parentWorkspaceId`, so a multi-agent run is traceable both as one run and as
its parts. `identityRefs()` is the subset the `EventBus` carries on every
event; `EventBus.emit` and every trace event accept and propagate it.

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