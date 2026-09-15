# Research Intelligence

Phase 7. Research is a first-class capability of the agent runtime, not a
search box: a question becomes a planned, budgeted, governed investigation
that produces verified claims with citations that point at text somebody can
actually check.

Everything here lives in `src/core/research/` and is host-agnostic. It owns no
storage, no policy evaluation, no approval flow and no artifact format of its
own — those come from the platform, injected. What it owns is the *order* of
the pipeline, the state machine, the budget, cancellation, and the rule that
nothing is returned that has not passed citation validation.

## What was and was not available to build on

Three findings from auditing the repository shaped the design, and they are
worth stating because they are the difference between this being an integration
and being a parallel stack:

- **There is no skill registry.** `src/core/` has no skills module, and the
  `skills` field on an agent definition is a list of strings nothing resolves.
  So research capabilities are registered as *tools* with capability tags, and
  `research/tools/index.js` maps each skill name onto the capability that
  resolves it through the ToolManager's existing capability index. If a skill
  registry is built later it reads that table; there is no second registry in
  the meantime.
- **There is no MCP client in core.** `src/main/mcp-config.js` writes the config
  files external harnesses read, and `src/main/browser-mcp.js` is a server
  KingAgent *exposes*. So `sources/mcpSource.js` takes a client from the host
  and reports itself unavailable without one. It never fabricates a result.
- **There are no embeddings.** `memory/relevance.js` is lexical. §14 asks to
  reuse embeddings *if they already exist*; they do not, so none are invented
  and no vector database is introduced. A host that has one supplies a
  `semanticScore` and only the relevance term of the reranker changes.

## The pipeline

```
request
   │
   ├─ researchRouter ── none / memory / direct / pipeline
   │
   ▼
ResearchTask (state machine + budget)
   │
   ├─ 1. queryClassifier    what kind of question is this?
   ├─ 2. researchStrategy   how hard should we work, and what can we actually reach?
   ├─ 3. queryPlanner       decompose into non-redundant queries
   ├─ 4. searchRouter       which source types per query
   ├─ 5. sourceRouter       how much budget each gets
   ├─ 6. parallelRetriever  bounded concurrency, partial failure, cancellation
   │       └─ SourceManager  task gates → policy → outbound screen → cache →
   │                          provider fallback → inbound screen → budget
   ├─ 7. resultNormalizer   one shape, merged per document
   ├─ 8. deduplicator       URL, digest, min-hash, containment, syndication
   ├─ 9. sourceQuality      authority, specificity, freshness, primacy
   ├─ 10. reranker          relevance + evidence density + diversity
   ├─ 11. evidenceExtractor verbatim spans with offsets
   ├─ 12. claimAnalyzer     claims, independence, derived verification status
   ├─ 13. conflictDetector  stance, value and temporal disagreements
   ├─ 14. sourceVerifier    a second opinion from a different kind of source
   ├─ 15. citationEngine    claim + evidence + source, or no citation
   ├─ 16. citationValidator quote digests re-checked against the stored source
   ├─ 17. researchEvaluator the honest scorecard
   ├─ 18. reviewer          did we answer it? is anything unsupported?
   └─ 19. synthesizer       known / supported / uncertain / conflicting / not found
```

Stages 3–19 are all public methods on `ResearchEngine` (§43), so a caller can
drive the pipeline by hand — plan without searching, re-verify without
re-planning — which is what makes it testable a stage at a time.

## The four invariants

Everything else is tuning. These four are what make the output trustworthy, and
each is enforced structurally rather than by instruction:

**1. Evidence is quoted, never paraphrased.** `evidenceExtractor` emits spans
taken from the stored source text *by offset*. A model provider may reorder and
relabel them; it cannot author one. A hallucinated quote is therefore impossible
by construction, not discouraged.

**2. A citation requires evidence that exists.** `validateCitation` refuses a
citation without an `evidenceId`, `EvidenceStore.addEvidence` refuses evidence
for a source that was never retrieved, and `citationValidator` recomputes the
quote's digest against the stored source before the answer ships. A fabricated
citation naming a real source is caught four separate ways.

**3. Verification status is derived, never asserted.** `claimAnalyzer.analyze`
is the only thing that writes `verificationStatus`, and it computes it from the
evidence in the store. A synthesizer cannot label its own output
"strongly supported" — and `strongly_supported` additionally requires
corroboration from genuinely independent sources, counted over dedup clusters
and domains.

