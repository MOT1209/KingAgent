# Phase 5 — architecture audit and consolidation

Phase 5 is not a redesign. It is the pass that makes the existing
implementation coherent: find what duplicates what, remove what nothing can
reach, and replace the places where the control plane reported things it had
not actually done.

This document records the audit findings and what was done about each. It is
the "before" half; [architecture.md](architecture.md) documents the result.

## Method

1. Map every module under `src/core/` and record who requires it.
2. Diff same-named modules across packages byte-for-byte.
3. Walk the real entry points (`src/core/index.js`, `src/main/agent-platform.js`)
   with a `Module._load` hook and list what is never reached.
4. Read every IPC handler and ask: could this answer be wrong?

## Findings

### F1 — a dead, broken copy of the multi-agent coordinator (§4, §5)

`src/core/orchestrator/` and `src/core/harness-orchestrator/` were built
independently and reconciled rather than merged. Four files were byte-identical
twins:

| File | Status |
| --- | --- |
| `orchestrator/coordinator.js` | identical to `harness-orchestrator/coordinator.js` |
| `orchestrator/handoff.js` | identical to `harness-orchestrator/handoff.js` |
| `orchestrator/locks.js` | identical to `harness-orchestrator/locks.js` |
| `orchestrator/messages.js` | identical to `harness-orchestrator/messages.js` |

Nothing imported any of them — not `orchestrator/index.js`, not
`src/core/index.js`, not a test. They formed a closed island: the coordinator
copy was the only importer of the handoff and messages copies.

Worse than dead. The copied coordinator opens with

```js
const { createDelegation, validateDelegation, completeDelegation,
        containment, delegationView, DELEGATION_STATUS } = require('./delegation');
```

but `orchestrator/delegation.js` is a *different module with the same name* — a
pure planner that turns a routing decision into delegation specs, exporting
`planDelegations` / `readyDelegations` / `auditDelegations`. It exports none of
those six names. CommonJS destructuring does not complain, so all six were
`undefined`, including `containment` — the check that enforces *"a delegated
child may never out-reach its parent"*. Anyone who wired this copy would have
got a coordinator whose containment check was not a function.

**Done:** the four copies were deleted. The live modules under
`harness-orchestrator/` are unchanged and remain the single source.

### F2 — a third artifact model (§6)

`src/core/artifacts/artifacts.js` was a byte-identical copy of
`src/core/harness-orchestrator/artifacts.js`, including a `createArtifactStore`
export that collides by name with the live one. Nothing imported it, and
`src/core/artifacts/` already holds the live workspace-owned model
(`artifact.js` + `store.js` + `manager.js`).

