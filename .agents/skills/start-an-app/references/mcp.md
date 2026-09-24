# Agent access (MCP)

Last verified: 2026-08-11

**Purpose:** Let AI agents — Claude, Claude Code, ChatGPT, Cursor, anything that speaks MCP — do the app's real work on behalf of a signed-in user. The app gains a second front door: the same actions, the same ownership rules, the same log, reached over an authenticated protocol instead of a browser.

> **Hard rule: every tool takes the user from the token and scopes every query to them. Never trust an id the model passed you.** A tool call arrives carrying the user's full authority, but the thing that *triggered* it may be text the user never wrote — a web page the agent read, an email it summarised, another tool's output. In the browser a person can only click what they already own; a tool argument is a string somebody else may have chosen. `logged()` below exists to make this mechanical rather than something to remember, and every tool goes through it.
>
> If Better Auth's or Anthropic's documentation and this file disagree on *how to structure this*, this file wins. If they disagree on a method name, an option, or an endpoint path, their docs win — update this file afterwards, because both of these move quickly.

**Read the `mcp-builder` and `better-auth-best-practices` skills before writing any of this.** Step 2a installed both. `mcp-builder` is Anthropic's own guidance on building an MCP server — server construction, tool design, what a tool description and its return value should look like — and it is the better authority on all of that than memory or a search result. `better-auth-best-practices` covers the OAuth side that this file hangs the authorisation flow off. The hard rule above still governs: whatever those skills say about tool shape, every tool here takes the user from the token and goes through `logged()`. A skill that shows a tool trusting an id in its arguments is showing a server that has no user to protect; this one does.

**Prerequisite: sign-in must exist.** Tools act as somebody, and the whole authorisation flow hangs off the auth config, so there is nowhere to put this otherwise. If the user asked for agent access but said no to accounts, set up `references/auth.md` first and explain it in a sentence ("an agent has to sign in as *you*, so the app knows whose data it's touching") rather than treating it as a blocker.

> **Almost every example online is wrong, in five specific ways.** This area churned hard and the search results have not caught up — Step 2's research is not optional here. (1) Better Auth's own `mcp()` plugin is **deprecated** in favour of the OAuth provider plugin used below; do not reach for it because a tutorial does — and it is not only a naming preference, the retired plugin also omits the `iss` parameter the current spec expects on an authorisation response. (2) The MCP TypeScript SDK **split in two**: `@modelcontextprotocol/server` and `@modelcontextprotocol/client` replace the single `@modelcontextprotocol/sdk`, and `mcp-handler` moved with it. Examples written against the old pairing use variadic `server.tool()`, pass a bare shape to `inputSchema` rather than a whole schema, read `extra.authInfo` instead of `ctx.http?.authInfo`, and set `basePath`, `maxDuration` or `redisUrl` options that no longer exist. (3) Better Auth's *own* MCP documentation page is still written against a retired adapter and will not compile. (4) Anything telling you to provision Redis is describing that old adapter. (5) Anything describing an `initialize` handshake, an `Mcp-Session-Id` header, a GET stream for server messages, or resumability via `Last-Event-ID` predates the stateless revision and is describing a protocol that no longer exists. If something here doesn't compile, check the current docs — never a blog post.

## What you're building

Three parts, and it helps to say them out loud to the user in this order:

1. **An authorisation server.** Already there — it's Better Auth. The plugin adds the OAuth endpoints an agent needs to ask permission.
2. **A resource server.** One route, `/mcp`, that checks the token and runs the tool.
3. **The tools.** The app's own verbs, the same ones the buttons call.

**There is no session.** MCP is a stateless request/response protocol: no handshake to complete, nothing held open, nothing remembered between calls. Every request arrives carrying its own protocol version and the identity of the client that sent it, and the route is a pure function of that request and the token on it. This is why nothing below provisions Redis, and why the endpoint needs no sticky routing — it scales behind an ordinary load balancer, or a serverless platform that never runs the same instance twice. `mcp-handler` answers older clients from the same handler as current ones, so this is not a compatibility decision anybody has to make.

The one place it shows up in your own code is the tools: **a tool cannot remember anything between calls.** If something has to survive from one call to the next — a paging cursor, the id of a half-finished draft — the server mints it and returns it, and the agent hands it back as an ordinary tool argument. It is never stashed server-side against a connection, because there is no connection to stash it against.

