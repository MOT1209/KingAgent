# Execution Trace

Every task produces an `ExecutionTrace` (`src/core/trace/`): an ordered,
correlated, bounded record of what happened. It is **operational
telemetry** — a plan created, a step started, a tool called, a file changed,
an artifact produced, a delegation, an approval — never a model's private
reasoning. That promise is enforced mechanically, not just by convention.

## Correlation (`trace/events.js`)

Every event carries `eventId, type, seq, timestamp, traceId, taskId,
workspaceId, agentId, projectId, sessionId, parentEventId`. `seq` is a
per-trace monotonic counter, so two events in the same millisecond still sort
correctly — timestamps alone cannot guarantee that. `parentEventId` lets a
delegation tree be walked: `trace.childrenOf(delegationEventId)` returns
everything that happened because of that delegation.

## What can never be traced

`trace/serializer.js#scrub` runs on every event's payload before it is
persisted, sent over IPC, or shown as activity:

- a key that looks like reasoning (`reasoning`, `chain_of_thought`,
  `thoughts`, `scratchpad`, `systemPrompt`, …) is replaced with
  `[removed: private reasoning is never traced]`;
- a key that looks like a credential (`apiKey`, `token`, `secret`,
  `password`, …) is replaced with `[redacted]`, at any nesting depth.

This runs whether or not an emitter remembered to be careful — a trace event
is data the platform controls the shape of, and the scrub is the backstop for
the emitter that didn't.

## Store (`trace/store.js`)

```
createTrace({ identity, label })
appendEvent(traceId, type, payload, { parentEventId })
getTrace(traceId) / loadTrace(traceId)   // live, then persisted
listTraces({ status, taskId })
completeTrace / failTrace / cancelTrace
deleteTrace(traceId)
```

Appending is the hot path (one event per tool call, per step, per
observation), so it never blocks on the store: writes are flushed on a bounded
interval and always flushed on completion. Both live traces and stored traces
are capped (`maxLiveTraces`, `maxStoredTraces`) — the oldest **completed**
trace is evicted first; a still-running trace is never pruned out from under
its task. Within one trace, `maxEvents` (default 5000) drops the oldest
events, with `droppedEvents` recording how many, so a truncated trace never
silently reads as a complete one.

## Activity stream

`trace/serializer.js#toActivityStream` turns a trace into the compact,
already-scrubbed view a UI renders — `{ at, type, agentId, workspaceId,
summary }` per event. The renderer's own reducer
(`src/renderer/agent-activity.mjs`) folds the live event stream from the same
fixed vocabulary of operational facts (a step, a tool, a file, an artifact, an
approval, a delegation) — an unrecognized event type is not shown, on the
theory that an unlabeled event is a change nobody decided how a user should
hear about.

## Testing

`tests/core-trace.test.mjs` covers correlation, sequence ordering, the
delegation tree via `parentEventId`, bounded event storage, terminal-state
idempotency, and — the security-relevant half — that reasoning-shaped and
credential-shaped payload keys never survive serialization.
