// URL hygiene, hashing, robots.txt, and a polite retrying fetch. Ports the
// Python crawler's helpers to TS with no external deps (regex-based parsing,
// which held up well against this exact CivicPlus site during profiling).
import {
	ALLOWED_HOSTS,
	MAX_RETRIES,
	REQUEST_TIMEOUT_MS,
	RETRY_BACKOFF_MS,
	SKIP_PATTERNS,
	USER_AGENT
} from './config';

const TRACKING_PREFIXES = ['utm_', 'fbclid', 'gclid'];

/** Canonicalize a URL: drop fragment + tracking params, sort query, lower host. */
export function normalize(raw: string, base?: string): string {
	let u: URL;
	try {
		u = base ? new URL(raw, base) : new URL(raw);
	} catch {
		return raw;
	}
	u.hash = '';
	u.hostname = u.hostname.toLowerCase();
	const keep = [...u.searchParams.entries()].filter(
		([k]) => !TRACKING_PREFIXES.some((p) => k.toLowerCase().startsWith(p))
	);
	keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	u.search = '';
	const sp = new URLSearchParams();
	for (const [k, v] of keep) sp.append(k, v);
	const qs = sp.toString();
	return `${u.protocol}//${u.host}${u.pathname}${qs ? `?${qs}` : ''}`;
}

export function inScope(url: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
	if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) return false;
	return !SKIP_PATTERNS.some((rx) => rx.test(url));
}

export function sha256Hex(data: Uint8Array | string): string {
	return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return '';
	}
}