**Done:** deleted. Two artifact stores remain, and that is deliberate — see
[the artifact model](#the-artifact-model) below.

### F3 — a superseded trace builder (§3)

`src/core/observability/trace.js` (`buildTrace(task)`) was the Phase-2-era trace
view, superseded by the `trace/` subsystem (`ExecutionTrace` + `serializer.js`),
which is what the IPC layer actually imports. It had no importers and no tests.

**Done:** deleted; the directory is gone.

### F4 — the workflow control plane reported work it had not done (§11, §12)

Two IPC handlers answered from constants:

```js
handle('workflow:listInstances', () => []);
handle('workflow:cancel', ({ id }) => ({ cancelled: true, id }));
```

`workflow:cancel` is the serious one: it reported success unconditionally. There
was nothing underneath it to call — `WorkflowEngine` had no `cancel()` and no
`list()`, its `_instances` map was never persisted, and while
`INSTANCE_STATUS.CANCELLED` was defined, nothing ever set it. A user pressing
Stop got a UI that said "cancelled" over a workflow that kept running to
completion.

**Done:** see [workflow lifecycle](#workflow-lifecycle) below.

### F5 — a tool's real policy action was invisible (§16, §17, §29)

Found while writing the §29 security tests, by asserting a policy denial rather
than assuming one.

A tool may declare its own policy action instead of the `tool.call.<id>`
fallback: `terminal:run` gates on `command.run`, `fs:delete` on
`filesystem.delete`. The policy engine evaluates that declared string.
`ToolManager.peek()` — the metadata view behind `toolManager.list()` and the
`agent:listTools` IPC channel — did not include it.

So the only action visible to a person, or to any policy UI reading that list,
was the fallback. A deny rule written against `tool.call.terminal:run` validated
cleanly, registered cleanly, appeared in `policy.list()` — and never matched.
The shell tool kept running. A policy that looks applied but is not is worse
than no policy at all, and §17 asks the UI to answer *"which policy caused the
denial?"*, which is unanswerable if the action a rule must name is not
discoverable.

**Done:** `peek()` now includes `policyAction` (null when the tool uses the
fallback). `tests/phase5-security.test.mjs` asserts, for every registered tool,
that `actionForTool(view) === actionForTool(registered)`, and pins the two
built-ins whose action differs from their id. [policies.md](policies.md)
documents both.

### F6 — three packaging entry points shipped without the offline model (§33, §34)

The app transcribes on-device with whisper-tiny.en, shipped through
electron-builder's `extraResources` from `build/models`, which
`npm run fetch-model` populates. An empty `build/models` is **not** a build
failure: electron-builder copies nothing, the installer is produced, and the app
downloads the weights on first launch instead — which is exactly what the local
engine exists to avoid.

npm runs `pre<name>` for the *exact* script name, so `prepack` covered `pack`
and nothing else. `dist:win`, `pack:win` and `pack:mac` had neither a hook nor
an inline call. package.json's own comment records this trap being sprung once
before, for `dist`:

> predist matters: npm runs pre&lt;name&gt; for any script, so `pack` picked up
> the weights via prepack while `dist` — the one that builds what users install
> — quietly shipped without them.

It was fixed there and for `dist:mac`, and missed for the Windows scripts.

The CI Windows job made it look handled without being handled: it caches
`build/models` and then runs `npm run pack:win`. A cache only restores what some
earlier run wrote, and no step ever wrote it — so the cache was always a miss
and every Windows CI pack produced a model-less build. The verification step
after it checked for the exe and for node-pty, not for the weights.

Release artifacts were never affected: `ship.yml` and `release.yml` chain
`npm run fetch-model &&` explicitly.

**Done:** `prepack:win`, `prepack:mac` and `predist:win` added, so every
packaging entry point is self-sufficient (`fetch-model` is idempotent, so the
one script that also calls it inline costs nothing). The CI Windows verification
now fails if `resources/models` contains no `.onnx`.
`tests/phase5-packaging.test.mjs` asserts that every script invoking
electron-builder fetches the model by hook or inline, that `extraResources`
still carries `build/models`, and that the CI job populates it before packing.

### F7 — contradictory architecture documentation (§40)

`docs/architecture.md` carried the section `## Phase 4: orchestration,
governance, execution` twice. The second copy's table pointed at `artifacts/`
and `orchestrator/` — the Phase 3 paths — for Phase 4 subsystems.

**Done:** the stale copy was removed.

## What was deliberately *not* merged

### The two orchestrators

`platform.orchestrator` is the public control plane. `platform.harnessOrchestrator`
is the harness-aware pipeline beneath it. They are different abstraction levels,
not two spellings of one thing, and §4 permits exactly that. Collapsing them into
one class would touch the IPC surface, the preload API and the renderer at once
— a change whose only honest validation is a running Electron app on Windows and
macOS, which this pass could not perform. The duplication that *was* pure
copy-paste (F1) is gone; the layering is now asserted by test rather than by
comment.

### The two coordinators

`AgentCoordinator` (`agents/coordinator.js`) selects agents, owns their
lifecycles and aggregates delegated results through the `AgentRuntime`.
`HarnessCoordinator` (`harness-orchestrator/coordinator.js`) owns the delegation
*record*, file locks, harness runs, sandboxes and the control view the UI reads.
Both expose `delegate`, which is the seam worth watching, so
`tests/phase5-architecture.test.mjs` pins the methods only one of them may have
and fails if either grows the other's.

### The artifact model

Two stores remain, for a reason §6 allows: the workspace-owned `ArtifactManager`
reads under a workspace's own policy, while the harness store carries execution
provenance for runs that may span workspaces. What must not differ is the shape
the UI has to understand — so both now pass through one `artifactView` in
`src/main/agent-platform.js` and reach the renderer as one model:

```
identity     id, type, name, summary
provenance   taskId, workspaceId, agentId, harnessId, sessionId, traceId,
             delegationId   — absent ones are null, never missing
storage      storage: { ref, path, bytes, digest, truncated }
```

The pre-Phase-5 top-level `path` / `bytes` / `digest` fields are still emitted so
existing readers keep working.

## Workflow lifecycle

`WorkflowEngine` gained the operations the IPC layer was pretending to have.

### Cancellation is real

`cancel(id, reason)` returns what it actually achieved, never a bare
`{ cancelled: true }`:

| Case | Result |
| --- | --- |
| running instance | `{ cancelled: true, status: 'cancelled', reason, requestedAt }` |
| unknown id | `{ cancelled: false, status: null, reason: 'unknown instance' }` |
| already finished | `{ cancelled: false, status: 'completed', reason: 'already completed' }` |
| already requested | `{ cancelled: false, reason: 'cancellation already requested' }` |

The IPC handler forwards that verbatim, so the UI cannot claim a cancellation
that did not happen.

Mechanically: the request is recorded on the instance, an `AbortController` is
aborted, and the walk checks for it **before entering a node and again after the
node returns**. An instance parked on a human approval — the one place a cancel
would otherwise hang forever — has its wait raced against the abort signal. The
abort signal is also passed into tool, code and shell executors, all of which
already accepted a `signal`.

The honest limit: a node executor that ignores the signal runs to completion.
What cancellation guarantees is that its output is discarded, no further node is
entered, and the instance reaches `cancelled` — not that an in-flight syscall is
unwound. `tests/phase5-workflow-lifecycle.test.mjs` asserts exactly that.

### History survives a restart

Instances are persisted to a `workflow:` collection on every status transition,
including **on entry to each node** — otherwise the persisted `currentNodeId`
names the last node that finished and an interrupted run misreports where it
stopped. Each instance carries `traceId`, `workspaceId` and `taskId` (§27).

`restore()` reloads them at startup. A run that was mid-flight when the process
died comes back as `interrupted` — a distinct status from `cancelled` and
`failed` — rather than claiming to still be running. Instances already live in
the process are never clobbered by a restore.

### Persisted history is scrubbed

Node inputs and outputs are whatever a tool, shell command or agent returned, so
they are exactly where a credential rides along — and unlike the in-memory view,
this copy is written to the user's disk and outlives the session. The persisted
record goes through the same `scrub()` the execution trace uses (§20), which
redacts credential-shaped keys, removes private-reasoning keys, and bounds
strings, arrays and depth so one enormous command output cannot balloon the
store. The in-memory view keeps the real values, so a running workflow's
conditions and its caller are unaffected.

## Invariants now held by tests

`tests/phase5-architecture.test.mjs`:

- no two core modules are byte-identical copies
- every symbol a core module destructures from a sibling is actually exported
  there (this is the check that would have caught F1 on the day it was written)
- the orchestrator package holds no module unreachable from its own barrel
- exactly two orchestrators on the platform, at distinct levels
- the two coordinators do not grow each other's responsibilities
- both artifact stores produce the same key set at the IPC boundary
- neither removed placeholder literal has come back

`tests/phase5-workflow-lifecycle.test.mjs`: cancellation, approval interruption,
listing, correlation ids, restart/interruption, and secret redaction.

`tests/phase5-packaging.test.mjs`: every packaging script fetches the model,
`extraResources` still carries it, and the Windows CI job populates it first.

`tests/phase5-security.test.mjs` — §29's named malicious inputs against the real
platform, not a unit: every path-escape shape (POSIX and Windows-flavoured) is
refused; `%USERPROFILE%`, `$env:PATH` and `$HOME` stay literal filenames rather
than expansions; shell metacharacters (`&&`, `|`, `;`, backticks, `$( )`) reach
the authorization gate and a denied call never reaches the shell adapter; a
policy denial is final and the human gate is never consulted past it; an agent
cannot author a policy; the listed policy action agrees with the gated one; and
— §18 — a platform with no approval UI wired fails closed: an unanswered
request expires as an auditable refusal rather than proceeding, and the shell
adapter is never reached.
