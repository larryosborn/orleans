# RAG eval

Measures the chat pipeline (retrieval → grounded answer) against a tagged
question set — **retrieval hit-rate**, **answer-mode correctness** (grounded /
labeled-fallback / abstained), and **citation validity** (cited ⊆ retrieved).

```sh
bun run eval            # offline: fake embedder + deterministic LLM, fixture corpus
bun run eval --real     # real: uses your embedded corpus + Anthropic (needs keys)
bun run eval --markdown # markdown report   ·   --strict (nonzero exit on any miss)   ·   --topK N
```

`--real` is implied when `ANTHROPIC_API_KEY` is set; `--offline` forces fakes.

## Retrieval provider (`RETRIEVAL_PROVIDER`)

The eval honors `RETRIEVAL_PROVIDER`, so custom-vs-AI-Search is one switch:

```sh
bun run eval                              # vectorize (default): our libSQL vector search
RETRIEVAL_PROVIDER=ai-search bun run eval # Cloudflare AI Search retrieval
```

- **`vectorize`** (default) — embed the query + `vector_top_k` over our `chunk` index.
- **`ai-search`** — Cloudflare AI Search's managed retrieval endpoint
  (`rag/search.ts`), indexing the cleaned-text export (`worker:index-export`). A
  **real** run needs `CF_ACCOUNT_ID` / `AI_SEARCH_INSTANCE` / `AI_SEARCH_TOKEN`; an
  **offline** run uses a deterministic fake AI Search endpoint built from the same
  fixture corpus (no network), so the switch is exercisable in CI. The comparison is
  drop-in — both providers return the same `{ passages, sources, context }`, so
  hit-rate / citation-validity are measured identically.

## Offline vs. real

- **Offline** (default) runs against a built-in fixture corpus with a deterministic
  fake embedder + a lexical fake LLM. It validates the _pipeline logic and the
  cite/fallback/abstain policy_ — **not** real answer quality. Green here means the
  plumbing is sound, nothing more.
- **Real** runs against **your embedded corpus** and real models. This is the only
  signal for actual answer quality and for tuning the answer-policy prompt (the
  fallback-vs-abstain boundary in `src/lib/server/rag/answer.ts`).

## Runbook — a real, keyed run end-to-end

> ⚠️ **Critical:** the embedder used at **query time** (eval / `/ask`) must match the
> embedder used at **index time** (`worker:embed`) — same `EMBEDDING_PROVIDER` and
> model. Mismatched vectors aren't comparable and retrieval silently returns garbage.

```sh
# 1. Corpus — crawl into the target DB (or point at an already-populated Turso)
DATABASE_URL="<turso-url>" bun run worker/index.ts --mode crawl --max 500 --once

# 2. Extract main-content text from the stored blobs
DATABASE_URL="<turso-url>" bun run worker:extract

# 3. Embed with a REAL provider — pick ONE and remember which:
EMBEDDING_PROVIDER=cloudflare CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
  DATABASE_URL="<turso-url>" bun run worker:embed
#   — or —
EMBEDDING_PROVIDER=openai OPENAI_API_KEY=… \
  DATABASE_URL="<turso-url>" bun run worker:embed

# 4. Eval against real models (SAME EMBEDDING_PROVIDER as step 3):
ANTHROPIC_API_KEY=… EMBEDDING_PROVIDER=<same> DATABASE_URL="<turso-url>" \
  bun run eval --real
#   compare answer models:  add  RAG_ANSWER_MODEL=claude-sonnet-5

# 5. Try it live (same env):  bun run dev  →  log in  →  /ask
```

### Relevant env

| var                                                        | purpose                            | default                                                |
| ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `EMBEDDING_PROVIDER`                                       | `cloudflare` \| `openai` \| `fake` | auto (fake if no creds)                                |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`           | Workers AI embeddings              | —                                                      |
| `OPENAI_API_KEY`                                           | OpenAI embeddings                  | —                                                      |
| `ANTHROPIC_API_KEY`                                        | answer LLM (enables `--real`)      | —                                                      |
| `RAG_ANSWER_MODEL`                                         | answer model override              | `claude-haiku-4-5`                                     |
| `CLOUDFLARE_EMBED_MODEL` / `OPENAI_EMBED_MODEL`            | embed model override               | `@cf/baai/bge-base-en-v1.5` / `text-embedding-3-small` |
| `RETRIEVAL_PROVIDER`                                       | `vectorize` \| `ai-search`         | `vectorize`                                            |
| `CF_ACCOUNT_ID` / `AI_SEARCH_INSTANCE` / `AI_SEARCH_TOKEN` | AI Search retrieval (real)         | —                                                      |

## The question set

`questions.ts` — the #32 example questions plus more, each tagged with an
`expectedMode` (`grounded` / `fallback` / `abstained`) and an optional
`expectedSource`. Add real questions here to sharpen the real-run signal.

## Known corpus caveat

On a real crawl, nav-heavy landing/index pages can leak menu boilerplate through
extraction, producing low-signal chunks that dilute retrieval — see
[#59](https://github.com/larryosborn/orleans/issues/59). Content pages extract
cleanly.
