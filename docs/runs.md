# Runs, dynamic agents and the governor

Three additions from the transformation plan's **Stage A**. Together they answer
two questions the platform could not previously answer directly:

- *"What did my AI organization actually do for the thing I asked?"* → a **Run**.
- *"Who allowed it to create another agent?"* → the **AgentFactory** and the
  **AgentGovernor**.

All three are additive. No existing subsystem changed shape; the task, workspace,
trace, session, policy and approval layers are untouched.

## Run — the human's unit of work

Source: `src/core/runs/`. Wired as `platform.runs`.

Before this, "a run" was implicit: a task, a workspace, a trace, a session and a
pile of artifacts, joined only by someone who knew all five ids. A Run is a small
index over those — an objective, the ids of everything it touched, spend, and a
timeline. It owns no behaviour: routing, execution and policy stay where they
were, which is what makes it cheap to add and impossible to disagree with.

```js
const run = await platform.runs.start({
  objective: 'Build a production-ready SaaS app',
  projectId, conversationId,
});

await platform.runs.addAgent(run.id, { id: 'coder', role: 'code' });
await platform.runs.noteUsage(run.id, { tokens: 1200, cost: 0.04 });
await platform.runs.complete(run.id, { result: { ok: true } });

await platform.runs.inspect(run.id);   // counts, spend, duration, errors, timeline
```

### States

`created → running → { paused, waiting_for_approval, completed, failed,
cancelled, stopped }`, guarded by the same transition pattern as
`runtime/states.js` and `agents/lifecycle.js`. Terminal states are absorbing: a
completed run cannot start running again.

`retry()` never resurrects a failed run — it starts a **new** one that records
`retryOf`, because "what went wrong the first time" has to stay answerable.

### Properties that keep it honest

- **Bounded.** Every indexed collection (`agents`, `tasks`, `tools`, `events`,
  `errors`, …) is deduplicated by id and capped (`DEFAULT_CAPS`). The detail lives
  in the `ExecutionTraceStore`; the run keeps a small index of it.
- **Additive usage.** There is no `setUsage()`; tokens and cost can only be
  *noted*, so nothing can accidentally zero a run's spend.
- **Rebuildable from the stream.** `attachBus(bus)` folds any event carrying a
  `runId` onto that run's timeline, so no subsystem needs to know a Run exists.

## AgentFactory — creating a specialist at runtime

Source: `src/core/agents/factory.js`. Wired as `platform.agentFactory`.

The registry has always been able to *store* a definition. The factory is about
whether it **may** be created, by whom, under what risk and with what limits.

Three phases, deliberately separate:

| Phase | Side effects | Returns |
| --- | --- | --- |
| `propose({ role, … })` | none — builds a validated `AgentDefinition` | `{ ok, definition, risk, fingerprint }` |
| `create(proposal, { approver, depth })` | governor check → approval if risk requires → register | `{ created, agent, executionApprovalRequired }` |
| `destroy(id)` | releases limits, removes a *dynamic* definition | `{ destroyed }` |

Risk policy defaults (prompt §31), configurable per host:

| Risk | Default effect |
| --- | --- |
| low | `auto` — create and run |
| medium | `approve_execution` — create now, a human authorizes the first run |
| high / critical | `approve_creation` — the definition itself needs a human |

Approval runs through the **existing** `ApprovalManager`, not a second queue, so
one human decision is one auditable record. With no approver wired, a risky spawn
is *denied* (`APPROVAL_UNAVAILABLE`) — it is never silently allowed.

### Promotion

A temporary agent that earned its place: `promote(id)` flips
`metadata.dynamic=false, persistent=true` **in place**, preserving lineage
(`createdBy`, `parentAgentId`, `rootTaskId`) rather than resetting it. A promoted
agent cannot be `destroy()`ed — promotion has to mean something. `demote(id)`
reverses it.

## AgentGovernor — the limits that make spawning safe

Source: `src/core/agents/governor.js`. Wired as `platform.agentGovernor`.

Dynamic creation is the only way KingAgent could fork-bomb itself. Every limit
exists because its absence is a specific failure mode:

| Limit | Failure mode it prevents |
| --- | --- |
| `maxDepth` | infinite delegation chains |
| `maxChildren` | one agent spawning an unbounded team |
| `maxConcurrentAgents` | a thousand live agents from many shallow spawns |
| `maxSpawnsPerRun` | a single objective producing agents forever |
| `maxRuntimeMs` | a stuck agent that never stops billing |
| `maxTokenBudget` / `maxCost` | one agent burning the whole budget |
| `maxTaskCount` | an agent that "helps" forever |
| `duplicateWindowMs` | the same specialist re-created every second |
| role-in-ancestry check | an agent creating copies of its own kind (recursive spawn) |

```js
const verdict = governor.canSpawn({ parentAgentId, depth, role, fingerprint });
// { allowed: false, code: 'SPAWN_RECURSIVE', reason: '…' } — a denial is a
// structured answer, never a thrown exception, so the caller can record why.

governor.sweep(); // agents past runtime or budget, for a host's watchdog to stop
```

Known limitation: the governor tracks **live** agents only, in memory. Persisted
definitions are the registry's business, and after a restart nothing counts as
live until it is running again — which is the correct reading of "running", but
means a host that wants restart-surviving budgets must persist usage itself.

## Events

New types on the one event bus, so a UI can watch without polling:
`run.started`, `run.updated`, `run.paused`, `run.resumed`, `run.completed`,
`run.failed`, `run.cancelled`, `run.stopped`, `agent.created`,
`agent.destroyed`, `agent.promoted`, `agent.demoted`, `agent.spawn.denied`.

## Tests

`tests/core-runs.test.mjs`, `tests/core-agent-factory.test.mjs`.