**4. External content is data.** Everything retrieved passes
`security/researchSecurity.js` before it reaches anything else. See below.

## Source model

A **Source** is a retrieved document with provenance. A **ResearchResult** is
"this query, against this adapter, found this" — so the same document found by
two queries is two results and one source, which is exactly the distinction
deduplication needs.

| Adapter | Type | Provider needed | Notes |
| --- | --- | --- | --- |
| `webSource` | `web` | web | broadest, least trusted by default |
| `webSource` (news) | `news` | news or web | recency-weighted |
| `academicSource` | `academic` | academic | DOI, venue, citation count |
| `discussionSource` | `discussion` | discussion or web | never primary |
| `githubSource` | `github` | github | primary *about its own repository* |
| `documentationSource` | `documentation` | documentation or web | highest authority for "how does this work?" |
| `fileSource` | `file` | none — uses `io.fs` | never touches the network |
| `mcpSource` | `mcp` | `io.research.mcp` | discovers capabilities, calls only search-shaped tools |

`SourceManager` is the single funnel. Adapters know how to talk to a kind of
source; it knows the rules that apply to all of them, in a fixed order no
adapter can skip: task gates (`filesOnly`, `allowWeb`, preferences) → policy →
outbound credential screen → cache → provider loop with fallback → inbound
content screen → budget.

### Providers

Core imports no HTTP client, exactly as it imports no model SDK. A concrete
search provider is supplied by the host:

```js
createPlatform({
  io: {
    research: {
      searchProviders: {
        myProvider: {
          sourceTypes: ['web', 'documentation'],
          priority: 10,
          async search({ query, limit, signal }) { /* → rows */ },
          async fetch({ url, signal }) { /* → { content } */ },  // optional
        },
      },
      mcp: mcpClient,          // { listTools, callTool } — optional
      extractText: extractor,  // ({ path, ext }) => { text } for PDF/DOCX
    },
  },
});
```

`resolveAll(sourceType)` returns every provider that can serve a type, best
first, which is what makes fallback a loop rather than a special case. **With no
provider configured, networked source types report themselves unavailable with a
reason** — the capability report says "no provider is configured for academic",
not an empty result set that reads as "nothing exists about this topic".

## Deduplication and independence

Ten copies of one press release is one fact. Reporting it as ten corroborations
invents nine, so `deduplicator` builds *clusters* rather than filtering rows:

1. canonical URL (tracking parameters stripped, `www` and scheme normalized)
2. content digest
3. min-hash sketch → Jaccard **or containment** ≥ 0.9
4. syndication: same headline, same day, different publisher

Containment matters: the commonest real duplicate is a syndicated article with
two paragraphs of the re-publisher's commentary bolted on, whose Jaccard drops
below any sane threshold while 100% of the original is still there.

`independentCount` then measures independence over clusters *and domains*: a
vendor's blog post and its docs page are not two opinions.

## Evidence, claims and conflicts

A source is not evidence. Evidence is a specific passage, with the offsets that
prove it is there and a digest the validator re-checks.

Stance is a property of the **claim↔evidence link**, not of the evidence: one
span supports a claim about transports and contradicts a claim about a version
number, and storing a single stance on the record means the second link silently
overwrites the first.

Conflicts come in three shapes, because they need different handling:

- **stance** — evidence pointing opposite ways
- **value** — the same quantity with different numbers. Invisible to a stance
  check: "$20 per month" and "$35 per month" are both affirmative sentences.
- **temporal** — the same fact stated differently a year apart, usually an
  outdated source rather than a contradiction

Every conflict defaults to `unresolved`. Resolution is explicit and rule-bound
(prefer the primary source; prefer the materially newer one), records which
side was superseded so the losing claim is actually downgraded, and
`report_uncertainty` is a legitimate final answer.

## Quality

`researchEvaluator` produces the scorecard §37 asks for — coverage, relevance,
source quality, evidence quality, citation completeness, diversity, freshness,
conflict handling, confidence — and then **caps the composite by its weakest
structural pillar**. Averaging lets a task with excellent sources and no
coverage score respectably, which is precisely the report nobody should trust.

