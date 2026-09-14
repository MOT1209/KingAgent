# The orchestrator

The orchestrator is the control plane. It turns a request into a routed, gated,
sandboxed, observed run — and it does not execute anything itself.

```
User
 │
 ▼
Orchestrator                src/core/orchestrator/orchestrator.js
 │
 ├─ Router          which Agent, on which Harness, for this task
 ├─ Policy          may this run happen at all
 ├─ Sandbox         the authorized workspace and its limits
 ├─ Executor        AgentRuntime (built-in) or a host harness runner
 ├─ Artifacts       what the run produced, with provenance
 └─ Evaluation      did it work, and what does the session end as
```

## Why it does not execute

Everything that plans, runs tools, evaluates steps and recovers is still the
Phase 2 `AgentRuntime`. When routing picks `kingagent-runtime`, the orchestrator
hands the task to that runtime and awaits its terminal state — the same planner,
executor, evaluator and recovery manager as before. Nothing is reimplemented.

When routing picks an external harness, the orchestrator starts the harness run
inside the sandbox and calls the host's `harnessRunner` to drive the
conversation. Core owns the brackets; the host owns the conversation. A harness
with no runner wired fails with `ORCHESTRATOR_NO_HARNESS_RUNNER` rather than
pretending to have run.

## The pipeline

`orchestrator.run(request, options)` performs the steps in this order, and the
order is the guarantee:

1. **Workspace check.** No authorized workspace, no run
   (`ORCHESTRATOR_NO_WORKSPACE`). This is the one precondition that is never
   relaxed.
2. **Route.** `AgentRouter.route()` returns a decision with the agent, the
   harness, the score and the reasons for every candidate it considered.
3. **Policy.** `agent.run` is evaluated. A `deny` ends the run here — before a
   sandbox, a process or a task exists. A decision that requires approval is
   routed through the policy approver; with no approver wired it is denied.
4. **Sandbox.** Created from the authorized workspace only, with the effective
   limits (a caller's request is clamped, never widened). The sandbox id is
   attached to the session.
5. **Execute.** `_runInternal()` (runtime) or `_runHarness()` (host runner).
6. **Artifacts.** Diffs, test results, reports and anything the runner returned
   are stored with `taskId`, `workspaceId`, `agentId`, `harnessId`, `sessionId`
   and `traceId`.
7. **Evaluate.** A host `evaluate` callback wins; otherwise the backend's own
   verdict is used: the runtime's terminal state, or the runner's `ok`.
8. **Settle.** Session completed or failed, sandbox stopped. The sandbox is
   stopped on the failure paths too.

## What it returns

```js
{
  ok,                 // the evaluation's verdict
  sessionId, taskId,
  decision,           // the routing decision, with reasons
  evaluation,         // { passed, summary, source }
  artifacts,          // summaries, each with its provenance
  harness,
  taskState,
  result,             // whatever the backend reported
  trace,              // the orchestration trace for this run
}
```

Failures never throw at the top level for expected conditions: a denial, a
missing runner and a failed task all come back as `ok: false` with the reason.
The two exceptions are a missing workspace and an empty request, which are
caller bugs.

## Trace

Each run has one trace, keyed by the session — keying by task would split it,
since routing and policy happen before a task exists. Every step lands in a
bounded ring (500 entries) and is mirrored onto the event bus as
`orchestrator.step`:

```
route → policy → sandbox → runtime.started → runtime.settled
      → artifacts → evaluate → sandbox.stopped
```

The trace holds step names, ids, counts and verdicts only. It never carries
model output, prompts or file contents.

## Pause, resume, cancel

- `pause`/`resume` go to the runtime task when there is one, otherwise to the
  session.
- `cancel` stops the runtime task, cancels every delegation below it, and — via
  the coordinator — stops the task's harness runs and sandboxes. It reports what
  was actually stopped, which is what recovery and the UI display.

## The control center view

`orchestrator.controlCenter({ sessionId, taskId })` returns the §36 view: agent,
harness, task state, current step, sandbox snapshots, artifacts, sub-agents,
recent policy decisions and the trace. Over IPC it is `agent:controlCenter`.

## Related

- [harness.md](harness.md) — what a backend is and how it is described
- [routing.md](routing.md) — how the decision is made
- [policies.md](policies.md) — what is allowed
- [sandbox.md](sandbox.md) — where it runs
- [sessions.md](sessions.md) — the container
- [multi-agent.md](multi-agent.md) — more than one agent
