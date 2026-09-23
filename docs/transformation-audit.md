# KingAgent — transformation audit, gap analysis and plan

Status: **Stages 1–3 complete (audit / gap analysis / plan). No code changed.**
Source of the target: the "Professional AI Development Operating Environment"
master prompt (v3.0). This document maps that target onto what the repository
*already* is, so we build the missing parts instead of rebuilding the whole.

The single most important finding:

> KingAgent already implements the large majority of the target runtime.
> `src/core/` (Phases 2–7) is a headless, Electron-free agent platform with an
> event bus, agent registry + runtime, planner/reasoner, task state machine,
> delegation coordinator, workflow engine, tool registry, policy engine,
> sandbox, sessions, approvals, artifacts, memory, context, traces, skills, MCP
> and a research subsystem. The transformation is therefore **additive**, not a
> rewrite. Blindly "rebuilding KingAgent" would destroy working, tested code.

---

## 1. What the repository is

Electron desktop app, plain JS, no bundler, no framework. Two long-lived
identities coexist by design (see `README.md`, "Relation to upstream"):

- **The paper workbench UI** (`src/renderer/`, `src/main/`): open a folder, run
  agent CLIs as paper tiles in real PTYs (`node-pty` + xterm), themes, MCP setup,
  a live browser pane. This is the product people install.
- **The core platform** (`src/core/`, CJS, no Electron imports): Phases 2–7.
  Wired into Electron through `src/main/agent-platform.js` and exposed to the UI
  as `window.kingagent.agentPlatform`.

Layering (`docs/architecture.md`):

```
renderer (ESM) ── contextBridge ──> preload ── ipcMain.handle ──> main
                                                                    │
                                      createPlatform(io) ── src/core (CJS)
```

`createPlatform({ io, storeDir })` in `src/core/index.js` is the whole wiring
diagram: one `EventBus`, every subsystem constructed once, storage abstracted
behind `persistence/collections.js` so the JSON store can move to SQLite by
changing one construction.

### Subsystem inventory (already present)

| Target capability | Existing implementation | Status |
| --- | --- | --- |
| Event bus | `core/events/event-bus.js` (`TYPES`, frozen stream) | ✅ |
| Observability / logging | `core/logging/logger.js`, `core/trace/store.js` | ✅ |
| Task engine + states | `core/runtime/task*.js`, `runtime/states.js` | ✅ |
| Agent runtime loop | `core/runtime/runtime.js` (analyze→plan→execute→evaluate→recover) | ✅ |
| Agent registry | `core/agents/registry.js`, `definition.js` (validated schema) | ✅ |
| Agent lifecycle states | `core/agents/lifecycle.js` | ✅ |
| Planning / reasoning | `core/planning/planner.js`, `core/reasoning/reasoning.js` | ✅ |
| Multi-agent delegation | `core/agents/coordinator.js` (narrowing, bounded, cancellable, traced) | ✅ |
| Agent messaging | `core/agents/messaging/` (typed message bus) | ✅ |
| Workflow engine | `core/workflows/engine.js` (nodes, approvals, cancel, persisted) | ✅ |
| Tool registry | `core/tools/manager.js` + `builtin.js` (permission-gated) | ✅ |
| Policy engine / security | `core/policy/`, `core/security/` | ✅ |
| Sandbox / code exec | `core/sandbox/`, `core/execution/code-exec.js` (opt-in engines) | ✅ |
| Human approvals | `core/approval/manager.js` (auditable, supplies tool gate) | ✅ |
| Workspace / files | `core/workspace/` (containment, policy, file tracking) | ✅ |
| Memory | `core/memory/` (scoped, importance-scored, provider-backed) | ✅ |
| Context | `core/context/` (budgeted packets, never whole repo) | ✅ |
| Artifacts | `core/artifacts/` + `harness-orchestrator/artifacts.js` | ✅ |
| Projects | `core/project/indexer.js` | ✅ |
| Sessions | `core/session/` + main-side `session-registry.js` | ✅ |
| Skills | `core/skills/` (+ `docs/skills/`) | ✅ |
| MCP | `core/mcp/` (classified, routed through ToolManager) | ✅ |
| Provider abstraction | `core/ai/provider.js` (registry) | ✅ (partial) |
| Harness routing | `core/harness-orchestrator/router.js` | ✅ |
| State recovery / snapshots | `core/state/recovery.js` | ✅ |
| Research | `core/research/` (Phase 7) | ✅ |
| Browser | `src/main/browser-*.js` + `@playwright/mcp` | ⚠️ main-side only |

