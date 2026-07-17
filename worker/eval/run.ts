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
import { answer } from '../../src/lib/server/rag/answer';
import { questions } from './questions';
import { createFixtureDb, makeGroundingFakeLlm } from './corpus';
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

/** Offline deps: throwaway DB + fixtures + fakes. Returns deps and a cleanup fn. */
async function offlineDeps(topK: number): Promise<{ deps: RunEvalDeps; cleanup: () => void }> {
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

/** Real deps: the worker's own libSQL client (DATABASE_URL) + configured models. */
async function realDeps(topK: number): Promise<{ deps: RunEvalDeps; cleanup: () => void }> {
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
	const { deps, cleanup } = opts.real ? await realDeps(opts.topK) : await offlineDeps(opts.topK);
	const title = opts.real ? 'RAG eval (real models + live archive)' : 'RAG eval (offline fakes)';

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
