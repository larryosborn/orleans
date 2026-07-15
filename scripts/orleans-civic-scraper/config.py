"""Shared configuration for the Orleans CivicPlus scraper pipeline."""

from pathlib import Path

# ---------------------------------------------------------------------------
# Target site
# ---------------------------------------------------------------------------
BASE_URL = "https://www.town.orleans.ma.us"
ALLOWED_HOSTS = {"www.town.orleans.ma.us", "town.orleans.ma.us"}

# Identify yourself. Towns appreciate knowing who's crawling, and it keeps
# you on the right side of polite. Update if you want a different contact.
USER_AGENT = (
    "OrleansCivicScraper/1.0 (resident civic project; contact: larry@cornsyrup.org)"
)

# ---------------------------------------------------------------------------
# Politeness
# ---------------------------------------------------------------------------
RATE_LIMIT_SECONDS = 1.0     # min delay between requests
REQUEST_TIMEOUT = 30         # seconds
MAX_RETRIES = 3
RETRY_BACKOFF = 5            # seconds, doubled per retry
MAX_PAGES = 20000            # hard safety cap for a single crawl run

# ---------------------------------------------------------------------------
# Seeds: CivicPlus module endpoints. The sitemap covers "Pages" content, but
# module content (agendas, documents, alerts, FAQs) is only partially linked
# from it, so we seed the module roots explicitly.
# ---------------------------------------------------------------------------
SEED_PATHS = [
    "/",
    "/sitemap.xml",
    "/AgendaCenter",            # boards/committees -> agenda + minutes PDFs
    "/DocumentCenter",          # document library index
    "/Archive.aspx",            # Archive Center (annual town reports etc.)
    "/CivicAlerts.aspx",        # news/alerts
    "/FAQ.aspx",                # FAQs
    "/Directory.aspx",          # staff/department directory
    "/Bids.aspx",               # procurement postings
    "/Calendar.aspx",           # event calendar (crawled shallowly, see below)
]

# URL patterns to skip entirely (infinite spaces, session junk, utility pages)
SKIP_PATTERNS = [
    r"/Search",
    r"/rss\.aspx",
    r"/List\.aspx",             # Notify Me signup
    r"/MyAccount",
    r"/Admin",
    r"login|logout",
    r"[?&]month=",              # calendar month pagination -> infinite space
    r"[?&]year=\d{4}",
    r"Calendar\.aspx\?.*(EID|view)=",
    r"/Facilities",
    r"translate\.google",
    r"\.(css|js|ico|woff2?|ttf|eot|map)(\?|$)",
]

# Binary document types worth keeping (checked against Content-Type header,
# NOT the URL -- CivicPlus serves PDFs from extensionless endpoints like
# /AgendaCenter/ViewFile/Minutes/_04152025-1234 and /DocumentCenter/View/2389)
DOC_CONTENT_TYPES = {
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
}

# ---------------------------------------------------------------------------
# Local storage layout
# ---------------------------------------------------------------------------
DATA_DIR = Path(__file__).parent / "data"
RAW_HTML_DIR = DATA_DIR / "raw" / "html"
RAW_DOCS_DIR = DATA_DIR / "raw" / "docs"
CORPUS_DIR = DATA_DIR / "corpus"      # extracted markdown, one file per source
DB_PATH = DATA_DIR / "crawl.sqlite3"  # crawl manifest (resume + change detection)
INDEX_DIR = DATA_DIR / "index"        # chunk store + embeddings

# ---------------------------------------------------------------------------
# Extraction / indexing
# ---------------------------------------------------------------------------
MIN_CHARS_PER_PDF_PAGE = 100   # below this avg => probably scanned, flag for OCR
CHUNK_SIZE = 1200              # target characters per chunk
CHUNK_OVERLAP = 200
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"  # small, fast, runs locally on CPU

# RAG chat
ANTHROPIC_MODEL = "claude-sonnet-5"
TOP_K = 8


def ensure_dirs() -> None:
    for d in (RAW_HTML_DIR, RAW_DOCS_DIR, CORPUS_DIR, INDEX_DIR):
        d.mkdir(parents=True, exist_ok=True)
