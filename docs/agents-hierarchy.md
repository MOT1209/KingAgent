# The agent hierarchy

The organization has two permanent agents at the top, and everything else exists
to serve a plan they produce and execute.

```
King 👑        (human — final authority, approvals)
  │
Ahmad 🧠       chief-planner: decides what work exists
  │
Rashid 👨‍💻     executive: gets it done
  │
  ├── coder / analyst        (delegable presets)
  ├── specialists            (created at runtime, governed)
  └── promoted agents        (specially kept)
```

Source: `src/core/agents/presets/chief.js` (the two definitions),
`src/core/agents/chief.js` (the `ChiefSystem` facade). Wired as `platform.chief`.

## The two system agents

| | Ahmad | Rashid |
| --- | --- | --- |
| id | `ahmad` | `rashid` |
| role | `chief-planner` | `executive` |
| does | reads the objective, names ambiguity, decomposes into ordered tasks with dependencies, decides required capabilities, flags approval points, reviews results | codes, debugs, researches, browses, runs tools and tests, delegates, recovers, aggregates, escalates |
| permissions | read-only | reaches destructive tools, always through the per-call gate |
| never | claims work it did not plan | performs an action the policy reserves for the King |

Both are `metadata.system = true`. That flag is what keeps the organization from
collapsing into one agent — see below.

### Not a rename, and not a second orchestrator

Ahmad is not the `Planner` renamed and Rashid is not the `Orchestrator`
renamed. They are *definitions* — persona, capabilities, permissions, memory and
workspace policy — that the existing planner, runtime, coordinator and
orchestrator run when selected. The facade that ties them together is
deliberately thin:

| `ChiefSystem` call | What it actually is |
| --- | --- |
| `plan({ request })` | the existing orchestrator **router** deciding a shape |
| `execute({ request })` | the existing orchestrator, pinned to `agentId: 'rashid'` |
| `spawnSpecialist({…})` | `AgentFactory.propose` + `create`, governed |
| `retireSpecialist` / `promoteSpecialist` | the factory's destroy / promote |
| `roster()` | registry + governor snapshot |
| `review({ runId })` | the Run's `inspect()` |

If `ChiefSystem` ever grows a planner or a scheduler of its own, it has become
the problem it was meant to avoid.

## System agents are never delegation targets

`AgentCoordinator.selectAgent` excludes agents with `metadata.system` from
capability-based selection. Without that rule a broad executive covers every
capability set, wins the "narrower agent breaks ties" comparison only sometimes,
and ends up doing specialists' work — the opposite of an organization. They
remain selectable when **explicitly** `preferred`, which is exactly how
`chief.execute()` pins Rashid.

## Creating a specialist

Rashid recognizes "I need another specialist" and asks the factory:

```js
await platform.chief.spawnSpecialist({
  role: 'db-optimizer',
  capabilities: ['code'],
  risk: 'low',
  rootTaskId,
});
```

The factory — not Rashid — decides whether the governor's limits allow it and
whether the King must approve (low = auto, medium = execution gated, high =
creation gated). Lineage is recorded on the definition:
`createdBy: 'rashid'`, `parentAgentId: 'rashid'`, `rootTaskId`. See
[docs/runs.md](runs.md) for the factory, governor and promotion details.

## Registration

`createPlatform({ registerChiefAgents = true })`. On by default; the guard
against a duplicate means a host that persisted them does not collide on
startup. `registerChiefAgents: false` gives a bare roster without disabling
anything else. The delegable preset catalogue (`coder`, `analyst`) is unchanged
— `AGENTS_DEFAULT_IDS` is asserted in tests to prove it.

## Tests

`tests/core-chief.test.mjs`.
