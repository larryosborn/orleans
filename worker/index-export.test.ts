// Cleaned-text R2 exporter test (#63). Three layers, all offline:
//   1. buildIndexObject / sanitizeMetaValue — the pure selection + skip + truncation rules
//      (non-ok skipped, oversize skipped, url/title metadata capped at 500 chars).
//   2. makeR2IndexWriter against a STUB S3 server (node http) — proves the real
//      aws4fetch-signed PUT carries the object body + x-amz-meta-source-url/title/
//      kind custom headers (the metadata Bun's S3Client can't set). Mirrors the
//      #30 storage test's "stub S3 server" approach.
//   3. executeIndexExport against a seeded libSQL DB + an injected capturing writer
//      — proves the run exports only `ok` resources with correct keys + metadata and
//      finalizes the sync_run.
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildIndexObject,
	sanitizeMetaValue,
	makeR2IndexWriter,
	MAX_OBJECT_BYTES,
	META_VALUE_MAX,
	type IndexObjectMeta,
	type IndexWriter
} from './index-export';

const okRow = {
	resourceId: 'res-1',
	url: 'https://www.town.orleans.ma.us/beach',
	title: 'Beach Stickers',
	kind: 'page',
	status: 'ok',
	text: 'Nauset Beach resident parking stickers and beach permits.'
};

describe('buildIndexObject', () => {
	it('builds an index/<resourceId>.md object with source-url/title/kind metadata', () => {
		const obj = buildIndexObject(okRow);
		if ('skip' in obj) throw new Error(`unexpected skip: ${obj.skip}`);
		expect(obj.key).toBe('index/res-1.md');
		expect(obj.contentType).toBe('text/markdown; charset=utf-8');
		expect(new TextDecoder().decode(obj.bytes)).toBe(okRow.text);
		expect(obj.meta).toEqual({
			sourceUrl: 'https://www.town.orleans.ma.us/beach',
			title: 'Beach Stickers',
			kind: 'page'
		});
	});

	it('skips non-ok resources', () => {
		for (const status of ['empty', 'scanned', 'unsupported']) {
			expect(buildIndexObject({ ...okRow, status })).toEqual({ skip: `status ${status} (not ok)` });
		}
	});

	it('skips a resource with blank text', () => {
		expect(buildIndexObject({ ...okRow, text: '   ' })).toEqual({ skip: 'empty text' });
		expect(buildIndexObject({ ...okRow, text: null })).toEqual({ skip: 'empty text' });
	});

	it('skips an object over the 4 MB ceiling', () => {
		const big = 'x'.repeat(MAX_OBJECT_BYTES + 1);
		const obj = buildIndexObject({ ...okRow, text: big });
		expect('skip' in obj && obj.skip).toMatch(/oversize/);
	});

	it('accepts an object exactly at the ceiling', () => {
		const exact = 'x'.repeat(MAX_OBJECT_BYTES);
		expect('skip' in buildIndexObject({ ...okRow, text: exact })).toBe(false);
	});

	it('truncates url/title metadata to the AI Search 500-char limit', () => {
		const longUrl = 'https://x/' + 'a'.repeat(600);
		const obj = buildIndexObject({ ...okRow, url: longUrl, title: 'b'.repeat(600) });
		if ('skip' in obj) throw new Error('unexpected skip');
		expect(obj.meta.sourceUrl).toHaveLength(META_VALUE_MAX);
		expect(obj.meta.title).toHaveLength(META_VALUE_MAX);
	});
});

describe('sanitizeMetaValue', () => {
	it('strips non-ASCII and control chars to a valid header value', () => {
		expect(sanitizeMetaValue('Beach — Stickers\n\t(été)')).toBe('Beach  Stickers (t)');
	});
	it('defaults null/undefined to empty', () => {
		expect(sanitizeMetaValue(null)).toBe('');
		expect(sanitizeMetaValue(undefined)).toBe('');
	});
});

