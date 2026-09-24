# Payments in production

Last verified: 2026-08-11

**Purpose:** Deploy an app that can take money, without taking any by accident.

> **Hard rule: test mode is the default, and going live is a separate, explicit confirmation.** This is the one carve-out from the skill's "one approval, then it runs" promise, and it is worth arguing for rather than assuming: this is the only step that can charge a real card, live prices cannot be deleted afterwards, and the go-ahead in Step 3 was given to a short summary. One deliberate exception is not a slippery slope; zero exceptions is an agent that can take money on a skimmed sentence.
>
> If the provider's documentation and this file disagree on *how the pieces fit*, this file wins. On an API shape, a product identifier, or a dashboard path, their docs win.

## Deploying in test mode

The normal case, and the recommended one. The app deploys with the sandbox keys it already has and a webhook registered against the production URL. Everything works; no real money moves.

**Say this three times**, because it is the thing users most often misunderstand about their own deployed app: on the sheet, at hand-off, and — if the app has a system page — visibly inside the app itself. A checkout that looks real and takes fake money is worse than one that is obviously disabled.

## The sandbox switch

Most providers here have a single value that decides which world the app is in. **It is present in the local `.env` set to sandbox, and copying it is correct in test mode and catastrophic in live mode.** It is on the denylist in `env.md` for exactly that reason: it is transformed deliberately, never copied by default.

## The webhook, and the one that bites

A webhook endpoint can be **registered against a URL that does not answer yet**, which is why this runs before the deploy rather than after.

**List before creating. Always.**

```bash
curl -s -u "$SECRET_KEY:" https://api.stripe.com/v1/webhook_endpoints
```

Providers will happily create a second endpoint on the same URL, and the result is the nastiest failure in this file: every event delivered twice, with the stored signing secret matching one delivery and failing the other. The symptoms are duplicated charges or duplicated records *plus* a stream of signature errors, and the two look like unrelated bugs.

Creating one returns the signing secret **once**:

```bash
curl -s https://api.stripe.com/v1/webhook_endpoints \
  -u "$SECRET_KEY:" \
  --data-urlencode "url=$PUBLIC_URL/api/auth/stripe/webhook" \
  -d "enabled_events[]=checkout.session.completed"
```

Capture it straight into the environment — it cannot be retrieved later:

```bash
printf '%s' "$WHSEC" | npx --yes vercel@latest env add STRIPE_WEBHOOK_SECRET production
```

Take the endpoint path from the app's own code. In this stack the payments plugin serves its own route, and the path differs by provider — guessing it registers a webhook against a URL that returns 404 forever.

**The local and deployed signing secrets are different.** The one from local forwarding is not the one production needs.

## Going live, if the user asks for it separately

Only after an explicit confirmation. In order:

1. Switch the provider out of sandbox.
2. **Recreate the products and prices in live mode.** Test and live catalogues are entirely separate — this surprises everyone, every time.
3. Swap the keys and the price identifiers in production.
4. Register the webhook against the real domain in live mode, listing first.

**Live prices cannot be deleted, only deactivated.** A wrong amount or currency is a permanent row in the user's account and a business event, not a bug. Read the values back to the user before creating them.

Also worth one sentence: the host's free tier generally forbids commercial use, so an app that genuinely takes money belongs on a paid plan. That is a cost line on the sheet, not a surprise later.

## What can be checked

**Post an unsigned body to the webhook route.** `400` is the pass — it means the route deployed and is verifying signatures. `200` means it accepts anything, `500` means it crashes, `404` means it never deployed. This is safe, cheap and real, and `gate.md` runs it.

**A real payment is not attempted, ever**, in either mode. Even a test-mode checkout needs a browser and a card form. Name it as unperformed and give the user the two-minute version to try themselves.

## Verify

- The app is in test mode unless the user separately and explicitly asked otherwise.
- The sandbox switch in production is the intended value, confirmed by name.
- Exactly **one** webhook endpoint exists for this URL — listed, not assumed.
- The webhook path matches what the app actually serves.
- The signing secret in production is the one the newly created endpoint returned, not the local forwarding one.
- Live branch only: products recreated in live mode, values read back to the user first, and the plan permits commercial use.
- Unperformed and named: any checkout completing, and the paid state appearing afterwards.
