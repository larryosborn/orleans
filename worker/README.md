# Sync worker

A standalone Bun process that performs the actual crawl. It shares the app's
Drizzle schema and Turso database but runs **outside** the web app, because a
full crawl takes hours and can't live in a serverless request handler.

> Part of the larger system — see [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
> for how the worker, Turso, blob storage, and dashboard fit together.

## Architecture: Turso is the control plane

The web app and the worker never talk directly. They coordinate through the
`sync_run` table:

```
  web app (Vercel/CF)                worker (this dir, anywhere)
  ─────────────────────              ───────────────────────────
  insert sync_run(status=queued) ─┐
  write control=pause|cancel ───┐ │
                                │ │  poll queued → claim (status=running)
                                │ └▶ obey control between requests
  read heartbeat/counters ◀─────┴──  write heartbeat + rollups + results
                                     write resource / resource_version / blob / link
```

Because coordination is entirely in the database, the worker can run anywhere
that can reach Turso + R2 — a small always-on box (Railway/Fly/Render), a
container, or your laptop. Nothing about it is Vercel/Cloudflare specific.

## What it writes

- **`resource`** — one row per unique URL; latest fingerprint + lifecycle.
- **`resource_version`** — append-only change log (new / changed / probed / gone / error).
- **`blob`** — content-addressed store (sha256), ref-counted, deduped across runs.
- **`link`** — the discovered link graph (relations).
- **`sync_run`** — run status, heartbeat, and rollup counters.
- **`crawl_event`** — per-URL errors / notable events.

## Modes

| Mode       | Downloads bodies? | Stores blobs?  | Use                                                                            |
| ---------- | ----------------- | -------------- | ------------------------------------------------------------------------------ |
| `sync`     | yes               | new/changed    | **Recommended.** Resumable, core-first, only-what's-due (see architecture §11) |
| `estimate` | no (HEAD-ish)     | no             | Cheap census: discovery + sizes + relations                                    |
| `crawl`    | yes               | yes (new only) | One-shot BFS; skips already-captured URLs                                      |
| `recrawl`  | yes               | yes (changed)  | One-shot BFS re-check via conditional GET                                      |

`estimate` writes real rows (resources, links, probed versions with sizes/etags)
so it's a persistent, diffable snapshot — not just a printout.

**Document size limit.** In `crawl`/`recrawl`, HTML is always downloaded but large
binaries can be skipped: `CRAWLER_MAX_DOC_BYTES` (env default) or per-run
`params.maxDocBytes` (the dashboard's "Max file size, MB"). Docs over the limit are
recorded as `probed` (size/etag, no blob); `0` = skip all documents (pages-only).

## Running

```bash
# Long-running poll loop (production shape): claims queued runs from the dashboard
bun run worker

# ...with auto-sync every hour (idle worker enqueues a `sync` run on a schedule)
SYNC_SCHEDULE_MINUTES=60 bun run worker

# One-shot (ops/testing) — enqueues + runs a single job, then exits
bun run worker/index.ts --mode estimate --max 80 --once
bun run worker/index.ts --mode crawl --once

# Local dev: crawl into the local blob cache (.cache/blobs), no R2 needed
BLOB_STORE=local bun run worker/index.ts --mode crawl --max 30 --once
```

## Blob storage & local ↔ R2 sync

Bodies are stored content-addressed (by sha256). Two backends, chosen by
`BLOB_STORE` (`auto` = R2 if configured, else the local cache):

- **local** — `.cache/blobs` (or `BLOB_DIR`). Free, great for dev/testing.
- **r2** — Cloudflare R2, for remote persistence.

Because keys are immutable, moving objects between them is a plain
copy-what's-missing — no conflicts:

```bash
bun run blobs:push    # local  -> R2   (upload objects R2 doesn't have)
bun run blobs:pull    # R2     -> local (download objects the cache lacks)
bun run blobs:sync    # reconcile both directions
bun run worker/sync-blobs.ts --both --dry-run   # preview
```

Typical workflow: crawl locally (cheap, `BLOB_STORE=local`), then
`bun run blobs:push` to persist to R2.

## Environment

See the root `.env.example`. Required: `DATABASE_URL` (+ `DATABASE_AUTH_TOKEN`
for remote Turso). For `crawl`/`recrawl`: `R2_ENDPOINT`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Tuning knobs (`CRAWLER_*`) are
optional.

## Politeness / staying low-impact

Single-threaded, with `CRAWLER_RATE_LIMIT` base seconds between requests plus
`CRAWLER_RATE_LIMIT_JITTER` random extra (so the pacing isn't a perfectly periodic
signature). Honors `robots.txt`, backs off on `429/503` (`Retry-After`), and uses
conditional GETs (ETag / Last-Modified) so re-runs are near-free. To minimize the
visible footprint: cap document downloads (`CRAWLER_MAX_DOC_BYTES`), run overnight
in capped batches from one stable IP, and set an honest `CRAWLER_USER_AGENT`
(e.g. a contactable `OrleansArchive/1.0 (+url; contact you@email)`). See
[docs/ARCHITECTURE.md §12](../docs/ARCHITECTURE.md) for the full rationale, and §13
for the CivicPlus data sources (sitemap `<lastmod>`, RSS) that avoid re-crawling.

Use `CRAWLER_SEEDS` (comma-separated) to point a run at a targeted subset.
