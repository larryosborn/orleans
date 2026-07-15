#!/usr/bin/env python3
"""Extract clean markdown from crawled HTML and PDFs.

Reads the crawl manifest, converts each source into a markdown file with YAML
frontmatter (url, title, type, fetched_at) in data/corpus/. Skips sources
whose content hash hasn't changed since last extraction.

HTML  -> trafilatura (strips CivicPlus chrome: nav trees, the giant Google
         Translate language list, footers)
PDF   -> PyMuPDF text extraction; low-text PDFs are flagged as likely-scanned
         so you can OCR them separately (see README).

Usage:
    python extract.py            # extract everything new/changed
    python extract.py --force    # re-extract all
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

import trafilatura
import fitz  # PyMuPDF

import config


def frontmatter(meta: dict) -> str:
    lines = ["---"]
    for k, v in meta.items():
        v = str(v).replace('"', "'")
        lines.append(f'{k}: "{v}"')
    lines.append("---\n")
    return "\n".join(lines)


def extract_html(path: Path, url: str) -> str | None:
    html = path.read_text(encoding="utf-8", errors="replace")
    # trafilatura does excellent boilerplate removal; favor_recall keeps
    # tables (budget figures, fee schedules) that precision mode can drop.
    md = trafilatura.extract(
        html,
        url=url,
        output_format="markdown",
        include_links=True,
        include_tables=True,
        favor_recall=True,
    )
    return md


def extract_pdf(path: Path) -> tuple[str | None, bool]:
    """Returns (text, likely_scanned)."""
    try:
        doc = fitz.open(path)
    except Exception:
        return None, False
    pages = [page.get_text("text") for page in doc]
    n_pages = max(len(pages), 1)
    text = "\n\n".join(pages).strip()
    likely_scanned = (len(text) / n_pages) < config.MIN_CHARS_PER_PDF_PAGE
    doc.close()
    return (text or None), likely_scanned


def run(force: bool) -> None:
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH)
    rows = conn.execute(
        """SELECT url, content_type, local_path, sha256, title, fetched_at
           FROM pages WHERE status=200 AND local_path != ''"""
    ).fetchall()
    conn.close()

    state_path = config.CORPUS_DIR / "_extracted.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    needs_ocr: list[str] = []
    written = skipped = 0

    for url, ctype, local_path, sha, title, fetched_at in rows:
        src = Path(local_path)
        if not src.exists():
            continue
        if not force and state.get(url) == sha:
            skipped += 1
            continue

        doc_id = src.stem
        out = config.CORPUS_DIR / f"{doc_id}.md"

        if "html" in ctype:
            body = extract_html(src, url)
            kind = "webpage"
        elif ctype == "application/pdf":
            body, scanned = extract_pdf(src)
            kind = "pdf"
            if scanned:
                needs_ocr.append(f"{src}\t{url}")
        else:
            # .doc/.docx/.xls/.xlsx: convert separately if needed (README)
            continue

        if not body or len(body.strip()) < 80:
            continue  # empty shells, redirect stubs

        meta = {
            "url": url,
            "title": title or "",
            "type": kind,
            "fetched_at": fetched_at,
            "source_file": src.name,
        }
        out.write_text(frontmatter(meta) + body, encoding="utf-8")
        state[url] = sha
        written += 1
        if written % 50 == 0:
            print(f"  ...{written} extracted")

    state_path.write_text(json.dumps(state, indent=1))
    if needs_ocr:
        ocr_list = config.CORPUS_DIR / "_needs_ocr.tsv"
        ocr_list.write_text("\n".join(needs_ocr))
        print(f"\n{len(needs_ocr)} PDFs look scanned -> listed in {ocr_list}")
        print("OCR them with: ocrmypdf --skip-text <in.pdf> <out.pdf>, re-run extract")

    print(f"done: {written} extracted, {skipped} unchanged, corpus in {config.CORPUS_DIR}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--force", action="store_true")
    run(ap.parse_args().force)
