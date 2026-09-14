# Orchestrator

The `Orchestrator` (`src/core/orchestrator/orchestrator.js`) is the one new
entry point above the `AgentRuntime`. What it does **not** do is the
important part: it does not plan, execute, evaluate or recover a step — the
Phase 2 `AgentRuntime` still owns all of that and is *called*, not replaced.
The Orchestrator owns the layer above it:

```
route      → router.js: single agent, several agents, a workflow, a tool, or ask a human
prepare    → workspace + project detection + a budgeted context packet + a trace
execute    → AgentRuntime / AgentCoordinator / WorkflowEngine, through the scheduler
conclude   → artifacts (a diff, if files changed), a memory candidate, a state snapshot
```

## Routing (`orchestrator/router.js`)

Deterministic by default — regex signals over the request text map to
capabilities (`analyze` → `repository_analysis`, `fix`/`implement` →
`code`+`write`, `test` → `run_tests`, …) and to one of five modes:

| Mode | When |
| --- | --- |
| `tool` | the request is literally one call (`read package.json`) |
| `approval` | the request names something irreversible or outward-facing (`delete`, `push`, `install`, …) |
| `multi-agent` | the capabilities span more than one enabled agent's coverage, and policy allows it |
| `single-agent` | everything else |
| `workflow` | a workflow id was named explicitly |

An explicit `mode` hint always wins over inference. A provider, when present,
can refine the decision, but never bypasses the policy check — `Router#route`
still calls `policies.allows()` before it will return `multi-agent`.

## Policies (`orchestrator/policies.js`)

Every limit exists because its absence is a known failure mode: no
concurrency cap is a fork bomb, no depth cap is infinite delegation, no task
timeout is a task that never ends, no approval policy is an agent that
deletes things unsupervised.

```
maxConcurrentTasks, maxDelegationDepth, maxDelegationsPerTask,
taskTimeoutMs, delegationTimeoutMs, allowMultiAgent,
approval: { require, allow, requireAll }, workspace: { allowNetwork, allowDestructive },
memory: { write, maxRetrieved }, context: { maxChars }
```

`policies.approvalPolicy()` resolves `require: null` to the platform's full
dangerous-action list (`approval/request.js`), so "use the defaults" is
expressed once rather than special-cased at every call site.

## Delegation planning (`orchestrator/delegation.js`)

Turns a `multi-agent` routing decision into ordered, bounded delegation specs
— a pure planner, no execution, no agent selected yet (that is the
coordinator's job). Four phases, each gated on whether the routed
capabilities touch it, each depending on the one before:

```
analysis (read-only) → implementation → verification (tests) → review (git, report)
```

`narrow()` intersects each phase's declared policy with the parent's —
the same two-sided, never-widen rule the workspace itself uses one level
earlier — and `auditDelegations()` is a last check before anything executes:
if a planned spec would grant a permission the parent does not hold, the
orchestrator refuses the whole plan loudly rather than silently dropping the
excess.

## Scheduler (`orchestrator/scheduler.js`)

Bounded concurrency (`maxConcurrentTasks`), a priority queue, and
cancellation that works whether a job is queued or already running. Nothing
here retries (Phase 2 recovery owns that) or tracks dependencies (the
workflow engine owns that) — it is deliberately small.

## The one call a host makes

```js
const run = await orchestrator.handle({ request, agentId, workspace, sessionId });
// run.id, run.decision — available immediately
const outcome = await run.result; // settles when the run finishes
```

`handle()` routes, creates the workspace and its trace, then submits the
execution to the scheduler and returns right away — a UI polls
`orchestrator.get(run.id)` or awaits `run.result`; the event stream carries
the same information live. `orchestrator.cancel(id)` cancels the scheduler
job, the runtime task, and any outstanding delegations together.

## Conclusion

At the end of every run: `workspace.files.diff()` becomes a `diff` artifact
if anything changed; the outcome becomes a memory **candidate** (scored, not
automatically stored — see [memory.md](./memory.md)); and a state snapshot is
captured (`COMPLETION` or `FAILURE` reason) so the run is recoverable even if
nothing goes wrong before the next restart.

## Testing

`tests/core-orchestrator.test.mjs` runs the full integration scenario end to
end against the real platform: a request becomes a workspace, a project
detection, a budgeted context packet, a real `AgentRuntime` run, tracked file
changes, a persisted trace with visible tool usage — and the multi-agent
scenario: delegation, permission narrowing, trace correlation, and
cancellation propagating from a parent to its children.