Test suite: **189 test files** under `tests/` (`node --test`), including
architecture-conformance tests (`phase5-architecture.test.mjs`,
`core-wiring.test.mjs`, `repo-shape.test.mjs`) that fail CI if a module is
copy-pasted or a channel is left unguarded.

---

## 2. Gap analysis — target vs. actual

Only genuinely missing or mis-shaped items are listed. Everything above is
preserved as-is.

### 2.1 G1 — The Ahmad / Rashid organizational hierarchy (missing)

The target names two permanent system agents: **Ahmad 🧠** (chief planner) and
**Rashid 👨‍💻** (executive operator), with specialist and dynamic agents beneath
them. Nothing in the repo uses those names or that two-tier role split
(`grep -i 'ahmad|rashid'` → no matches). Today the equivalent logic is generic:

- planning exists but is anonymous (`Planner`, `Orchestrator`), not an agent
  persona that owns a plan and reviews results;
- execution is `harnessOrchestrator` / `coordinator`, not an executive agent
  that owns delegation, recovery and King approval.

**Decision required:** is Ahmad/Rashid (a) a *rename + persona layer* over the
existing orchestrator/coordinator, or (b) two real `AgentDefinition`s with
system prompts and their own runtime tasks? (b) is closer to the prompt but
touches the runtime; (a) is cheaper and less risky.

### 2.2 G2 — Agent Factory: runtime creation of new specialists (partial)

`AgentRegistry.register/update/unregister` exist, so programmatically creating
an agent definition is already possible. What is missing is the **factory as a
governed capability**:

- no "Rashid decides it needs a specialist → create one" flow with a proposal
  step;
- no **spawn approval policy** by risk level (prompt §31: low = auto, medium =
  approve before execution, high = approve creation *and* execution);
- spawn limits exist only as delegation limits (`DEFAULTS.maxDepth = 3`,
  `maxFanout = 6`) — there is no `maxChildren`, `maxRuntime`, token/cost budget,
  duplicate-agent detection, recursive-spawn detection or runaway watchdog
  (prompt §30).

### 2.3 G3 — Agent promotion (missing)

Temporary → persistent promotion (prompt §32) does not exist. `update()` can
persist a definition, so the write path is there; the promote/demote semantics,
provenance (`createdBy`, `parentAgentId`, `rootTaskId`) and UI do not.

### 2.4 G4 — Model Router (missing)

There is a **provider registry** (`core/ai/provider.js`) and an `agent.model`
binding, and a **harness router** that picks an *agent/harness*. There is no
**model router** that picks a provider+model per task type (planning → reasoning
model, coding → coding model, vision → vision model, fast → lightweight),
balancing cost/latency/privacy/availability. `grep -i 'modelRouter|selectModel'`
→ no matches. Provider independence is architecturally in place; the routing
brain is not.

### 2.5 G5 — Run entity (missing)

Prompt §44 wants every major execution to be a first-class **Run** (id, project,
conversation, root task, agents, tasks, tools, models, providers, browser
sessions, events, artifacts, cost, duration, status; start/pause/resume/stop/
retry/inspect). Today a "run" is implicit across a task + workspace + trace +
session. No `Run` object aggregates them.

### 2.6 G6 — Shared conversation (missing / architectural)

