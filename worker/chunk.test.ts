import { describe, it, expect } from 'vitest';
import { chunkText } from './chunk';

describe('chunkText', () => {
	it('returns no chunks for blank input', () => {
		expect(chunkText('')).toEqual([]);
		expect(chunkText('   \n\n  ')).toEqual([]);
	});

	it('keeps short text as a single chunk', () => {
		const text = 'A short paragraph of town-meeting notes.';
		const chunks = chunkText(text, { maxChars: 1000 });
		expect(chunks).toHaveLength(1);
		expect(chunks[0].index).toBe(0);
		expect(chunks[0].text).toBe(text);
	});

	it('records offsets that reproduce each chunk verbatim from the source', () => {
		const text = Array.from(
			{ length: 12 },
			(_, i) => `Paragraph number ${i} with some words.`
		).join('\n\n');
		const chunks = chunkText(text, { maxChars: 120, overlapChars: 20 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const ch of chunks) {
			expect(text.slice(ch.charStart, ch.charEnd)).toBe(ch.text);
			expect(ch.charEnd).toBeGreaterThan(ch.charStart);
		}
	});

	it('assigns sequential, non-decreasing indices and offsets', () => {
		const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i} here.`).join(' ');
		const chunks = chunkText(text, { maxChars: 60, overlapChars: 10 });
		chunks.forEach((ch, i) => expect(ch.index).toBe(i));
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].charStart).toBeGreaterThanOrEqual(chunks[i - 1].charStart);
		}
	});

	it('never exceeds maxChars per chunk', () => {
		const text =
			Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ') + '. ' + 'x'.repeat(500);
		const max = 80;
		const chunks = chunkText(text, { maxChars: max, overlapChars: 15 });
		for (const ch of chunks) expect(ch.text.length).toBeLessThanOrEqual(max);
	});

	it('hard-wraps a single over-long token with no natural boundaries', () => {
		const text = 'a'.repeat(250);
		const chunks = chunkText(text, { maxChars: 100, overlapChars: 0 });
		expect(chunks.length).toBe(3);
		expect(chunks.map((c) => c.text.length)).toEqual([100, 100, 50]);
	});

	it('overlaps consecutive chunks so boundary context is not lost', () => {
		const paras = Array.from({ length: 8 }, (_, i) => `Para ${i}: ` + 'w'.repeat(40));
		const text = paras.join('\n\n');
		const chunks = chunkText(text, { maxChars: 100, overlapChars: 30 });
		// at least one adjacent pair should share a source span (charStart of next < charEnd of prev)
		const overlapping = chunks.some((ch, i) => i > 0 && ch.charStart < chunks[i - 1].charEnd);
		expect(overlapping).toBe(true);
	});
});