**The endpoint is `[domain]/mcp`, not `/api/mcp`.** Next.js puts route handlers under `src/app/api/` by convention and it is an easy habit to follow straight past this, but nothing in the App Router requires that segment — `src/app/mcp/route.ts` serves `/mcp` perfectly well. It matters because this URL is not an internal detail: it is a string a person types into Claude's connector dialog, reads out to somebody, or puts in a README. `traillog.com/mcp` is what the ecosystem has settled on and what people guess first. Every other API route in the app stays under `/api`; this one is public-facing, so it doesn't. Better Auth keeps its own `/api/auth` base path unchanged.

The agent never sees a password. It gets sent to the app's own sign-in page, the user approves it on a consent screen, and the agent walks away with a scoped token the user can revoke.

## Install

```bash
pnpm add better-auth @better-auth/oauth-provider
pnpm add mcp-handler @modelcontextprotocol/server zod
```

`zod` is listed because tool schemas are written with it directly and `mcp-handler` wants a whole schema object rather than a shape it assembles itself. It is a dependency of this app, not something to rely on inheriting through another package.

If `better-auth` is already installed from `references/auth.md`, upgrade it in the same command rather than leaving it behind — `@better-auth/oauth-provider` declares it as a peer dependency, and a version skew between the two fails later, at a confusing moment, rather than at install time.

Two reasons this file insists on the current release rather than whatever is already in the lockfile: the OAuth provider plugin is comparatively new and its surface is still settling, and the plugins it replaces carried a refresh-token replay flaw in older versions. This is security-relevant code. Do not build it on a stale install.

**Nothing new goes in `.env`.** `BETTER_AUTH_URL` now does three jobs — the app's origin, the OAuth issuer, and the audience stamped into every token — so in production it has to be the real public URL. Set it to anything else and the flow completes right up to the first tool call, then fails on an audience mismatch with no useful error. That one variable is the whole go-live switch.

## Configure

### One file for the strings that must agree

Four separate things have to be character-identical: the plugin's audience, the discovery document's `resource`, the audience checked at verify time, and the URL the user types into Claude. Put the strings in one place so they cannot drift.

`src/lib/mcp/resource.ts`:

```ts
const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export const ISSUER = `${BASE_URL}/api/auth`;
export const MCP_RESOURCE = `${BASE_URL}/mcp`;

// Two scopes, named after the app. Not one per table.
export const MCP_SCOPES = ["hikes:read", "hikes:write"] as const;
```

No trailing slash, ever — the spec prefers it absent and a stray one is a mismatch like any other. `ISSUER` includes `/api/auth`: Better Auth issues from its own base path, not from the bare origin, and pointing discovery at the origin is the most common way this fails silently.

Two scopes, not nine. A consent screen listing `hikes:read`, `hikes:write`, `photos:read`, `photos:write`… is a consent screen nobody reads, which defeats the point of having one.

### The OAuth provider

Extend `src/lib/auth.ts` — this adds a plugin alongside whatever is already there:

```ts
import { oauthProvider } from "@better-auth/oauth-provider";
import { MCP_RESOURCE, MCP_SCOPES } from "@/lib/mcp/resource";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  // ...existing config

  plugins: [
    // ...existing plugins
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/oauth/consent",

      // The fallback door for clients that can't identify themselves any other
      // way — see "How the agent gets a client id" below before changing these.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,

      validAudiences: [MCP_RESOURCE],
      scopes: ["openid", "profile", "email", "offline_access", ...MCP_SCOPES],
      clientRegistrationDefaultScopes: ["openid", "profile", "email"],
      clientRegistrationAllowedScopes: ["offline_access", ...MCP_SCOPES],

      accessTokenExpiresIn: "1h",
      refreshTokenExpiresIn: "30d",
    }),
  ],

  rateLimit: {
    enabled: true,
    storage: "database",
    customRules: {
      // `references/settings.md` adds its own rules to this object later.
      "/oauth2/register": { window: 60, max: 5 },
      "/oauth2/token": { window: 60, max: 30 },
    },
  },
});
```

This app is the authorisation server, so one requirement lands on it directly: **the authorisation response has to carry the `iss` parameter**, naming the issuer, and clients are expected to check it against the issuer they started with before redeeming the code. `@better-auth/oauth-provider` emits it. The `mcp()` and `oidcProvider()` plugins it replaces do not, which is the concrete version of the warning at the top of this file about reaching for the wrong plugin.

### How the agent gets a client id

