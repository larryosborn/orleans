# Database layer

Turso / libSQL (SQLite dialect) via Drizzle. Shared by the web app and the
[sync worker](../../../../worker/README.md). See the
[architecture doc](../../../../docs/ARCHITECTURE.md) for the big picture.

## Files

| File              | Purpose                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`        | App DB client (reads `$app/env/private`). Lazy singleton; `ensureDb()` runs migrations + seeds a demo admin on first use. Import-safe at build time. |
| `schema.ts`       | Barrel — re-exports `auth.schema` + `crawl.schema`. Drizzle's `schema` config points here.                                                           |
| `auth.schema.ts`  | better-auth tables (`user`, `session`, `account`, `verification`) + `task`. Regenerate with `bun run auth:schema`.                                   |
| `crawl.schema.ts` | The sync/archive tables (see below).                                                                                                                 |
| `migrator.ts`     | Runtime-agnostic migration runner. Applies `drizzle/*.sql`, tracked in `_migrations`, tolerant of "already exists".                                  |
| `migrate.web.ts`  | App-side loader — Vite-bundles `drizzle/*.sql` as strings so migrations ship in the serverless bundle.                                               |

The worker uses `migrator.ts` directly with a filesystem loader (it has disk
access); the app uses `migrate.web.ts`.

## Crawl/archive tables

Defined in `crawl.schema.ts`:

- **`resource`** — one row per unique normalized URL; the manifest. Latest
  fingerprint (sha256/etag/last-modified/size/status), `kind`, `state`, and
  first/last seen/fetched/changed timestamps.
- **`resource_version`** — append-only change log. One row per real change
  (`new` | `changed` | `probed` | `gone` | `error`), with the blob pointer.
- **`blob`** — content-addressed store record (sha256 PK), size, content-type,
  `storage_key`, `ref_count`. Deduped across runs.
- **`link`** — the discovered link graph (`from_resource` → `to_url`/`to_resource`).
- **`sync_run`** — per-run status, `control` flag, heartbeat, and rollup counters;
  the control plane between app and worker.
- **`crawl_event`** — per-URL errors/events for the dashboard.

Read models + control helpers live in [`../sync.ts`](../sync.ts).

## Migrations — auto-applied

Migrations self-apply, so **there is no manual migrate step**:

- App: `ensureDb()` → `runMigrations()` on first request (bundled SQL).
- Worker: applies the same migrations on startup.

To change the schema:

```bash
# 1. edit crawl.schema.ts (or auth via better-auth)
bun run db:generate     # writes a new drizzle/NNNN_*.sql
# 2. deploy — the app/worker apply it automatically on next start
```

Manual/CI escape hatches still exist: `bun run db:migrate`, `db:push`, `db:studio`.

## Conventions

- Timestamps: `integer({ mode: 'timestamp_ms' })`, default
  `sql\`(cast(unixepoch('subsecond') * 1000 as integer))\``.
- Booleans: `integer({ mode: 'boolean' })`. IDs: `text` UUIDs.
- SQLite has no enums — status/kind columns are `text` with documented values.
