# File uploads (local folder → Vercel Blob)

Last verified: 2026-07-27

**Purpose:** Let users upload files (photos, avatars, documents) with **one storage module and two backends chosen at runtime**. In local development files are written into `public/uploads/` and served straight off disk — nothing to sign up for. In production the same code writes to Vercel Blob. The calling code never knows which one it got.

> Why the switch is necessary, in plain words for the user: on Vercel the app's filesystem is read-only and thrown away between requests, so "save it in a folder" simply cannot work there. And `public/` is snapshotted at build time, so even a file written at runtime would never be served. Local folder for development, blob storage for the real thing.

**The switch is presence-based, not a mode flag.** If a blob credential is in the environment, blob wins; otherwise local. That means the user configures nothing locally, and Vercel configures itself the moment a Blob store is connected to the project.

## Install

```bash
pnpm add @vercel/blob
```

Nothing goes in `.env` for local development — the absence of the token *is* the local-mode signal.

Ignore the upload folder so user files never land in git:

```bash
echo "/public/uploads" >> .gitignore
```

## Configure

Four small files under `src/lib/storage/`.

`src/lib/storage/types.ts` — shared shape, kept separate so the two backends don't import each other:

```ts
export type StoredFile = {
  /** Public URL to render in an <img> or link. */
  url: string;
  /** Stable key used to delete the file later. */
  pathname: string;
};
```

`src/lib/storage/local.ts`:

```ts
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { StoredFile } from "./types";

const root = () => path.join(process.cwd(), "public");

export async function saveLocal(file: File, folder: string): Promise<StoredFile> {
  const name = `${randomUUID()}${path.extname(file.name)}`;
  const pathname = `${folder}/${name}`;
  await mkdir(path.join(root(), folder), { recursive: true });
  await writeFile(path.join(root(), pathname), Buffer.from(await file.arrayBuffer()));
  return { url: `/${pathname}`, pathname };
}

export async function deleteLocal(pathname: string): Promise<void> {
  await unlink(path.join(root(), pathname)).catch(() => {});
}
```

`src/lib/storage/blob.ts`:

```ts
import { put, del } from "@vercel/blob";
import type { StoredFile } from "./types";

export async function saveBlob(file: File, folder: string): Promise<StoredFile> {
  const blob = await put(`${folder}/${file.name}`, file, {
    access: "public",
    addRandomSuffix: true,
  });
  return { url: blob.url, pathname: blob.pathname };
}

export async function deleteBlob(pathname: string): Promise<void> {
  await del(pathname);
}
```

`src/lib/storage/index.ts` — the only file the rest of the app imports:

```ts
import { saveLocal, deleteLocal } from "./local";
import { saveBlob, deleteBlob } from "./blob";
import type { StoredFile } from "./types";

export type { StoredFile };

/**
 * Blob storage wins whenever a credential is present. On Vercel these are set
 * automatically once a Blob store is connected to the project:
 *   - BLOB_STORE_ID   (+ VERCEL_OIDC_TOKEN) — the default, short-lived credentials
 *   - BLOB_READ_WRITE_TOKEN — long-lived fallback, also used off-platform
 */
export const usingBlobStorage = Boolean(
  process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID,
);

export function saveFile(file: File, folder = "uploads"): Promise<StoredFile> {
  return usingBlobStorage ? saveBlob(file, folder) : saveLocal(file, folder);
}

export function deleteFile(pathname: string): Promise<void> {
  return usingBlobStorage ? deleteBlob(pathname) : deleteLocal(pathname);
}
```

Upload endpoint `src/app/api/upload/route.ts`:

```ts
import { saveFile } from "@/lib/storage";

const MAX_BYTES = 4 * 1024 * 1024; // stay under Vercel's 4.5 MB request limit
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return Response.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "That file is larger than 4 MB." }, { status: 413 });
  }
  if (!ALLOWED.includes(file.type)) {
    return Response.json({ error: "Only images are allowed." }, { status: 415 });
  }

  return Response.json(await saveFile(file));
}
```

**If sign-in was chosen, guard this route** — an open upload endpoint is a free file host for the whole internet. Check the session first and return 401 when there isn't one:

```ts
const session = await auth.api.getSession({ headers: req.headers });
if (!session) return Response.json({ error: "Sign in first." }, { status: 401 });
```

**If you render uploads with `next/image`, allow the blob host in `next.config.ts`** — otherwise images work locally (where the URL is a same-origin `/uploads/...` path) and break the moment they come from blob storage, which is a miserable thing to debug after deploying:

```ts
images: {
  remotePatterns: [{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" }],
},
```

A plain `<img>` needs none of this — fine for a first version.

**Store the returned `url` and `pathname` on the row they belong to** — an `imageUrl` / `imagePath` column on the user's own table, not a separate orphan table. `url` is what you render; `pathname` is what you pass to `deleteFile` when the row is deleted.

Build the upload UI to match the interview (an avatar picker, a photo on each entry, an attachment list) — a bare "choose a file" test page is the fallback, not the goal. Post a `FormData` with a `file` field to `/api/upload`, then save the returned `url` with the record.

## Going to production

Tell the user at hand-off, in this order:

1. Deploy to Vercel.
2. In the project, open **Storage → Create Database → Blob**, set access to **Public**, and connect it to the project.
3. That's it — Vercel injects the credentials, `usingBlobStorage` flips to true on the next deploy, and uploads go to blob storage. No code change, no config file.

Files uploaded locally stay local; they are development data and were never in git.

For files over 4.5 MB the request never reaches the function — that needs client-side direct upload (`@vercel/blob/client`), which is worth adding only when the app actually needs it.

## Verify

- `pnpm dev`, upload an image through the app's own UI: it appears in `public/uploads/` and renders on the page.
- The saved `url` survives a page refresh, so it is persisted on the record and not just held in React state.
- `git status` shows no uploaded files.
- Oversized and wrong-type files produce the friendly error, not a crash.
- Auth branch only: signed out, the upload endpoint returns 401.
