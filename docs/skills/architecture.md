# The KingAgent Skill Platform

A skill is a **capability package**: instructions, metadata, declared permissions
and provenance. It is not a plugin, not a script, and not something the platform
executes. That distinction is the foundation of everything below — a skill
contributes *how to do something*, and every action taken as a result goes
through the tool manager and the policy engine that already existed.

```
src/core/skills/
  index.js              createSkillPlatform() — the factory and public surface
  taxonomy.js           the closed category vocabulary + implications
  builtin/catalog.js    the skills KingAgent ships

  schemas/              SkillManifest · SkillPermissionSchema · SkillResultSchema
  registry/             SkillRegistry · SkillMetadata · SkillVersion · SkillSource
  discovery/            SkillDiscovery · SkillRanking · SkillSearch · SkillRecommendation
  loader/               SkillLoader · SkillResolver · SkillDependencyResolver
  runtime/              SkillRuntime · SkillExecutor · SkillContext · SkillResult
  security/             SkillValidator · SkillScanner · SkillTrust · SkillPermissions · SkillSandbox
  lifecycle/            states · SkillInstaller · SkillUpdater · SkillRemover · SkillEnabler
  evaluation/           SkillEvaluator · SkillQualityScore · SkillBenchmarks
  sources/              Builtin · Local · GitHub · SkillsSh
  cache/                SkillCache

src/core/mcp/
  classify.js  registry.js  bridge.js  inspector.js  index.js
```

## What this layer reuses rather than rebuilds

The most important architectural property of Phase 6 is what it *does not*
contain. There is no skill-specific permission engine, approval queue, sandbox
or tool surface:

| Concern | Owned by | How skills use it |
| --- | --- | --- |
| Permissions & governance | `core/policy` (PolicyManager) | Each manifest permission maps to an existing policy action (`filesystem.write`, `command.run`, …) and is evaluated through `policy.evaluate` |
| Human decisions | `core/approval` (ApprovalManager) | Install and run approvals are ordinary approval records, listable and auditable |
| Isolation | `core/sandbox` (SandboxManager) | `SkillSandbox` decides *whether*; the existing manager provides the sandbox, with its honest `advisory`/`kernel` enforcement flag |
| Actions | `core/tools` (ToolManager) | A skill's tool surface is an allowlist over registered tools; MCP tools are registered tools too |
| Learning | `core/memory` (MemoryManager) | Run outcomes are scoped memory entries |
| Events & tracing | `core/events`, `core/trace` | `skill.*` and `mcp.*` event types on the same bus |
| Persistence | `core/persistence` collections | `skill:` and `mcpserver:` namespaces on the same store |

A deployment that denies `command.run` blocks a skill that wants a shell without
anyone writing a skill-specific rule.

## The pipeline

```
user request
  → analysis + discovery      which capabilities does this task need?
  → ranking                   which installed skill is the best fit, and why?
  → recommendation            the working set, grouped into ordered phases
  → dependency resolution     dependencies first; cycles and conflicts refuse
  → security validation       manifest, scan, provenance (re-checked on load)
  → policy evaluation         every declared permission, through PolicyManager
  → approval                  when trust × risk (or a finding) calls for it
  → load                      content fetched, digest compared with install time
  → execute                   a host-supplied runner, with an allowlisted tool surface
  → evaluate                  outcome recorded, quality rescored, quarantine if warranted
  → recovery                  one alternative skill, then an honest stop
  → result
```

`SkillRuntime.plan()` runs everything up to (not including) loading and returns
the decision without side effects. That is what the UI previews and what the
orchestrator consults before deciding skills are worth loading at all.

## Discovery, and why it narrows

Loading every skill is not merely wasteful — it fills the context window with
instructions for work that is not happening. Discovery is therefore a narrowing
pass: request text in, a small ranked set of taxonomy categories out.

It is deterministic (a phrase table plus token matching, no model call, no
network) for three reasons: it runs on every request; a routing decision must be
explainable after the fact; and a platform that cannot discover skills offline
cannot discover them on a plane. A model may *widen* the result via
`providerCategories`, but its suggestions are filtered through the taxonomy and
weighted below every deterministic signal.

One level of **implication** is applied on top (`taxonomy.IMPLIES`): "build a
REST API" implies testing, documentation and a security pass, because expert
practice implies them and users do not type them. One level, never transitive —
that is the guardrail that keeps four matched words from selecting half the
taxonomy.

## Ranking

Eight normalized factors, weighted, each reported with its contribution:
relevance (0.32), reliability (0.18), trust (0.16), security (0.14), quality
(0.10), maintenance (0.05), compatibility (0.03), popularity (0.02).

Popularity is deliberately last and capped by its weight. A skill with a million
installs cannot outrank a well-matched, trusted, proven one. Compatibility and
security failures are *gates*, not weights: an incompatible or scanner-blocked
skill is not a lower-ranked option, it is not an option.

## Composition

`SkillRecommendation` groups the working set into phases — research, analysis,
design, implementation, testing, security, delivery — and a skill covering
several categories takes the earliest phase among them. Two composition rules:

* **Permissions never widen across a pipeline.** Each skill runs with its own
  declared set; skill three does not inherit shell access approved for skill one.
* **A failed skill does not silently disappear.** Recovery tries the next ranked
  skill for the same categories, once, and both attempts appear in the result.

## State

See `lifecycle/states.js` for the full transition table. The rule worth stating
here: **quarantine is one-way without a person.** A skill quarantined by the
platform (failure streak, security incident) can only move to `disabled` — by a
named human — or be removed.

## Where the layer degrades honestly

| Missing dependency | Behaviour |
| --- | --- |
| No policy engine | Validation reports permissions as *undetermined*; execution refuses |
| No approval manager | Anything needing approval is refused, never auto-approved |
| No sandbox manager | A skill whose posture requires a sandbox refuses to run |
| No tool manager | A skill has no tool surface; an undeclared call is a security incident |
| No HTTP client | Remote sources report "not wired" — never an empty result set |
| No runner | A run reports `prepared` (assembled, permitted, not executed), which does not count as a success |

## See also

- [Skill manifest](./skill-manifest.md)
- [Security model](./security.md)
- [Creating skills](./creating-skills.md)
- [MCP capability layer](./mcp.md)
- [Evaluation](./evaluation.md)
- [skills.sh integration](./skills-sh.md)
