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

## Untrusted external content (Phase 7)

Research ingests text from pages nobody here wrote, files the user pointed at
and MCP servers someone else configured. `src/core/research/security/researchSecurity.js`
is the boundary; nothing else in the research layer is allowed to decide these
questions. Tested in `research-security.test.mjs`.

- **SSRF.** Only `http`/`https`; no credentialed URLs; loopback, private, CGNAT,
  link-local and cloud-metadata addresses refused, plus bare intranet hostnames.
  IPv4-mapped IPv6 is handled in **both** spellings — WHATWG `URL` rewrites
  `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, and matching only the readable one
  let a loopback fetch straight through.
- **Credentials and exfiltration** are hard failures: API-key and private-key
  shapes, and long data-carrying URLs, are redacted and the content refused.
  Outbound query text is screened too — a query decomposed from file contents is
  the realistic way a secret reaches a search box.
- **Prompt injection is defanged, not discarded.** Instruction-shaped spans are
  wrapped in a visible marker and the source's authority is docked. Dropping the
  page would let any site remove itself from research by adding "ignore previous
  instructions" to its footer — a denial-of-service, not a defence — and would
  make research *about* prompt injection impossible.
- **Nothing is concatenated into a prompt.** `wrapUntrusted` fences retrieved
  text with a per-call unguessable marker and a header declaring it data.
- Evidence extraction **refuses** any source without a security verdict, so
  content cannot reach a model by going around the boundary.

Research telemetry is subject to the same no-deliberation rule as everything
else: the event types carry operational facts only, and `trace/events.js`
rejects the forbidden key shapes (`research-integration.test.mjs` asserts it).

## Coping without a provider

`nullProvider` throws `ModelError`; every subsystem has a deterministic
fallback so a platform with no model configured still runs, and nothing
pretends otherwise (`core-security.test.mjs`).