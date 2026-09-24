# Database (Drizzle ORM)

Last verified: 2026-07-21

**Purpose:** Store the app's data. Drizzle is the ORM in both branches; only the driver and connection differ. Follow exactly one branch: **SQLite** (local/prototype, zero setup, data lives in a file in the project) or **Postgres** (production-ready, runs in Docker locally and points at a hosted database in production via the same environment variable).

## Install

Both branches:

```bash
pnpm add drizzle-orm
pnpm add -D drizzle-kit
```

**SQLite branch:**

```bash
pnpm add better-sqlite3
pnpm add -D @types/better-sqlite3
```

**Postgres branch:**

```bash
pnpm add pg
pnpm add -D @types/pg
```

## Configure

Schema lives at `src/lib/db/schema.ts` — define tables from the user's interview nouns (plus auth tables later if sign-in is chosen).

**SQLite branch** — `drizzle.config.ts` at project root:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: { url: "./data/app.db" },
});
```

`src/lib/db/index.ts`:

```ts
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";

const sqlite = new Database("./data/app.db");
export const db = drizzle(sqlite, { schema });
```

Create the folder and ignore the data file: `mkdir -p data` and add `data/` to `.gitignore`.

**Postgres branch** — run the database locally in Docker so the user installs nothing but Docker Desktop, and nothing is left running on their machine afterwards. `docker-compose.yml` at project root:

```yaml
services:
  db:
    image: postgres:alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

The tag carries no version on purpose, so a fresh project gets the current stable Postgres. Say one thing about it to the user if they ever ask why: a Postgres data directory belongs to the major version that created it, so once the app has real data in it, an image that moves to a new major will refuse to start against the old volume — the fix is a dump and restore, not a flag. That is the moment to pin the major, not before.

Append to `.env`:

```
POSTGRES_URL=postgresql://app:app@localhost:5432/app
```

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.POSTGRES_URL! },
});
```

`src/lib/db/index.ts`:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
export const db = drizzle(pool, { schema });
```

Start it with `pnpm db:up` (see the scripts below). Docker Desktop must be running — if it isn't, `docker compose` fails with a daemon connection error; tell the user to start Docker Desktop rather than debugging the app.

**If Docker isn't available and the user doesn't want to install it,** don't force it. Either fall back to the SQLite branch, or point `POSTGRES_URL` at a free hosted Postgres (Neon, Supabase) — the rest of this file is identical either way, because only the connection string changes.

**Going to production:** nothing in the code changes. Docker Compose is a local convenience only; a deployed app points `POSTGRES_URL` at a hosted Postgres set in the host's environment variables. Say this at hand-off so the user doesn't think they need to deploy a container.

**Both branches** — add scripts to `package.json`:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate",
"db:studio": "drizzle-kit studio"
```

**Both branches** — also change the existing `build` script so migrations run on every deploy:

```json
"build": "pnpm db:migrate && next build"
```

(If the project was scaffolded with npm rather than pnpm, use `npm run db:migrate && next build`.)

Without this, a deploy ships new code against an old database schema: the migration files are committed but nothing ever applies them on the host, and the first request touching a new column fails at runtime. Hooking `db:migrate` into `build` means the host applies pending migrations as part of the deploy, in the same step that produces the build. It is a no-op locally when there is nothing pending, so `pnpm build` stays safe to run any time.

This needs the deployed environment to have the same database connection variable the migration uses (`POSTGRES_URL`, or the SQLite file path) set at *build* time, not just at runtime — say so at hand-off, because a build that can't reach the database fails the whole deploy.

**Postgres branch** — also add:

```json
"db:up": "docker compose up -d",
"db:down": "docker compose down"
```

**Never use `drizzle-kit push`.** Not for the first schema, not for a "quick" column, not while prototyping — and `db:push` is deliberately absent from the scripts above so it isn't within reach. `push` diffs the schema straight onto the database with no artefact left behind, which means the project has no migration history, teammates and production have no way to reproduce the schema, and the first destructive diff silently drops a column with real data in it. Migrations are the whole point of using an ORM with a migration tool.

**The schema workflow, every single time:**

```bash
pnpm db:generate   # writes a reviewable SQL file into ./drizzle
pnpm db:migrate    # applies pending migrations
```

Read what `db:generate` produced before applying it. Drizzle cannot always tell a rename from a drop-plus-add, and the generated SQL is where that shows up — a `DROP COLUMN` you didn't intend is obvious in the file and invisible if you skip it.

Commit the `drizzle/` folder. It is source code, not build output.

## Schema conventions

**Better Auth's tables are not yours to design.** `src/lib/db/auth-schema.ts` is written by the Better Auth CLI (see `references/auth.md`) and is left exactly as generated — same column names, same types, same `text` ids. Editing it breaks the adapter, and the next CLI run overwrites the edit anyway.

**Every table you define gets a randomly generated UUID primary key.** Not an auto-incrementing integer. Sequential ids leak information the app never meant to publish — `/invoices/1042` tells any customer roughly how many invoices exist, and lets them walk the whole table by counting down — and they collide the moment data is merged or seeded from more than one place. A UUID is unguessable, and the row can be given its id before it ever reaches the database.

The id fills itself in, so application code never passes one on insert.

**Postgres branch:**

```ts
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const hikes = pgTable("hikes", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  trail: text("trail").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

`defaultRandom()` is a real database-level default (`gen_random_uuid()`), so rows inserted by anything other than the app get an id too.

**SQLite branch** — SQLite has no `uuid` column type, so the id is `text` filled in by Drizzle at insert time:

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const hikes = sqliteTable("hikes", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  trail: text("trail").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
```

`$defaultFn` runs in the app, not the database — fine here, because every insert goes through Drizzle. `crypto.randomUUID()` is a global in the Node and edge runtimes; nothing to import.

**The one trap: a column that points at a user stays `text`.** Better Auth's `user.id` is `text` in both branches, so `userId` above is `text` even in the Postgres example where the table's own id is `uuid`. Declaring it `uuid` looks consistent and fails — the foreign key won't create, and `db:migrate` stops with a type mismatch. The same applies to any other column referencing a generated auth table.

Tables that reference *your* tables use the matching type: `uuid` on Postgres, `text` on SQLite.

## Verify

- `pnpm db:generate` produces a migration file in `drizzle/`, and `pnpm db:migrate` applies it without errors.
- Every table you defined has a UUID primary key that fills itself in — inserting a row without passing an `id` works — and `auth-schema.ts` is untouched from what the Better Auth CLI generated.
- `package.json` has `"build": "pnpm db:migrate && next build"`, and `pnpm build` completes — running migrations first, then the Next.js build.
- Inserting and reading one row through `db` works (a quick script or the first page using a table is fine).
- `pnpm db:studio` opens and shows the tables (optional, good demo for the user).