An agent that has never met this app needs a `client_id` before it can ask for anything. There are two mechanisms, and knowing which is which is what keeps the two options above from looking arbitrary.

**Client ID Metadata Documents are what the spec now prefers.** The client's `client_id` *is* an HTTPS URL, and that URL serves a small JSON document describing the client — its name, its redirect URIs. The authorisation server fetches it, checks the document's own `client_id` matches the URL it came from, and validates the redirect URI against it. Nothing is registered, so there is no anonymous write endpoint and no row created per connection.

**Dynamic registration is the older mechanism and is now deprecated**, though it stays in the spec through a deprecation window. It is what those two `allow*` options above enable: the agent POSTs its details and gets a `client_id` back.

Support both, and do not be tempted to turn dynamic registration off early. **The client picks**, working down from credentials it already has, to metadata documents if this server advertises them, to dynamic registration if it doesn't — so a server that drops the last rung strands every agent that hasn't moved up yet.

For the metadata-document half, Better Auth ships `@better-auth/cimd`, which plugs into the `clientDiscovery` extension point on `oauthProvider` and adds `client_id_metadata_document_supported` to the discovery document by itself. Step 2's research establishes whether the release you are installing has it; if it does, add it, and leave the dynamic-registration options in place beside it.

`allowUnauthenticatedClientRegistration` sounds alarming and is required for the fallback to work at all: the agent registers *before* anybody has signed in, because signing in is what it is about to ask for. Registration creates a client record, not access — nothing can be read until a human approves it on the consent screen. The rate limit is there because registration is the one endpoint an anonymous caller can reach, and each fresh connection makes a new client row.

One more thing the spec now asks of clients, worth knowing because it is where sign-in from a terminal breaks: a client registering dynamically must declare an `application_type`, and command-line and desktop tools declare `native` so that loopback redirect URIs are accepted. Omitting it means `web`, under which a `localhost` redirect can be rejected outright.

The plugin changes the schema, and so does adding client discovery beside it — settle both before running this, so it is one migration rather than two:

```bash
pnpm dlx @better-auth/cli@latest generate --config src/lib/auth.ts --output src/lib/db/auth-schema.ts -y
pnpm db:generate
pnpm db:migrate
```

### Discovery

An agent finds all of this by fetching two well-known documents from the **domain root**. These need their own route handlers — the `/api/auth/[...all]` catch-all does not serve anything outside its own path, and expecting it to is a half-hour of confusion.

`src/app/.well-known/oauth-authorization-server/route.ts`:

```ts
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { auth } from "@/lib/auth";

export const GET = oauthProviderAuthServerMetadata(auth, {
  headers: { "Access-Control-Allow-Origin": "*" },
});
```

The second document describes the *resource*, and Better Auth has historically not served it — an authorisation server generally doesn't know what it is protecting. **Check what the installed version does before writing this by hand**; serving it natively is on the plugin's roadmap, and if it has landed, use that instead of the routes below. If it hasn't, write it once and mount it twice, because Claude probes the path-suffixed form first and the bare form second.

`src/lib/mcp/protected-resource.ts`:

```ts
import { createAuthClient } from "better-auth/client";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { auth } from "@/lib/auth";
import { ISSUER, MCP_RESOURCE, MCP_SCOPES } from "./resource";

const client = createAuthClient({ plugins: [oauthProviderResourceClient(auth)] });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function GET() {
  const metadata = await client.getProtectedResourceMetadata({
    resource: MCP_RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
  });

  return Response.json(metadata, {
    headers: { ...cors, "Cache-Control": "public, max-age=15, stale-while-revalidate=15" },
  });
}

export const OPTIONS = () => new Response(null, { headers: cors });
```

Then two one-line routes, both re-exporting it:

```ts
// src/app/.well-known/oauth-protected-resource/mcp/route.ts
// and src/app/.well-known/oauth-protected-resource/route.ts
export { GET, OPTIONS } from "@/lib/mcp/protected-resource";
```

The suffixed path mirrors the endpoint's own path, so it is `/mcp` here rather than `/api/mcp` — RFC 9728 inserts the resource's path after the well-known segment, and a document served at the wrong suffix is a document Claude does not find.

`authorization_servers` takes exactly one entry and Claude uses only the first — it does not try the others. `scopes_supported` here lists the app's two scopes and deliberately leaves out `offline_access`: that belongs to the authorisation server, and Claude adds it by itself when it wants a refresh token.