Prompt §13/§38: **one** shared conversation where King sees King/Ahmad/Rashid/
specialists/system/tool/approval events, instead of isolated per-agent chat.
The current UI is the opposite: isolated PTY tiles per session
(`docs/design.md`), and the core has no conversation entity. This is the single
largest UI change and conflicts with the current product's deliberate design
("a structured card view over those CLIs was tried and retired, 2026-08-21").
**This must be a conscious product decision, not a silent rewrite.**

### 2.7 G7 — Agent observability UI (partial)

The core emits the means (events, traces, lifecycle, lineage via
`workspace.identity` + `metadata.delegatedFrom`), but there is no org view:
agent tree with status, current task, model, tools, children, runtime, cost
(prompt §41/§42), no agent detail panel, no execution timeline view (§34). The
renderer has `agent-activity.mjs` and `research-panel.mjs` as starting points.

### 2.8 G8 — Browser as a governed core subsystem (misplaced)

Browser automation is main-side (`browser-cdp.js`, `browser-mcp.js`,
`browser-views.js`, `browser-overlays.js`, profiles, policy) plus
`@playwright/mcp`. Prompt §22–§24 want a `BrowserManager → Runtime → Session →
Tab → Actions` model in the platform, agent-addressable, with granular
permissions (`browser.navigate/read/click/type/…`) and live **Take Control /
Return Control**. Much of the *feature* exists; whether an agent can reach it
through the core ToolManager + permission gate needs verification before we
claim a gap. Treat as **verify-then-decide**, not rebuild.

### 2.9 G9 — Explicit "no isolated chat rooms" UI + project-centric shell

The prompt's three-pane IDE shell (§39) — Nav / Shared Conversation / Activity
— is not the current layout. Same product-decision caveat as G6.

### 2.10 Non-gaps (do **not** rebuild)

AgentRuntime, Planner, Reasoner, ToolManager, WorkflowEngine, EventBus, Policy,
Sandbox, Approval, Memory, Context, Artifacts, Trace, Skills, MCP, Research —
all exist and are tested. The prompt's §48 module list is already satisfied by
`src/core/*`; forcing the exact `/agent-runtime`, `/agent-factory`, `/runs`
folder names would churn paths caught by `phase5-architecture.test.mjs`.

---

## 3. Recommended plan (additive, staged, test-gated)

Order chosen to maximize value per risk. Each stage: implement → run
`npm test` + `npm run lint` → fix → continue. No stage deletes working modules.

**Stage A — Foundation entities (low risk, high leverage). — ✅ DONE**
`core/runs/` (Run entity aggregating the work an objective touched, with
start/pause/resume/stop/cancel/retry/inspect and a timeline fed off the event
bus), `core/agents/factory.js` (governed runtime creation with risk-based spawn
policy and promotion/demotion) and `core/agents/governor.js` (depth, fan-out,
concurrency, runtime, budget, duplicate and recursive-spawn limits). Wired into
`createPlatform` as `platform.runs`, `platform.agentFactory` and
`platform.agentGovernor`; documented in [runs.md](./runs.md); tested by
`tests/core-runs.test.mjs` and `tests/core-agent-factory.test.mjs` (32 tests).
Full suite: 2067 passing, 0 failing. Lint clean on the touched files.

**Stage B — Model Router. — ✅ DONE**
`core/ai/model-router.js`: task kind → requirements → provider + model, with
capability, cost, latency and privacy constraints and a deterministic fallback
when nothing is wired. Wired as `platform.modelRouter`; the orchestrator records
the selection on each Run. Tests: `tests/core-model-router.test.mjs`.
Documented in [model-routing.md](./model-routing.md).

**Stage C — Ahmad / Rashid as real agents. — ✅ DONE**
Two real `AgentDefinition`s (`agents/presets/chief.js`) — Ahmad (chief planner)
and Rashid (executive) — plus a thin `ChiefSystem` facade (`agents/chief.js`)
that composes the existing router/orchestrator/coordinators/factory rather than
owning any planning or execution of its own. System agents carry
`metadata.system` and are excluded from capability-based delegation. Wired as
`platform.chief`; tests in `tests/core-chief.test.mjs`; documented in
[agents-hierarchy.md](./agents-hierarchy.md).

