#!/usr/bin/env python3
"""Polite, resumable crawler for a CivicPlus municipal site.

Discovers pages via sitemap.xml + BFS from module seeds, saves raw HTML and
binary documents (PDF/Office), and records everything in a SQLite manifest
so re-runs are incremental (conditional GETs via ETag/Last-Modified).

Usage:
    python crawl.py                 # full crawl (resumes automatically)
    python crawl.py --recrawl       # revisit known URLs to pick up changes
    python crawl.py --max 500       # cap this run
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sqlite3
import sys
import time
import urllib.robotparser
import xml.etree.ElementTree as ET
from collections import deque
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse, urlunparse, parse_qsl, urlencode

import requests
from bs4 import BeautifulSoup

import config

SKIP_RE = [re.compile(p, re.IGNORECASE) for p in config.SKIP_PATTERNS]


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------
def db() -> sqlite3.Connection:
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS pages (
            url          TEXT PRIMARY KEY,
            status       INTEGER,
            content_type TEXT,
            local_path   TEXT,
            sha256       TEXT,
            etag         TEXT,
            last_modified TEXT,
            title        TEXT,
            fetched_at   TEXT
        )"""
    )
    return conn


# ---------------------------------------------------------------------------
# URL hygiene
# ---------------------------------------------------------------------------
def normalize(url: str) -> str:
    """Canonicalize a URL: strip fragments and tracking params, sort query."""
    p = urlparse(url)
    query = [
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not k.lower().startswith(("utm_", "fbclid", "gclid"))
    ]
    return urlunparse(
        (p.scheme, p.netloc.lower(), p.path, "", urlencode(sorted(query)), "")
    )


def in_scope(url: str) -> bool:
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        return False
    if p.netloc.lower() not in config.ALLOWED_HOSTS:
        return False
    return not any(rx.search(url) for rx in SKIP_RE)


def local_name(url: str, ext: str) -> str:
    return hashlib.sha256(url.encode()).hexdigest()[:24] + ext


# ---------------------------------------------------------------------------
# Discovery helpers
# ---------------------------------------------------------------------------
def parse_sitemap(xml_text: str) -> list[str]:
    """Return URLs from a sitemap or sitemap-index document."""
    urls: list[str] = []
    try:
        root = ET.fromstring(xml_text.encode())
    except ET.ParseError:
        return urls
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    for loc in root.iterfind(".//sm:loc", ns):
        if loc.text:
            urls.append(loc.text.strip())
    return urls


