# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Configuration

- **Language**: TypeScript. **Package manager**: bun — run scripts with `bun run <script>`.
- **Stack**: SvelteKit (Svelte 5), Drizzle + Turso (libSQL), better-auth, Tailwind, Paraglide (i18n), Storybook, Vitest, Playwright. The `worker/` is a standalone Bun process (no separate `package.json` — run via root scripts).

## Commands

```sh
bun install
bun run dev              # app + dashboard at http://localhost:5173/dashboard
bun run build            # production build   ·   bun run preview to serve it
bun run check            # svelte-check typecheck (run this, not tsc)
bun run lint             # prettier --check + eslint   ·   bun run format to fix
```

**Tests** — Vitest is split into `--project` groups (`client` = Svelte in a browser, `server` = node, plus a Storybook project):

```sh
bun run test:unit                              # watch mode
bun run test:unit -- --run                     # single pass (CI-style)
bun run test:unit -- --run src/foo.test.ts     # one file
bun run test:unit -- --run -t "some name"      # filter by test name
bun run test:unit -- --project server          # one project only
bun run test:e2e                               # Playwright e2e
bun run test                                   # full suite (unit --run + e2e)
```

**Database** — Drizzle Kit. Schema auto-migrates on deploy; there is **no manual `db:migrate` step**.

```sh
bun run db:push          # push schema to the dev DB   ·   db:studio to browse
bun run auth:schema      # regenerate auth tables after editing src/lib/server/auth.ts
```

**Worker & blobs** — the crawler and content-addressed blob store:

```sh
bun run worker           # run the sync worker   ·   worker:estimate for a dry count
# local crawl, no R2 needed:
DATABASE_URL="file:local.db" BLOB_STORE=local bun run worker/index.ts --mode estimate --max 100 --once
bun run blobs:sync       # reconcile local cache ↔ R2 (blobs:push / blobs:pull for one direction)
```

Local dev login (seeded mock DB): `admin@example.com` / `password`. Copy `.env.example` → `.env` for the full variable set.

## Conventions

- **Commits auto-format.** A husky pre-commit hook runs `lint-staged` (prettier + `eslint --fix`) on staged files, so a commit will reformat/restage them — expected, not a mistake.
- **The app and worker never talk directly** — they coordinate only through Turso rows. Keep it that way.

## Architecture

This app crawls/archives the Orleans CivicPlus site and tracks changes. **Read
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first** for the full system: a Bun
sync worker ([`worker/`](worker/)) writes to Turso (metadata + change history) and
content-addressed blob storage (local cache / Cloudflare R2); the SvelteKit app
provides a dashboard (`/dashboard`) and steers the worker via DB rows. Per-area
docs: [`worker/README.md`](worker/README.md),
[`src/lib/server/db/README.md`](src/lib/server/db/README.md),
[`src/routes/dashboard/README.md`](src/routes/dashboard/README.md). Schema changes
auto-migrate on deploy — never a manual `db:migrate` step.

## Issue-driven workflow

GitHub issues are the front door for all work. Ideas, bugs, and feature requests
are written as issues, triaged into a small state machine, then picked up by
agents. The lifecycle and the label vocabulary are owned by the `/triage` skill —
consult it before changing an issue's state.

**State labels** (exactly one per triaged issue, alongside a category label
`bug`/`enhancement`): `needs-triage` → `needs-info` / `ready-for-agent` /
`ready-for-human` / `wontfix`, plus `in-progress` while actively worked. An issue
only reaches `ready-for-agent` once it carries a self-contained **agent brief**
comment — that brief, not the original body, is the contract the agent works from.

**Branch / PR / merge conventions** (every agent and human follows these):

- **Worktree per task.** Run each issue in its own git worktree so parallel work
  never collides. Never commit straight to `main`.
- **Branch name:** `issue-<number>-<short-slug>` (e.g. `issue-17-status-card`).
- **Claim first.** Before writing any code, flip the issue to `in-progress` and
  self-assign — this is the single-writer guard that stops two agents grabbing the
  same issue (same guarantee the sync worker uses for its single-writer lock).
- **PR body opens with `Closes #<number>`** so the merge auto-closes the issue.
- **Verify before handoff.** Run `/verify` and `/code-review` on the branch; move
  the PR to `ready-for-human` when it's ready to merge.
- **Squash only.** The repo enforces squash merges (merge + rebase commits are
  disabled). Merge with `gh pr merge --squash --delete-branch`.

---

You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.
