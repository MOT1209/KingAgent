# Routing

Routing decides which Agent runs on which Harness for a given task. It is
deterministic and explainable — no learning, no randomness, and no tie broken by
iteration order.

```
request ──> classify ──> required tags ──> candidate pairs ──> policy filter ──> rank ──> decision
```

## Task classification

`classifyTask(request)` scores keyword hints to pick a task type, then maps the
type to the capability tags a backend must declare.

| Type | Keywords | Required tags |
| --- | --- | --- |
| `review` | review, diff, audit, critique | `review` |
| `research` | research, investigate, find out, analyze, report | `research` |
| `test` | test, failing, regression, coverage | `terminal` |
| `document` | document, readme, docs, explain | `files` |
| `code` | fix, bug, implement, refactor, feature, build, add | `coding`, `files` |

The agent's own capabilities are translated on top of that table
(`run_tests` → `terminal`, `git` → `git`, `write` → `files`, …), so an agent
that can write is never routed to a backend without filesystem access.

Classification is keyword-based rather than model-based on purpose: routing must
still work when no provider is configured, which is exactly the degraded
condition where a deterministic fallback matters most.

## Strategies

| Strategy | Effect |
| --- | --- |
| `manual` | the caller named agent and harness; the router validates and reports |
| `fixed` | the agent's binding decides (`agent.metadata.harness`) |
| `capability` | most capable fit (default) |
| `best_available` | prefer backends this machine actually has installed |
| `policy` | policy verdict first, capability second |
| `cost_aware` | cheapest compatible backend first (`io.costs`) |
| `performance_aware` | best observed success rate, then fastest (`io.metrics`) |

Each strategy is an *adjustment on the shared capability score*, not a separate
ranking implementation. That is what keeps the reasons comparable between
strategies instead of producing seven incompatible explanations.

## Scoring

Base score for a (agent, harness) pair:

1. every required tag is present, minus a small penalty per surplus tag (the
   most specific backend that can still do the job wins)
2. `+3` when the backend declares every tag for the detected task type
3. `+2` when it lists the agent's model; `-5` when its list excludes it while
   declaring a list at all; a backend that declares no model list is assumed
   workable and says so
4. `+1` when it is present on this machine (detected, or in-process)
5. `+0.5` for the built-in runtime: the only guaranteed backend, so it wins ties
   and is the documented fallback

Then the strategy adjustment, and finally — when a policy manager is wired — a
filter: a `deny` makes a pair ineligible regardless of score, so a denied
backend can never win on points.

## The decision

```js
{
  strategy, agentId, harnessId, model, score,
  reasons: [...],            // why the winner won
  candidates: [              // the shortlist, with each one's reasons
    { agentId, harnessId, eligible, score, required, reasons }
  ],
  classification: { type, scores, required },
  platform, deterministic: true, at
}
```

`reasons` and `candidates[].reasons` are what make "why that agent?" answerable.
The policy UI reads them, and `agent:route` exposes a dry run over IPC that
creates no session, no sandbox and no task.

## Worked example

```
Request: "Review this TypeScript repository"
  classification      → review            required: [review]

Developer agent (coder) — capabilities: code, read, write, run_tests
  required tags       → [coding, files, review, terminal]
  kingagent-runtime   → declares all four, in-process, built-in     score 14.5 ✓
  claude-code         → declares all four, not detected here        score 14.0
  codex               → declares all four, not detected here        score 14.0
  gemini-cli          → missing coding, terminal                    rejected
```

Winner: `coder` on `kingagent-runtime`, with the other two listed as
alternatives and the rejection reasons recorded.

## Determinism

Ties break by agent id, then harness id — never by registration order — so the
same registry contents always produce the same decision. The test suite asserts
this by building two independent routers and comparing the full candidate list,
not just the winner.

## Related

- [harness.md](harness.md) — what the candidates are
- [policies.md](policies.md) — how a policy removes a candidate
- [multi-agent.md](multi-agent.md) — routing per delegated task
