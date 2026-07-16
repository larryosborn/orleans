# Orleans — Sync & Archive Architecture

This project crawls the Town of Orleans CivicPlus site (`www.town.orleans.ma.us`),
**stores a durable copy** of every page and document, tracks **what changed and
when**, and exposes a **dashboard** to observe and control the sync. This document
is the durable reference for how it all fits together.

> TL;DR: A standalone **Bun worker** does the crawling and writes to **Turso**
> (metadata + change history) and **content-addressed blob storage** (the actual
> bytes — local cache for dev, **Cloudflare R2** for prod). The **SvelteKit app**
> reads Turso for a dashboard and steers the worker by writing rows — the two
> never talk directly.

---

## 1. The core idea: Turso is the control plane

The web app and the worker are fully decoupled. They coordinate only through the
`sync_run` table:

```
  web app (Vercel / Cloudflare)          worker (Bun, runs anywhere)
  ─────────────────────────────          ────────────────────────────
  insert sync_run(status=queued)  ─┐
  set control = pause | cancel  ─┐ │
                                 │ │  poll queued → claim (status=running)
                                 │ └▶ obey control between requests
  read heartbeat / counters ◀────┴──  write heartbeat + rollups + results
                                      write resource / resource_version / blob / link / crawl_event
```

Because coordination lives in the database, **the worker can run anywhere** that
can reach Turso + the blob store — a small always-on box (Railway/Fly/Render), a
container, or your laptop. This sidesteps the fact that a multi-hour crawl can't
run inside a Vercel/Cloudflare serverless function.

---

## 2. Components

| Component       | Tech                          | Role                                              | Where it runs                     |
| --------------- | ----------------------------- | ------------------------------------------------- | --------------------------------- |
| **Web app**     | SvelteKit + better-auth       | Dashboard + control API                           | Vercel or Cloudflare (serverless) |
| **Database**    | Turso / libSQL (SQLite)       | System of record: manifest, change log, run state | Turso cloud                       |
| **Blob store**  | Local FS **or** Cloudflare R2 | The actual page/document bytes, content-addressed | Local dir (dev) / R2 (prod)       |
| **Sync worker** | Bun + Drizzle                 | Crawls, stores, tracks changes                    | Any long-running host             |

Key decisions (and why):

- **Turso, not Postgres** — the app already spoke libSQL; staying on it removed a
  dialect migration and a better-auth port. SQLite via Turso handles the
  single-writer worker + dashboard reads comfortably.
- **Content-addressed blobs** — keyed by sha256, so identical bytes dedupe to one
  object and keys are immutable (which makes local↔R2 sync conflict-free).
- **Standalone Bun worker, not serverless** — a polite ~1 req/s crawl runs for
  hours; serverless times out in minutes. DB-based control keeps it portable.

---

## 3. Data model

Six tables (defined in [`src/lib/server/db/crawl.schema.ts`](../src/lib/server/db/crawl.schema.ts)),
alongside the existing `user`/`session`/`account`/`verification`/`task` tables.

