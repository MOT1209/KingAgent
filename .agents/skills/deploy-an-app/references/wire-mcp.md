# Agent access in production

Last verified: 2026-08-11

**Purpose:** Make the app usable by AI agents on its real domain, and prove it — this is the branch where a single wrong character produces a failure with no useful error message, and also the branch that is most completely checkable from outside.

> **Hard rule: the public URL is the entire go-live switch, and it must match character for character.** It does three jobs at once — the app's origin, the identity issuer, and the audience stamped into every token. A trailing slash, `http` instead of `https`, or the bare domain where the canonical form is the `www` one, and the sign-in flow completes perfectly, right up to the first tool call, which then fails on a mismatch that reports nothing useful.
>
> **Changing this value later invalidates every token already issued.** Users have to reconnect. Get it right once.
>
> If the library's or the protocol's documentation and this file disagree on *how the pieces fit*, this file wins. On a method, an option, or an endpoint path, their docs win — both move quickly.

## The one variable

The canonical production URL recorded in `project-and-url.md`. No trailing slash.

Four things must be character-identical, and the app was built so they come from one place: the audience the plugin stamps, the resource named in the discovery document, the audience checked when a token is verified, and the URL the user types into their agent. If they were hard-coded separately anywhere, that is the bug — fix the source, not the symptom.

Behind a proxy that rewrites the origin, the resource URL may need to be passed explicitly. On this host the forwarded headers are already correct.

## Why this branch is the most checkable

Everything above is provable from outside with no token, no browser and no account — which is unusual, and worth using fully.

**The discovery documents resolve and name production:**

```bash
curl -s "$URL/.well-known/oauth-protected-resource/mcp" | jq .
curl -s "$URL/.well-known/oauth-authorization-server" | jq .
```

Both `200`. Every URL inside them is the production domain, `https`, with no trailing slash and no development address left behind. This is where a copied local value shows up immediately.

**An unauthenticated call is refused, and points at the right place:**

```bash
curl -s -i -X POST "$URL/mcp" -H 'content-type: application/json' -d '{}' | head -20
```

`401`, with a header pointing back at the resource metadata — and that pointer must be the production URL. A `200` here is the serious finding: the endpoint is open.

**The method is constrained:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$URL/mcp"
```

A plain `GET` should be rejected rather than opening a stream, in a stateless setup.

Together these three prove the audience, the issuer and the guard, from outside, before anyone connects. That is a better production check than most branches ever get.

## Protection blocks agents too

If the deployment is protected, an agent gets the host's sign-in page rather than the app, and the failure looks like a broken connector. Same rule as the jobs branch: configure a bypass or leave protection off deliberately, and **never turn it off without saying in one sentence what becomes publicly reachable.**

## Hand it over properly

**Give the user the connector URL** — their domain and the endpoint path — and say where it goes in their agent. They will not find it on their own, and this is the single most valuable sentence in the hand-off for this branch.

Two more worth one line each:

- Every fresh connection that registers dynamically creates a client record. Fine for one person; worth pruning if the app becomes popular.
- The app has a page listing every agent with access and a button to cut it off. Show them where it is.

## Verify

- The public URL variable is the canonical production URL, `https`, no trailing slash, identical to the value the auth branch used.
- Both discovery documents return `200` and contain **no** development address.
- Every URL inside them is the production domain.
- An unauthenticated call returns `401` with a pointer to the production resource metadata — never `200`.
- The user has the connector URL and knows where it goes.
- Unperformed and named: an agent actually connecting, the consent screen, a tool call succeeding, and revocation stopping the next one. All need a real client.
