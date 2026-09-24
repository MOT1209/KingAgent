# Base project

Last verified: 2026-07-21

**Purpose:** Create the Next.js project that everything else builds on: TypeScript, Tailwind, App Router, shadcn/ui components.

> **Read the `shadcn` skill before adding components, and `vercel-react-best-practices` before writing Next code.** Step 2a installed both. They are shadcn's and Vercel's own instructions for their own tools — on CLI flags, component composition, theming, and current Next patterns they outrank anything found by searching. This file owns the project layout and what goes where; they own how each piece is used.

## Install

**The app is created in the current working directory, never in a subfolder.** The user is already standing in the folder they want the app to live in, so `package.json`, `src/`, and `next.config.ts` belong at its top level. Passing `.` as the project name does this — and there is no `cd` afterwards.

Use pnpm if available, otherwise npm.

```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --turbopack --use-pnpm
```

If a prompt still appears for an option not covered by flags, accept the default.

Then set the package name, because `.` makes `create-next-app` derive it from the folder name — which is often not the app's name:

```bash
npm pkg set name=my-app   # kebab-case version of the user's app name
```

**If the command refuses because the directory isn't empty** (a stray `README.md`, notes, an existing `package.json`), do *not* fall back to a subfolder. Scaffold into a temporary directory and move the result up:

```bash
npx create-next-app@latest .scaffold-tmp --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --turbopack --use-pnpm
shopt -s dotglob && mv .scaffold-tmp/* . && rmdir .scaffold-tmp
```

Resolve collisions deliberately rather than letting `mv` decide: keep the user's existing file where it has content worth keeping (their `README.md`), take the scaffold's otherwise, and merge `.gitignore` by hand if both exist.

Initialize shadcn/ui with defaults:

```bash
pnpm dlx shadcn@latest init -d
```

Add components on demand as pages need them (start small):

```bash
pnpm dlx shadcn@latest add button card input label
```

## Configure

Project layout to follow for everything added later — all paths are relative to the current working directory, which *is* the project root:

```
src/
├── app/           # routes: page.tsx, layout.tsx, api/
├── components/    # shared React components (shadcn/ui lands in components/ui)
└── lib/           # db, auth, utilities
```

Create `.env` at the project root now (empty is fine) and confirm `.env*` is in `.gitignore` — later steps append to it.

## Verify

- `package.json` sits in the current working directory — there is no nested project folder.
- `pnpm dev` starts without errors and http://localhost:3000 renders.
- A shadcn `Button` imported into `src/app/page.tsx` renders styled.