| Table              | One row per                  | Purpose                                                                                                                                                                                              |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource`         | unique normalized URL        | The manifest. Latest fingerprint (sha256/etag/size/status), `kind` (page/document/sitemap), `state` (active/gone/error), lifecycle timestamps. Stable identity across runs.                          |
| `resource_version` | observed change              | Append-only history. A row is written only on a real change: `new`, `changed`, `probed` (estimate), `gone`, `error`. This is the "what changed, when" log.                                           |
| `blob`             | unique file content (sha256) | Content-addressed store record: size, content-type, `storage_key`, ref-count, and `r2_synced_at` (null until confirmed in R2 — the publish marker, §5). Many versions can point to one blob (dedup). |
| `link`             | discovered edge              | The link graph: `from_resource` → `to_url`/`to_resource`, so you can find orphan documents, hub pages, etc.                                                                                          |
| `sync_run`         | a run                        | Mode, status, `control` flag, heartbeat, `current_url`, and rollup counters (pages/docs/new/changed/errors/bytes). Also the control plane.                                                           |
| `crawl_event`      | a per-URL event              | Errors and notable events (`http_error`, `fetch_error`, `throttled`, `robots_blocked`, …) for the dashboard's errors panel.                                                                          |

Change detection: on fetch, the worker compares the new sha256 (crawl) or
size/etag (estimate) to the resource's stored fingerprint → decides
new/changed/unchanged/probed. Only new/changed/probed/gone/error write a
`resource_version`; unchanged 304s just bump `last_fetched_at`.

**HTML is normalized before hashing** (`normalizeHtml` in `worker/http.ts`): CivicPlus
re-renders per-request junk on every load — ASP.NET `__VIEWSTATE`, randomized element
ids, and a rotating photo carousel — which would otherwise produce endless false
`changed` versions and near-duplicate blobs. The normalizer strips exactly those
(content, links, and text are untouched), so an unchanged page hashes identically and
dedupes. The stored blob is the normalized copy — the tradeoff for R2 dedup.

---

## 4. Run modes

Set per run (`sync_run.mode`). All honor `robots.txt` and rate-limit. `sync` is
the frontier model (§11); the others are one-shot BFS from the sitemap + seeds.

| Mode       | Downloads bodies?                | Stores blobs?      | Use                                                                                                                                                                                 |
| ---------- | -------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`     | yes                              | yes (new/changed)  | **Recommended.** Resumable, priority-ordered, freshness-driven (see §11). Core pages first, then fan out; only fetches what's due. Run it whenever — it picks up where it left off. |
| `estimate` | no (reads headers, cancels body) | no                 | Cheap census: discovery + sizes + relations. Writes `resource` + `link` + `probed` versions with sizes/etags — a persistent, diffable snapshot with **zero** stored bytes.          |
| `crawl`    | yes                              | yes (new only)     | One-shot BFS. Skips URLs already captured; stores bodies for new content.                                                                                                           |
| `recrawl`  | yes                              | yes (changed only) | One-shot BFS re-check of every known URL via conditional GET; stores only what changed.                                                                                             |

**Document size limit (crawl/recrawl).** HTML pages are always downloaded (they're
small and needed for link-following), but large binaries can be skipped: set the
dashboard's **"Max file size, MB"** field (or `CRAWLER_MAX_DOC_BYTES`, or per-run
`params.maxDocBytes`). Documents over the limit are recorded as `probed` versions
(size/etag, no blob) instead of downloaded. `0` = skip all documents (pages-only).
This is the cheapest way to archive the text/HTML while deferring multi-MB PDFs.

---

## 5. Blob storage: R2 canonical + opt-in publishing

Bodies are content-addressed: `blobs/<ab>/<cd>/<sha256><ext>`. There are two
backends, but they are **not** interchangeable targets picked by a switch —
they're layered:

- **local** — a filesystem dir (`.cache/blobs`, or `BLOB_DIR`). The dev/staging
  store. Every crawl writes new bytes here first.
- **r2** — Cloudflare R2 (S3-compatible), the **canonical durable archive**.

**Publishing to R2 is opt-in.** The crawler always writes new blobs to the local
backend; it only writes **through** to R2 when the worker runs with `--publish`
(prod runs pass it). A default (unpublished) run therefore never touches R2, so a
dev/experimental crawl can't pollute the canonical archive. This is a write-path
policy, not a read cache — nothing in the app reads blob bytes on the hot path, so
there is no prod read-through cache.

`blob.r2_synced_at` (nullable timestamp) is the publish marker: **null until the
object is confirmed present in R2**, then stamped. It's set on a successful
`--publish` write-through and on a `blobs:push` promotion. Because it doubles as
the "held / pending publish" queue, `r2_synced_at IS NULL` is exactly the set of
blobs that exist only locally. The read model `getUnpublishedBlobCount()`
(`src/lib/server/sync.ts`) exposes that backlog.

Because keys are immutable, promoting/reconciling is a plain copy-what's-missing
(no conflicts, ever). The `blob` table is the manifest:

```bash
bun run blobs:push    # promote held (r2_synced_at IS NULL) blobs → R2, then stamp them
bun run blobs:pull    # R2 → local (download objects the cache lacks)
bun run blobs:sync    # both directions
bun run worker/sync-blobs.ts --both --dry-run
```

