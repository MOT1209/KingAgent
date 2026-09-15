# Multi-Agent Foundation

Phase 3 builds the foundation for multi-agent work, deliberately not the full
thing: there is no autonomous team here, no agent deciding on its own to spawn
another agent, no emergent negotiation. There is a lead execution that may
delegate a bounded sub-task to a named agent and get a structured result back,
or hand off responsibility for the rest of a task to another agent. Both are
owned by the `AgentCoordinator` (`src/core/agents/coordinator.js`).

## Four properties, checked by tests

- **Narrowing, never widening** — a delegate's workspace policy is the
  intersection of its parent's policy and what was requested
  (`workspace/workspace.js#derivePolicy`); a delegate's tool grant is the
  intersection of the request and the selected agent's own declared tools
  (`coordinator.js#intersect`). `null` on either side means "unrestricted from
  that side"; there is no path to a wider grant than the parent held.
- **Bounded** — every delegation has a timeout, a depth limit
  (`maxDelegationDepth`, default 3) and a fan-out limit
  (`maxDelegationsPerTask`, default 6), so a delegation loop cannot become a
  fork bomb.
- **Cancellable** — a parent's `AbortSignal` propagates to every child it
  started; `coordinator.cancelDelegations()` aborts the rest.
- **Traceable** — the delegation, its messages and its result are events on
  the parent's trace, correlated by `parentEventId`.

## Agent lifecycle (`agents/lifecycle.js`)

A second state machine, deliberately built the same way as the task state
machine (`runtime/states.js`) rather than as a new pattern:

```
CREATED → INITIALIZING → READY → RUNNING ⇄ PAUSED → COMPLETED
                                     │
                                  FAILED ⇄ RECOVERING
any non-terminal state → STOPPING → STOPPED
```

This is the state of a *participant*, not of the task it is running — the
task state machine is unchanged.

## Selection

```js
coordinator.selectAgent({ capabilities, preferred });
```

Deterministic: a `preferred` id (which may come from a model) is looked up in
the registry, never trusted as a fact — an agent that does not exist or is
disabled is never selected because a string said so. Absent that, coverage of
the requested capabilities wins, with ties going to the *narrower* agent (an
analyst with `['read', 'report']` beats a coder with ten capabilities for a
read-only job).

## Delegation

```js
const result = await coordinator.delegate({
  from: parentWorkspace, capabilities: ['read'], request: 'find the bug',
  policy: { tools: [...] }, timeoutMs, resultSchema,
});
// { ok, agentId, workspaceId, data, error, code, artifacts, files }
```

`delegate()` never throws for an agent-level failure — the failure is the
*result*, so a lead agent can decide what to do about it. It runs the
sub-task through the real `AgentRuntime` (nothing here reimplements the
analyze→plan→execute loop), in a child workspace built with `derivePolicy`,
and polls the runtime for a terminal state. A `resultSchema`, when given, is
checked structurally against the result — a delegate returning the wrong
shape is a failed delegation (`DELEGATION_BAD_RESULT`), not a surprise
upstream.

`delegateAll()` runs several delegations at once, bounded by the fan-out
limit; `aggregate()` collapses the results — **partial success is reported as
partial, never rounded up to success**.

## Handoff (`agents/handoff.js`)

A handoff transfers responsibility, not history. `createHandoff()` produces a
bounded brief — objective, current state, changed/active files (paths and
reasons, not contents), constraints, memory ids, artifact refs, open issues —
capped at a fixed size per field regardless of how long the run behind it was.
`handoffFromWorkspace()` derives the brief from what a workspace's own
`FileContext` actually recorded, so a caller does not have to assemble it (or
accidentally include something unbounded) by hand.

## Messaging (`agents/messaging/`)

`AgentMessageBus` is **not** the platform `EventBus` — the `EventBus` is
broadcast telemetry anyone may watch; the message bus is addressed delivery
with a membership check. An agent can only message another agent the
coordinator has admitted to the same task (`bus.join(taskId, agentId)`);
sending to a non-participant throws `MessageDeliveryError`. Reading an inbox
drains it by default — a `DELEGATION` message delivered twice would mean a
second execution. Every delivered message is mirrored onto the `EventBus` as
`agent.message`, so a trace or a UI can see the conversation without being
able to inject into it.

## Testing

`tests/core-multiagent.test.mjs` covers the lifecycle graph, messaging
membership and draining, handoff bounding, delegation's policy narrowing,
depth/fan-out limits, schema checking, and aggregation's partial-success
reporting. `tests/core-orchestrator.test.mjs` runs the multi-agent path
end-to-end through the real platform.