A run is also graded against the bar its own mode set (`researchStrategy`
TARGETS), so a "deep" label cannot mean nothing.

## Security

Everything retrieved is untrusted. `security/researchSecurity.js` is the
boundary and answers three questions nothing else is allowed to answer:

**May we fetch this?** — scheme allowlist, no credentialed URLs, and SSRF
screening that refuses loopback, private, CGNAT, link-local and cloud-metadata
addresses, bare intranet hostnames, and IPv4-mapped IPv6 in both spellings
(`::ffff:127.0.0.1` and the `::ffff:7f00:1` the URL parser rewrites it to).

**Is what came back safe?** — credentials and active exfiltration URLs are
*hard* failures: the content is redacted and refused. Prompt injection is a
*soft* failure: instruction-shaped spans are defanged in place and the source
carries on with its trust score docked. Discarding it would let any site remove
itself from research by adding "ignore previous instructions" to its footer,
which is a denial-of-service, not a defence — and it would make a research
corpus *about* prompt injection impossible.

**How does a model see it?** — `wrapUntrusted` fences content with a per-call
unguessable marker and a header saying it is data. Nothing concatenates
retrieved text into a system prompt.

Outbound queries are screened too: a decomposed query built from file contents
is the realistic way a secret ends up in a search box.

## Policy

`policies/researchPolicy.js` contributes action names and a baseline document
to the **existing** policy engine. There is no second engine and no evaluation
logic here.

| Action | Baseline effect |
| --- | --- |
| `research.start`, `research.plan` | allow |
| `research.source.file`, `research.source.local` | allow |
| `research.memory.write` | allow |
| `research.search`, `research.fetch`, `research.source.{web,academic,github,documentation,discussion,news}` | **approval** (allow when `research.allowNetworkedSources`) |
| `research.source.mcp` | **approval**, always |
| `research.browser` | **approval**, always |

Two properties fall out of the existing engine rather than being restated:

- The merge is most-restrictive-wins, so this document can only tighten the
  platform baseline. A networked source is evaluated **twice** — on its own
  action and on the platform's existing `network.request` — and the stricter
  answer wins. Turning on `allowNetworkedSources` does not bypass the network
  gate.
- With no approver wired, an approval gate is a **denial**. A fresh install
  therefore does no outbound research unattended.
- MCP is gated harder than the rest on purpose: an MCP server is third-party
  code, not a page.

## Memory

Built on the existing `MemoryManager`: no second store, no second scope model.
This layer decides *what* becomes an entry and *when it expires*.

- Only `supported` / `strongly_supported` claims at confidence ≥ 0.6, with
  citations, are remembered. An unverified claim is not a fact, and storing it
  would mean the next run treats our own uncertainty as established background.
- Expiry is chosen by how fast the subject moves. A **realtime** question has a
  zero TTL: nothing from it is remembered as fact, because it would be wrong
  before it was read. `researchRouter` applies the same rule on the way in and
  re-researches rather than serving a stale answer.
- Citations travel with the fact, so a remembered claim can be re-cited.

## Budget and cancellation

The task carries its own wallet. `spend()` is the only way usage moves and it
throws at the ceiling — checked *before* the increment, so usage never reports
more than was allowed. A budget stop is not a crash: whatever was gathered is
returned as a partial result, and a partial result says so.

Cancellation threads one `AbortController` through every provider call and is
checked between stages, so a cancelled task stops at the next boundary rather
than running to completion invisibly. `dispose()` cancels live tasks before
releasing anything else.

## Observability

Research events (`traceEvents.js`) are appended to the platform's own
`ExecutionTrace` with the same correlation envelope everything else carries —
`traceId`, `taskId`, `workspaceId`, `agentId`, `sessionId`, `projectId`. The
trace schema has no field for deliberation and `trace/events.js` rejects the key
shapes outright, so a research run cannot leak reasoning into telemetry.

Per-source and per-citation events fire many times per run and are deliberately
kept off the renderer wire; the UI gets `research.progress` and reads counts
from `research:status`, the same judgement already applied to
`policy.evaluated`.

## Artifacts

Through the existing `ArtifactManager`. Each completed run writes
`research-report.md`, `research-report.json`, `sources.json`, `evidence.json`
and `citations.json`.

## Configuration (`settings.json`)

