# Workflows

A workflow is a directed graph of typed nodes, validated before it runs
(`src/core/workflows/definition.js`) and executed by `WorkflowEngine`
(`src/core/workflows/engine.js`). It sits beside the agent runtime rather than
above it: a workflow is the deterministic path, for work whose shape is known
in advance.

Node types: `start`, `end`, `input`, `output`, `agent`, `tool`, `command`,
`code`, `condition`, `loop`, `parallel`, `approval`.

Tool nodes go through the same permission gate as runtime tools. Approval nodes
pause the instance until the injected `authorize` callback resolves.

## Instance lifecycle

```
pending ──> running ──┬──> completed
                      ├──> failed
                      ├──> cancelled
                      └──> awaiting_approval ──> running | cancelled

(process dies mid-run)  ──> interrupted     [set by restore(), never by a walk]
```

`interrupted` is deliberately distinct from `failed` and `cancelled`: nobody
decided it, and nothing is known about whether the work took effect.

## Cancellation

`cancel(id, reason)` reports what it actually achieved. It never returns a bare
`{ cancelled: true }`.

| Case | Result |
| --- | --- |
| running instance | `{ cancelled: true, status: 'cancelled', reason, requestedAt }` |
| unknown id | `{ cancelled: false, status: null, reason: 'unknown instance' }` |
| already finished | `{ cancelled: false, status: 'completed', reason: 'already completed' }` |
| already requested | `{ cancelled: false, reason: 'cancellation already requested' }` |

The `workflow:cancel` IPC handler forwards that verbatim, so a UI cannot show
"cancelled" for a run that was already finished, never existed, or is still
going.

What happens on a cancel:

1. the request is recorded on the instance (`cancellation.requested`)
2. the instance's `AbortController` is aborted — this interrupts a wait on a
   human approval, and reaches any executor that took the signal (tool, code and
   shell executors all accept one)
3. the walk checks the request **before entering a node and again after the node
   returns**, so nothing new is started and an in-flight result is discarded
4. pending and running nodes are marked `cancelled`, the instance reaches
   `cancelled` with a `completedAt`, the record is persisted, and
   `workflow.cancelled` is emitted

**The honest limit.** A node executor that ignores the abort signal runs to
completion. Cancellation guarantees that its output is discarded, that no
further node is entered, and that the instance reaches `cancelled` — not that an
already-issued syscall is unwound. `error` stays `null`: a cancellation is not a
failure.

## Persistence

Given a collection (`createPlatform` supplies `collections.workflows`), every
status transition is written, **including on entry to each node**. Persisting
only on completion would leave `currentNodeId` naming the last node that
finished, so an interrupted run would misreport where it stopped.

Each instance record carries:

```
id, workflowId, status, error
inputs, outputs, nodes[]          (scrubbed — see below)
currentNodeId, cancellation
traceId, workspaceId, taskId      (§27 correlation)
startedAt, completedAt
```

`restore()` reloads history at startup — the Electron host calls it in
`installAgentPlatform`. Anything not in a terminal state comes back as
`interrupted`, and that transition is itself persisted, so a second restart
agrees with the first. Instances already live in the process are never
clobbered.

## What is not persisted

Node inputs and outputs are whatever a tool, shell command or agent returned, so
they are exactly where a credential rides along — and unlike the in-memory view,
the persisted copy lands on the user's disk and outlives the session. It goes
through the same `scrub()` the execution trace uses:

- credential-shaped keys (`token`, `apiKey`, `password`, `authorization`, …)
  become `[redacted]` — redacted visibly, not dropped silently
- private-reasoning keys are removed outright
- strings, arrays and depth are bounded, so one enormous command output cannot
  balloon the store

The in-memory view keeps the real values, so a running workflow's conditions and
its caller are unaffected.

## IPC surface

| Channel | Returns |
| --- | --- |
| `workflow:list` | registered workflow definitions |
| `workflow:run` | the instance summary after the run settles |
| `workflow:get` | one instance summary, or `null` |
| `workflow:listInstances` | every instance the engine knows about, newest first |
| `workflow:cancel` | the honest cancellation report above |

See [phase5-audit.md](phase5-audit.md) for what these two last handlers used to
return and why it mattered.