Leave a comment on `protected-resource.ts` saying it exists only until Better Auth serves this document itself, and that it should be deleted then. Without the comment it is still here in two years, quietly shadowing the built-in.

### Verifying a token

`src/lib/mcp/verify.ts`:

```ts
import "server-only";
import { createAuthClient } from "better-auth/client";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { auth } from "@/lib/auth";
import { ISSUER, MCP_RESOURCE } from "./resource";

const client = createAuthClient({ plugins: [oauthProviderResourceClient(auth)] });

export async function verifyBearer(token: string) {
  const payload = await client.verifyAccessToken(token, {
    verifyOptions: { issuer: ISSUER, audience: MCP_RESOURCE },
  });

  return {
    userId: String(payload.sub),
    clientId: String(payload.client_id ?? payload.azp ?? ""),
    scopes: String(payload.scope ?? "").split(" ").filter(Boolean),
    expiresAt: payload.exp,
  };
}
```

Log one decoded payload to the terminal the first time this runs and check the field names against what you actually got before moving on. The shape is stable but it is the one thing here worth confirming with your own eyes, and a wrong field name gives you `undefined` as a user id rather than an error.

### The endpoint

`src/app/mcp/route.ts` — note the path, per the rule above:

```ts
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { registerTools } from "@/lib/mcp/tools";
import { verifyBearer } from "@/lib/mcp/verify";

export const runtime = "nodejs";

const mcp = createMcpHandler(registerTools, {
  serverInfo: { name: "traillog", version: "1.0.0" },
});

const handler = withMcpAuth(
  mcp,
  async (_req, bearerToken) => {
    if (!bearerToken) return undefined;
    try {
      const { userId, clientId, scopes, expiresAt } = await verifyBearer(bearerToken);
      return { token: bearerToken, clientId, scopes, expiresAt, extra: { userId } };
    } catch {
      return undefined; // -> 401 with the challenge header
    }
  },
  {
    required: true,
    requiredScopes: ["hikes:read"],
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
  },
);

export { handler as POST };
```

**POST only.** Older versions of this route exported `GET` for a standing message stream and `DELETE` to tear a session down; both went when sessions did, and even a long-lived notification stream is now the response to a POST. Leaving them exported would route them into a handler that refuses them anyway. Not exporting them means Next.js answers `405 Method Not Allowed`, which is exactly what the spec asks a current server to say to a client still trying the old shapes.

Do not give this route the permissive CORS headers the two discovery documents get. Those are public metadata and are meant to be readable from anywhere; this is the route that carries the token. A server is required to check the `Origin` header when one is present and refuse a request that doesn't belong, and a blanket `Access-Control-Allow-Origin: *` copied down from the well-known routes quietly removes that.

**`required: true` is not optional, despite the name.** It defaults to `false`, and with the default a request carrying no token runs the tools anyway. Nothing looks broken — the app serves unauthenticated traffic, Claude never receives a 401, and so it never starts the sign-in flow at all. This is the single most expensive line to leave out.

Returning `undefined` is what produces the 401. Do not catch the failure and return a friendly error object instead: a `200` carrying `isError: true` is an ordinary tool failure, so Claude hands the text to the model and moves on. Only a real 401 makes it stop and ask the user to sign in.

## The tools

### They call the same code the buttons call

Put the app's reads and writes in `src/lib/<domain>.ts` — `listHikes({ userId, limit })`, `createHike({ userId, ... })` — and have both the server actions and the tools call those. A tool that writes its own query is a tool whose ownership check drifts from the one the UI enforces, and nobody notices until the drift is a leak. One function, two callers, one `where`.

### The wrapper that enforces the hard rule

`src/lib/mcp/log.ts` — every tool goes through this, which is what makes "take the user from the token" structural instead of a thing to remember:

```ts
import "server-only";
import { db } from "@/lib/db";
import { mcpCallLog } from "@/lib/db/schema";

type Ctx = {
  http?: { authInfo?: { clientId?: string; scopes?: string[]; extra?: { userId?: string } } };
};

export function logged<A>(
  tool: string,
  scope: string,
  run: (args: A, userId: string) => Promise<unknown>,
) {
  return async (args: A, ctx: Ctx) => {
    const userId = ctx.http?.authInfo?.extra?.userId;
    if (!userId) throw new Error("No user on this token");
    if (!ctx.http?.authInfo?.scopes?.includes(scope)) {
      throw new Error(`This connection was not granted ${scope}`);
    }

    const clientId = ctx.http?.authInfo?.clientId ?? null;
    const startedAt = Date.now();

    try {
      const result = await run(args, userId);
      await db.insert(mcpCallLog).values({
        tool,
        userId,
        clientId,
        ok: true,
        durationMs: Date.now() - startedAt,
        rowCount: Array.isArray(result) ? result.length : null,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error) {
      await db.insert(mcpCallLog).values({
        tool,
        userId,
        clientId,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
```