**Runs are now indexed automatically. — ✅ DONE**
`Orchestrator.handle()` starts a Run for every objective and folds the agent,
task, provider, model, context packet and artifacts into it. Indexing is an
observer: `_indexRun` swallows its own failures so bookkeeping can never break a
run. Covered by the integration tests in `tests/core-runs.test.mjs`.

**Stage D — Agent observability UI. — 🟡 DATA LAYER DONE, MOUNT REMAINING**
`src/renderer/agent-org.mjs`: the org tree (lineage from what the factory
actually wrote, orphans kept and flagged, cycles cut rather than recursed,
deterministic ordering with system agents first), the run timeline (§34, folded
from the run record's own event summaries and filterable to one agent), the run
headline, and the §42 agent detail panel — plus a deliberately dumb DOM adapter.
Pure, no DOM, no preload, so the whole view is asserted in plain node; tests in
`tests/agent-org.test.mjs` (16).
**Remaining**: mounting it in the shell (which needs the layout decision in
Stage E, since where the tree lives depends on whether there is an Activity
pane).

**Stage E — Shared conversation + project shell (product decision). — ⬜ DEFERRED**
The big one. Requires choosing between (i) replacing the tile design, or (ii)
adding a "Conversation" view alongside tiles. Must not retire the PTY workbench
without explicit sign-off.

**Stage F — Browser parity. — 🟡 CONTROL PLANE DONE, WIRING REMAINING**
Verified first, and the verification changed the verdict: the browser **is**
already agent-reachable, through a per-session Playwright MCP endpoint over a
scoped CDP transport (`src/main/browser-mcp.js`, `browser-cdp.js`) with its own
session scoping and grant/revoke. What was genuinely missing is the part a
policy can be written against: named permission actions, risk levels, and
take-control that actually stops an agent.
`src/core/browser/` adds exactly that — `BrowserControl` (owner per session,
refusal inside the tool call, one agent per session, take/return control) and ten
`browser:*` tools registered against the existing ToolManager, so the existing
level, policy and approval gates apply with no new permission system. Wired as
`platform.browser`; `io.browser.host` is the injected adapter (object or late-
bound function) that owns the real engine, and with none wired the tools register
but fail with `BROWSER_UNAVAILABLE`. Tests: `tests/core-browser.test.mjs` (18).
Documented in [browser.md](./browser.md).
**Remaining** (main side, cannot be verified without Electron): the host adapter
over `browser-views.js`, holding the MCP route when a person takes control, and a
UI affordance. Named in [browser.md](./browser.md) §"What is not done yet".

**Stage G — Docs.** `docs/agents/`, `docs/runs.md`, `docs/model-routing.md`,
update `docs/architecture.md`.

---

## 4. Risks / constraints

- **Do not fork a second architecture.** Both existing layers (Phase 3 and
  Phase 4/harness) are deliberately parallel with the same-named concepts kept
  apart (see `core/index.js` header). New work must extend one side explicitly,
  or `phase5-architecture.test.mjs` and reviewer sanity both suffer.
- **Determinism is a contract.** `io.provider === null` must keep working; every
  new subsystem needs a deterministic fallback.
- **G6/G9 are product changes**, not engineering ones. Building them unasked
  would delete the shipped paper-workbench experience.
- **Coverage gate.** `c8` gates lines/statements ≥70, functions ≥80 on
  `src/main` + `src/core`. New core modules must ship tests.

---

## 5. Open questions for the owner

1. **Ahmad/Rashid (G1):** thin persona facade over the existing
   planner/orchestrator, or two real agents with their own runtime tasks?
2. **Shared conversation (G6/G9):** replace the tile workbench, or add a
   Conversation view beside it?
3. **Model routing (G4):** which providers/models are in scope (the app today
   runs on the user's existing agent subscriptions, with no KingAgent account)?
4. **Priority:** which of A–F first? Suggested order is A → B → C → D, deferring
   E (product decision) until the runtime pieces exist.