`blobs:push` is marker-aware: it only considers held blobs, uploads what R2 lacks,
and stamps `r2_synced_at` — so a second push right after copies nothing. There is
no automatic/scheduled sync (that's a separate concern).

Cost-saving workflow: crawl locally (default, no `--publish` → no R2 usage), then
`bun run blobs:push` when you want it durable — or run the prod worker with
`--publish` to write through as it goes.

**Viewing an archived copy.** The dashboard's content explorer links each stored
resource to `/dashboard/blob/[id]` (auth-gated). In prod it presigns a short-lived
R2 GET URL (via `aws4fetch`, portable across Vercel/Cloudflare) and redirects; in
dev without R2 it streams the file from the local cache. The app reuses the same
`R2_*` credentials as the worker (see [`src/lib/server/blob.ts`](../src/lib/server/blob.ts)).

---

## 6. Migrations (auto-applied — no manual step)

Drizzle migrations in [`drizzle/`](../drizzle) are the single source of truth.
They self-apply, so schema ships with the code:

- **App** — `ensureDb()` (via `hooks.server.ts`) runs the migrator on first
  request. Migration SQL is Vite-bundled ([`migrate.web.ts`](../src/lib/server/db/migrate.web.ts))
  into the server output, so it works on Cloudflare/Vercel with no filesystem.
- **Worker** — applies the same migrations from disk on startup.
- **Core** — [`migrator.ts`](../src/lib/server/db/migrator.ts) tracks applied
  migrations in a `_migrations` table (each runs once) and tolerates "already
  exists" so it's safe on a previously-bootstrapped DB.

To change the schema: edit `crawl.schema.ts` → `bun run db:generate` → deploy. No
`db:migrate` needed (though the script still exists for manual/CI use).

---

## 7. Dashboard & control API

`/dashboard` (gated by better-auth). See
[`src/routes/dashboard/README.md`](../src/routes/dashboard/README.md).

- **Overview** — live run status + progress, controls (enqueue/pause/resume/cancel),
  stat tiles, storage-by-type, errors, change feed.
- **Runs** — history + per-run detail with events.
- **Content** — searchable/filterable resource explorer.

Control is just DB writes: enqueue = insert `sync_run(status=queued)`; pause/cancel
= set `sync_run.control`. The worker polls and obeys.

---

## 8. Running it

**Local dev**

```bash
bun install
bun run dev                      # web app + dashboard (http://localhost:5173/dashboard)

# in another shell — crawl into the local cache (default: no --publish, no R2 needed):
DATABASE_URL="file:local.db" \
  bun run worker/index.ts --mode estimate --max 100 --once
```

Default seeded login (local/mock DB): `admin@example.com` / `password`.

**Production**

1. Web app → Vercel or Cloudflare. Set `DATABASE_URL` (Turso `libsql://…`) +
   `DATABASE_AUTH_TOKEN` + `ORIGIN` + `BETTER_AUTH_SECRET`, and the `R2_*` vars so
   the dashboard can presign archived copies (§5). Tables auto-create on first request.
2. Blob store → create an R2 bucket + token, set `R2_*` (see below).
3. Worker → run `bun run worker --publish` on an always-on host with the same
   `DATABASE_URL`/`DATABASE_AUTH_TOKEN` + `R2_*`. `--publish` writes blobs through
   to R2 (the canonical archive); without it the worker holds blobs local-only.
   Drive it from `/dashboard`.

---

## 9. Environment variables

Full list in [`.env.example`](../.env.example).

| Var                                                                       | Used by      | Notes                                                                                                                |
| ------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                            | app + worker | Turso `libsql://…` (or `file:` locally)                                                                              |
| `DATABASE_AUTH_TOKEN`                                                     | app + worker | Required for remote Turso                                                                                            |
| `ORIGIN`, `BETTER_AUTH_SECRET`                                            | app          | Auth                                                                                                                 |
| `--publish` (CLI flag, not env)                                           | worker       | Write blobs through to R2 (canonical archive) + stamp `r2_synced_at`. Default off = local-only (§5). Prod passes it. |
| `BLOB_DIR`                                                                | worker       | Local cache dir (default `.cache/blobs`)                                                                             |
| `R2_ENDPOINT` / `R2_BUCKET` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | worker + app | Cloudflare R2 (S3 API). Worker for crawl/recrawl + `blobs:*`; the app presigns them to view archived copies (§5).    |
| `CRAWLER_USER_AGENT`                                                      | worker       | How the crawler identifies itself (see §13).                                                                         |
| `CRAWLER_RATE_LIMIT` / `CRAWLER_RATE_LIMIT_JITTER`                        | worker       | Base seconds between requests + random extra 0..N (non-periodic).                                                    |
| `CRAWLER_MAX_PAGES`                                                       | worker       | Hard safety cap per run.                                                                                             |
| `CRAWLER_MAX_DOC_BYTES`                                                   | worker       | Skip downloading docs over N bytes (0 = pages-only). See §4.                                                         |
| `CRAWLER_SEEDS`                                                           | worker       | Comma-separated paths/URLs to override the default seeds.                                                            |
| `CRAWLER_TTL_{CORE,PAGE,AGENDA,DOC}_DAYS`                                 | worker       | `sync` per-tier freshness TTLs (default 7/7/30/180). See §11.                                                        |
| `CRAWLER_SYNC_BATCH` / `CRAWLER_ERROR_BACKOFF_HOURS`                      | worker       | `sync` claim batch size / failed-URL re-schedule delay.                                                              |
| `SYNC_SCHEDULE_MINUTES` / `WORKER_STALE_MINUTES`                          | worker       | Auto-enqueue `sync` this often (0=off); reap crashed runs. §11.                                                      |

---

## 10. Coverage & completeness

The site has two tiers, and "how complete are we?" depends on which you mean:

- **Core set = the sitemap's canonical pages (~808).** This is CivicPlus's own
  list of authored pages (departments, boards, services). It's the right
  denominator for "have we mirrored the site?"
- **Full archive = core pages + documents (thousands of PDFs).** Documents are a
  handful in page-terms but ~all of the bytes (PDFs are MB-scale). They're the
  long tail, reached via `/DocumentCenter/View/{id}` links embedded in pages.

Rough coverage math (fetched vs. total): pages ≈ `fetched-pages / ~808`; whole
archive ≈ `fetched / ~3,500–6,000 items` (dominated by documents). By **bytes**,
the archive total is ~2.5–5 GB, almost all PDFs.

To measure exactly:

- **Core %**: fetch `sitemap.xml`, count how many `<loc>` URLs exist in the
  `resource` table (case-insensitive).
- **True denominator**: run an uncapped `estimate` — it exhausts the frontier
  (HEAD-only, no downloads) and gives exact counts + summed `Content-Length` for
  the entire site. That's the definitive 100% to measure against.

The `link` table also shows the live frontier: `distinct in-scope to_url` not yet
a `resource` = discovered-but-unfetched (with a document/page breakdown).

---

## 11. Freshness & the `sync` frontier — when to revisit vs. skip

The `sync` mode makes the **`resource` table a durable priority queue** instead of
rebuilding an in-memory BFS each run. Two columns drive it:

- **`priority`** — tier: `0` core (sitemap page), `1` other page, `2` agenda PDF,
  `3` DocumentCenter PDF. Core is assigned from the sitemap; the rest by URL pattern.
- **`nextFetchAt`** — when the URL is next _due_. New → now; after a fetch → now +
  per-tier TTL.

A run: refresh seeds (sitemap → core tier, module roots) → drain all _due_
resources `ORDER BY (last_fetched_at IS NULL) DESC, priority, nextFetchAt` in
batches → each fetch reschedules itself and enqueues newly-discovered URLs as
due-now → stop when nothing is due. The `IS NULL` clause is **completeness before
freshness**: never-seen URLs (in priority order) are fetched before re-verifying
ones we already hold — so new content (e.g. thousands of documents) is captured
before we spend requests re-checking pages we already have.

This gives all four properties at once:

- **Core-first, then fan-out** — priority ordering drains the ~808 core pages
  before other pages, before documents.
- **Only what's needed** — a URL with `nextFetchAt > now` is skipped; conditional
  GET (`ETag`/`Last-Modified`) makes any re-fetch cheap (`304`); documents get a
  long TTL (near-immutable on CivicPlus).
- **Freshness signal** — sitemap `<lastmod>` (parsed via `parseSitemapEntries`) is
  compared to `lastChangedAt`; a page changed before its TTL is marked due early.
  (Matched case-sensitively on the sitemap's canonical `<loc>`.)
- **Resumable / idempotent** — all state is in the DB; `nextFetchAt` only advances
  after a successful fetch, so a crash just leaves the item due. Run it whenever;
  it does nothing if nothing's due, or drains the backlog if there is.

TTLs are env-tunable per tier (`CRAWLER_TTL_CORE_DAYS`, `_PAGE_`, `_AGENDA_`,
`_DOC_`; defaults 7/7/30/180); `CRAWLER_SYNC_BATCH` sizes the claim query;
`CRAWLER_ERROR_BACKOFF_HOURS` re-schedules a failed URL. The BFS `crawl`/`recrawl`
modes remain for one-shot use.

**Auto-schedule.** Set `SYNC_SCHEDULE_MINUTES` and an idle worker enqueues a `sync`
run that often (no external cron — the worker is the always-on component). It skips
when a run is already active, so runs never stack. It also **reaps stale runs**: a
`running`/`paused` row whose heartbeat is older than `WORKER_STALE_MINUTES` (default 5) is marked failed, so a crashed worker doesn't block claims or the schedule.
Scheduler-triggered runs are tagged `requested_by = 'scheduler'` (⏱ in the dashboard).

---

## 12. Traffic footprint (staying low-impact)

The crawl is deliberately unobtrusive:

- **Pacing**: `CRAWLER_RATE_LIMIT` base seconds + `CRAWLER_RATE_LIMIT_JITTER`
  random extra, so requests aren't a perfectly periodic (obviously-automated)
  signature. Single-threaded.
- **Bandwidth**: the visible cost is PDF egress (~GBs). Use the document size
  limit (§4) to archive HTML first and defer/skip large PDFs.
- **Politeness**: honors `robots.txt`, backs off on `429/503` (`Retry-After`),
  and uses conditional GETs so re-crawls are near-free.
- **Sitemap/RSS freshness (§11, §13)** means you rarely re-crawl broadly.
- **Run** overnight, in capped batches, from one stable IP (residential draws
  less WAF attention than datacenter IPs). Crawl once, then `blobs:push` to R2.
- **User-Agent** (`CRAWLER_USER_AGENT`) is a choice: an honest contactable string
  (`OrleansArchive/1.0 (+url; contact you@email)`) lets admins reach you instead
  of blocking; a browser-like string blends in. Public records law (MA) is on
  your side either way.

---

## 13. CivicPlus data sources

What the target exposes, and how we use it:

| Source                         | Status                  | Use                                                                                                        |
| ------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/sitemap.xml`                 | ✅ public, best signal  | ~808 pages **with `<lastmod>` + `<changefreq>`** — core page set + freshness.                              |
| `/RSSFeed.aspx?ModID=…&CID=…`  | ✅ robots-allowed       | Module feeds (news/alerts, agendas, bids) — cheap "what's new" polling.                                    |
| AgendaCenter (`/AgendaCenter`) | ✅ server-rendered HTML | Landing page directly lists agenda/minutes `ViewFile` PDFs — no API needed.                                |
| DocumentCenter documents       | ✅ via page links       | `/DocumentCenter/View/{id}/{slug}` links embedded in content pages.                                        |
| DocumentCenter data API        | ⛔ off-limits           | `/Admin/DocumentCenter/Folder/GetDocumentsForAFolder` is admin/auth-gated + `robots`-disallowed. Not used. |

Note: `robots.txt` disallows `/RSS.aspx` but **not** `/RSSFeed.aspx`; the
DocumentCenter index is a React SPA, so its folder listing isn't in the page HTML
(documents are still reached via the embedded `/View/{id}` links above).

---

## 14. Directory map

| Path                                                                 | What                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [`worker/`](../worker)                                               | The Bun sync worker + blob storage + sync CLI ([README](../worker/README.md)) |
| [`src/lib/server/db/`](../src/lib/server/db)                         | Schema, migrations, DB client ([README](../src/lib/server/db/README.md))      |
| [`src/lib/server/sync.ts`](../src/lib/server/sync.ts)                | Control plane + dashboard read models                                         |
| [`src/routes/dashboard/`](../src/routes/dashboard)                   | Dashboard UI + control actions ([README](../src/routes/dashboard/README.md))  |
| [`drizzle/`](../drizzle)                                             | Generated migrations (source of truth)                                        |
| [`scripts/orleans-civic-scraper/`](../scripts/orleans-civic-scraper) | **Legacy** Python prototype (superseded by `worker/`)                         |

---

## 15. Open items / future work

- **Case-duplicate URLs** — `normalize()` lowercases the host but not the path, so
  `/AgendaCenter` and `/agendacenter` become two resources for the same content.
  Lowercasing paths would dedupe them (safe for this IIS/CivicPlus target) but is a
  data migration on existing rows.
- **Blob location indicator** — show per-blob local/R2/both state in the dashboard.
- The CivicPlus DocumentCenter index is a React SPA; documents are still reached
  via links embedded in normal pages, so coverage is "reachable," not "entire
  library." The `/Search` skip also caps the AgendaCenter archive by design.
