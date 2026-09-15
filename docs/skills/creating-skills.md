# Creating a skill

A skill is a directory with a manifest and a Markdown document. There is no
build step, no entry point, and nothing to register in code.

```
my-skill/
  skill.json
  SKILL.md
```

## 1. The manifest

```json
{
  "id": "postgres-tuning",
  "name": "PostgreSQL Tuning",
  "version": "0.1.0",
  "description": "Diagnose and fix slow PostgreSQL queries.",
  "author": "you",
  "categories": ["query-optimization", "postgresql", "performance-monitoring"],
  "capabilities": ["db.query.optimize"],
  "permissions": ["filesystem.read", "network.request"],
  "tags": ["postgres", "performance"]
}
```

Declare the permissions the approach actually needs. Under-declaring produces a
scanner warning and an approval prompt that understates the skill; over-declaring
raises its risk level and costs the user a prompt they did not need. See
[the manifest reference](./skill-manifest.md) for every field.

## 2. The instructions

`SKILL.md` is read by a model as guidance. What belongs in it is the part that is
*specific*: the order of operations, the failure modes, the judgement calls. What
does not belong is a restatement of what a competent model already knows — that
wastes the context the skill was loaded into.

A shape that works:

```markdown
# PostgreSQL Tuning

## Method
1. Get the actual plan (EXPLAIN ANALYZE), not the estimate.
2. …

## Failure modes
- Adding an index for a query that is not the one that is slow.
- …
```

Write instructions, not scripts. A skill may *name* a command as part of an
explanation; it must not be a document intended to be executed verbatim. The
scanner flags download-and-execute, credential access and destructive commands,
and those flags are not a formatting problem to work around — they mean the skill
is trying to be a program, and the platform has a place for programs (tools).

## 3. Install it locally

```bash
npm run skills -- validate --source=local --id=postgres-tuning --skills-dir=/path/to/skills
npm run skills -- install  --source=local --id=postgres-tuning --skills-dir=/path/to/skills
```

`validate` never writes anything; run it until it is clean. A local skill is
`workspace` trust, so a medium-risk one is sandboxed and a high-risk one also
asks for approval each run.

## 4. Iterate

Edit `SKILL.md` freely: the loader compares the content digest against the one
recorded at install, re-scans anything that changed, and re-pins it. An edit that
introduces something the scanner refuses quarantines the skill — that is the
mechanism working, not a bug.

## Testing that it is selected

Discovery only reaches a skill through its **categories**. If a skill is never
selected, the category is usually the reason:

```bash
npm run skills -- plan "why is this query slow in production"
```

The output shows the categories the request produced with their scores, the
selected working set, and any gaps. If your category is not in the list, the
request does not imply it — either the taxonomy needs a keyword
(`src/core/skills/taxonomy.js`) or the skill needs a category that is actually
implied.

## Publishing

| Destination | What it takes | Trust it earns |
| --- | --- | --- |
| Local directory | Nothing; point `--skills-dir` at it | `workspace` |
| GitHub | A `skills/<id>/` directory in a repository | `community`, and only when installed at a pinned commit sha |
| skills.sh | Publishing there | `community`, and only once a content digest is recorded |

Remote skills always arrive `untrusted`, are scanned locally, and require
approval on install. That is not a statement about any particular publisher; it
is how the platform treats bytes it did not review.

## Checklist before publishing

- [ ] `validate` is clean — no errors, and every warning understood
- [ ] Permissions match what the instructions actually ask an agent to do
- [ ] Categories are ones a real request would imply
- [ ] The document says something a good model would not already do
- [ ] Failure modes are named, not just the happy path
- [ ] No credential, host name or internal URL is embedded
