// Crawl configuration for the Orleans CivicPlus site. Ported from the Python
// scraper's config.py — single source of truth for the TS sync worker.

export const BASE_URL = 'https://www.town.orleans.ma.us';
export const ALLOWED_HOSTS = new Set(['www.town.orleans.ma.us', 'town.orleans.ma.us']);

// Identify the crawler. Override via env to add a contact address.
export const USER_AGENT = process.env.CRAWLER_USER_AGENT ?? 'OCS/1.0';

// Politeness knobs.
export const RATE_LIMIT_SECONDS = Number(process.env.CRAWLER_RATE_LIMIT ?? 1.0);
// Extra random delay (0..N seconds) added to each request's pause. Smooths the
// traffic so it isn't a perfectly periodic, obviously-automated signature.
export const RATE_LIMIT_JITTER = Number(process.env.CRAWLER_RATE_LIMIT_JITTER ?? 0);
export const REQUEST_TIMEOUT_MS = Number(process.env.CRAWLER_TIMEOUT_MS ?? 30_000);
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MS = 5_000; // doubled per retry
export const MAX_PAGES = Number(process.env.CRAWLER_MAX_PAGES ?? 20_000); // hard safety cap

// Documents (PDF/Office) larger than this many bytes are recorded (size/etag)
// but NOT downloaded — HTML pages are always fetched. Undefined = download all;
// 0 = skip all documents (pages-only). Per-run `params.maxDocBytes` overrides.
export const MAX_DOC_BYTES: number | undefined =
	process.env.CRAWLER_MAX_DOC_BYTES != null && process.env.CRAWLER_MAX_DOC_BYTES !== ''
		? Number(process.env.CRAWLER_MAX_DOC_BYTES)
		: undefined;

// CivicPlus module roots. The sitemap covers "Pages" content; module content
// (agendas, documents) is only partially linked, so we seed the roots too.
// Override with CRAWLER_SEEDS (comma-separated paths/URLs) for a targeted crawl.
export const SEED_PATHS = process.env.CRAWLER_SEEDS
	? process.env.CRAWLER_SEEDS.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
	: [
			'/',
			'/sitemap.xml',
			'/AgendaCenter',
			'/DocumentCenter',
			'/Archive.aspx',
			'/CivicAlerts.aspx',
			'/FAQ.aspx',
			'/Directory.aspx',
			'/Bids.aspx',
			'/Calendar.aspx'
		];

// URL patterns to skip entirely (infinite spaces, session junk, utility pages).
export const SKIP_PATTERNS: RegExp[] = [
	/\/Search/i,
	/\/rss\.aspx/i,
	/\/List\.aspx/i, // Notify Me signup
	/\/MyAccount/i,
	/\/Admin/i,
	/login|logout/i,
	/[?&]month=/i, // calendar month pagination -> infinite space
	/[?&]year=\d{4}/i,
	/Calendar\.aspx\?.*(EID|view)=/i,
	/\/Facilities/i,
	/translate\.google/i,
	/\.(css|js|ico|woff2?|ttf|eot|map)(\?|$)/i
];

// Binary document types worth keeping (checked against the Content-Type header,
// NOT the URL — CivicPlus serves PDFs from extensionless endpoints).
export const DOC_CONTENT_TYPES: Record<string, string> = {
	'application/pdf': '.pdf',
	'application/msword': '.doc',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
	'application/vnd.ms-excel': '.xls',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
};

export function docExtFor(contentType: string): string | undefined {
	return DOC_CONTENT_TYPES[contentType];
}

