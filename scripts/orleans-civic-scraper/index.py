#!/usr/bin/env python3
"""Chunk the corpus and build a hybrid search index (BM25 + vectors).

- Chunks markdown heading-aware, ~CHUNK_SIZE chars with overlap
- SQLite FTS5 for keyword/BM25 search
- sentence-transformers embeddings stored as a single .npy matrix
- search() does reciprocal-rank fusion of both result lists

Usage:
    python index.py                 # build/rebuild index from data/corpus
    python index.py --query "transfer station sticker fee"   # test a search
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path

import numpy as np

import config

INDEX_DB = config.INDEX_DIR / "chunks.sqlite3"
EMB_PATH = config.INDEX_DIR / "embeddings.npy"


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------
def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    meta = {}
    for line in text[3:end].strip().splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"')
    return meta, text[end + 4:]


def chunk_markdown(body: str) -> list[str]:
    """Split on headings first, then pack paragraphs into ~CHUNK_SIZE chunks."""
    sections = re.split(r"(?m)^(?=#{1,4} )", body)
    chunks: list[str] = []
    for section in sections:
        paras = [p.strip() for p in re.split(r"\n\s*\n", section) if p.strip()]
        buf = ""
        for p in paras:
            if len(buf) + len(p) > config.CHUNK_SIZE and buf:
                chunks.append(buf.strip())
                buf = buf[-config.CHUNK_OVERLAP:] + "\n\n"  # overlap tail
            buf += p + "\n\n"
        if buf.strip():
            chunks.append(buf.strip())
    return [c for c in chunks if len(c) > 60]


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
def build() -> None:
    from sentence_transformers import SentenceTransformer

    config.ensure_dirs()
    if INDEX_DB.exists():
        INDEX_DB.unlink()
    conn = sqlite3.connect(INDEX_DB)
    conn.execute("CREATE TABLE chunks (id INTEGER PRIMARY KEY, url TEXT, title TEXT, text TEXT)")
    conn.execute("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id')")

    texts: list[str] = []
    n = 0
    for md_file in sorted(config.CORPUS_DIR.glob("*.md")):
        meta, body = parse_frontmatter(md_file.read_text(encoding="utf-8"))
        for chunk in chunk_markdown(body):
            n += 1
            conn.execute(
                "INSERT INTO chunks (id, url, title, text) VALUES (?,?,?,?)",
                (n, meta.get("url", ""), meta.get("title", ""), chunk),
            )
            conn.execute(
                "INSERT INTO chunks_fts (rowid, text) VALUES (?,?)", (n, chunk)
            )
            texts.append(chunk)
    conn.commit()
    print(f"{n} chunks from {len(list(config.CORPUS_DIR.glob('*.md')))} documents")

    print(f"embedding with {config.EMBEDDING_MODEL} (first run downloads the model)...")
    model = SentenceTransformer(config.EMBEDDING_MODEL)
    emb = model.encode(texts, batch_size=64, show_progress_bar=True,
                       normalize_embeddings=True)
    np.save(EMB_PATH, emb.astype(np.float32))
    conn.close()
    print(f"index written: {INDEX_DB}, {EMB_PATH}")


# ---------------------------------------------------------------------------
# Search (used by chat.py)
# ---------------------------------------------------------------------------
def search(query: str, top_k: int = config.TOP_K) -> list[dict]:
    from sentence_transformers import SentenceTransformer

    conn = sqlite3.connect(INDEX_DB)
    conn.row_factory = sqlite3.Row

    # BM25 candidates
    fts_query = " OR ".join(re.findall(r"[A-Za-z0-9']+", query)) or query
    bm25 = [
        r["rowid"]
        for r in conn.execute(
            "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 50",
            (fts_query,),
        )
    ]

    # Vector candidates (corpus is small enough for a full scan)
    emb = np.load(EMB_PATH)
    model = SentenceTransformer(config.EMBEDDING_MODEL)
    q = model.encode([query], normalize_embeddings=True)[0].astype(np.float32)
    sims = emb @ q
    vec = (np.argsort(-sims)[:50] + 1).tolist()  # rowids are 1-based

    # Reciprocal rank fusion
    scores: dict[int, float] = {}
    for rank, rid in enumerate(bm25):
        scores[rid] = scores.get(rid, 0) + 1.0 / (60 + rank)
    for rank, rid in enumerate(vec):
        scores[rid] = scores.get(rid, 0) + 1.0 / (60 + rank)
    top = sorted(scores, key=scores.get, reverse=True)[:top_k]

    results = []
    for rid in top:
        row = conn.execute("SELECT * FROM chunks WHERE id=?", (rid,)).fetchone()
        if row:
            results.append(dict(row))
    conn.close()
    return results


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--query", help="test the index with a search")
    args = ap.parse_args()
    if args.query:
        for r in search(args.query):
            print(f"\n--- {r['title']}  ({r['url']})\n{r['text'][:300]}")
    else:
        build()