// ---------------------------------------------------------------------------
// makeR2IndexWriter against a stub S3 server.
// ---------------------------------------------------------------------------
interface CapturedPut {
	method: string;
	path: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

describe('makeR2IndexWriter (aws4fetch → stub S3)', () => {
	let server: Server;
	let base: string;
	const puts: CapturedPut[] = [];

	beforeAll(async () => {
		server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', () => {
				puts.push({
					method: req.method ?? '',
					path: req.url ?? '',
					headers: req.headers,
					body: Buffer.concat(chunks).toString('utf8')
				});
				res.writeHead(200).end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const addr = server.address();
		if (!addr || typeof addr === 'string') throw new Error('no server address');
		base = `http://127.0.0.1:${addr.port}`;
	});

	afterAll(() => {
		server?.close();
	});

	it('signs a PUT carrying the body + x-amz-meta-* custom metadata', async () => {
		const writer = makeR2IndexWriter({
			endpoint: base,
			bucket: 'test-bucket',
			accessKeyId: 'AKIA_TEST',
			secretAccessKey: 'secret'
		});
		expect(writer).not.toBeNull();

		const meta: IndexObjectMeta = {
			sourceUrl: 'https://www.town.orleans.ma.us/beach',
			title: 'Beach Stickers',
			kind: 'page'
		};
		await writer!.put(
			'index/res-1.md',
			new TextEncoder().encode('hello clean text'),
			'text/markdown; charset=utf-8',
			meta
		);

		expect(puts).toHaveLength(1);
		const put = puts[0];
		expect(put.method).toBe('PUT');
		expect(put.path).toBe('/test-bucket/index/res-1.md');
		expect(put.body).toBe('hello clean text');
		expect(put.headers['x-amz-meta-source-url']).toBe('https://www.town.orleans.ma.us/beach');
		expect(put.headers['x-amz-meta-title']).toBe('Beach Stickers');
		expect(put.headers['x-amz-meta-kind']).toBe('page');
		expect(String(put.headers['content-type'])).toContain('text/markdown');
		// aws4fetch signs the request — so the metadata is part of the signature.
		expect(String(put.headers['authorization'])).toMatch(/^AWS4-HMAC-SHA256/);
	});

	it('returns null when R2 config is incomplete', () => {
		expect(makeR2IndexWriter({ endpoint: base })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// executeIndexExport against a seeded DB + injected capturing writer.
// ---------------------------------------------------------------------------
const drizzleDir = fileURLToPath(new URL('../drizzle/', import.meta.url));

describe('executeIndexExport', () => {
	let tmp: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let db: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let schema: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let client: any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let executeIndexExport: any;

	beforeAll(async () => {
		(globalThis as unknown as { Bun?: unknown }).Bun ??= { sleep: () => Promise.resolve() };
		tmp = mkdtempSync(join(tmpdir(), 'index-export-'));
		process.env.DATABASE_URL = `file:${join(tmp, 'test.db')}`;
		delete process.env.DATABASE_AUTH_TOKEN;
		({ db, client } = await import('./db'));
		schema = await import('../src/lib/server/db/schema');
		const { applyMigrations } = await import('../src/lib/server/db/migrator');
		({ executeIndexExport } = await import('./index-export'));
		const entries = readdirSync(drizzleDir)
			.filter((f) => f.endsWith('.sql'))
			.map((name) => ({ name, sql: readFileSync(join(drizzleDir, name), 'utf8') }));
		await applyMigrations(client, entries);

		// Two `ok` resources (should export) + one `empty` (should not).
		const rows = [
			{ id: 'r-ok-1', url: 'https://x/one', title: 'One', status: 'ok', text: 'clean text one' },
			{ id: 'r-ok-2', url: 'https://x/two', title: 'Two', status: 'ok', text: 'clean text two' },
			{ id: 'r-empty', url: 'https://x/none', title: 'None', status: 'empty', text: null }
		];
		for (const r of rows) {
			await db.insert(schema.resource).values({
				id: r.id,
				url: r.url,
				urlHash: `h-${r.id}`,
				host: 'x',
				path: new URL(r.url).pathname,
				kind: 'page',
				title: r.title,
				state: 'active',
				sha256: `sha-${r.id}`
			});
			await db.insert(schema.resourceText).values({
				resourceId: r.id,
				sha256: `sha-${r.id}`,
				contentType: 'text/html',
				status: r.status,
				text: r.text,
				charCount: r.text?.length ?? 0,
				extractor: 'test'
			});
		}
	});

	afterAll(() => {
		client?.close();
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	it('exports only ok resources with correct keys + metadata, and finalizes the run', async () => {
		const written: { key: string; meta: IndexObjectMeta; text: string }[] = [];
		const writer: IndexWriter = {
			label: 'capture',
			async put(key, bytes, _ct, meta) {
				written.push({ key, meta, text: new TextDecoder().decode(bytes) });
			}
		};

		const [run] = await db
			.insert(schema.syncRun)
			.values({ mode: 'index-export', status: 'queued', requestedBy: 'test' })
			.returning();

		await executeIndexExport(run, { writer });

		expect(written.map((w) => w.key).sort()).toEqual(['index/r-ok-1.md', 'index/r-ok-2.md']);
		// the empty resource was never written
		expect(written.some((w) => w.key.includes('r-empty'))).toBe(false);
		const one = written.find((w) => w.key === 'index/r-ok-1.md');
		expect(one?.text).toBe('clean text one');
		expect(one?.meta).toEqual({ sourceUrl: 'https://x/one', title: 'One', kind: 'page' });

		const [finished] = await db.select().from(schema.syncRun).limit(1);
		expect(finished.status).toBe('completed');
	});
});
