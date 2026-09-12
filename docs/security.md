# KingAgent security model

The threat model: a renderer that is untrusted-by-default, tool calls that can
touch the filesystem and the shell, and a model provider that must never leak
chain-of-thought or secrets.

## Renderer isolation

- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true` (`src/main/main.js`).
- The renderer gets exactly one bridge — `window.kingagent` via
  `contextBridge` in `src/main/preload.js`. It never touches `require`, IPC
  internals or the filesystem directly.

## Guarded IPC

- `src/core/security/ipc-guard.js` is the single source of truth:
  - `CHANNELS` — the allowlist of channels the main process may handle.
  - `PUSH_CHANNELS` — the three fixed push channels (`agent:event`,
    `workflow:event`, `approval:event`) the preload may subscribe to.
  - `validatePayload(channel, payload)` — required fields, types, unknown
    fields are dropped before a handler touches the subsystem.
- Every main-process handler (and the preload's API) is audited by tests:
  - `core-security.test.mjs` — unknown channels are forbidden, validation is
    enforced, `authorizeResponse` only accepts a boolean.
  - `core-wiring.test.mjs` — every guarded channel has an `ipcMain.handle`,
    and the preload surface is a subset of the allowlist.

## Tool permissions

- Every tool has a permission `level` (`read_only` … `destructive`) from
  `src/core/tools/definition.js`.
- `src/core/tools/permissions.js` decides what an agent may execute based on
  the configured levels and `allowDestructive`.
- `requiresAuth` tools (e.g. `fs:delete`) get an explicit authorization
  decision per call — default **deny** (`ToolDeniedError`). The runtime asks
  through `agent:authorizeResponse`, pending decisions live in the main
  process' `pendingAuth` map, and a workflow approval node uses the same gate.
- Timeouts abort cleanly and classify as `TOOL_TIMEOUT`; aborts as
  `TOOL_ABORTED` (`src/core/tools/manager.js`).

## Path containment

- `src/core/tools/path-guard.js` — `assertWithin(root, p)` / `resolveWithin`.
  Root-relative, OS-correct containment is unit-tested
  (`core-tools.test.mjs` — path-guard escape attempts fail).
- Filesystem tools are wired to the workspace root via `io.root`; without a
  root they still resolve through `node:path`, never string literals.

## No chain-of-thought, no leakage

- The reasoner returns only `{ goal, rationale, decision, actions }` where
  rationale is a **capped human-readable** sentence — never raw reasoning
  (`src/core/reasoning/reasoning.js`, verified in `core-reasoning.test.mjs`).
- The evaluator's judge prompt asks for `{ passed, reason, next }` only.
- Logger redacts secret-shaped keys (`*token*`, `apiKey`, `authorization`, …)
  at every depth and survives circular references (`core-foundations.test.mjs`).
- Provider adapters hold keys in `src/main/`, never in the core or the UI.

## Coping without a provider

`nullProvider` throws `ModelError`; every subsystem has a deterministic
fallback so a platform with no model configured still runs, and nothing
pretends otherwise (`core-security.test.mjs`).