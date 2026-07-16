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