def extract_links(base_url: str, html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    found = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        found.append(normalize(urljoin(base_url, href)))
    return found


# ---------------------------------------------------------------------------
# Crawl
# ---------------------------------------------------------------------------
def crawl(max_pages: int, recrawl: bool) -> None:
    conn = db()
    session = requests.Session()
    session.headers["User-Agent"] = config.USER_AGENT

    robots = urllib.robotparser.RobotFileParser()
    robots.set_url(config.BASE_URL + "/robots.txt")
    try:
        robots.read()
    except Exception:
        print("warning: could not read robots.txt; proceeding cautiously")

    queue: deque[str] = deque(
        normalize(urljoin(config.BASE_URL, p)) for p in config.SEED_PATHS
    )
    if recrawl:
        for (url,) in conn.execute("SELECT url FROM pages"):
            queue.append(url)

    seen: set[str] = set()
    fetched = 0

    while queue and fetched < max_pages:
        url = queue.popleft()
        if url in seen or not in_scope(url):
            continue
        seen.add(url)

        if not robots.can_fetch(config.USER_AGENT, url):
            continue

        row = conn.execute(
            "SELECT etag, last_modified FROM pages WHERE url=?", (url,)
        ).fetchone()
        if row and not recrawl:
            continue  # already have it; use --recrawl to check for updates

        headers = {}
        if row:
            if row[0]:
                headers["If-None-Match"] = row[0]
            if row[1]:
                headers["If-Modified-Since"] = row[1]

        resp = fetch(session, url, headers)
        fetched += 1
        if resp is None:
            record(conn, url, 0, "", "", "", None, None)
            continue
        if resp.status_code == 304:
            continue  # unchanged since last crawl
        if resp.status_code != 200:
            record(conn, url, resp.status_code, "", "", "", None, None)
            continue

        ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()

        if ctype in config.DOC_CONTENT_TYPES:
            ext = config.DOC_CONTENT_TYPES[ctype]
            path = config.RAW_DOCS_DIR / local_name(url, ext)
            path.write_bytes(resp.content)
            record(conn, url, 200, ctype, str(path),
                   hashlib.sha256(resp.content).hexdigest(),
                   filename_hint(resp), resp)
            print(f"[doc ] {url}")
        elif "html" in ctype or "xml" in ctype:
            text = resp.text
            if url.endswith("sitemap.xml") or "<urlset" in text[:500] or "<sitemapindex" in text[:500]:
                for u in parse_sitemap(text):
                    nu = normalize(u)
                    if nu not in seen and in_scope(nu):
                        queue.append(nu)
                print(f"[map ] {url}")
                continue
            path = config.RAW_HTML_DIR / local_name(url, ".html")
            path.write_text(text, encoding="utf-8", errors="replace")
            title = page_title(text)
            record(conn, url, 200, ctype, str(path),
                   hashlib.sha256(text.encode()).hexdigest(), title, resp)
            print(f"[html] {title[:60] if title else url}")
            for link in extract_links(url, text):
                if link not in seen:
                    queue.append(link)
        # anything else (images, etc.): ignore

        time.sleep(config.RATE_LIMIT_SECONDS)

    conn.commit()
    conn.close()
    print(f"\ndone: {fetched} fetches this run, queue had {len(queue)} remaining")


def human_bytes(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}"
        n /= 1024


def estimate(max_pages: int) -> None:
    """Dry run: discover the full crawl frontier and tally counts + bytes
    WITHOUT downloading document bodies or touching disk/manifest.

    HTML/XML pages are fetched (bodies are needed to extract links for BFS),
    but documents are only probed: the streamed request is closed after the
    headers arrive, so we read Content-Length without pulling the file down.
    """
    session = requests.Session()
    session.headers["User-Agent"] = config.USER_AGENT

    robots = urllib.robotparser.RobotFileParser()
    robots.set_url(config.BASE_URL + "/robots.txt")
    try:
        robots.read()
    except Exception:
        print("warning: could not read robots.txt; proceeding cautiously")

    queue: deque[str] = deque(
        normalize(urljoin(config.BASE_URL, p)) for p in config.SEED_PATHS
    )
    seen: set[str] = set()

    n_html = n_docs = n_maps = requests_made = 0
    n_robots_blocked = n_errors = n_docs_unknown = 0
    html_bytes = doc_bytes = 0
    doc_counts: dict[str, int] = {}

    while queue and requests_made < max_pages:
        url = queue.popleft()
        if url in seen or not in_scope(url):
            continue
        seen.add(url)

        if not robots.can_fetch(config.USER_AGENT, url):
            n_robots_blocked += 1
            continue

        resp = fetch(session, url, {}, stream=True)
        requests_made += 1
        if resp is None:
            n_errors += 1
            continue
        try:
            if resp.status_code != 200:
                n_errors += 1
                continue

            ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()

            if ctype in config.DOC_CONTENT_TYPES:
                n_docs += 1
                ext = config.DOC_CONTENT_TYPES[ctype]
                doc_counts[ext] = doc_counts.get(ext, 0) + 1
                clen = resp.headers.get("Content-Length")
                if clen and clen.isdigit():
                    doc_bytes += int(clen)
                else:
                    n_docs_unknown += 1
                # don't read the body -- close to release without downloading
                continue

            if "html" in ctype or "xml" in ctype:
                text = resp.text  # consumes the (already small) HTML body
                if (url.endswith("sitemap.xml")
                        or "<urlset" in text[:500] or "<sitemapindex" in text[:500]):
                    n_maps += 1
                    for u in parse_sitemap(text):
                        nu = normalize(u)
                        if nu not in seen and in_scope(nu):
                            queue.append(nu)
                    continue
                n_html += 1
                html_bytes += len(text.encode("utf-8", errors="replace"))
                for link in extract_links(url, text):
                    if link not in seen:
                        queue.append(link)
            # anything else (images, etc.): ignored, matching the real crawl
        finally:
            resp.close()

        if requests_made % 100 == 0:
            print(f"  ...{requests_made} probed "
                  f"({n_html} html, {n_docs} docs, {human_bytes(doc_bytes)} so far)")

        time.sleep(config.RATE_LIMIT_SECONDS)

    projected_unknown = ""
    if n_docs_unknown:
        avg = doc_bytes / (n_docs - n_docs_unknown) if n_docs > n_docs_unknown else 0
        projected_unknown = (
            f"  (+{n_docs_unknown} docs sent no Content-Length; "
            f"~{human_bytes(avg * n_docs_unknown)} more at observed avg)"
        )

    print("\n" + "=" * 60)
    print("CRAWL ESTIMATE (dry run -- nothing saved)")
    print("=" * 60)
    print(f"requests issued this probe : {requests_made:>8,}")
    print(f"sitemaps parsed            : {n_maps:>8,}")
    print(f"HTML pages                 : {n_html:>8,}   {human_bytes(html_bytes):>10}")
    print(f"documents                  : {n_docs:>8,}   {human_bytes(doc_bytes):>10}")
    for ext, c in sorted(doc_counts.items(), key=lambda kv: -kv[1]):
        print(f"    {ext:<6}                 : {c:>8,}")
    if projected_unknown:
        print(projected_unknown)
    print("-" * 60)
    fetches = n_html + n_docs
    print(f"real-crawl fetches (pages+docs): {fetches:>8,}")
    print(f"estimated download size        : {human_bytes(html_bytes + doc_bytes):>10}")
    eta = fetches * config.RATE_LIMIT_SECONDS
    print(f"min wall time @ {config.RATE_LIMIT_SECONDS}s/req      : "
          f"~{eta / 3600:.1f} h ({eta / 60:.0f} min), plus download time")
    if requests_made >= max_pages:
        print(f"\nNOTE: hit --max={max_pages}; frontier not exhausted, "
              f"true totals are higher. Re-run with a larger --max.")
    if n_robots_blocked or n_errors:
        print(f"\n(skipped {n_robots_blocked} robots-blocked, "
              f"{n_errors} errors/non-200)")


def fetch(session: requests.Session, url: str, headers: dict,
          stream: bool = False) -> requests.Response | None:
    delay = config.RETRY_BACKOFF
    for attempt in range(config.MAX_RETRIES):
        try:
            resp = session.get(url, headers=headers, stream=stream,
                               timeout=config.REQUEST_TIMEOUT)
            if resp.status_code in (429, 503):
                wait = int(resp.headers.get("Retry-After", delay))
                print(f"  throttled ({resp.status_code}); sleeping {wait}s")
                time.sleep(wait)
                delay *= 2
                continue
            return resp
        except requests.RequestException as e:
            print(f"  retry {attempt + 1}: {e}")
            time.sleep(delay)
            delay *= 2
    return None


def filename_hint(resp: requests.Response) -> str | None:
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r'filename\*?="?([^";]+)', cd)
    return m.group(1) if m else None


