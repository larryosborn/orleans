// Eval runner CLI (#39). `bun run eval` (or `bun run worker/eval/run.ts`).
//
// Two modes, auto-selected:
//   • offline (default / no creds) — seeds a throwaway libSQL DB with the fixture
//     corpus + the deterministic fake embedder, and answers with the fake
//     grounding LLM. Fully reproducible, no network, CI-friendly.
//   • real (creds present, or --real) — runs the SAME question set against the
//     live archive (DATABASE_URL) using the configured embedder + Anthropic model.
//
// Flags:
//   --real / --offline   force a mode (default: real when ANTHROPIC_API_KEY set)
//   --topK <n>           passages to retrieve per question (default 4)
//   --markdown           emit a Markdown report instead of the text one
//   --strict             exit non-zero if any metric is below 100% (CI gate).
//                        Off by default — the report is informational unless asked.
import { selectEmbedder } from '../embeddings';
import { retrieve } from '../../src/lib/server/rag/retrieve';
import { search, type SearchOptions } from '../../src/lib/server/rag/search';
import { resolveProvider, type RetrievalProvider } from '../../src/lib/server/rag/provider';
import { answer } from '../../src/lib/server/rag/answer';
import { questions } from './questions';
import { createFixtureDb, makeFakeAiSearchFetch, makeGroundingFakeLlm } from './corpus';
import { runEval, formatReport, formatMarkdown, type RunEvalDeps } from './harness';

interface CliOptions {
	real: boolean;
	topK: number;
	markdown: boolean;
	strict: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const has = (f: string) => argv.includes(f);
	const topKArg = argv[argv.indexOf('--topK') + 1];
	const real = has('--real') || (!has('--offline') && !!process.env.ANTHROPIC_API_KEY);
	return {
		real,
		topK: has('--topK') && topKArg ? Math.max(1, Number(topKArg)) : 4,
		markdown: has('--markdown'),
		strict: has('--strict')
	};
}

/** Offline deps: throwaway DB + fixtures + fakes. Returns deps and a cleanup fn.
 *  The retrieval provider is selected by RETRIEVAL_PROVIDER so the offline eval can
 *  compare vectorize vs ai-search with no network — ai-search runs against a
 *  deterministic fake AI Search endpoint built from the same fixture corpus. */
async function offlineDeps(
	topK: number,
	provider: RetrievalProvider
): Promise<{ deps: RunEvalDeps; cleanup: () => void }> {
	if (provider === 'ai-search') {
		// Options are typed SearchOptions (a superset of RetrieveOptions) so the extra
		// AI Search knobs survive assignment into RunEvalDeps.retrieveOptions.
		const retrieveOptions: SearchOptions = {
			topK,
			fetch: makeFakeAiSearchFetch(),
			accountId: 'offline',
			instance: 'offline',
			token: 'offline'
		};
		return {
			deps: {
				retrieve: search,
				answer,
				retrieveOptions,
				answerOptions: { llm: makeGroundingFakeLlm() }
			},
			cleanup: () => {}
		};
	}
	const { client, embedder, cleanup } = await createFixtureDb();
	return {
		deps: {
			retrieve,
			answer,
			retrieveOptions: { client, embedder, topK },
			answerOptions: { llm: makeGroundingFakeLlm() }
		},
		cleanup
	};
}

/** Real deps: the worker's own libSQL client (DATABASE_URL) + configured models.
 *  With RETRIEVAL_PROVIDER=ai-search, retrieval goes to the live AI Search endpoint
 *  (CF_ACCOUNT_ID / AI_SEARCH_INSTANCE / AI_SEARCH_TOKEN via env) instead. */
async function realDeps(
	topK: number,
	provider: RetrievalProvider
): Promise<{ deps: RunEvalDeps; cleanup: () => void }> {
	if (provider === 'ai-search') {
		return {
			deps: { retrieve: search, answer, retrieveOptions: { topK } },
			cleanup: () => {}
		};
	}
	// Import lazily so the offline path never needs DATABASE_URL.
	const { client } = await import('../db');
	const embedder = selectEmbedder();
	return {
		// selectLlm() (inside answer()) picks the real Anthropic client from creds.
		deps: { retrieve, answer, retrieveOptions: { client, embedder, topK } },
		cleanup: () => {}
	};
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const provider = resolveProvider(); // RETRIEVAL_PROVIDER: vectorize (default) | ai-search
	const { deps, cleanup } = opts.real
		? await realDeps(opts.topK, provider)
		: await offlineDeps(opts.topK, provider);
	const base = opts.real ? 'RAG eval (real models + live archive)' : 'RAG eval (offline fakes)';
	const title = `${base} · retrieval: ${provider}`;

	try {
		const report = await runEval(questions, deps);
		console.log(opts.markdown ? formatMarkdown(report, title) : formatReport(report, title));

		if (opts.strict) {
			const m = report.metrics;
			const failed =
				m.citationValidity < 1 ||
				m.modeCorrectness < 1 ||
				(!Number.isNaN(m.retrievalHitRate) && m.retrievalHitRate < 1);
			if (failed) {
				console.error('\n✗ --strict: a metric is below 100%');
				process.exitCode = 1;
			}
		}
	} finally {
		cleanup();
	}
}

// Bun sets import.meta.main for the entrypoint; guard so tests can import freely.
if (import.meta.main) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