```jsonc
{
  "research": {
    "enabled": true,
    "defaultMode": "standard",        // quick | standard | deep
    "maxQueries": null,               // null = the mode's own ceiling
    "maxSources": null,
    "maxConcurrency": null,
    "timeoutMs": null,
    "requireCitations": true,
    "requireVerification": true,
    "cacheEnabled": true,
    "allowedDomains": [],             // a ceiling; the renderer can only narrow it
    "blockedDomains": [],
    "allowNetworkedSources": false    // still gated by network.request
  }
}
```

Every value is re-validated on read (`settings.researchConfig`): the file is
user-editable, and a hand-typed `allowNetworkedSources: "yes"` must not become a
policy `allow`.

## IPC

| Channel | Purpose |
| --- | --- |
| `research:start` | begin a task (the only channel that spends anything) |
| `research:status` | stage, counts, quality |
| `research:cancel` | cancel a live task |
| `research:get` | the full result |
| `research:list` | live tasks |
| `research:sources` | sources + bibliography |
| `research:evidence` | evidence, claims, conflicts |
| `research:report` | markdown or json |
| `research:capabilities` | what this install can actually do |

Every field on `research:start` can only *narrow*. The main side clamps limits
against the configured ceilings and **intersects** domain allowlists rather than
replacing them, so a compromised renderer cannot widen what the install permits.
There is no channel that can raise a ceiling, name a provider, or add a policy.

## Developer API

```js
const { research } = createPlatform({ io });

// The high-level route: decides whether to research at all.
const { route, result } = await research.researcher.answer(question, {
  mode, files, filesOnly, allowWeb, sourcePreferences,
  allowedDomains, excludedDomains, workspace, memoryPolicy, signal,
});

// Or drive the stages directly (§43).
const task = research.engine.create({ question, mode: 'deep' });
await research.engine.plan(task);
await research.engine.search(task);
await research.engine.analyze(task);
await research.engine.verify(task);
await research.engine.synthesize(task);
await research.engine.evaluate(task);
research.engine.cancel(task.id);
const out = research.engine.result(task.id);
```

As tools, through the existing `ToolManager`: `research:run`,
`research:verify`, `research:sources`, `research:capabilities` — all read-only,
all carrying a `research.*` policy action.

## Testing

| File | Covers |
| --- | --- |
| `tests/research-unit.test.mjs` | classifier, planner, strategy, routers, dedup, rerank, cache, extractor, store, claims, conflicts, citations, quality, task model |
| `tests/research-integration.test.mjs` | no duplicate architecture, platform wiring, agents, tools, skills, policy, trace, artifacts, memory, recovery |
| `tests/research-security.test.mjs` | SSRF, domains, injection, credentials, exfiltration, untrusted framing, unsafe files, the boundary end to end |
| `tests/research-e2e.test.mjs` | the §45 scenarios, cancellation, budget, and the no-model path |
| `tests/research-ui.test.mjs` | the progress reducer and the panel's boundaries |

## Troubleshooting

**"Research returned no sources."** Call `research:capabilities`. Most often
either no provider is configured for the source types the question needs, or
`allowNetworkedSources` is false and no approver is wired — in which case the
refusal is recorded on the query (`query.errors`) with the policy that made it.

**"The answer says it is partial."** Check `quality.reasons` and
`quality.targetMisses`. A run is partial when a planned query was skipped or
failed, when the budget was spent, or when a deadline was hit — all three are
stated rather than smoothed over.

**"A claim I expected is missing."** Look at `quality.detail.completeness` —
uncovered subjects are listed by name, and `answer.notFound` says what was
looked for and not found.

**"A source I trust scored low."** `sourceQuality.scoreSource` returns its
reasons. Common causes: an open publishing platform (the author, not the host,
is the authority), no named author or publisher, an archived repository, or
instruction-shaped text in the page.

**"Research is slow."** It is asynchronous and bounded by
`maxConcurrency` and `timeoutMs`. Lower `maxSources`, or use `quick` mode.

## Cross-platform

Nothing here is OS-specific. File research goes through the injected `io.fs`
and the same `assertWithin` path guard the built-in filesystem tools use, so
Windows drive letters and UNC paths are handled exactly as they are elsewhere.
No child processes, no shell, no platform-conditional code.