The table goes in `src/lib/db/schema.ts` alongside the app's own — Postgres branch shown, SQLite uses `text` ids and `integer` timestamps per `references/database.md`:

```ts
export const mcpCallLog = pgTable("mcp_call_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  clientId: text("client_id"),
  tool: text("tool").notNull(),
  ok: boolean("ok").notNull(),
  durationMs: integer("duration_ms"),
  rowCount: integer("row_count"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

`pnpm db:generate` then `pnpm db:migrate` — this one is the app's own table, so it does not need the Better Auth CLI.

`onDelete: "set null"` rather than `cascade`, for the same reason `references/ops.md` gives: the record of what an agent did outlives the account it did it to.

**This log records reads as well as writes**, which is the one place this skill departs from `references/ops.md`'s "log writes, not reads". When the caller is a person, a read is noise. When the caller is an agent, a read *is* the event worth seeing — it is how data leaves the app. Tools that write should additionally call the existing `logActivity()` with `{ via: "mcp" }` in the detail, so the ordinary activity log keeps telling the truth about who changed what.

### Writing a tool

```ts
// src/lib/mcp/tools.ts
import "server-only";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { listHikes, createHike } from "@/lib/hikes";
import { logged } from "./log";

export function registerTools(server: McpServer) {
  server.registerTool(
    "list_hikes",
    {
      title: "List hikes",
      description:
        "List the signed-in person's hikes, newest first. Use to answer questions about what they have walked, or to find a hike before changing it.",
      inputSchema: z.object({
        since: z.string().optional().describe("Only hikes on or after this date (YYYY-MM-DD)."),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    logged("list_hikes", "hikes:read", ({ since, limit }, userId) =>
      listHikes({ userId, since, limit }),
    ),
  );

  server.registerTool(
    "log_hike",
    {
      title: "Log a hike",
      description: "Record a hike the person has been on. Ask them for the trail and date if either is missing.",
      inputSchema: z.object({
        trail: z.string().min(1).max(200),
        date: z.string().describe("YYYY-MM-DD"),
        distanceKm: z.number().positive().optional(),
        notes: z.string().max(2000).optional(),
      }),
      annotations: { destructiveHint: false },
    },
    logged("log_hike", "hikes:write", (input, userId) => createHike({ userId, ...input })),
  );
}
```

`inputSchema` takes a whole `z.object({...})`, not a bare shape, and the registration function is `registerTool` — `server.tool()` is from the retired adapter. Both are things half the examples online still get wrong.

**The scope argument is per-tool for a reason.** `requiredScopes` on the handler decides who may *connect*; it cannot decide who may write, because it sees the same value for every call. Without the check inside `logged()`, a connection the user approved for reading only can call every write tool in the app, and the consent screen they read becomes a lie.

### The rules that make tools good rather than merely present

- **Task-shaped, not table-shaped.** Name them after what a person would ask for — `log_hike`, `weekly_summary` — not `create_row` or `query_table`. A mechanical CRUD-per-table mapping technically works and produces a tool list an agent uses badly, because no single tool matches anything anyone actually wants.
- **Reads and writes are separate tools.** Never one tool with a `method` or `action` argument. Anthropic rejects catch-all tools outright in connector review, and it makes the next rule impossible.
- **Every tool declares `readOnlyHint: true` or `destructiveHint`.** These drive whether Claude runs a tool without asking. Label a write as read-only and it will fire without confirmation.
- **The description says what it does and when to use it.** It does not contain instructions aimed at the model, and it does not oversell — a description that claims more than the tool does is how an agent picks the wrong one.
- **A tool that is missing something says so in its description and lets the model ask.** `log_hike` above does this — "Ask them for the trail and date if either is missing" — and for an app like this it is the whole answer. Do not reach for sampling, roots, or logging to get it instead: all three are deprecated. The protocol's own route for a server that needs more input is to return an `input_required` result the client retries, and it is rarely worth the machinery here.
- **Every list tool takes a `limit` with a hard maximum.** Results are capped near 150,000 characters on Claude.ai and around 25,000 tokens in Claude Code. An uncapped list either truncates mid-JSON into something unparseable, or hands a single call the entire account. Cap it in the schema *and* in the query, and return a cursor if there is more.
- **Destructive tools need a reason to exist.** Deleting is nearly always better done by the person, in the app. If the interview genuinely called for it, require an id the agent had to read first, mark it `destructiveHint: true`, and say so in the description.
- **Names stay under 64 characters** and read as `verb_noun`.

Pick the four or five tools that cover what the user said the app is *for* in Step 1a. A short list of tools that match real intentions beats a complete list that mirrors the schema.

## What the user can see and control

An agent working out of sight is exactly the thing this skill says an app must never have. Three pieces, and none of them is optional.

### The consent screen

`src/app/oauth/consent/page.tsx`, styled like the rest of the app — this is where somebody decides whether Claude gets their data, and a page that looks nothing like the app they just signed into reads as a phishing attempt.

Read the pending request through the plugin's client (`oauthProviderClient` on `authClient`, backed by `/api/auth/oauth2/get-consent`), then show:

- **Who is asking**, by the client name it registered with, and a plain warning that this name is chosen by whoever is connecting.
- **What it will be able to do**, in the app's own words. "Read your hikes" and "Add and edit hikes" — never the raw scope strings.
- **Whose account it will act as** — their email, visible, so a signed-in-as-the-wrong-person mistake is caught here.
- Two buttons of equal weight. Approve is not the primary-coloured one.

Accepting posts to `/api/auth/oauth2/consent`. Do not auto-approve, and do not skip the screen for "trusted" clients — a client's name is chosen by the client, whether it registered dynamically or handed over a metadata document it hosts itself, so anything can call itself anything.

### Connected apps

`references/settings.md` builds this section: what has access, what it can do, when it was granted, and a Revoke button. Revoking has to stop the *next* tool call, not just remove a row from a list.

### The call log

`references/ops.md` renders `mcp_call_log` on `/settings/system`: which tool, which client, worked or failed, how long, how many rows went out. This is the panel that answers "what did Claude actually do?" and "why did it say it couldn't find anything?"

## Testing locally

**Claude Code talks to localhost.** No tunnel, no deploy — the whole flow works the moment the routes exist:

```bash
claude mcp add --transport http traillog http://localhost:3000/mcp
```

Then `/mcp` inside Claude Code to run the sign-in. The browser opens the app's own sign-in page, then the consent screen, and the tools appear. This is the loop to iterate in.

For tool shapes and schemas without the auth round trip, `pnpm dlx @modelcontextprotocol/inspector` against the same URL.

**Claude.ai and Claude Desktop cannot reach localhost** — they connect from Anthropic's servers, not from the user's machine. To test as a real connector, tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Set `BETTER_AUTH_URL` to the tunnel's public URL and restart the dev server, or every token comes out stamped with the wrong audience. Then add the tunnel URL plus `/mcp` under **Settings → Connectors → Add custom connector** on claude.ai.

If discovery fails, check it by hand before guessing — these three must line up exactly:

```bash
curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp | jq
curl -s http://localhost:3000/.well-known/oauth-authorization-server | jq
curl -si -X POST http://localhost:3000/mcp | head -20
```

The third must be a `401` carrying a `WWW-Authenticate: Bearer ... resource_metadata="..."` header. A `200` means `required: true` is missing.

That third command deliberately sends nothing but the method — it is asking "is auth wired?", and the answer arrives before the request body is ever looked at. It is **not** a test of whether the endpoint speaks MCP, and it can't be: a real call carries an `MCP-Protocol-Version` header and an `Mcp-Method` header naming the RPC, plus an `Mcp-Name` header when the method is one that names a thing (`tools/call`, `resources/read`, `prompts/get`). Headers that disagree with the body are rejected with a `400`. To check the protocol itself, send `server/discover` — the request that replaced the old handshake, needs no session, and lists what the server supports:

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Mcp-Method: server/discover' \
  -H "MCP-Protocol-Version: $VERSION" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"server/discover\",\"params\":{\"_meta\":{\"io.modelcontextprotocol/protocolVersion\":\"$VERSION\"}}}" | jq
```

`$VERSION` is the revision the installed SDK implements and has to be identical in the header and in `_meta` — take it from the SDK rather than typing one in, because a guess fails as a mismatch rather than as a version error. Getting a token out of the flow by hand is more trouble than it is worth; the practical way to run this is to copy one from a connection Claude Code has already made.

If sign-in from Claude Code fails at the redirect step, the cause is almost always redirect matching: it listens on a fresh ephemeral port each time and registers a loopback callback, and a client registering dynamically has to declare `application_type: "native"` for a `localhost` redirect to be accepted at all — the default is `web`, under which it can be refused. Check that the client sent it and that the plugin's redirect matching is port-agnostic, rather than working around it by widening what the app accepts.

## Going to production

- `BETTER_AUTH_URL` becomes the real public URL on the host. That is the entire change; everything else derives from it.
- Give the user the connector URL — their domain plus `/mcp`, so `https://traillog.com/mcp` — and show them where it goes in Claude. They will not find it on their own.
- If the host sits behind a proxy that rewrites the origin, pass `resourceUrl` to `withMcpAuth` explicitly. On Vercel the forwarded headers are already right.
- Dynamic registration creates a client row per fresh connection. Fine for one person; if the app gets popular, mention that old unused clients are worth pruning. Clients that identify themselves with a metadata document instead don't create rows at all, so this shrinks as the ecosystem moves across.
- Two things remove code from this file when they are available on the release you install. Serving the protected-resource document natively is still on Better Auth's roadmap; client metadata documents have already landed, as `@better-auth/cimd`, and are the deprecated dynamic-registration path's replacement. Both change the schema — so take them deliberately, not by accident during an unrelated upgrade.

## Harnesses that can't do OAuth

Some automation tools — n8n, a self-hosted script, a home-grown harness — only send a static header. The temptation is to add a personal access token, and it is worth saying plainly what that costs: a long-lived credential that grants everything the user can do, that lives in another system's settings screen, that never expires, and that is the one people paste into a chat message. Every agent that matters here — Claude, Claude Code, ChatGPT, Cursor — does OAuth properly.

Don't build it unless the user asks for it specifically and understands that. If they do, four rules keep it survivable: issue it from `/settings` so it is visible where access is managed; verify it in the same function that verifies OAuth tokens so the tool layer never learns there are two kinds of caller; give it the same two scopes, not a bypass; and list it in Connected apps with a revoke button beside the others.

## Verify

- The endpoint answers at `/mcp` — `src/app/mcp/route.ts` — and there is no `src/app/api/mcp/` directory left behind.
- An unauthenticated `POST /mcp` returns `401` with a `WWW-Authenticate` header containing `resource_metadata`, not a `200`.
- `GET /mcp` and `DELETE /mcp` return `405` — the route exports `POST` and nothing else.
- The authorisation server document advertises whichever registration mechanisms are actually wired: `registration_endpoint` for dynamic registration, and `client_id_metadata_document_supported` as well if `@better-auth/cimd` was available and added.
- The redirect back from the consent screen carries an `iss` parameter matching the issuer in the authorisation server document.
- Both `.well-known` documents return JSON, and two pairs match character for character: the protected-resource document's `resource` against `validAudiences[0]` in `src/lib/auth.ts`, and its `authorization_servers[0]` against the `issuer` in the authorisation-server document. No trailing slash on either.
- `offline_access` appears in the authorisation server document and does not appear in the protected-resource document.
- Adding the server in Claude Code opens the app's own sign-in page, then a consent screen wearing the app's design, and the tools appear afterwards.
- A read tool returns only the signed-in user's rows, and asking for more than the schema's maximum is rejected rather than clamped silently.
- **Second account test:** signed in as a different user, ask the agent for the first account's record by its id. It fails server-side — an empty result is not good enough, because that means the query ran.
- A write tool creates a real row that shows up in the app's own UI on refresh, and the activity log records it as the app's verb with `via: "mcp"`.
- Approving read access only, then asking the agent to write, is refused by the tool — not merely absent from the consent screen.
- `/settings/system` lists the calls that were just made, including the reads, with the tool name and the client.
- Revoking the connection in Connected apps makes the very next tool call fail, without restarting the server.
- Every tool has a `title`, a `readOnlyHint` or `destructiveHint`, and a description that names a real reason to call it — no `create_row`, no catch-all with a `method` argument.
- With `BETTER_AUTH_URL` absent the app still starts, and the system page reports the MCP endpoint as not configured rather than crashing.
