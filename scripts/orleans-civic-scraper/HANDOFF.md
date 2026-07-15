# Handoff: Orleans Town Website Scraper

**Your job:** run the crawl-to-corpus pipeline in this repo, end to end, and hand back a populated `data/` directory. Downstream work (chatbot, SvelteKit frontend) builds on your output but is not your responsibility.

## Background

Orleans, MA runs its town website (town.orleans.ma.us) on CivicPlus, a municipal CMS vendor. The site works, but content is hard to navigate: information is spread across bolted-on modules (AgendaCenter, DocumentCenter, Archive Center, FAQs, CivicAlerts), and much of the substance — meeting minutes, budgets, annual town reports — lives in PDFs several clicks deep.

The town's cost for this is climbing. Per the FY27 budget book, the Media Operations department line that carries CivicPlus fees ("Other Professional & Technical Services") went from ~$9.3k actual in FY24 to $52.8k proposed for FY27, driven by added CivicPlus modules (CivicSend newsletter, per-department sub-sites, notification tiers) and a redesign project.

This project is a resident-led alternative: scrape all public content into a clean corpus, then build better search, a citation-backed Q&A chatbot (RAG over the corpus — not a fine-tuned model), and eventually a faster static frontend. Everything scraped is Massachusetts public record on a public website. The crawler is deliberately conservative (details below) — keep it that way.

## What the pipeline does

```
crawl.py    fetch every page + PDF        -> data/raw/, data/crawl.sqlite3
extract.py  strip boilerplate, PDF->text  -> data/corpus/*.md (YAML frontmatter)
index.py    chunk + embed, hybrid search  -> data/index/
chat.py     RAG chat CLI (smoke test)     -> answers with cited sources
```

Your deliverable is the output of the first three stages. `chat.py` is a nice end-to-end smoke test if you have an Anthropic API key, but optional.

## Setup

Python 3.10+.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

All knobs live in `config.py` — seeds, skip patterns, rate limit, storage paths, embedding model. You shouldn't need to touch anything except possibly `USER_AGENT` (put your own contact email in it if you're the one running the crawl).

## Running it

### 1. Crawl

```bash
python crawl.py
```

- Runs at 1 request/second, single-threaded. Expect several hours to a full day for the whole site including PDFs. Run it overnight; `nohup`/`tmux` recommended.
- **Interruptible.** Ctrl-C anytime; progress is in `data/crawl.sqlite3` and a rerun resumes where it left off.
- Console shows `[html]`, `[doc]`, `[map]` lines as it goes. `[doc]` entries are PDFs/Office files — agendas, minutes, budgets.
- Sanity check afterward:
  ```bash
  sqlite3 data/crawl.sqlite3 "SELECT content_type, count(*) FROM pages GROUP BY 1"
  ```
  You should see hundreds of HTML pages and a substantial pile of `application/pdf`. If PDF count is near zero, something's wrong — see gotchas.

### 2. Extract

```bash
python extract.py
```

- Fast (minutes). Produces one markdown file per source in `data/corpus/`, each with frontmatter: `url`, `title`, `type`, `fetched_at`.
- **Check `data/corpus/_needs_ocr.tsv`** — PDFs averaging <100 chars/page are probably image scans (common for older annual reports and minutes). OCR them and re-extract:
  ```bash
  ocrmypdf --skip-text <raw-file> <raw-file>   # needs tesseract installed
  python extract.py --force
  ```
- Spot-check quality: open a few corpus files. They should read as clean article text, no nav menus, no 200-language translate dropdown.

### 3. Index

```bash
python index.py
python index.py --query "transfer station sticker fee"    # verify retrieval
```

- First run downloads the embedding model (~130MB, runs on CPU). Embedding takes minutes to a few tens of minutes depending on corpus size.
- The test query should return relevant chunks with URLs. Try a couple of others: "town meeting warrant", "shellfish permit".

### 4. Smoke test (optional)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
python chat.py "when does the transfer station close?"
```

A good answer cites numbered sources with town URLs.

## Rules of engagement — do not skip

1. **Don't raise the crawl rate.** 1 req/sec, one thread. It's a small town's website; the whole point is to be a good neighbor. The crawler already honors robots.txt and backs off on 429/503.
2. **Keep a real contact email in the User-Agent** (`config.py`). If the town's IT (2-person department) sees the traffic and reaches out, they should reach a person, not a mystery bot.
3. **If you get sustained 403s or an IP block, stop and tell** rather than rotating IPs or spoofing browser UAs. This is public data and there's a friendly-conversation path; don't create an adversarial one.
4. Scope is `town.orleans.ma.us` only. Don't add external hosts to `ALLOWED_HOSTS`.

## Gotchas you'd otherwise learn the hard way

- **PDFs have no `.pdf` in their URLs.** CivicPlus serves them from `/AgendaCenter/ViewFile/...` and `/DocumentCenter/View/{id}`. The crawler classifies by `Content-Type` header. Don't "fix" this by filtering on extensions.
- **The sitemap is incomplete.** It only covers Pages-module content; agendas, documents, alerts, and FAQs are discovered from the module seeds in `config.py`.
- **`Calendar.aspx` is an infinite URL space** (month/year pagination forever). Skip patterns block it. If you see the queue growing without bound, a new infinite space slipped through — add a pattern to `SKIP_PATTERNS`.
- **Re-crawls are cheap.** `python crawl.py --recrawl` uses conditional GETs (ETag/Last-Modified); unchanged pages return 304 and cost nothing. Extraction skips unchanged content hashes.
- The corrupted-looking hash filenames in `data/raw/` are intentional (sha256 of URL); the manifest maps them back to URLs.

## Definition of done

- [ ] Crawl completed with no remaining queue (rerun `crawl.py`; it should finish quickly with ~0 new fetches)
- [ ] Manifest counts look sane (hundreds of HTML pages, large PDF count)
- [ ] `_needs_ocr.tsv` handled or explicitly punted (note which)
- [ ] Corpus spot-checked: 5+ random files are clean readable text with correct frontmatter URLs
- [ ] Index built; 3 test queries return relevant chunks
- [ ] Hand back the whole `data/` directory (zip or drive) + any notes on failures/oddities
