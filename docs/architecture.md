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
| workflows | `workflows/engine.js` | node-graph workflows with approvals, real cancellation and persisted instance history |
| context | `context/context.js` | immutable snapshot of the task world per step (Phase 2) |
| memory | `memory/memory.js` | in-process session/task key-value memory (Phase 2) |
| execution | `execution/code-exec.js` | sandboxed code execution interface |
| recovery | `recovery/recovery.js` | retry / replan / ask-human decisions for a failed **step** |

## Phase 4: orchestration, governance, execution

Phase 2's runtime still runs the work. Phase 4 wraps it in a second,
independent control plane that decides *what* runs, *where*, *whether it
may*, and *in which sandbox* — built alongside the Phase 3 layer below
rather than in place of it (see that section for why both exist and how
`src/core/index.js` reconciles them):

| Subsystem | Path | Responsibility |
| --- | --- | --- |
| harness | `harness/` | execution backends behind one adapter interface + registry |
| policy | `policy/` | scoped governance: allow / deny / approval, with an audit trail |
| sandbox | `sandbox/` | authorized workspaces, limits, process ownership, cleanup |
| session | `session/` | the container a person's work lives in |
| artifacts | `harness-orchestrator/artifacts.js` | the products of a run, with harness/session provenance (`platform.harnessArtifacts`) |
| orchestrator | `harness-orchestrator/` | routing, multi-agent coordination and the run pipeline (`platform.harnessOrchestrator`) |

```
User
 ↓
Orchestrator ── Router ──> Agent + Harness
 ↓
Policy ──> Sandbox ──> Workspace
 ↓
Agent Runtime (Planning → Tools → Execution → Evaluation → Recovery)
 ↓
Artifacts ──> Session ──> Trace
```

The rule this layer is built on:

> KingAgent owns orchestration, governance, workspace, context, memory,
> execution control and observability. Harnesses are replaceable execution
> backends.

Design documents: [harness-orchestrator.md](harness-orchestrator.md),
[harness.md](harness.md), [routing.md](routing.md), [policies.md](policies.md),
[sandbox.md](sandbox.md), [sessions.md](sessions.md),
[harness-multi-agent.md](harness-multi-agent.md),
[delegation.md](delegation.md), [security-model.md](security-model.md).

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

## Phase 5: one path, asserted rather than described

Phase 5 consolidated what Phase 3 and Phase 4 had each built independently. It
removed five unreachable modules — four of them byte-identical copies, one of
them a coordinator whose containment check resolved to `undefined` — replaced
two IPC handlers that answered from constants, and turned the layering rules
into tests. The findings and what was done about each are recorded in
[phase5-audit.md](phase5-audit.md).

What the layering means in practice:

| Question | Answer |
| --- | --- |
| Which orchestrator is public? | `platform.orchestrator`. `platform.harnessOrchestrator` is the harness-aware pipeline beneath it. |
| Who owns agent delegation? | `AgentCoordinator` — selection, lifecycles, aggregation through the `AgentRuntime`. |
| Who owns the execution backend? | `HarnessCoordinator` — delegation records, file locks, harness runs, sandboxes, the control view. |
| How many artifact shapes does the UI see? | One. Two stores remain (different ownership rules); one `artifactView` at the IPC boundary. |
| Can a workflow actually be cancelled? | Yes, and `cancel()` reports only what it achieved. See [workflows.md](workflows.md). |

These are enforced by `tests/phase5-architecture.test.mjs`, so a future copy of a
module, a dangling sibling import, or a placeholder handler fails CI rather than
surviving in the tree.

The style is composition over libraries: `io` adapters (fs, shell, cwd) are
injected, so tests swap them for stubs and the main process injects the real
ones. No hardcoded OS paths — everything resolves through `io`, `node:path` or
`process.env` (e.g. `ComSpec`/`$SHELL` for the shell adapter).

## Phase 6: the skill ecosystem and the MCP capability layer

Phase 6 adds `src/core/skills/` and `src/core/mcp/`, wired into the factory as
`platform.skills` and `platform.mcp`, plus `platform.initSkills()` (construction
stays synchronous and side-effect free; a host decides when to pay for
validation and scanning).

A skill is a capability package — instructions, metadata, declared permissions,
provenance — not a plugin and not something the platform executes. The layer
takes the subsystems that already exist rather than growing parallel ones:
permissions are policy actions evaluated by the `PolicyManager`, human decisions
are `ApprovalManager` records, isolation is the Phase 4 `SandboxManager`, actions
are `ToolManager` calls, and outcomes are scoped memory entries. A deployment
that denies `command.run` blocks a skill wanting a shell without a
skill-specific rule existing anywhere.

MCP is governed by the same seam: `src/core/mcp/` classifies each advertised
tool (READ_ONLY … PRIVILEGED, with a server's own hints able to raise a class but
never lower it), and the bridge registers those tools *as tools*, so there is no
path by which an MCP call reaches an agent without the permission gate and the
policy engine.

Full detail in [docs/skills/architecture.md](skills/architecture.md);
[security](skills/security.md), [MCP](skills/mcp.md),
[manifests](skills/skill-manifest.md), [evaluation](skills/evaluation.md),
[authoring](skills/creating-skills.md) and
[skills.sh](skills/skills-sh.md) each have their own document.

## Phase 7: research

Research is a subsystem of the runtime, not a utility beside it: a question
becomes a planned, budgeted, governed investigation that produces verified
claims with citations pointing at text somebody can check.

