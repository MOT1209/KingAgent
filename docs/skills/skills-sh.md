# skills.sh integration

skills.sh is supported as an external discovery ecosystem through a source
adapter (`src/core/skills/sources/SkillsShSource.js`).

## Status: unverified in this build

**The adapter was written without being able to call the service** — the build
environment has no network route to that host — so its default endpoints and
field names are a starting point to be corrected, not documentation of the API.
Two consequences, both deliberate and both visible in the code:

1. **Every endpoint and field name is configuration**, not a constant compiled
   into the platform.
2. **An unrecognized response is an error, not an empty list.** A source that
   silently returns `[]` when its API changed is how a platform starts shipping
   "no skills found" as if it were an answer.

`source.contract()` returns what the adapter will call, including
`verified: false`, so the UI can say which registry it is talking to and that the
contract has not been confirmed.

## Configuring it

```js
createPlatform({
  io: {
    skills: {
      http,                       // the host's HTTP client — the core has none
      skillsSh: {
        baseUrl: 'https://skills.sh',
        endpoints: {
          search:  '/api/skills?q={query}&limit={limit}',
          detail:  '/api/skills/{id}',
          content: '/api/skills/{id}/content',
        },
        map: {                    // where the fields live in the response
          results: ['skills', 'results', 'items', 'data'],
          id: ['id', 'slug'],
          version: ['version', 'latestVersion'],
          content: ['content', 'instructions', 'body'],
        },
      },
    },
  },
});
```

`baseUrl` must be https, and a templated request that would leave that origin is
refused before it is sent.

## What the adapter does

| Capability | Method | Notes |
| --- | --- | --- |
| Search | `search({ query, limit })` | Listing rows only — advertising copy, never a decision |
| Metadata | `find({ id })` | One listing |
| Source retrieval | `fetch({ id })` | Manifest + content + **digest of the bytes actually read** |
| Installation | via `SkillInstaller` | Full validation, scan, policy, approval |
| Version detection | `SkillUpdater.check()` | Compares the published version with the installed one |
| Update detection | `SkillUpdater.checkAll()` | Read-only; what a "3 updates available" badge reads |

## Trust

A skills.sh skill is **untrusted** until it has been fetched, scanned and
validated locally. The listing's own claims about permissions or risk are used
for display only.

Installing records the digest of the content that was fetched. That digest is
what makes the skill eligible for `community` trust, and it is what the loader
compares on every subsequent load — a registry entry republished under the same
version is detected as a change, re-scanned, and quarantined if the new content
is refused.

```
listing (untrusted, display only)
  → fetch  → digest recorded
  → validate + scan locally
  → policy evaluation
  → approval (always, for a remote skill)
  → registry, at `community` trust once a person accepts it
```

## Trying it

```bash
npm run skills -- search "mcp" --remote
npm run skills -- validate --source=skills.sh --id=<id>
npm run skills -- install  --source=skills.sh --id=<id> --yes
```

`validate` fetches and checks without installing. `install` without `--yes`
refuses and prints what it would have been consenting to — a non-interactive
session never auto-approves a remote skill.

## If the contract is wrong

You will get a clear error naming what was expected:

```
skills.sh search response was not recognized (expected an array, or an object
with one of: skills, results, items, data). Configure `endpoints`/`map` on the
skills.sh source for the real API shape.
```

Fix it in configuration; no platform code needs to change.