export function pathOf(url: string): string {
	try {
		const u = new URL(url);
		return u.pathname + u.search;
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// Discovery parsers (regex-based; adequate for anchor hrefs and <loc> entries)
// ---------------------------------------------------------------------------
const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const HREF_RE = /<a\s[^>]*?href\s*=\s*["']([^"']+)["']/gi;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

export function parseSitemap(xml: string): string[] {
	const out: string[] = [];
	for (const m of xml.matchAll(LOC_RE)) out.push(m[1].trim());
	return out;
}

export interface SitemapEntry {
	loc: string;
	lastmod?: string;
	changefreq?: string;
}

const URL_BLOCK_RE = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;

/** Parse `<url>` entries with their `<lastmod>`/`<changefreq>` freshness hints. */
export function parseSitemapEntries(xml: string): SitemapEntry[] {
	const out: SitemapEntry[] = [];
	for (const m of xml.matchAll(URL_BLOCK_RE)) {
		const block = m[1];
		const loc = block.match(/<loc>\s*([^<\s]+)\s*<\/loc>/i)?.[1]?.trim();
		if (!loc) continue;
		out.push({
			loc,
			lastmod: block.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/i)?.[1]?.trim(),
			changefreq: block.match(/<changefreq>\s*([^<\s]+)\s*<\/changefreq>/i)?.[1]?.trim()
		});
	}
	// Fall back to bare <loc> list (e.g. a sitemap index of nested sitemaps).
	if (out.length === 0) for (const loc of parseSitemap(xml)) out.push({ loc });
	return out;
}

/** Remove the full `<div …>…</div>` block starting at the first match of `openRe`,
 *  balancing nested divs (which regex can't). Recurses to strip every occurrence. */
function stripDivBlock(html: string, openRe: RegExp): string {
	const m = openRe.exec(html);
	if (!m) return html;
	const scan = /<div\b|<\/div>/gi;
	scan.lastIndex = m.index;
	let depth = 0;
	let t: RegExpExecArray | null;
	while ((t = scan.exec(html))) {
		if (t[0][1] === '/') {
			if (--depth === 0) {
				return stripDivBlock(html.slice(0, m.index) + html.slice(scan.lastIndex), openRe);
			}
		} else {
			depth++;
		}
	}
	return html; // unbalanced — leave it
}

// CivicPlus rotating photo carousel: the whole widget (slides, nav dots, image
// selection, per-request ids) differs every request. Stable pages don't have it.
const SLIDESHOW_OPEN = /<div class="widget slideShow\b/i;

/**
 * Strip per-request volatile bits from CivicPlus/ASP.NET HTML so re-fetches of an
 * unchanged page hash identically — no false `changed` versions, and identical
 * pages dedupe to one blob. Only junk is removed (ASP.NET WebForms state tokens,
 * randomized ids, and the rotating slideshow); visible content/links/text stay.
 */
export function normalizeHtml(html: string): string {
	return (
		stripDivBlock(html, SLIDESHOW_OPEN)
			// ASP.NET hidden fields (__VIEWSTATE, __VIEWSTATEGENERATOR, *Token, …): blank the value
			.replace(
				/(<input\b[^>]*\bname="(?:__[A-Za-z]+|[^"]*Token[^"]*)"[^>]*\bvalue=")[^"]*(")/gi,
				'$1$2'
			)
			// …and the value-before-name attribute ordering
			.replace(
				/(<input\b[^>]*\bvalue=")[^"]*("[^>]*\bname="(?:__[A-Za-z]+|[^"]*Token[^"]*)")/gi,
				'$1$2'
			)
			// CivicPlus per-request random element ids: anch<hex> / row<hex> (id="" or href="#…")
			.replace(/\b(anch|row)[0-9a-f]{6,}\b/gi, '$1_')
	);
}

export function extractLinks(baseUrl: string, html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(HREF_RE)) {
		const href = m[1].trim();
		if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
		out.push(normalize(href, baseUrl));
	}
	return out;
}

export function pageTitle(html: string): string | undefined {
	const m = html.match(TITLE_RE);
	return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
}

export function filenameHint(resp: Response): string | undefined {
	const cd = resp.headers.get('Content-Disposition') ?? '';
	const m = cd.match(/filename\*?="?([^";]+)/i);
	return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
interface RobotsRule {
	allow: boolean;
	pattern: string;
}

export class Robots {
	private rules: RobotsRule[] = [];

	static async load(baseUrl: string): Promise<Robots> {
		const r = new Robots();
		try {
			const resp = await fetch(new URL('/robots.txt', baseUrl), {
				headers: { 'User-Agent': USER_AGENT },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (resp.ok) r.parse(await resp.text());
		} catch {
			// No robots.txt reachable — default to permissive, matching the Python.
		}
		return r;
	}

	/** Parse the group applicable to our UA (falling back to `*`). */
	private parse(text: string): void {
		const groups = new Map<string, RobotsRule[]>();
		let current: string[] = [];
		for (const line of text.split(/\r?\n/)) {
			const stripped = line.replace(/#.*$/, '').trim();
			if (!stripped) continue;
			const idx = stripped.indexOf(':');
			if (idx === -1) continue;
			const field = stripped.slice(0, idx).trim().toLowerCase();
			const value = stripped.slice(idx + 1).trim();
			if (field === 'user-agent') {
				const ua = value.toLowerCase();
				if (!groups.has(ua)) groups.set(ua, []);
				current = groups.get(ua)!;
			} else if (field === 'disallow' || field === 'allow') {
				current.push({ allow: field === 'allow', pattern: value });
			}
		}
		const ua = USER_AGENT.toLowerCase();
		const match =
			[...groups.keys()].find((k) => k !== '*' && ua.includes(k)) ?? (groups.has('*') ? '*' : null);
		this.rules = match ? (groups.get(match) ?? []) : [];
	}

	canFetch(url: string): boolean {
		const path = pathOf(url) || '/';
		let decision: { allow: boolean; len: number } | null = null;
		for (const rule of this.rules) {
			if (rule.pattern === '') continue; // empty Disallow = allow all
			if (this.matches(rule.pattern, path)) {
				const len = rule.pattern.length;
				// Longest match wins; Allow breaks ties (RFC 9309 semantics).
				if (!decision || len > decision.len || (len === decision.len && rule.allow)) {
					decision = { allow: rule.allow, len };
				}
			}
		}
		return decision ? decision.allow : true;
	}

	private matches(pattern: string, path: string): boolean {
		const anchored = pattern.endsWith('$');
		const body = anchored ? pattern.slice(0, -1) : pattern;
		const rx =
			'^' +
			body
				.split('*')
				.map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
				.join('.*') +
			(anchored ? '$' : '');
		try {
			return new RegExp(rx).test(path);
		} catch {
			return path.startsWith(body);
		}
	}
}

// ---------------------------------------------------------------------------
// Polite fetch with retry + 429/503 Retry-After backoff
// ---------------------------------------------------------------------------
export interface FetchResult {
	resp: Response | null;
	throttled: boolean;
	error?: string;
}

export async function politeFetch(
	url: string,
	headers: Record<string, string>,
	opts: { method?: 'GET' | 'HEAD' } = {}
): Promise<FetchResult> {
	let delay = RETRY_BACKOFF_MS;
	let throttled = false;
	let lastErr = '';
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const resp = await fetch(url, {
				method: opts.method ?? 'GET',
				headers: { 'User-Agent': USER_AGENT, ...headers },
				redirect: 'follow',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (resp.status === 429 || resp.status === 503) {
				throttled = true;
				const retryAfter = Number(resp.headers.get('Retry-After'));
				const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : delay;
				await Bun.sleep(wait);
				delay *= 2;
				continue;
			}
			return { resp, throttled };
		} catch (e) {
			lastErr = e instanceof Error ? e.message : String(e);
			await Bun.sleep(delay);
			delay *= 2;
		}
	}
	return { resp: null, throttled, error: lastErr };
}
