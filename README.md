# Orleans

Crawls the Town of Orleans CivicPlus site, **archives** every page and document,
tracks **what changed and when**, and provides a **dashboard** to observe and
control the sync.

- A standalone **Bun worker** ([`worker/`](worker/)) crawls and writes to **Turso**
  (metadata + change history) and **content-addressed blob storage** (local cache
  for dev, **Cloudflare R2** for prod).
- The **SvelteKit app** reads Turso for a dashboard (`/dashboard`) and steers the
  worker by writing rows — the two never talk directly.

> **Start here:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the durable
> reference for the whole system (data model, run modes, storage, deploy).

## Quickstart

```sh
bun install
bun run dev            # app + dashboard at http://localhost:5173/dashboard

# crawl into the local cache (default: no --publish, no R2 needed), in another shell:
DATABASE_URL="file:local.db" \
  bun run worker/index.ts --mode estimate --max 100 --once
```

Local login (seeded mock DB): `admin@example.com` / `password`.

### Subsystem docs

- [`worker/README.md`](worker/README.md) — the sync worker, blob storage, local↔R2 sync
- [`src/lib/server/db/README.md`](src/lib/server/db/README.md) — schema + auto-migrations
- [`src/routes/dashboard/README.md`](src/routes/dashboard/README.md) — dashboard + control API
- [`.env.example`](.env.example) — all environment variables

---

## Project scaffolding

Generated with [`sv`](https://github.com/sveltejs/cli). To recreate this project with the same configuration:

```sh
# recreate this project
bun x sv@0.16.2 create --template minimal --types ts --add prettier eslint vitest="usages:unit,component" playwright tailwindcss="plugins:none" sveltekit-adapter="adapter:auto" drizzle="database:sqlite+sqlite:libsql" better-auth="demo:password" paraglide="languageTags:en, es+demo:yes" storybook experimental="versions:kit+features:async,remoteFunctions,explicitEnvironmentVariables,handleRenderingErrors" mcp="ide:claude-code+setup:remote" --install bun orleans
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
