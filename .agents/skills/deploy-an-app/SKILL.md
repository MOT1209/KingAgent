---
name: deploy-an-app
description: Take a Next.js app that runs on the user's machine and put it into production on Vercel — provisioning the database, file storage, background jobs and payments it needs, setting every environment variable, deploying once, and then proving the live site actually works. Use when the user wants to deploy, ship, publish, launch or go live with an app; when they have finished building and ask how to put it online; or when an already-deployed app needs a database, a custom domain, an email domain, or an integration wired up properly. Covers preflight and stack detection, provisioning Postgres and Blob storage, converting a SQLite app so it can run on a read-only filesystem, custom domains and DNS, OAuth callback URLs, email domain verification, background job syncing, payments, agent access over MCP, and a closing pass that checks the deployed site rather than taking the deploy's word for it.
---

# Deploy an App

Take an app that works on one machine and make it work for everyone. The result is a live URL the user owns, backed by real infrastructure, with an honest account of what was done for them and what is still theirs to do.

**Deploying is not building.** This skill provisions infrastructure, sets configuration and runs deploys. It does not add features, redesign pages, or improve code it happens to dislike. Where a change to the code is genuinely required to run in production — and there is exactly one common case, a SQLite app moving to Postgres — it goes on the sheet in Step 3 and is approved before it happens.

**Most of this is automatable, and the parts that aren't are knowable in advance.** The value of this skill is not that it types `vercel deploy`. It is that it asks for every human-only credential *once*, in one place, before anything starts — rather than discovering them one failed build at a time.

## Ground rules

- Explain every step like you would to a smart friend who doesn't code. Say "the address people will type" before saying "domain". Introduce each term once, briefly, then use it normally.
- **Never write or accept a version number.** Not in an install command, not in prose, not a CLI version to gate on. Every invocation takes the current release, and Step 1 is what establishes what that means today. A version written into a skill file is a lie with a timestamp on it.
- **Nothing deprecated, ever.** If the current release renames or supersedes something a reference file uses, use the replacement, not the old path that "still works".
- **On what the hosting CLI can do, `--help` outranks everything** — this file, the reference files, the research in Step 1, and the provider's own documentation. Documentation describes the release the writer had. Ask the binary that is about to run. This is the deploy-side twin of the parent skill's rule that research wins on API detail.
- **The public URL is read back from the platform, never predicted.** A name collision makes the host assign something else, and every value derived from a guessed URL — the sign-in origin, the OAuth callbacks, the token audience — is then quietly wrong.
- **Everything the build needs is set before the build runs.** Not just the database. Provider clients get constructed when a module is first imported, so a missing key is a failed build, not a runtime warning. Step 7 finishes before Step 8 starts.
- **`.env` is not a deployment artefact.** Some values in it are actively dangerous in production — a local database address, a sandbox payments flag, a switch that turns off signature checking. Each is copied, transformed, regenerated or refused deliberately. `references/env.md` has the table; there is no copy loop.
- **A secret goes from its source into the host and nowhere else.** Never printed, never echoed into the conversation, never asked for as a chat message when a file or an environment variable would do.
- **One approval, and one announced pause.** Step 3 is the only place the user decides anything. Step 6 is a scheduled hand-off where they do browser work no API can do — named on the sheet before it happens, so it is a meeting rather than an interruption.
- **Test mode unless the user says otherwise, separately.** Everything else on the sheet runs under one go-ahead. Taking real money does not: it is the one action that can charge a real card, and live prices cannot be deleted afterwards.
- **Check before creating, and write down what was created.** Every provider here will happily create a second one of anything. Two webhooks on one URL means every event is processed twice, with half the signature checks failing. The record is written as each thing is created, never reconstructed afterwards — `references/recovery.md` has the format, and it is what makes an interrupted run reportable instead of mysterious.
- **When something fails, stop and report — never tear down.** A database a later step couldn't reach still holds the schema that worked. `references/recovery.md` says what can be undone and what cannot.
- **Never delete or overwrite something this run did not create.** A name collision stops and asks. The exception is a value this run wrote itself and is correcting.
- **A check that wasn't run is named, never claimed.** In this skill the specific temptations are saying the environment is verified when only names were read, that the database is connected when only a page returned 200, and that webhooks work when only an endpoint was registered. The user reads silence as success.
- **The gate is passed by fixing the deploy, never by widening the gate.** No build-error suppression, no skipping validation, and above all never removing the migration step from the build script to make a red X go green.
- **Never `drizzle-kit push`.** The parent skill's rule, and here the database has the user's real data in it.
- The app is deployed **from the current working directory** — that folder is the project root. Never create a subfolder and never `cd` into one.
- All commands, package names and config live in the reference files, never in this file. Load only the ones the detected branches need.
- If a reference command fails because a tool changed, check that tool's official docs, use the current equivalent, finish the job, and tell the user at the end which file needs a refresh.

