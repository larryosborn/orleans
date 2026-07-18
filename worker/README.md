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
- **`resource_text`** — cleaned extracted text per resource (the `extract` mode).
- **`chunk`** — retrieval-sized text chunks + libSQL-native embedding vectors (the `embed` mode).

## Modes

| Mode       | Downloads bodies? | Stores blobs?  | Use                                                                            |
| ---------- | ----------------- | -------------- | ------------------------------------------------------------------------------ |
| `sync`     | yes               | new/changed    | **Recommended.** Resumable, core-first, only-what's-due (see architecture §11) |
| `estimate` | no (HEAD-ish)     | no             | Cheap census: discovery + sizes + relations                                    |
| `crawl`    | yes               | yes (new only) | One-shot BFS; skips already-captured URLs                                      |
| `recrawl`  | yes               | yes (changed)  | One-shot BFS re-check via conditional GET                                      |
| `extract`  | no                | no             | RAG stage 1: blob → cleaned main-content text in `resource_text`               |
| `embed`    | no                | no             | RAG stage 2: `resource_text` → chunks + embedding vectors in `chunk`           |

`estimate` writes real rows (resources, links, probed versions with sizes/etags)
so it's a persistent, diffable snapshot — not just a printout.

## RAG pipeline (`extract` → `embed`)

Two derivation stages turn captured content into retrieval-ready vectors. Both are
content-addressed and idempotent — a re-run does work only where the source changed.

```bash
bun run worker:extract   # blobs → resource_text (cleaned main-content text)
bun run worker:embed     # resource_text (status ok) → chunk (text + F32_BLOB vector)
```

