# Proving the deploy

Last verified: 2026-08-11

**Purpose:** The app is live. Nothing yet establishes that it works. This file turns the end of the pipeline from a list the agent agrees with into commands run against the real site, and then hands the result to eyes that didn't run them.

> **Hard rule: the gate is passed by fixing the deploy, never by widening the gate.** And a check that wasn't run is **named**, never claimed. In this skill the three specific lies are: "the environment variables are verified" when only names were read, "the database is connected" when only a page returned 200, and "webhooks are working" when only an endpoint was created.

Commands are written for a POSIX shell. **On Windows use the Bash tool** rather than translating them.

## Three outcomes, not two

Before running anything, fix the vocabulary, because this is what makes the gate readable:

- **passed** — the command ran and the result was right.
- **failed** — the command ran and the result was wrong.
- **blocked** — a prerequisite isn't there yet, so the check could not mean anything.
- **not attempted** — needs a browser, a card, or a person.

**Check zero is whether the domain resolves.** If it doesn't, every check behind it is `blocked: DNS`, reported as one line with one cause. Fifteen red failures for a single unpropagated record is noise that teaches the user to ignore the gate.

The second thing to distinguish: **an authentication page is not a failure.** If the deployment is protected, requests get an interstitial rather than the app, and it looks exactly like a broken site. A `401` whose body is the host's sign-in page means `blocked: deployment protection` — never `failed`. Say which it was.

## The gate

### 1 — What actually went live

```bash
npx --yes vercel@latest inspect <production-url>
git rev-parse HEAD
```

Deployment is `READY`, and its commit equals the local head.

### 2 — The build ran the migration

Read the build log for the migration step's output:

```bash
npx --yes vercel@latest inspect <url> --logs
```

This is the only external evidence that the schema was applied. Everything else infers it from a page loading, which it shouldn't.

### 3 — The database answers, without writing anything

The obvious probe — signing *up* — is **forbidden here.** In this stack the first account created becomes the administrator, so a probe account on a fresh production database takes the user's own place, and deleting it afterwards can lock them out of their own system page.

Sign *in* instead, with credentials that cannot exist:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/api/auth/sign-in/email" \
  -H 'content-type: application/json' \
  -d '{"email":"nobody@example.test","password":"not-a-real-passphrase"}'
```

**`401` is the pass. `500` is the fail.** A rejection means the request reached the database, queried a table that exists, and found nothing — which proves the connection string, the pooler, the migrations and the runtime environment in one request, while creating nothing.

### 4 — Every route answers

The same sweep the parent skill runs locally, against the live URL. List the app's real pages, ask each for a status:

```bash
for r in / /sign-in /dashboard /settings; do
  printf '%-28s %s\n' "$r" \
    "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$URL$r")"
done
```

No 500s. `200`, or a redirect to sign-in for anything behind it. **Keep this output** — the critics get it verbatim.

Do not blind-probe endpoints that do things. A POST with side effects is not a check.

### 5 — The address itself

```bash
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://<domain>"
curl -sI "https://<non-canonical-host>" | grep -i '^location'
```

The certificate is valid, plain HTTP redirects to HTTPS, the non-canonical host redirects to the canonical one, and there is no redirect loop.

### 6 — Cookie flags

```bash
curl -sI -X POST "$URL/api/auth/sign-in/email" -H 'content-type: application/json' \
  -d '{"email":"nobody@example.test","password":"x"}' | grep -i '^set-cookie'