def page_title(html: str) -> str | None:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def record(conn, url, status, ctype, path, sha, title, resp) -> None:
    etag = resp.headers.get("ETag") if resp is not None else None
    lastmod = resp.headers.get("Last-Modified") if resp is not None else None
    conn.execute(
        """INSERT INTO pages (url, status, content_type, local_path, sha256,
                              etag, last_modified, title, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(url) DO UPDATE SET
             status=excluded.status, content_type=excluded.content_type,
             local_path=excluded.local_path, sha256=excluded.sha256,
             etag=excluded.etag, last_modified=excluded.last_modified,
             title=excluded.title, fetched_at=excluded.fetched_at""",
        (url, status, ctype, path, sha, etag, lastmod, title,
         datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max", type=int, default=config.MAX_PAGES)
    ap.add_argument("--recrawl", action="store_true",
                    help="revisit known URLs with conditional GETs")
    ap.add_argument("--estimate", action="store_true",
                    help="dry run: tally page/doc counts and bytes without "
                         "downloading document bodies or writing anything")
    args = ap.parse_args()
    try:
        if args.estimate:
            estimate(args.max)
        else:
            crawl(args.max, args.recrawl)
    except KeyboardInterrupt:
        print("\ninterrupted -- progress saved; rerun to resume")
        sys.exit(1)