// ---------------------------------------------------------------------------
// Frontier sync (mode = "sync"): priority tiers + freshness TTLs
// ---------------------------------------------------------------------------
// Priority: 0 = core (sitemap pages), 1 = other pages, 2 = agenda/minutes PDFs,
// 3 = DocumentCenter PDFs. Core (0) is assigned from the sitemap; everything else
// is classified by URL pattern here.
export function priorityFor(url: string): number {
	if (/\/DocumentCenter\/View\//i.test(url)) return 3;
	if (/\/AgendaCenter\/ViewFile\//i.test(url)) return 2;
	return 1;
}

const DAY = 86_400_000;

// How long a fetched resource stays "fresh" before it's due again, per tier.
export const TTL_MS: Record<number, number> = {
	0: Number(process.env.CRAWLER_TTL_CORE_DAYS ?? 7) * DAY, // core sitemap pages
	1: Number(process.env.CRAWLER_TTL_PAGE_DAYS ?? 7) * DAY, // other pages
	2: Number(process.env.CRAWLER_TTL_AGENDA_DAYS ?? 30) * DAY, // agenda/minutes PDFs
	3: Number(process.env.CRAWLER_TTL_DOC_DAYS ?? 180) * DAY // documents (near-immutable)
};

export function ttlFor(priority: number): number {
	return TTL_MS[priority] ?? TTL_MS[1];
}

// How many due resources to claim per batch, and how long to back off a failed URL.
export const SYNC_BATCH = Number(process.env.CRAWLER_SYNC_BATCH ?? 200);
export const SYNC_ERROR_BACKOFF_MS =
	Number(process.env.CRAWLER_ERROR_BACKOFF_HOURS ?? 6) * 3_600_000;

// ---------------------------------------------------------------------------
// Tick budget (the resumable core, worker/core.ts)
// ---------------------------------------------------------------------------
// A single `tick()` processes ONE bounded batch of frontier work and returns —
// bounded by BOTH a max item count AND a soft wall-time budget (whichever trips
// first). This is what makes the core resumable and driver-agnostic: a long-lived
// local driver pumps many ticks back-to-back; a serverless driver would run one
// tick per invocation. The bounds only chunk the work — the resulting rows/counts
// are identical to an unbounded loop, because each processed resource reschedules
// itself (see createSyncSession's freshness scheduling), so tick boundaries never
// double-process or drop work.
export const TICK_MAX_ITEMS = Number(process.env.WORKER_TICK_MAX_ITEMS ?? 200);
export const TICK_TIME_BUDGET_MS = Number(process.env.WORKER_TICK_BUDGET_MS ?? 10_000);

// Local-driver loop cadence (worker/driver.ts). How long to sleep when the core
// reports `idle` (nothing to claim), and how often to run maintenance (reap stale
// runs, sweep the worker registry, refresh standby, auto-schedule).
export const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 3000);
export const MAINTENANCE_INTERVAL_MS = Number(process.env.WORKER_MAINTENANCE_MS ?? 30_000);

// Auto-schedule: when > 0, an idle worker enqueues a `sync` run this often.
// 0 / unset = disabled (only manual/dashboard runs). See worker/index.ts.
export const SYNC_SCHEDULE_MS = Number(process.env.SYNC_SCHEDULE_MINUTES ?? 0) * 60_000;

// A run whose heartbeat is older than this is considered dead and reaped, so a
// crashed worker doesn't leave a `running` row blocking the schedule forever.
// Also the sweep threshold for the worker registry: a worker row not refreshed
// within this window is dropped (see sweepStaleWorkers in worker/index.ts).
export const STALE_RUN_MS = Number(process.env.WORKER_STALE_MINUTES ?? 5) * 60_000;

// A running run that keeps heartbeating but whose forward-progress counter hasn't
// advanced for this long is flagged "stalled" on the dashboard. WARNING ONLY —
// the worker never auto-fails a run on a stall. Read-model concern only (the
// dashboard derives the flag); the worker just records the progress marker.
export const PROGRESS_STALL_MS = Number(process.env.WORKER_STALL_MINUTES ?? 3) * 60_000;

// ---------------------------------------------------------------------------
// Embedding pipeline (mode = "embed"): chunking + embedding knobs. The vector
// DIMENSION is fixed by the schema (EMBED_DIM in crawl.schema.ts), not here — a
// model with different dims needs a migration. See worker/embeddings.ts for the
// provider selection and worker/chunk.ts for the splitter.
// ---------------------------------------------------------------------------
// Target chunk size (characters) and overlap between neighbouring chunks. Chunks
// split on natural boundaries (paragraph/sentence) and never exceed the max.
export const CHUNK_MAX_CHARS = Number(process.env.EMBED_CHUNK_CHARS ?? 1200);
export const CHUNK_OVERLAP_CHARS = Number(process.env.EMBED_CHUNK_OVERLAP ?? 200);
// How many chunks to send to the embedding model per request (batching).
export const EMBED_BATCH = Number(process.env.EMBED_BATCH ?? 32);
// Boilerplate/low-signal chunk filter (#59). A chunk whose content density —
// measured as its function-word (stopword) ratio, see worker/boilerplate.ts — is
// below this floor is treated as nav/menu/link-list/form chrome and kept OUT of
// the `chunk` index, so those near-duplicate low-signal snippets don't pollute
// retrieval. Genuine prose (FAQ answers, policy text, news) sits well above it
// (~0.25–0.50 on the real Orleans corpus) while nav/label chrome sits near zero,
// so 0.2 separates them with margin. Set to 0 to disable the filter entirely.
export const CHUNK_MIN_STOPWORD_RATIO = Number(process.env.EMBED_MIN_STOPWORD_RATIO ?? 0.2);
// Which embedding provider to use: 'cloudflare' | 'openai' | 'fake'. Unset =
// auto-detect from available credentials, falling back to the deterministic
// 'fake' embedder (so the pipeline runs offline / in CI). See selectEmbedder().
export const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER;
export const CLOUDFLARE_EMBED_MODEL =
	process.env.CLOUDFLARE_EMBED_MODEL ?? '@cf/baai/bge-base-en-v1.5';
export const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small';