```

Anything issued must be `Secure` and `HttpOnly`, with a sane `SameSite`. These go wrong silently when the origin is misconfigured, and they are free to check.

### 7 — Secrets did not ship to the browser

```bash
grep -rn "NEXT_PUBLIC_" src/ || echo "clean"
curl -s "$URL" | grep -oE "(sk_live|sk_test|re_|whsec_)[A-Za-z0-9_]*" || echo "clean"
curl -s -o /dev/null -w '%{http_code}\n' "$URL/.env"
```

That prefix makes a value public, so a secret behind one is already leaked. `/.env` must be `404`.

### 8 — Branch checks

Only where the branch exists. Each is described in that branch's own file, and each is a real assertion rather than a ping:

- **Payments** — post an unsigned body to the webhook route: `400` is the pass. `200` means it verifies nothing, `500` means it crashes, `404` means it never deployed.
- **Background jobs** — the endpoint introspects, and after syncing, the provider reports the app with a function count equal to the number in the code.
- **Agent access** — the discovery document resolves and names the **production** domain exactly, an unauthenticated call is rejected with a pointer to it, and the audience matches character for character.
- **Email** — the DNS records resolve from outside, and the provider reports the domain verified.

### 9 — Names present in production

```bash
npx --yes vercel@latest env ls production
```

Compare against the manifest **as a set of names**, and report it that way. Sensitive values cannot be read back; a name existing is the strongest true statement available.

## Use a browser if there is one

The parent skill's gate already takes this position, and it matters more against production. A real sign-in on the live domain is the single check that proves the URL, the database and the session cookie are correct *together*, and no status code substitutes for it.

If browser automation is available: load the front page and the main page, sign in as the user, capture what renders, and read the console. If not, this is `not attempted` — and named.

## What a command cannot prove

Name every one of these. Do not omit them, and do not imply them:

- Sign-in with Google or GitHub actually completing.
- A real payment. It should not be attempted.
- An email arriving in somebody's inbox. A provider accepting a send proves the provider accepted it, and nothing about spam placement.
- An upload going to the store and rendering afterwards. Unauthenticated, the most that is free is that the endpoint refuses.
- The consent screen, and a real agent connecting.
- Anything visual — the landing page, dark mode, a phone-width viewport.
- Whether the app *does what the sheet said*. That is what the critics are for.

## Fresh eyes

**Dispatch the critics in a single message so they run at once.** Read-only. They read evidence — the sheet, the ledger, the captured output, the transcript — and never run anything.

Two rules carry over from the parent skill and are load-bearing: critics get **evidence, not access**, and critics do not get the reference files. Where a critic needs a rule, quote it inside the brief.

| Lens | Covers |
| --- | --- |
| Sheet against reality | everything promised exists; nothing exists that wasn't promised, especially if it costs money |
| Claim against evidence | every sentence asserting a result traces to a status code, a log line, or a name |
| Secret exposure | anything in git, in a public variable, in the build log, in the served page, or in the transcript |
| Left behind | orphaned resources, duplicate webhooks, settings changed and not restored |

### What every critic is told

> You are reviewing a deployment you did not perform, for someone who cannot read code. You have the deploy sheet they approved, the ledger of what was created, and the transcript of the checks that were run. You do not have access to anything and must not run commands.
>
> **The deploy sheet is the only bar.** Not what a mature production setup would have — no monitoring, no alerting, no CDN tuning, no staging environment, unless the sheet named it.
>
> **Every finding names the promise it breaks** — a line of the sheet, a rule quoted in your brief, or a claim in the transcript. If you cannot name one, you have an opinion. Drop it.
>
> **Never in scope:** tests, CI beyond what was set up, performance, SEO, accessibility, rate limiting, cost optimisation, refactors, or any sentence beginning "consider adding".
>
> **At most five findings, most serious first.** If the deploy keeps the sheet, say so in one line and stop.
>
> Each finding, exactly:
> **What** — one sentence.
> **Where** — the resource, the URL and what it answered, or `path:line`.
> **Which promise** — the sheet line, the ledger entry, or the transcript sentence.
> **How sure** — `saw it` if the evidence proves it, `suspect` if it reads that way.
> **Severity** — `broken` (live and wrong, or leaking), `missing` (promised, absent), `worth knowing`.

**The claim-against-evidence lens is the important one here**, and it is more checkable in a deploy than in a build: every claim should trace to a status code, a log line, or a name in a list. Give it the transcript and the captured output and ask it to find sentences the evidence does not support.

## What comes back

- **Only `broken` and `missing` enter the fix loop.** `worth knowing` goes to hand-off verbatim.
- **A `suspect` finding is re-checked with a command before it is fixed.**
- **No fix widens the gate**, and no fix changes what was agreed.
- **Re-run the affected checks after every round**, not just at the end.
- **Two rounds, then stop and report.** Round three is where an agent starts changing infrastructure it doesn't understand to make a report go away.
- **On what is live the critic wins; on why it was done that way the runner wins.** Where a finding can be settled by a command, run the command — it outranks both.

## Verify

- Every check was run and its output read, or is recorded as `blocked` or `not attempted` with a reason.
- No probe account exists in production, and the user's first account is still their own.
- Nothing was written to the production database by the gate.
- Every claim made to the user traces to captured evidence.
- The unperformed list is in the hand-off, not omitted.
