# Multi-agent coordination

> **Note:** this document describes multi-agent coordination in the
> harness-orchestrator layer (`src/core/harness-orchestrator/coordinator.js`),
> which coexists with the Phase 3 multi-agent foundation
> (`src/core/agents/coordinator.js`, documented in
> [multi-agent.md](./multi-agent.md)) rather than replacing it — reached as
> `platform.harnessCoordinator` vs. `platform.coordinator`.

Several agents on one job, safely: a lead delegating scoped work, children
reporting through a structured protocol, parallel runs that cannot corrupt each
other, and a reviewer that evaluates evidence rather than a retelling.

```
Lead
 ├── Research   ✓
 ├── Developer  ✓
 └── Tester     ●
      ↓
    Lead  ──> Reviewer ──> accept | request fix
```

## Roles

| Role | Purpose |
| --- | --- |
| `lead` | owns the task and delegates |
| `worker` | does scoped work |
| `research` | read-only investigation |
| `reviewer` | evaluates another agent's output |
| `tester` | runs and reports tests |

`TEAM_TEMPLATES` maps a task type to the roles it needs — `code` is
`[research, worker, tester, reviewer]`, which is §26's example — and is a plain
table so a host can replace it without touching the coordinator.

## Files

All of these live under `src/core/harness-orchestrator/`. The paths matter:
`src/core/orchestrator/` is the *public* control plane and has a
`delegation.js` of its own that is a different module — a planner that turns a
routing decision into delegation specs, not the record type below. Until
Phase 5 this table's paths named byte-identical copies that nothing imported;
see [phase5-audit.md](phase5-audit.md).

| File | Responsibility |
| --- | --- |
| `harness-orchestrator/messages.js` | the structured protocol and the mailbox |
| `harness-orchestrator/delegation.js` | delegation records and the containment check |
| `harness-orchestrator/handoff.js` | the eight handoff fields, bounded |
| `harness-orchestrator/locks.js` | cooperative file locks for parallel runs |
| `harness-orchestrator/coordinator.js` | delegation, messaging, handoff, parallel, review |

## Communication is a protocol, not concatenation

The message types are `REQUEST`, `DELEGATION`, `RESULT`, `ERROR`, `STATUS`,
`APPROVAL` and `HANDOFF`. An envelope is:

```js
{ id, type, from, to, inReplyTo, at,
  payload: { … },                            // whitelisted keys only
  taskId, delegationId, sessionId, traceId,  // correlation
  agentId, harnessId, workspaceId, parentEventId }
```

Two properties matter:

- **Payload keys are whitelisted.** There is no field for a prompt or a
  transcript, so a caller cannot smuggle one through the protocol, and
  `send()` refuses a bare string outright.
- **Replies inherit correlation.** `replyTo(message, …)` copies every id, so a
  conversation tree can be reconstructed from the trace without reading
  payloads. Hand-building a reply is how ids drift, so there is exactly one
  sanctioned way to answer.

`send()` on a harness refuses anything without a `type` for the same reason.

## Delegation

A delegation carries §27's fields in full: `id`, `parentTaskId`,
`parentAgentId`, `childAgentId`, `workspaceId`, `permissions`, `scope`,
`timeout`, `resultSchema`, `traceId`, plus `role`, `depth`, `sessionId`,
`harnessId` and `parentDelegationId`.

### A child can never out-reach its parent

`containment(parent, child)` compares, and a widening delegation is refused at
construction time with the reason:

- child permission levels must be a subset of the parent's
- `allowDestructive` on the child requires it on the parent
- child scope paths must fall inside the parent's declared paths
- child scope tools must be among the parent's when the parent declared any

```js
containment(
  { permissions: { levels: ['read_only', 'safe'] } },
  { permissions: { levels: ['read_only', 'safe', 'destructive'], allowDestructive: true } },
)
// { ok: false, reasons: [
//   'child grants "destructive" but the parent grants at most "safe"',
//   'child allows destructive tools but the parent does not' ] }
```

The delegation also passes through the policy engine (`agent.delegate`), and
depth is capped at 4.

## Parallel execution

`runParallel(ids, { runner })` runs delegations concurrently, each taking the
file locks its scope names:

```
read  × read  → allowed
read  × write → conflict
write × write → conflict
```

A conflicting child is reported as `blocked`, with the holders it conflicts
with, and **nothing of it runs** — a conflicting write is not a performance
problem, it is data loss. Start order is deterministic, and locks are released
in a `finally` so a throwing agent cannot deadlock the next one.

The locks are cooperative and advisory by design: they protect agents that go
through the coordinator, which is every agent this platform starts. The
alternative — believing two OS processes can share a file safely — is how
parallel agents earn their reputation.

## Handoff

```js
{ objective, currentState, relevantFiles, constraints,
  results, memoryRefs, artifacts, outstandingIssues }
```

Bounded on purpose: files (40), references (40), results (20), and `memoryRefs`
carry *keys*, not values, so a receiver reads the value through the memory
manager where its own scoping and lifetime apply. A handoff that carries the
whole conversation is delegation with extra steps, so there is nowhere to put
one.

`readyToAccept()` reports which required fields are missing, so a receiver asks
one specific question instead of guessing.

## Review

§31 is precise about what a reviewer receives — and what it does not:

```js
coordinator.buildReview({
  taskId, delegationId, coderAgentId, coderHarnessId, reviewerAgentId,
  diff, testResults, constraints, files, context,
});
// { reviewId, taskDiff, testResults, artifacts, constraints, files,
//   context, coder, reviewer, verdict: null }
```

It receives the diff, the artifacts, the test results, the constraints and a
short caller-supplied summary. It does **not** receive the task history, the
message log or the transcript: a reviewer starting from a retelling inherits
every wrong turn.

`recordReview(reviewId, { verdict, notes })` accepts `accept`, `request_fix` or
`reject` and attaches the verdict to the delegation.

Because the bundle is plain data, cross-harness review (§32) needs no special
support: a coder on Claude Code and a reviewer on Codex is just two harness ids
in the same record.

## Cancellation is contagious downward

`cancel(delegationId)` cancels the subtree, children first, so no child is left
running against a parent that was told to stop. It releases its own file locks
and nothing else — stopping the *task's* harness runs and sandboxes is
`cancelTask()`'s job, done once at the top, so a child cancelling its subtree can
never tear down a sibling's processes.

`cancelTask(taskId)` is what the orchestrator and recovery call:
delegations cancelled, harness runs stopped, sandboxes stopped.

## Inspection

- `coordinator.tree(taskId)` — the delegation tree the UI renders under
  "Sub-agents"
- `coordinator.controlView(taskId)` — delegations, sub-agent rows and the tree
- `coordinator.messages({ taskId })` — the conversation, newest last
- `coordinator.stats()` — delegations by status, message count, lock count
- over IPC: `agent:delegations`