`embed` chunks each resource's extracted text (recording char offsets), embeds each
chunk via a configured model, and stores it in `chunk` with the vector in a
libSQL-native `F32_BLOB` column plus an ANN index (`chunk_vec_idx`), so retrieval
(#36) can run `vector_top_k('chunk_vec_idx', vector32(?), k)`. Freshness mirrors
extraction: each chunk records the `resource_text.sha256` it was built from, so a
content change re-embeds **only** that resource and leaves no orphan/stale chunks
(a resource whose text stops being `ok` has its chunks removed).

**Embedding model** is chosen by config, behind a small `Embedder` interface, so
swapping needs no call-site changes (see `worker/embeddings.ts`):

- `EMBEDDING_PROVIDER=cloudflare` → Workers AI `@cf/baai/bge-base-en-v1.5` (768-dim
  native; needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`)
- `EMBEDDING_PROVIDER=openai` → `text-embedding-3-small` requested at 768 dims
  (needs `OPENAI_API_KEY`)
- `EMBEDDING_PROVIDER=fake` (or no credentials) → a deterministic offline embedder,
  so the pipeline runs in CI / locally without any API

All providers emit `EMBED_DIM` (768) dimensions to match the fixed `F32_BLOB(768)`
column width. A model with a different dimensionality needs a new migration
(vector columns are fixed-width) — see `EMBED_DIM` in
[`crawl.schema.ts`](../src/lib/server/db/crawl.schema.ts).

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

# Local dev: crawl into the local blob cache (.cache/blobs) — default holds blobs
# local-only, no R2 needed:
bun run worker/index.ts --mode crawl --max 30 --once

# Publish through to R2 (the canonical archive) as it crawls — prod shape (needs R2_*):
bun run worker --publish
```

> **Restart after pulling code.** Bun does not hot-reload a running `bun run`
> process — it keeps the modules it loaded at startup. A worker started before a
> code change keeps running the old behavior (e.g. a pre-`sync` worker will
> execute a `sync` run as a plain BFS crawl). Restart it after deploying/pulling.
> Tell-tale: a `sync` run stuck in `current_phase='crawling'` with no tier-0
> resources or unfetched frontier rows — that's an old worker.

## Runtime seam: core `tick()` + drivers

The execution model is split in two so the same crawl engine can run in very
different environments (a long-lived box today; a serverless function tomorrow)
without the engine knowing which. This is the SvelteKit-adapter idea applied to
the worker: one portable **core**, swappable **drivers**.

```
  ┌──────────────────────────── core (env-agnostic) ────────────────────────────┐
  │  worker/core.ts    tick(opts) -> { status: 'more' | 'idle' | 'done', … }     │
  │  worker/crawl.ts   createCrawlSession / createSyncSession (bounded step())    │
  │                                                                              │
  │  One tick = claim-or-continue the active run, process ONE bounded batch      │
  │  (capped by a max item count AND a soft wall-time budget), persist progress, │
  │  honor control (pause/cancel/discovery), return. NO loop, NO signals, NO     │
  │  wait-sleeps, NO process lifecycle. It does one unit and returns.            │
  └──────────────────────────────────────────────────────────────────────────────┘
                                     ▲  pumps
  ┌──────────────────────────── driver (env-specific) ──────────────────────────┐
  │  worker/driver.ts  makeLocalDriver — the long-lived `bun run worker` loop:   │
  │    loop { maintenance-when-due; tick(); react to status } + idle sleeps +    │
  │    SIGINT/SIGTERM graceful shutdown + registry active/standby transitions.   │
  │  worker/index.ts   thin: build identity + budget, migrate, pick a driver.    │
  └──────────────────────────────────────────────────────────────────────────────┘
```

**`tick()` status contract** — the whole seam:

| status | meaning                                  | a driver typically…                     |
| ------ | ---------------------------------------- | --------------------------------------- |
| `more` | budget spent, work remains               | pumps again immediately                 |
| `idle` | nothing to claim, or the run is paused   | waits (sleep / next cron) then re-ticks |
| `done` | run reached a terminal state (finalized) | pumps again (claim the next run)        |

Per-tick bounds are configurable — `WORKER_TICK_MAX_ITEMS` (item cap) and
`WORKER_TICK_BUDGET_MS` (soft wall-time). The bounds only _chunk_ the work: the
resulting rows/counts are identical to an unbounded loop, because every processed
resource reschedules itself (`sync`) or is skipped as already-captured (`crawl`),
and unchanged content produces no new version row (content-addressed sha compare).
So a batch is safe to re-run — `tick()` advances **atomically and idempotently**
(no duplicate `resource_version` rows, no double blob writes), which is also what
keeps a future sharded/parallel driver from needing any core change.

**Single-writer is unchanged.** Exactly one active run at a time via the Turso
lease (`claimNext` + heartbeat, preserved verbatim in `core.ts`). The local driver
keeps one warm in-process session across ticks, so the crawl BFS frontier
(in-memory for `crawl`/`estimate`/`recrawl`) continues step to step. `sync` is the
DB-resumable mode — the `resource` table _is_ the frontier — so it resumes across
process restarts too.

### Adding a serverless driver (future — NOT built here)

The seam is shaped so a Cloudflare/Vercel driver drops in **without touching the
core**. It composes the same primitives, but inverts the loop — the platform's
scheduler _is_ the loop. A one-tick-per-invocation handler looks like:

```ts
// pseudo-code for a future serverless driver — do not ship yet
export async function handler() {
	await runMaintenance(identity, /* idle */ true); // reap/sweep/schedule
	const r = await tick({ identity, publish, budget });
	// 'more'  -> schedule an immediate follow-up invocation
	// 'idle'  -> let the next cron tick handle it
	// 'done'  -> lapse; the next queued run is picked up next invocation
}
```

Because `sync` is DB-resumable and every processed row reschedules itself, one tick
per invocation across fresh processes still converges on the same result — no
shared in-process state required. `worker/driver.ts` exports the reusable
primitives (`runMaintenance`, `reapStaleRuns`, `maybeScheduleSync`) alongside
`makeLocalDriver`; a new driver reuses them and supplies only its own loop
discipline and lifecycle.

## Blob storage: R2 canonical + opt-in publishing

Bodies are stored content-addressed (by sha256). R2 is the **canonical durable
archive**, but publishing to it is **opt-in**:

- **local** — `.cache/blobs` (or `BLOB_DIR`). The dev/staging store. An
  unpublished crawl writes new bytes here only.
- **r2** — Cloudflare R2. Written **only** (no local copy) when the worker runs
  with `--publish` (prod passes it). A default run holds blobs local-only, so a
  dev/experimental crawl can't pollute the archive; a publishing run writes no
  local files, so it needs no filesystem (runs on a no-fs host).

`blob.r2_synced_at` is the publish marker — null until an object is confirmed in
R2, then stamped (on a `--publish` R2 write or a `blobs:push` promotion). It
doubles as the held/pending-publish queue (`r2_synced_at IS NULL`).

Because keys are immutable, promoting/reconciling is a plain copy-what's-missing —
no conflicts:

```bash
bun run blobs:push    # promote held (r2_synced_at IS NULL) blobs -> R2, then stamp them
bun run blobs:pull    # R2 -> local (download objects the cache lacks)
bun run blobs:sync    # reconcile both directions
bun run worker/sync-blobs.ts --both --dry-run   # preview
```

`blobs:push` is marker-aware: only held blobs are considered, so a second push
right after copies nothing. There is no automatic/scheduled sync.

Typical workflow: crawl locally (default, no `--publish`), then
`bun run blobs:push` to persist to R2 — or run the worker with `--publish`.

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
