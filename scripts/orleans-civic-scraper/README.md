# Orleans Civic Scraper (legacy Python prototype)

> **Status: superseded.** The crawl / archive / change-tracking now lives in the
> TypeScript **sync worker** ([`worker/`](../../worker/README.md)), writing to
> Turso and R2 with a dashboard — see
> [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md). This Python pipeline is
> kept for reference and for its `extract → index → chat` (RAG) stages, which
> haven't been ported yet. Use the worker for crawling.

A four-stage pipeline that turns town.orleans.ma.us (a CivicPlus site) into a clean, searchable corpus with a citation-backed RAG chatbot on top.

```
crawl.py  ->  extract.py  ->  index.py  ->  chat.py
raw HTML/PDFs   markdown corpus   hybrid index    Claude-powered Q&A
```

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...   # only needed for chat.py
```

## Run

```bash
python crawl.py            # hours at 1 req/sec; ctrl-c anytime, resumes
python extract.py          # HTML/PDF -> data/corpus/*.md with frontmatter
python index.py            # chunk + embed (first run downloads ~130MB model)
python index.py --query "transfer station hours"   # sanity-check retrieval
python chat.py "when does the transfer station close?"
```

Everything lands under `data/`: raw files, a SQLite crawl manifest, the markdown corpus, and the search index.

## What it knows about CivicPlus

The crawler is tuned for CivicPlus quirks so you don't have to rediscover them:

- **Extensionless PDFs.** Agendas/minutes are served from `/AgendaCenter/ViewFile/...` and documents from `/DocumentCenter/View/{id}` with no `.pdf` in the URL. Files are classified by `Content-Type` header, never by extension.
- **Module sprawl.** The sitemap only covers "Pages" content, so `AgendaCenter`, `DocumentCenter`, `Archive.aspx` (annual town reports), `CivicAlerts.aspx`, `FAQ.aspx`, `Directory.aspx`, and `Bids.aspx` are seeded explicitly in `config.py`.
- **Infinite calendar.** `Calendar.aspx` month/year pagination is an infinite URL space; skip patterns block it.
- **Boilerplate.** The 200-language Google Translate dropdown and nav trees on every page are stripped by trafilatura during extraction.

## Politeness (worth keeping)

The crawl is single-threaded at 1 request/second with a User-Agent that identifies you and your email (`config.py`), honors robots.txt, respects `Retry-After` on 429/503, and uses conditional GETs (`ETag`/`Last-Modified`) on re-crawls so unchanged pages cost the town's server almost nothing. Run overnight. This is all public record — Massachusetts public records law is firmly on your side — but a considerate crawl keeps it that way, and if anyone at Town Hall asks, "resident building a better search for town information" is a conversation you'll enjoy having.

## Scanned PDFs

Older annual reports and minutes are often image scans. `extract.py` flags any PDF averaging under ~100 chars/page into `data/corpus/_needs_ocr.tsv`. Fix them with:

```bash
ocrmypdf --skip-text input.pdf output.pdf   # then replace the raw file and re-run extract.py
```

## Re-crawling / freshness

```bash
python crawl.py --recrawl && python extract.py && python index.py
```

Cron it weekly. Conditional GETs make re-crawls cheap; extraction skips unchanged hashes. This is also why RAG beats fine-tuning here: your bot is current the moment the index rebuilds, and every answer cites the page or PDF it came from.

## Design notes

- **Hybrid retrieval.** FTS5/BM25 catches exact tokens ("Article 12", "Chapter 194", parcel IDs) that pure vector search whiffs on; embeddings catch paraphrases ("dump sticker" -> transfer station permit). Reciprocal-rank fusion combines them. For a corpus this size (thousands of chunks), full-scan cosine in numpy is milliseconds — no vector DB needed.
- **bge-small-en-v1.5** runs fine on CPU. Swap `EMBEDDING_MODEL` in `config.py` for `bge-base` if retrieval feels weak.
- **Chunking** is heading-aware (~1200 chars, 200 overlap) so budget tables and bylaw sections stay intact.

## Next: the SvelteKit frontend

The corpus is deliberately frontend-agnostic markdown + SQLite. A clean path:

1. **Site**: SvelteKit with `adapter-static`. Generate routes from `data/corpus/` frontmatter (url -> slug mapping), render markdown with `mdsvex`. You get a fast, sanely-organized mirror of the town's content for near-zero hosting cost.
2. **Search**: [Pagefind](https://pagefind.app) over the static build gives instant client-side search with zero backend.
3. **Chat**: one `+server.ts` endpoint that does what `chat.py` does — retrieve top-k chunks, call the Claude API, stream the response. Either shell out to a small FastAPI wrapper around `index.search()`, or port retrieval to TS (FTS5 works in better-sqlite3; embeddings via a hosted API like Voyage). Svelte 5 chat UI with `$state` for the message list and a streamed `fetch`.

## Layout

```
config.py          all knobs: seeds, skip patterns, rate limits, models
crawl.py           polite resumable crawler -> data/raw/ + crawl.sqlite3
extract.py         HTML/PDF -> data/corpus/*.md (YAML frontmatter)
index.py           chunk, embed, hybrid search -> data/index/
chat.py            RAG chat CLI with citations
```