## Step 0 — Preflight

Find out what is true before promising anything. `references/preflight.md`.

Nothing here changes anything. It establishes: whether the hosting CLI is available and what it can actually do; whether the user is logged in and under which account; what this app is, which package manager it uses, and what its build command really runs; which features it has, read from the code rather than asked about; the complete list of environment variables the code reads; and whether the git tree is clean.

**The branch list comes from the code.** An app has payments because there is a payments client in it, not because the user remembered to mention it. This is also what lets the skill work on an app it did not build.

**A dirty tree stops here.** A deploy cut from uncommitted work is a build nobody can reproduce, and the two deploy mechanisms — a push and a direct upload — disagree about what it even contains.

**Is there already a production deployment with users on it?** If so, the posture changes for the rest of the run: nothing is created from scratch, and Step 8 stops deploying straight to production. Establish it here, not at the moment it matters.

## Step 1 — Check what's current

The branches are known, so find out what deploying them involves *today*. Same pattern as the parent skill: **one research subagent per detected branch, all dispatched in a single message.**

Hosting CLIs, dashboards and provider APIs move faster than application libraries, and they move in a way that breaks scripts rather than types. A flag that was renamed is a pipeline that stops halfway through, having already created things.

Each gets the standard brief — current stable release, anything deprecated or renamed, current command and endpoint shapes, any capability added since that would replace hand-written steps in the reference file. Reconcile as the parent skill does: latest stable only, take the new capability when there is one, and on how the pieces fit together this skill wins.

**Say something to the user only when something changed.** Narrating research that found everything fine reads as filler.

## Step 2 — What only the user knows

Short, because Step 0 answered most of it from the code. Ask one thing at a time, with a recommendation.

1. **"What address should this live at?"** — a domain they own, or the free one the host provides. Asked first because every callback URL, every webhook target and the sign-in origin derive from it, and each one that changes later is manual work done twice.
2. **The credentials the detected branches need**, gathered in **one block** — every provider account and key, what each is for, and where to get it. Not one question per failure.
3. **Payments, if present: test mode or real money.** Recommend test mode. Real money is a separate, explicit confirmation.

## Step 3 — Deploy sheet

Restate it in plain words and get one clear go-ahead. `start-an-app` Step 3's job, on the deploy side:

> Here's what I'll set up for **TrailLog**:
>
> **It'll live at:** traillog.com — you'll add two DNS records at your registrar, I'll tell you exactly what.
> **Database:** a hosted Postgres, free tier — sleeps when idle, so the first visit after a quiet spell takes a second.
> **Photos:** a file store connected to the project, free up to a point.
> **Sign-in:** you'll paste one callback URL into Google's console — about two minutes, and I'll give you the exact text.
> **Payments:** set up in test mode. No real cards until you say so.
> **What it costs:** nothing today. Every piece is on a free tier, and I'll tell you where each one ends.
> **One pause:** after I've set up the address, I'll stop and give you a short list of browser work — the DNS records and the Google callback. Everything else runs without interrupting you.
>
> Sound right?

Include what will be created, what it costs, what is irreversible, and where the pause lands. For a SQLite app, the conversion appears here as a change to their code, in plain words.

## Step 4 — The address

Everything downstream needs the URL, so it is settled before anything else exists. `references/project-and-url.md`.

Create the project, **read back the production URL the platform actually assigned**, attach the custom domain if there is one, and produce the DNS records the user will need. Start DNS early: it is the slowest thing in the pipeline and it depends on nothing.

