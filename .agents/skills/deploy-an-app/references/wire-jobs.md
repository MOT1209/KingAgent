# Background jobs in production

Last verified: 2026-08-11

**Purpose:** Move background work from the local development server to the real one, and prove the deployed app's functions are actually registered — not merely that an endpoint answers.

> **Hard rule: the development flag must never reach production.** It points the SDK at a local server *and turns off signature verification*. Shipping it means jobs silently never run and the endpoint accepts unsigned requests from anyone. Do not set it to `0` either — the SDK already defaults to cloud mode, and a variable that exists to be ignored is a variable someone will later set.
>
> If the provider's documentation and this file disagree on *how the pieces fit*, this file wins. On an endpoint, a key name, or a dashboard path, their docs win.

## The keys

Two, and both originate in the provider's dashboard: one for sending events, one for signing. They exist independently of this app, so they can be collected before anything is deployed.

**Two routes:**

- **The host's integration**, which sets both keys and re-syncs on every deploy. This is the one people otherwise forget, so prefer it where it is available.
- **By hand**, copying both keys into production and syncing after the first deploy. Fine, and it needs the sync step below.

## The origin, on a custom domain

If the app has a custom domain, the provider must be told to call *that* — otherwise it registers whatever deployment URL it saw and calls the wrong host, which fails in a way that looks like a key problem.

Set the serve-origin variable to the canonical URL from `project-and-url.md`.

## The sync, and why it is the one thing that waits

Syncing is the one action in the whole pipeline that needs a **live** endpoint, not just a known URL — the provider calls the deployed app back and reads its function list synchronously. So it runs after the deploy, and it is the only thing that does.

Where the integration is installed, it happens automatically on deploy. Otherwise trigger it:

```bash
curl -s -X POST "https://api.inngest.com/v2/apps/$APP_ID/syncs" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"url\": \"$PUBLIC_URL/api/inngest\"}"
```

The app identifier is the one declared in the app's own client file — read it from the code rather than guessing from the project name. They are frequently different, and a sync against the wrong identifier creates a second, empty app.

**Re-sync after any deploy that adds or changes a function**, which the integration does for free and the manual route does not.

## Deployment protection will look like a key problem

If the deployment is protected, the provider cannot reach the endpoint and the sync fails with an authentication error that reads exactly like a bad signing key. Hours have been lost to this.

Two honest options, and **never simply turn protection off without saying what becomes publicly reachable**: configure a bypass for the endpoint, or leave protection off for production if it was never wanted. If the skill cannot do either with the CLI it has, this is a named manual step on the sheet, not a surprise at gate time.

## The check that is worth more than a ping

The endpoint answering proves the route deployed. It does not prove the provider knows about any functions.

**After syncing, ask the provider what it registered and compare the count to the number of functions in the code.** That is a real end-to-end assertion: the endpoint was reachable, the signature verified, and the function list came back. A count of zero against an app with four functions is the exact failure this branch has, and nothing else catches it.

## Verify

- The development flag is absent from production. Confirm by name.
- Both keys are present in production.
- On a custom domain, the serve origin is set to the canonical URL.
- The sync ran **after** the deploy, against the identifier taken from the code.
- The provider reports the app with a function count matching the code.
- If protection blocked the sync, that was diagnosed as protection rather than reported as a key failure, and whatever was changed is in the ledger.
- Unperformed and named: a job actually running end to end, and a deliberate failure retrying. Both need triggering real work.
- At hand-off: the free tier counts each *step*, not each job, so a five-step function costs five.
