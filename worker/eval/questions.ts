// The curated eval question set (#39) — the contract this harness measures the
// RAG pipeline against. Each entry pairs a natural-language question with the
// behaviour we EXPECT from `retrieve()` + `answer()` (#36/#37):
//
//   • grounded  — the archive covers it; the answerer should answer from the
//                 retrieved passages and cite a real source. `expectedSource`
//                 (when set) is the doc that ought to surface in retrieval.
//   • abstained — a HARD, SPECIFIC civic fact (a fee, date, deadline, or who
//                 holds an office) the archive does NOT cover; the answerer must
//                 refuse rather than guess. This is the accuracy/abstention bar.
//   • fallback  — an explanatory / "in general" question the archive doesn't
//                 cover; a labeled general-knowledge answer is allowed, with no
//                 citation.
//
// The set covers every example question raised in the RAG epic (#32) — beach
// stickers, town meeting, dogs at Kent's Point, the July 4th parade/fireworks,
// election results, and "who runs this place" — plus a few more, tagged across
// all three expected modes so the eval exercises grounding AND abstention.
//
// The `expectedSource` URLs line up with the offline fixture corpus in
// `corpus.ts`; a real-model run against the live archive ignores them for
// hit-rate unless the same URL is present there too.
import type { AnswerMode } from '../../src/lib/server/rag/answer';

export interface EvalQuestion {
	/** The natural-language question sent through retrieve() + answer(). */
	question: string;
	/** The mode we expect the answerer to choose (the behaviour under test). */
	expectedMode: AnswerMode;
	/** For grounded questions: the source URL that SHOULD surface in retrieval.
	 *  Drives the retrieval hit-rate metric. Omit when no single source applies
	 *  (e.g. abstain/fallback questions the archive shouldn't cover). */
	expectedSource?: string;
	/** Why this question is tagged the way it is — shown in the report. */
	note?: string;
}

// Fixture source URLs, kept in one place so questions and the offline corpus
// (corpus.ts) can't drift apart.
export const SOURCES = {
	beach: 'https://www.town.orleans.ma.us/parks-beaches/beach-stickers',
	townMeeting: 'https://www.town.orleans.ma.us/town-clerk/annual-town-meeting',
	kentsPoint: 'https://www.town.orleans.ma.us/conservation/kents-point',
	government: 'https://www.town.orleans.ma.us/select-board/form-of-government'
} as const;

export const questions: EvalQuestion[] = [
	// --- grounded: the archive covers it → answer + cite ---------------------
	{
		question: 'How do I get a beach parking sticker for Nauset Beach?',
		expectedMode: 'grounded',
		expectedSource: SOURCES.beach,
		note: '#32 example: beach stickers'
	},
	{
		question: 'When is the Annual Town Meeting held?',
		expectedMode: 'grounded',
		expectedSource: SOURCES.townMeeting,
		note: '#32 example: town meeting'
	},
	{
		question: "Are dogs allowed off-leash at Kent's Point?",
		expectedMode: 'grounded',
		expectedSource: SOURCES.kentsPoint,
		note: "#32 example: dog rules at Kent's Point"
	},
	{
		question: 'Who runs the town government in Orleans?',
		expectedMode: 'grounded',
		expectedSource: SOURCES.government,
		note: '#32 example: "who runs this place"'
	},
	{
		question: 'What is the form of government for the Town of Orleans?',
		expectedMode: 'grounded',
		expectedSource: SOURCES.government,
		note: 'grounded variant of the governance question'
	},

	// --- abstained: hard specific the archive does NOT cover → refuse --------
	{
		question: 'What is the fee for a 2026 resident shellfish permit?',
		expectedMode: 'abstained',
		note: 'hard specific (a fee) with no supporting record — must not guess'
	},
	{
		question: 'When will the 2026 town election results be certified?',
		expectedMode: 'abstained',
		note: '#32 example: election results — a specific date the archive lacks'
	},
	{
		question: 'What time do the July 4th fireworks begin this year?',
		expectedMode: 'abstained',
		note: '#32 example: parade/fireworks — a specific time the archive lacks'
	},

	// --- fallback: explanatory / general, not in the records → labeled -------
	{
		question: 'Why do coastal towns regulate shellfishing in general?',
		expectedMode: 'fallback',
		note: 'explanatory background the town records do not cover'
	},
	{
		question: 'How does municipal zoning generally work?',
		expectedMode: 'fallback',
		note: 'general "how does X work" — allowed as labeled general knowledge'
	}
];
