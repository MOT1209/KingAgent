# Context

The rule Phase 3 exists to enforce: **never inject the entire repository, or
the entire memory store, into the model.** The `ContextManager`
(`src/core/context/manager.js`) is the one place that assembles what an agent
sees, and every stage of the pipeline is a small, independently testable
module:

```
gather  → layers.js    which value wins, and from which layer
select  → selector.js  required / relevant / optional / irrelevant
budget  → budget.js    dedupe, trim, fit a hard ceiling, account for drops
freeze  → packet.js    a serializable, deterministic, versioned ContextPacket
```

## Layers (`context/layers.js`)

```
Global → Session → Project → Workspace → Agent → Task → Step → Tool
```

Narrower wins. `stack.get('model')` walks from `Tool` back to `Global` and
returns the first layer that set it; `stack.origin('model')` says which layer
that was, which is the debugging question ("why did the agent get this
value?") that a flat merge cannot answer. `ContextManager.build()` populates
`Global` (host-supplied), `Project` (from the indexer), `Workspace` (root, cwd,
policy flags), `Agent` (capabilities, model), `Task` and `Step`.

## Selection (`context/selector.js`)

Every candidate item is classified before it is considered for the budget:

| Relevance | Meaning |
| --- | --- |
| `required` | the objective, the current step, the agent's own instructions, explicit constraints — never dropped |
| `relevant` | matches the objective's keywords, or a memory/file with a real relevance score, or a recent tool result |
| `optional` | plausible but not clearly tied to the objective — kept only if the budget allows |
| `irrelevant` | dropped before the budget ever sees it |

Priority within the kept set follows the order the mission brief specifies:
task → step → files → tool results → memories → agent instructions → workflow
state → project → history. Classification and ordering are pure functions of
the input, so the same items in the same order always produce the same
selection — `tests/core-context.test.mjs` checks this determinism directly.

## Budget (`context/budget.js`)

- **dedupe** — identical content under different ids/kinds is carried once;
  the drop is recorded (`reason: 'duplicate', duplicateOf`).
- **trim** — a long value is cut to head + tail (the command that ran, and the
  failure that ended it), never just the head; the record it came from says
  `trimmed: true` and keeps the original size.
- **fit** — items are admitted in priority order until a character ceiling
  (`maxChars - reserveChars`) is reached. `required` items are trimmed but
  never refused outright, because losing the objective is worse than going
  over budget by a controlled amount.
- **account** — every drop is reported with a reason (`budget`, `item-limit`,
  `duplicate`); nothing disappears silently.

Token count is `chars / 4` (the standard approximation), computed in exactly
one function (`estimateTokens`) so a real tokenizer can replace it later
without touching every caller.

## The packet (`context/packet.js`)

`createContextPacket()` produces a frozen object: the identity, the objective,
task/step/agent/project/workspace summaries, the selected+budgeted `items`,
and a `digest` — a stable hash over everything *except* `id` and `createdAt`,
so two packets built from the same world compare equal. That is what makes a
rerun comparable to the original, and what a cache or a dedup check can use.
`serializePacket`/`deserializePacket` round-trip through JSON and refuse a
packet from a different `PACKET_VERSION` rather than guessing at its shape.

## Memory reaches context through search, never a dump

`ContextManager.build()` calls `MemoryManager.search()` under the
workspace's own memory policy, capped at `memoryLimit` (default 8). There is
no code path that hands the whole memory store to a packet — see
[memory.md](./memory.md).

## Testing

`tests/core-context.test.mjs` covers layer resolution, selection priority and
determinism, budget trimming/dedup/accounting, packet determinism and
version-refusal, and the manager's memory integration (including graceful
degradation when memory search itself fails).
