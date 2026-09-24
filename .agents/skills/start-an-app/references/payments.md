# Payments (Polar or Stripe)

Last verified: 2026-07-27

**Purpose:** Take money — a subscription or a one-off purchase — and know which users have paid.

> **Hard rule: payments go through the Better Auth plugin. Always.** Better Auth ships first-class plugins for both providers (`@polar-sh/better-auth`, `@better-auth/stripe`), and this stack uses them without exception. Do **not** install the standalone provider SDK and wire checkout, customer creation, or webhooks by hand — not "just for a quick one-off payment", not because a provider's own quickstart shows the standalone route. Going around Better Auth means a second source of truth for who the customer is, a hand-rolled webhook route with hand-rolled signature verification, and a customer id that has to be reconciled with the session forever. The plugin does all of it and keeps "who is signed in" and "what have they paid for" as one object.
>
> If a provider's documentation and this file disagree on *how to integrate*, this file wins. If they disagree on a product ID, dashboard path, or API detail, the provider's docs win — update this file afterwards. For the Better Auth half — how the plugin is registered and what it adds to the session — the `better-auth-best-practices` skill installed in Step 2a is the authority; the provider's own docs cover only their side.

**Prerequisite: sign-in must exist.** A payment has to attach to somebody, and the plugin lives inside the auth config, so there is nowhere to put it otherwise. If the user asked for payments but said no to accounts, go back and set up `references/auth.md` first — explain it in one sentence ("we need accounts so the app knows *whose* subscription it is") rather than treating it as a blocker.

Follow exactly one branch: **Polar** (recommended) or **Stripe**.

> Which to recommend, in plain words: Polar is the *merchant of record* — they sell to your customer, so sales tax and VAT in every country are their legal problem, not the user's. That is the single biggest hidden cost of selling software internationally, and it is why Polar is the default here. Stripe leaves the user as the seller: more control, lower fees at scale, more paperwork. Recommend Polar; if the user already has a Stripe account or needs Stripe-specific features, take the Stripe branch without argument.

Everything below is **test/sandbox mode**. Nobody is charged. Say that out loud — users get nervous when a card form appears.

---

## Polar branch (recommended)

### Install

```bash
pnpm add @polar-sh/better-auth @polar-sh/sdk
```

### Set up the Polar account

Walk the user through it, one step at a time:

1. Open https://sandbox.polar.sh and sign up — this is the sandbox, entirely separate from real money.
2. Create an organization (the app's name is fine).
3. **Products → New Product.** Name it after what they're actually selling ("Pro", "Lifetime"), set a price, save. Copy the **product ID**.
4. **Settings → Developers → New Token.** Copy the token — it is shown once.
5. **Settings → Webhooks → Add Endpoint**, URL `https://<their-domain>/api/auth/polar/webhooks`, format **Raw**. Copy the signing secret. (Until the app is deployed there's no public URL for this — see *Testing webhooks locally* below.)

Append to `.env`:

```
POLAR_ACCESS_TOKEN=<from step 4>
POLAR_WEBHOOK_SECRET=<from step 5>
POLAR_SERVER=sandbox
POLAR_PRODUCT_ID=<from step 3>
```

`POLAR_SERVER` becomes `production` on launch day — that one word is the whole go-live switch.

### Configure

Extend `src/lib/auth.ts` — this replaces nothing, it adds a plugin alongside the existing config:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { polar, checkout, portal, webhooks } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import { db } from "@/lib/db";

const polarClient = new Polar({
  accessToken: process.env.POLAR_ACCESS_TOKEN!,
  server: process.env.POLAR_SERVER === "production" ? "production" : "sandbox",
});

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite" }), // or "pg"
  emailAndPassword: { enabled: true },
  plugins: [
    polar({
      client: polarClient,
      createCustomerOnSignUp: true,
      use: [
        checkout({
          products: [{ productId: process.env.POLAR_PRODUCT_ID!, slug: "pro" }],
          successUrl: "/thanks?checkout_id={CHECKOUT_ID}",
          authenticatedUsersOnly: true,
        }),
        portal(),
        webhooks({
          secret: process.env.POLAR_WEBHOOK_SECRET!,
          onOrderPaid: async (payload) => {
            // Mark the customer as paid in the app's own database.
          },
          onCustomerStateChanged: async (payload) => {
            // Fires on every subscription change — the reliable source of truth.
          },
        }),
      ],
    }),
  ],
});
```

`createCustomerOnSignUp: true` means every new account gets a Polar customer automatically, so there is never a "customer not found" branch to write.

Client plugin in `src/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";
import { polarClient } from "@polar-sh/better-auth/client";

