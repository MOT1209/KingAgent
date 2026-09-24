# The ledger, and when things go wrong

Last verified: 2026-08-11

**Purpose:** Keep a record of everything this run creates, so that an interrupted deploy is reportable rather than mysterious — and set the policy for what happens when a step fails halfway, before the moment it does.

> **Hard rule: write the ledger as each resource is created, never reconstructed afterwards.** A run that crashes is exactly the run that cannot remember what it made. Without the ledger the user is left with an unknown number of billable resources and no inventory; with it, "stop and report" is a complete answer rather than an abdication.

## The ledger

Append a line the moment each thing exists — not at the end of the step, and not from memory:

| What | Where | Costs | To remove |
| --- | --- | --- | --- |
| project | account / team | nothing | the CLI's project remove |
| database | provider, region | free tier, and where it ends | provider dashboard or CLI |
| file store | project | free tier | the CLI's store remove |
| repository | owner/name | nothing | the GitHub CLI |
| webhook endpoint | provider, URL | nothing | provider API |
| domain | registrar, records written | the user's existing cost | the records are theirs |
| variables written | names only, never values | nothing | remove by name |

It does three jobs at once: the failure report, the removal list at hand-off, and the resume point if the skill is run again.

## When something fails

**Fail closed. Do not tear down. Print the ledger.**

There is no "roll back" on a first deploy, because nothing was live before. Rolling back is a concept that exists only on a second run, against a site that already had users.

**Retry only these**, and say so when you do: a network timeout, a cold database refusing its first connection, DNS not yet propagated, a deployment still queued, a provider rate limit or server error.

**Never retry:** a build error, any provider rejection of a request, or a failed migration. Retrying a build error unchanged is superstition — the same commit builds the same way.

**Never delete a resource to "start clean."** A database that a later step failed to reach still holds the schema that worked. Deleting it destroys the only finished part of the job. Stop, report, and let the user decide.

## What can and cannot be undone

| Left behind | Undo |
| --- | --- |
| A failed deployment record | None. Permanent, visible, harmless. |
| **Partially applied migrations** | **None.** The migration ran, the build failed, the schema moved anyway. No down migrations exist. |
| Database, file store, integrations | Deletable — and each costs money until it is. |
| Variables written | Removable by name. A wrong value can only be overwritten, never diffed, because it cannot be read. |
| **Live payment prices** | **Cannot be deleted, only deactivated.** |
| Webhook endpoints | Deletable — and duplicated on a re-run unless checked for first. |
| Email domain, jobs app | Deletable. |
| **DNS records at a registrar** | The user's, not the skill's. |
| **An OAuth client** | The user's. |
| **The user's own account, once created** | Deleting it removes the administrator and may lock them out. |

## The window that closes

**Recreating the database is a legitimate recovery only while it has no user data — and that window closes the moment the user creates their account.**

This is worth stating on the sheet, because it is the difference between an awkward five minutes and an unrecoverable position. Put every destructive recovery option before the user is invited to sign up, and after that point treat the database as permanent.

## Running it again

Every failure ends with someone running the skill again, so every create is **check-then-create**:

- A variable that exists is updated, not added — and how depends on what the CLI reported in `preflight.md`.
- **A webhook endpoint at the same URL is the nastiest one.** Providers will happily create a second, and then every event is delivered twice, with the signing secret matching one and failing the other. Silent double-processing plus a stream of signature errors. List before creating, always.
- A database, a store, a domain assignment: list first, reuse or stop.

Where the ledger from a previous run exists, read it first — it is the resume point.

## Verify

- Every created resource has a ledger line, written when it was created.
- No value appears in the ledger — names only.
- Nothing was deleted that this run did not create.
- Retries happened only for named transient causes, and each was said out loud.
- The user was told what exists, what it costs, and how to remove it.
