# KingAgent runtime

The task lifecycle and the pieces that drive it.

## Task state machine

`src/core/runtime/states.js` defines `STATES` and `EDGES`
(`state-machine.js` enforces them; illegal transitions throw). One task moves:

```
created → queued → analyzing → planning → executing → completed
                                  ↘ paused ↔ executing
                                  ↘ cancelling → cancelled
                                  ↘ failed
```

`TaskManager` owns the transitions and publishes the matching event-bus event
(`task.created`, `task.started`, `task.plan.created`, `task.step.*`,
`task.completed`, …). `listSummaries(filter)` sorts newest-first; `history(id)`
exposes the state trace and step log for the UI and audit.

## The run loop (`runtime/runtime.js`)

`runAgentTask({ request, agentId, workspace }, { mode })`:

1. resolve + create + queue the task (background run, caller polls).
2. **Analyze** — task → `analyzing`; reasoner produces a CoT-free goal.
3. **Plan** — `planning`; planner builds the plan (mode decides: `simple` /
   `auto` / `structured` / `autonomous`).
4. **Execute** — for each ready step: run the tool/action, evaluate the result.
5. **Recover** — on failure: retry (with backoff), replan (bounded by
   `maxReplans`, default 3), or fail/ask.
6. **Evaluate + Complete** — task-level verdict; `outcome.summary` records it.

Cancellation is cooperative: `cancel(id, reason)` aborts the controller; the
loop checks the task state between steps (`_terminal`).

## Planner modes

- `simple` / `auto` (no provider): **analysis skeletons** (scan → read →
  search → report) with function inputs for data-driven grounding — never
  fake writes (`planning/planner.js:TEMPLATES`).
- `structured`: the provider returns a JSON plan; validated through
  `createPlan`; falls back to deterministic on any failure/refusal. Tool input
  may come from `tool.input` or `input`.
- `autonomous`: one self-driving step whose action picks + runs a tool via the
  reasoner each cycle.
- Replans drop completed steps so finished work is never re-run.

## Tools

`ToolManager` funnels every call through one gate (registered → permission →
authorization → validation → timeout/abort), emitting `tool.called` /
`tool.completed` / `tool.failed` with classification codes
(`TOOL_INVALID_INPUT`, `TOOL_TIMEOUT`, `TOOL_ABORTED`, `TOOL_DENIED`,
`TOOL_FAILURE`).

Builtins (`tools/builtin/index.js`) ship as fs / search:grep / git / terminal
tools, all through injected `io` adapters — the same code runs in Electron and
in tests with stub fs/shell.

## Workflows

`src/core/workflows/engine.js` runs validated node graphs
(start/end/input/output/tool/command/code/agent/loop/parallel/approval/
condition). Edges route on outputs (`when` conditions use a regex DSL, no
`eval`). Approval nodes pause the instance until the injected `authorize`
decides; grants restore `running`, denials fail the instance.

## Events the UI listens to

`agent:event` / `workflow:event` / `approval:event` push channels forward the
matching bus stream from the main process to `window.kingagent.agentPlatform`,
which the renderer panel (`src/renderer/agent-platform.mjs`) renders live.

## Testing

`node --test tests/*.test.mjs` — 1257 tests, 0 failures (15 env skips: no zsh /
symlink permissions). The core suites stand alone under plain node; the state
machine, permissions, containment and IPC symmetry each have dedicated
specs.