Where a domain is involved, decide the canonical host — bare or `www` — and redirect the other to it. A session cookie set on the wrong one is a sign-in that appears to work and then doesn't.

## Step 5 — Provision and prepare

`references/provision-database.md`, plus `references/provision-storage.md` for the uploads branch.

Create the database and the file store, and connect them to the project. Two details decide whether this works: the name the provider injects may not be the name the code reads, and migrations want the direct connection string while the app wants the pooled one.

This is also where the code changes happen, if any: the SQLite conversion, and reconciling any variable name. Commit them.

**Then build it locally against the production database, before deploying anything.** It runs the same migrate-then-build the platform will run, catches the conversion and every module-scope key, and costs no deployments. This is the single best-value check in the skill.

## Step 6 — The rendezvous

The one announced pause. Hand the user everything that needs a human in a browser, in a single block: the DNS records, the OAuth callback URLs, any provider account they still need. Exact values, ready to paste.

This is not a prompt for a decision — Step 3 was. It is a scheduled hand-off, promised in advance, so the user can do fifteen minutes of console work in one sitting rather than being interrupted five times.

## Step 7 — The environment

`references/env.md`. Write every variable the code reads, to production, before any build.

Three things make this more than a copy: values that must be transformed or refused rather than copied; secrets that are corrupted by an invisible trailing newline and cannot be read back to diagnose; and the fact that a written secret can be confirmed to *exist* but never to be *correct*.

Then wire the external systems that need only the URL, not a live site — payment webhooks, background-job keys. `references/wire-payments.md`, `references/wire-jobs.md`, `references/wire-auth.md`, `references/wire-email.md`, `references/wire-mcp.md`, each only if that branch exists.

## Step 8 — Deploy

`references/deploy.md`. **Once.** Everything the build needs is already in place, so the first deploy is the first one that can succeed rather than a throwaway that fails on a missing database.

Where the user has a repository, connect it and let a push produce the deploy — so the mechanism they will use forever is the one that just got proven. A direct upload is the fallback.

Then confirm the deployment that went live is the commit you think it is. It is one command, and it catches the two most common false victories: reading the previous build's result while the new one is still going, and deploying something that was never committed.

**Deploy straight to production only for a project this run created.** Where there is already a live site with users, that is a different posture, and `references/deploy.md` has it.

## Step 9 — Prove it

`references/gate.md`. The app is deployed. Nothing yet establishes that it works.

Commands against the live URL, whose output is read. What is genuinely provable from outside without a browser is more than it looks: the deployed commit, that migrations ran, that the database answers, every route, the certificate and canonical host, cookie flags, that a webhook endpoint verifies signatures rather than accepting anything, that discovery documents name the real domain.

**Distinguish failed from blocked from not attempted.** If DNS has not landed yet, every check behind the domain is red for one reason, and reporting fifteen failures for one cause teaches the user to ignore the gate.

Where a browser is available, use it — a real sign-in on the live domain is the one check that proves the URL, the database and the session cookie are all correct together. Everything still out of reach is named as unperformed.

## Step 10 — Fresh eyes

The gate proves the site answers. It cannot tell whether the deploy did what was agreed, or left something behind. **Dispatch the critics in a single message**, read-only, evidence not access, two rounds then stop. Briefs are in `references/gate.md`.

The lenses differ from the parent skill's, because there is no new app to review — sheet against reality, claim against evidence, secret exposure, and what got left behind.

## Step 11 — Hand off

- **What exists now and what it costs**, from the record kept while creating it — every resource, its free-tier limit, and how to remove it.
- **What the next `git push` does.** If push-to-deploy is wired, this is the biggest change to how they work, and it deserves one plain sentence: pushing to the main branch puts it live, and a bad migration fails the build.
- **How to deploy again, and how to roll back.**
- **Every check that could not be run**, with what it would need.
- **The manual steps still outstanding**, if the rendezvous left any.
- If agent access was built, the connector URL, and where it goes in Claude — they will not find it on their own.
- Anything Step 1's research contradicted, named, so this skill can be corrected.