| Subsystem | Path | Responsibility |
| --- | --- | --- |
| research | `research/` | the whole layer (`platform.research`) |
| planning | `research/planner/` | classify, choose a strategy, decompose into non-redundant queries |
| routing | `research/router/` | does this need research at all; which source types; how much budget each gets |
| sources | `research/sources/` | web, news, academic, discussion, github, documentation, file, MCP — behind one injected provider registry |
| retrieval | `research/retrieval/` | bounded-concurrency parallel retrieval, normalization, clustering dedup, reranking, freshness-aware cache |
| evidence | `research/evidence/` | verbatim spans, claims, independence, conflicts, cross-verification |
| citations | `research/citations/` | build, format and validate — a citation requires evidence that exists |
| quality | `research/quality/` | source, evidence and completeness scoring, capped by its weakest pillar |
| agents | `research/agents/` | a normal read-only KingAgent agent, plus reviewer and synthesizer roles |
| security | `research/security/` | the untrusted-content boundary: SSRF, injection, credentials, exfiltration |
| policies | `research/policies/` | research actions for the **existing** policy engine |

It constructs none of what it uses. The policy engine gates each source, the
`MemoryManager` decides what may be remembered, the `ExecutionTraceStore`
records the run, the `ArtifactManager` holds the report, the `ToolManager`
publishes the capabilities and the `AgentRegistry` gets the agent — no second
manager of anything, asserted by `tests/research-integration.test.mjs`.

Core imports no HTTP client, exactly as it imports no model SDK: every
networked source resolves through a host-supplied provider
(`io.research.searchProviders`), and with none configured those source types
report themselves unavailable *with a reason* rather than returning an empty
result set that reads as "nothing exists about this topic".

See `docs/research.md` for the pipeline, the four invariants that make the
output trustworthy, the threat model and the developer API.

## Phase 8: runs, the organization and model routing

Three additions that sit *above* the phases above without replacing any of
them — the orchestrator composes them, and none of them owns a planner, a
runtime or a scheduler.

| Subsystem | Path | Responsibility | Wired as | Doc |
| --- | --- | --- | --- | --- |
| runs | `runs/` | a Run indexes one objective: the agents, tasks, tools, artifacts and spend it touched, plus a timeline fed off the event bus | `platform.runs` | [runs.md](./runs.md) |
| agent factory | `agents/factory.js` | runtime creation of specialists with a risk-based spawn policy, plus promotion/demotion | `platform.agentFactory` | [runs.md](./runs.md) |
| agent governor | `agents/governor.js` | depth / fan-out / concurrency / runtime / budget limits, duplicate and recursive-spawn detection, runaway sweep | `platform.agentGovernor` | [runs.md](./runs.md) |
| chief system | `agents/presets/chief.js`, `agents/chief.js` | Ahmad 🧠 plans, Rashid 👨‍💻 executes, specialists are spawned through the factory | `platform.chief` | [agents-hierarchy.md](./agents-hierarchy.md) |
| model router | `ai/model-router.js` | a *kind* of work → provider + model, by capability/cost/latency/privacy, deterministic when nothing is wired | `platform.modelRouter` | [model-routing.md](./model-routing.md) |
| browser | `browser/` | ten `browser:*` tools with named policy actions and risk levels, plus session ownership and take/return control | `platform.browser` | [browser.md](./browser.md) |

The browser's other half lives in `main`, because that is where the tabs are:
`browser-agent-host.js` is the `io.browser.host` adapter (each action over the
app's own `webContents`, navigation still validated by `browserUrl()`), and
`browser-mcp.js` refuses the browser-facing MCP tools while a person holds a
granted tab — so take-control stops the route agents actually use, not only the
new one. Take/return control is reachable from the browser menu and never as a
tool.

The orchestrator uses the last two directly: `handle()` asks the router for a
selection, starts a Run before work begins, and folds the agent, task, provider,
model, context and artifacts into it as the run proceeds. Run indexing is an
observer — `_indexRun` swallows its own failure so a bookkeeping problem can
never turn into a failed run.

System agents (Ahmad, Rashid) carry `metadata.system` and are excluded from
capability-based delegation, so a broad executive cannot out-compete a narrow
specialist for every job.

### The shared conversation (§13/§38)

`src/renderer/conversation-view.mjs` is one transcript for the whole
organization, mounted beside the tile workbench rather than instead of it. It
folds the *same* event stream the activity view reads: King's objective, Ahmad
planning, Rashid executing, specialists appearing, tool calls, approvals and the
result. King's input goes to `orchestrator:run`, so saying what you want is what
starts a run.

The vocabulary is `agent-activity.mjs`'s `describe()` — a fixed list of
operational facts — so no line can be private reasoning, and an event nobody has
decided how to phrase produces no line instead of a raw type name.

### Rendering the organization

`src/renderer/agent-org.mjs` is the view's *data* layer, and it is separate from
any DOM on purpose: `buildOrgTree` folds lineage into a tree (`orgRows` is the
display order), `runTimeline` narrows a run's timeline to one agent,
`runHeadline` summarizes a run and `agentDetail` assembles the §42 panel. All
pure, so the whole view is asserted in plain node
(`tests/agent-org.test.mjs`); `mountOrgView` is the thin adapter that renders
rows and calls back with the id that was clicked. Only the mount remains to be
placed in the shell.

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