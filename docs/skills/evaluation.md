# Skill evaluation

Two independent measurements, deliberately not merged into one number:

* **Run statistics** — what happened when a skill actually ran here.
* **Benchmarks** — whether discovery selects the right capabilities for a task.

A skill can score well on one and badly on the other, and collapsing them would
hide exactly that.

## What is recorded per run

`SkillEvaluator.record()` stores: outcome, duration, error, **security incident
(separately from failure)**, approval granted/denied, and the consecutive-failure
streak. A `prepared` or `skipped` outcome is *neutral* — it does not count as a
run, so a platform with no runner wired cannot manufacture a perfect success rate.

## Quality score

`SkillQualityScore.score()` returns a number **and the sentences that justify
it**. Components and weights:

| Component | Weight | Source |
| --- | --- | --- |
| reliability | 0.35 | observed success rate, shrunk toward a neutral prior until ~10 runs |
| security | 0.25 | scanner findings; **0 if there has ever been an incident** |
| evaluation | 0.20 | benchmark pass rate, when one has been run |
| maintenance | 0.12 | how recently it was updated; deprecated → 0.1 |
| adoption | 0.08 | installs, log-scaled — a popularity signal, labelled as one |

Three rules the output enforces:

1. **Unknown is not zero.** A skill that has never run gets the neutral prior and
   a caveat saying so, not a 0% reliability score.
2. **Low confidence widens the grade.** Below ~⅓ of the evidence wanted, the
   grade is `unproven` rather than a two-decimal figure implying precision.
3. **Every component carries an explanation**, and the caveats list what the
   number does not know.

```
good (72/100, moderate confidence). strongest: security — scanner found 0 findings;
weakest: evaluation — no benchmark results; scored neutral.
Caveats: no benchmark has been run against this skill.
```

## Automatic quarantine

| Trigger | Result |
| --- | --- |
| Any security incident | Quarantined immediately |
| Three consecutive failures | Quarantined |
| Scanner block (install or re-scan) | Quarantined / refused |

Release is a human action and lands in `disabled`. See
[security](./security.md#quarantine).

## Benchmarks

`SkillBenchmarks` encodes the phase brief's scenarios as executable
expectations — "Build a REST API" must reach design, implementation, testing and
security; "Create an MCP server for GitHub" must reach the MCP skills, and so on.

```bash
npm run skills -- benchmark
```

**Recall is the metric, not precision.** Selecting a slightly wider set costs some
context; missing the security skill on a security task costs the task. A scenario
passes at ≥ 0.6 recall; precision is reported but not gated, because the
implication layer (deliberately) broadens selection.

The report repeats what it measures — *discovery and selection only, not
execution quality* — in its own payload, so a dashboard cannot present it as an
overall quality figure.

## Memory

With a memory policy supplied, outcomes are written as scoped memory entries
(`skill-outcome`): which skill, which task type, success or failure, duration.
Failures are stored too — a memory that only records successes is a
recommendation engine for survivors.

Memory informs ranking. It **cannot** override security: a blocked or quarantined
skill stays that way regardless of how well it once performed.
