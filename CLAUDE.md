## Project Configuration

- **Language**: TypeScript
- **Package Manager**: bun
- **Add-ons**: prettier, eslint, vitest, playwright, tailwindcss, sveltekit-adapter, drizzle, better-auth, paraglide, storybook, experimental, mcp

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
