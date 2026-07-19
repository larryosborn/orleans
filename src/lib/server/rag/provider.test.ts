// Retrieval-provider switch test (#63). Proves RETRIEVAL_PROVIDER cleanly selects
// the custom vectorize retriever (default) vs the AI Search provider, and that an
// unset/unknown value keeps today's default — no behaviour change unless opted in.
import { afterEach, describe, it, expect } from 'vitest';
import { resolveProvider, selectRetriever, DEFAULT_RETRIEVAL_PROVIDER } from './provider';
import { retrieve } from './retrieve';
import { search } from './search';

const original = process.env.RETRIEVAL_PROVIDER;
afterEach(() => {
	if (original === undefined) delete process.env.RETRIEVAL_PROVIDER;
	else process.env.RETRIEVAL_PROVIDER = original;
});

describe('retrieval provider switch', () => {
	it('defaults to vectorize when unset', () => {
		delete process.env.RETRIEVAL_PROVIDER;
		expect(DEFAULT_RETRIEVAL_PROVIDER).toBe('vectorize');
		expect(resolveProvider()).toBe('vectorize');
		expect(selectRetriever()).toBe(retrieve);
	});

	it('selects ai-search when RETRIEVAL_PROVIDER=ai-search', () => {
		process.env.RETRIEVAL_PROVIDER = 'ai-search';
		expect(resolveProvider()).toBe('ai-search');
		expect(selectRetriever()).toBe(search);
	});

	it('is case-insensitive and trims', () => {
		expect(resolveProvider('  AI-Search ')).toBe('ai-search');
		expect(selectRetriever('  AI-Search ')).toBe(search);
	});

	it('falls back to the default on an unknown value (never silently disables)', () => {
		process.env.RETRIEVAL_PROVIDER = 'pinecone';
		expect(resolveProvider()).toBe('vectorize');
		expect(selectRetriever()).toBe(retrieve);
	});

	it('an explicit argument overrides the env var', () => {
		process.env.RETRIEVAL_PROVIDER = 'vectorize';
		expect(selectRetriever('ai-search')).toBe(search);
	});
});