export const authClient = createAuthClient({ plugins: [polarClient()] });
export const { signIn, signUp, signOut, useSession, checkout, customer } = authClient;
```

Adding the plugin can add columns and tables, so regenerate the schema and migrate:

```bash
pnpm dlx @better-auth/cli@latest generate --config src/lib/auth.ts --output src/lib/db/auth-schema.ts -y
pnpm db:generate
pnpm db:migrate
```

Wire up two buttons:

- **Upgrade** → `authClient.checkout({ slug: "pro" })`
- **Manage billing** → `authClient.customer.portal()` (Polar hosts the cancel/invoice/payment-method screens, so there is nothing to build)

### Testing webhooks locally

Polar can only call a public URL, so on `localhost` webhooks stay silent — checkout itself still works end to end. Either deploy first and test webhooks there, or expose the dev server with a tunnel (`pnpm dlx untun@latest tunnel http://localhost:3000`, or ngrok) and use that URL as the webhook endpoint. Say which one you did.

Sandbox test card: `4242 4242 4242 4242`, any future expiry, any CVC.

---

## Stripe branch

### Install

```bash
pnpm add @better-auth/stripe stripe
```

### Set up the Stripe account

1. Open https://dashboard.stripe.com and make sure the **Test mode** toggle is on.
2. **Product catalogue → Add product.** Name and price it, save, copy the **price ID** (`price_...`, not the product ID).
3. **Developers → API keys.** Copy the **secret key** (`sk_test_...`).
4. Get a webhook secret by running the Stripe CLI (below) — it prints one.

Append to `.env`:

```
STRIPE_SECRET_KEY=sk_test_<from step 3>
STRIPE_WEBHOOK_SECRET=whsec_<from the CLI>
STRIPE_PRICE_ID=price_<from step 2>
```

### Configure

Extend `src/lib/auth.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { db } from "@/lib/db";

const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite" }), // or "pg"
  emailAndPassword: { enabled: true },
  plugins: [
    stripe({
      stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: [{ name: "pro", priceId: process.env.STRIPE_PRICE_ID! }],
      },
    }),
  ],
});
```

If TypeScript complains about a missing or mismatched `apiVersion`, pass the exact version string the installed `stripe` package's types name — don't guess one.

Client plugin in `src/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";
import { stripeClient } from "@better-auth/stripe/client";

export const authClient = createAuthClient({
  plugins: [stripeClient({ subscription: true })],
});
export const { signIn, signUp, signOut, useSession, subscription } = authClient;
```

Regenerate the schema — this plugin definitely adds a `subscription` table and a customer id on `user`:

```bash
pnpm dlx @better-auth/cli@latest generate --config src/lib/auth.ts --output src/lib/db/auth-schema.ts -y
pnpm db:generate
pnpm db:migrate
```

Better Auth's own docs mention `npx auth migrate` — that is for its built-in Kysely adapter. This stack is Drizzle, so migrations always go through `db:generate` + `db:migrate`.

Wire up the upgrade button:

```ts
await authClient.subscription.upgrade({
  plan: "pro",
  successUrl: "/thanks",
  cancelUrl: "/pricing",
});
```

The plugin serves its own webhook at `/api/auth/stripe/webhook` — do not write a webhook route by hand.

### Testing webhooks locally

Install the Stripe CLI, then in a second terminal:

```bash
stripe login
stripe listen --forward-to localhost:3000/api/auth/stripe/webhook
```

It prints a `whsec_...` — that is `STRIPE_WEBHOOK_SECRET` for local development. The deployed app needs a *different* secret, created under **Developers → Webhooks** with the real URL.

Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

---

## Both branches — gating the app

Paying for something has to change something. Read the session server-side and gate the feature the user actually named in the interview:

- Read subscription state on the server (Better Auth session / the plugin's subscription list), never from a client-side flag a user can flip in devtools.
- Show a real upgrade prompt on the gated page, not a blank screen.
- Keep the free tier usable — the app should still make sense to someone who never pays.

## Going to production

At hand-off, tell the user the go-live steps in order: switch the provider out of sandbox/test mode, create the product again in live mode (test and live catalogues are separate — this surprises everyone), swap the keys in the host's environment variables, and register the webhook against the real domain.

## Verify

- A signed-in user clicks Upgrade and reaches the provider's hosted checkout with the right product and price.
- Paying with the test card returns to `successUrl` inside the app.
- The paid state is visible on the server after checkout (a gated page unlocks, or the subscription shows in `pnpm db:studio`).
- The billing portal opens for a paying user.
- With payment env vars missing, the app still starts and the upgrade button shows a friendly "billing isn't configured yet" notice instead of crashing.
