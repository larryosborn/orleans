// Text chunker — stage 2 of the RAG pipeline (#35). Splits a resource's cleaned
// extracted text (from `resource_text`, #34) into retrieval-sized pieces and
// records each piece's char offsets back into the source, so a retrieved chunk
// can be attributed to (and re-sliced from) the exact span it came from.
//
// A boundary-snapping sliding window: each chunk is at most `maxChars` wide, its
// end snapped back to the nearest natural break (paragraph → line → sentence →
// word) so we don't cut mid-word, and the next window starts `overlapChars`
// before the previous end so meaning that straddles a boundary isn't lost.
// Offsets always index the ORIGINAL string, so `text.slice(charStart, charEnd)`
// reproduces the chunk verbatim.
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS } from './config';

export interface Chunk {
	index: number; // 0-based order within the resource
	text: string;
	charStart: number; // inclusive offset into the source text
	charEnd: number; // exclusive offset into the source text
}

export interface ChunkOptions {
	maxChars?: number;
	overlapChars?: number;
}

/** Split `text` into ordered, offset-tagged chunks. Returns [] for blank input. */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
	const maxChars = Math.max(1, opts.maxChars ?? CHUNK_MAX_CHARS);
	// Overlap must stay below maxChars, else a chunk can't make forward progress.
	const overlap = Math.min(Math.max(0, opts.overlapChars ?? CHUNK_OVERLAP_CHARS), maxChars - 1);
	const n = text.length;

	if (!text.trim()) return [];

	const chunks: Chunk[] = [];
	let start = skipSpaceForward(text, 0, n);

	while (start < n) {
		const hardEnd = Math.min(start + maxChars, n);
		// Snap the window end to a natural boundary (unless it's the end of the text).
		let end = hardEnd;
		if (hardEnd < n) {
			const bp = findBreak(text, start, hardEnd);
			if (bp > start) end = bp;
		}

		// Record the span with whitespace trimmed off its edges (offsets stay exact).
		let e = end;
		while (e > start && /\s/.test(text[e - 1])) e--;
		if (e > start) {
			chunks.push({
				index: chunks.length,
				text: text.slice(start, e),
				charStart: start,
				charEnd: e
			});
		}

		if (end >= n) break;

		// Advance, backing up by the overlap so the next chunk re-includes context.
		let next = end - overlap;
		if (next <= start) next = end; // overlap would stall — skip it this step
		next = skipSpaceForward(text, next, n);
		if (next <= start) next = start + 1; // guarantee forward progress
		start = next;
	}

	return chunks;
}

function skipSpaceForward(text: string, i: number, n: number): number {
	while (i < n && /\s/.test(text[i])) i++;
	return i;
}

/** Find the best cut point in `(minEnd, hardEnd]` — the position just after the
 *  nearest natural boundary to `hardEnd`. Prefers newline > sentence end > word
 *  space. Returns -1 when none is found (caller then hard-cuts at `hardEnd`).
 *  `minEnd` keeps chunks from collapsing to tiny fragments. */
function findBreak(text: string, start: number, hardEnd: number): number {
	const minEnd = start + Math.max(1, Math.floor((hardEnd - start) / 2));
	let sentence = -1;
	let space = -1;
	for (let i = hardEnd; i > minEnd; i--) {
		const prev = text[i - 1];
		if (prev === '\n') return i; // strongest boundary; take the one nearest hardEnd
		if (sentence < 0 && (prev === '.' || prev === '!' || prev === '?')) {
			if (i >= text.length || /\s/.test(text[i])) sentence = i;
		}
		if (space < 0 && /\s/.test(prev)) space = i;
	}
	return sentence >= 0 ? sentence : space;
}
