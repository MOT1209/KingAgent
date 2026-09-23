# Model routing

Source: `src/core/ai/model-router.js`. Wired as `platform.modelRouter` and used
by the orchestrator to record what each run actually used.

## The principle

Models are infrastructure. The person using KingAgent should be thinking *"what
do I want my AI organization to accomplish"*, not *"which model should I use"*.
So a **kind of work** maps to a set of **requirements**, and the router resolves
those into a concrete provider + model against whatever is configured.

Nothing here names a model or imports a provider SDK. `ai/provider.js` remains
the only place a real adapter lives; the router only names ids.

## Task kinds → requirements

| Kind | Reasoning | Requires | Max tokens |
| --- | --- | --- | --- |
| `planning` | high | `reasoning` | 8k |
| `architecture` | high | `reasoning` | 16k |
| `coding` | medium | `tools` | 16k |
| `research` | medium | `reasoning` | 12k |
| `vision` | low | `vision` | 4k |
| `classification` | low | `fast` | 1k |
| `review` | high | `reasoning` | 8k |
| `multi-agent` | high | `reasoning` | 16k |
| `single-agent` | medium | — | 12k |
| `workflow` | medium | — | 8k |
| `tool` | low | `fast` | 2k |
| `approval` | low | — | 1k |
| `default` | medium | — | 8k |

The orchestrator's execution modes are kinds, so a request routed to
`multi-agent` gets a high-reasoning model without anyone choosing one.

## Providers

A provider *descriptor* tells the router what it can do. Descriptors are
configuration, supplied by the host (`io.models.providers`):

```js
createPlatform({
  io: {
    models: {
      providers: {
        premium: { capabilities: ['reasoning', 'tools', 'vision'], models: [{ id: 'big', capabilities: ['reasoning', 'tools'] }], cost: 10, latencyMs: 5000, quality: 3 },
        cheap:   { capabilities: ['fast', 'tools'],               models: ['mini'],                                    cost: 0.1, latencyMs: 200, quality: 1 },
      },
    },
  },
});
```

## Selection

1. Filter to providers that satisfy every required capability (plus any
   `requirements.requiresVision` / `requiresTools`).
2. Drop any that break a constraint: `maxCost`, `maxLatencyMs`, `privacy`.
3. Sort by the cost policy: `balanced` (quality, then cost), `cost`,
   `performance`, or `quality`.
4. Pick the first, and choose a model whose declared capabilities cover the
   requirements — falling back to the provider's first model.

The whole decision is returned, including the candidates considered, so "why did
this run on that model?" is answerable:

```js
platform.modelRouter.route({ kind: 'planning' });
// { kind: 'planning', provider: 'premium', model: 'big', reasoning: 'high',
//   maxTokens: 8000, requires: ['reasoning'], candidates: ['premium'],
//   reason: 'selected premium for planning (balanced)', deterministic: false }
```

## Deterministic by default

With no providers wired, `route()` still returns a decision — `provider: null`,
`model: 'default'`, and a reason that says so. It never throws and never returns
nothing, because every caller (the orchestrator included) has to keep working on
a fresh install with no AI configured. The orchestrator records the selection on
the Run's metadata and timeline either way.

## Overrides

`setRoute(kind, patch)` pins a kind without editing config, and
`describe()` returns the whole table for a settings screen. Per-request
constraints (`maxCost`, `privacy`, `requiresVision`) are respected for that one
call.

## Tests

`tests/core-model-router.test.mjs`.

## Known limitation

Deeper integration — switching provider *mid-run* when a step's kind changes —
is not wired. Today the selection is made once per orchestrated request and
recorded. The router is the seam for that, not yet the switch.
