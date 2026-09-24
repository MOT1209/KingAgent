# The database

Last verified: 2026-08-11

**Purpose:** Give the deployed app a database it can reach, with the schema applied — and, where the app was built against a file on disk, change it so it can run somewhere that has no disk to write to.

> **Hard rule: never `drizzle-kit push`.** The parent skill bans it while building; here the database holds the user's real data and the first destructive diff is unrecoverable. Schema changes reach production the same way they reach a laptop: generated, read, then applied.
>
> **Never delete or recreate a database that has data in it.** There is a window where "start over" is a legitimate recovery, and it closes the moment the user creates their first account. `recovery.md` says where that line is.
>
> If the provider's documentation and this file disagree on *how the pieces fit*, this file wins. On a command, a flag, or a connection-string format, their docs win.

## Two ways in, and they are not equivalent

**Through the host's marketplace.** One command provisions the database, connects it to the project, and injects its variables:

```bash
npx --yes vercel@latest install <integration> --name <db-name> --plan free -e production
```

Convenient, and billed on the host's invoice. Two things to know before relying on it: the **first** install of a given integration on an account may require accepting terms in a browser, which is a human step; and it injects **its own variable names**, which may not be the names this app reads.

**Through the provider directly.** Create the database with the provider's own CLI or API, take the connection string, and write it under the name the app already uses. More steps, no name mismatch, and it works the same whether or not the app is on this host.

Pick one deliberately and say which on the sheet. Where the app already reads a specific name and the marketplace injects a different one, the direct path is usually less work than reconciling.

## When the injected name isn't the name the code reads

This is the trap. The app reads one name; the integration injects another. The instinct is to copy the value across — **and you cannot**, because production values are sensitive and unreadable. There is no copy operation.

Three exits, in order of preference:

1. **Read both names in the code.** One line, in each place the name appears, falling back from the app's name to the injected one. Find every occurrence rather than recalling them — the connection is usually configured in two files, the migration config and the client. This is a code change, so it goes on the sheet.
2. **Get the connection string from the provider's API** and write it under the app's own name. Two records of one database, which is a small ongoing cost.
3. **Skip the integration** and provision directly, as above.

## Pooled and direct are different strings

Most hosted Postgres offers both, and they are not interchangeable here:

- **Migrations want the direct connection.** Schema changes take locks and run in transactions, which is exactly what a transaction-mode pooler is not built for.
- **The app wants the pooled connection**, because serverless functions open many short-lived connections.

That is potentially **two variables, not one**. Check what the migration config reads.

## Cold starts look like broken credentials

A free-tier database that scales to zero takes a moment to wake. The first connection from a cold build container can time out — and a migration that fails on a cold start is indistinguishable, in the log, from a wrong connection string.

Retry the first connection before concluding anything. Then say it at hand-off, because the user will meet it again as "the first visit after a quiet spell is slow" and report it as a bug.

## Converting an app built on SQLite

An app whose database is a file cannot run here: the filesystem is read-only and thrown away between requests, so every write is lost and the file is gone at the next request anyway. This is the one case where deploying requires changing the code, and it is on the sheet in Step 3, in plain words, before it happens.

The change, in order:

1. **Swap the driver dependency** — remove the file-based one, add the Postgres one.
2. **Change the dialect** in the migration config, and the client in the database module. Both read the connection string from the environment now.
3. **Regenerate the migrations from scratch.** The existing ones are the other dialect's SQL and will not apply. Delete the generated migration folder, generate once against the new dialect, and **read the SQL before applying it**.
4. **Check the id columns.** Where the parent skill's rule applies, app tables take a native UUID type on Postgres while anything referencing the auth tables stays text. Getting this wrong produces a foreign key that fails only once there is data.
5. **Remove the local database file and its folder from the project**, and from the ignore file if it is named there.

**Local development now needs Postgres too.** That is the point — one code path, switched by a connection string, rather than two that drift. If the user has containers available, the parent skill's local compose setup is the same database as production; if not, point local at a second free database.

**Say plainly that local data does not come with it.** The rows on their laptop are development data. If the user wants them, that is a separate export and import, and it is worth asking rather than assuming either way.

## Then build it locally, against production

Before deploying anything:

```bash
POSTGRES_URL="<the production connection string>" pnpm build
```

Use whatever name the app actually reads. This runs the same migrate-then-build the platform will run, on the same code, against the real database — so it catches the conversion, a wrong connection string, and every module-scope key that would fail a build. It costs no deployments and it is the best-value check in the skill.

It does **apply the migrations early**. That is intended and desirable, but it is a real change to a real database, so it belongs on the sheet.

## Verify

- The database exists, is connected to the project, and is recorded in the run's ledger with its free-tier limit.
- The name the app reads and the name that exists in production are the same name — confirmed by reading the code, not by assuming the integration matched it.
- Where the provider offers both, migrations use the direct string and the app uses the pooled one.
- A local production build against the production database succeeds, and its migration step ran.
- Conversion branch: no file-database driver remains in the dependencies, the migration folder was regenerated rather than edited, the generated SQL was read before it was applied, and no stray database file is left in the project.
- No `push` was used, and no migration that had already been applied was edited.
