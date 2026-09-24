# Deploying

Last verified: 2026-08-11

**Purpose:** Put the code into production, once, and prove that what went live is what was meant to go live.

> **Hard rule: the deploy is fixed by fixing the cause, never by widening what the build accepts.** No suppressing build errors, no skipping validation, and above all **never remove the migration step from the build script to make a red build go green**. That turns the check that protects the database into the thing that was in the way.
>
> **Never deploy a tree with uncommitted changes, or a branch whose head has not been pushed.** The two mechanisms below deploy different things when those differ, and only one of them is reproducible.

## One deploy

By the time this file runs, the address is settled, the database exists, the schema is applied and every variable is written. So the first deploy is the first one that can succeed, rather than a throwaway that fails on something already known to be missing.

If a redeploy turns out to be necessary, that is a **contingency with a cause** — name it. A scheduled second deploy trains the habit of writing the environment twice, and the second write is where an invisible trailing newline lands unnoticed.

## Which mechanism

**With a repository — preferred.** Connect it and let a push produce the deploy, so the mechanism the user keeps forever is the one that just got proven:

```bash
gh repo create <name> --private --source=. --remote=origin --push
npx --yes vercel@latest git connect
```

Order matters: **create the repository, commit, push, connect, and only then let a deploy happen.** Connecting before the variables are written means the next push produces a failed build that is permanent in the dashboard and emails the user a failure notice in their project's first minute.

**Without one — the fallback.** A direct upload of the working directory:

```bash
npx --yes vercel@latest deploy --prod --yes --logs
```

Offer the repository first. Push-to-deploy is most of the value, and an app with no version control is a separate conversation worth having briefly.

## Straight to production, or not

**A project this run created deploys straight to production.** The worst case of a failed first deploy is a failed build and no live site — which is exactly the state it was already in. There are no users to protect.

**Preview-then-promote is the wrong default here, and actively misleading:**

- Promotion does not rebuild. A preview build was built with *preview* values baked in, so promoting it puts an artifact built against the wrong configuration into production.
- Preview URLs are unique per deployment, so the sign-in origin cannot match one. Every auth check on a preview is red for a reason that has nothing to do with the app.
- Previews are protected by default, so the gate's own requests get an authentication page instead of the app.

**Where there is already a production site with users** — established in `preflight.md` — the posture inverts: deploy a preview, gate what can be gated, promote deliberately, and know the rollback command before starting.

## Watch it finish

Do not report a result from a deployment that is still running. Wait for a terminal state, then read what happened:

```bash
npx --yes vercel@latest inspect <url> --wait
```

**When a build fails, read the build log** — which is a different command from the runtime log:

```bash
npx --yes vercel@latest inspect <url> --logs
```

Runtime logs are empty for a build that never produced a running app, and reaching for them here is the obvious wrong turn. Read the build log, find the cause, fix the cause. **Do not retry a failed build unchanged** — the same commit builds the same way, and retrying is superstition that costs minutes.

Retry is only correct for genuinely transient things, and each should be named when it happens: a cold database refusing the first connection, DNS not yet propagated, a queued deployment, a provider rate limit or server error.

## Confirm what went live

One command, and the highest value per keystroke in the whole skill:

```bash
npx --yes vercel@latest inspect <production-url>
git rev-parse HEAD
```

**The deployed commit must equal the local head.** This catches the two most common false victories: reading the previous deployment's result while the new one is still building, and deploying a working directory that was never committed.

## Verify

- The tree was clean and the head was pushed before anything deployed.
- Exactly one production deployment was made — or, if more, each extra one has a named cause.
- The deployment reached a terminal state and was not reported on while running.
- The deployed commit equals `git rev-parse HEAD`.
- Where a repository was connected, it was connected **after** the environment was written, not before.
- No build error was suppressed, no validation skipped, and the build script still runs its migration step.
- A failed build was diagnosed from the build log rather than retried.
- The deployment, the project and the repository are all in the run's ledger.
