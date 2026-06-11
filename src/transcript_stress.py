# transcript_stress.py
#
# Earnings-call transcript NLP stress detection.
#
# Bottlenecks show up in management language ("on allocation", "lead times
# extended", "sold out through 2027") quarters before they become consensus.
# This ETL scans the earnings-call transcripts of every company on the capex
# map and converts that language into a per-company, per-quarter supply-chain
# stress score.
#
# Two-stage funnel keeps it cheap and auditable:
#   Stage 1 — deterministic lexicon scan (free). Weighted regex phrases catch
#             supply-stress language; transcripts with zero hits are scored 0
#             and never touch the LLM.
#   Stage 2 — Gemini classification (only for flagged transcripts). The model
#             receives ONLY the flagged excerpts, classifies severity and
#             direction (is the company the bottleneck owner, or starved of
#             inputs?), and must return verbatim supporting quotes. Quotes are
#             stored in the DB so every score is auditable back to the source.
#
# Output table: transcript_stress (ticker, fiscal_year, fiscal_quarter) PK
# Served by:    functions/stress.js  →  GET /stress
#
# Transcript sources (tried in order):
#   1. defeatbeta-api — FREE, no API key. Open Hugging Face dataset queried
#      via DuckDB (pip install defeatbeta-api). Verified coverage of the
#      watchlist universe including small caps (AXTI, VECO, AAOI, ALAB, …).
#      Its quarter list uses each company's FISCAL calendar, so we trust the
#      list rather than guessing calendar quarters.
#   2. API Ninjas / earningscall.biz — optional PAID fallbacks, only used for
#      tickers defeatbeta doesn't carry and only if a key is configured.
#
# Env vars (GitHub Secrets inject these — see transcript-stress.yml):
#   DATABASE_URL          required  Neon Postgres connection string
#   GEMINI_API_KEY        optional  without it, scores are lexicon-only
#   API_NINJAS_KEY        optional  paid fallback transcript provider
#   EARNINGSCALL_API_KEY  optional  paid fallback transcript provider
#   WATCHLIST_BASE_URL    optional  deployed site root, e.g.
#                                   https://wizzles-watchlist.pages.dev —
#                                   used to pull the LIVE capex-map tickers
#   TICKER_LIMIT          optional  cap tickers per run (testing)
#
# Local Windows note: run with PYTHONIOENCODING=utf-8 (defeatbeta prints a
# unicode banner on import that trips cp1252 consoles).

import json
import os
import re
import time
from datetime import date

import psycopg2
import psycopg2.extras
import requests

try:
    from defeatbeta_api.data.ticker import Ticker as DefeatBetaTicker
    DEFEATBETA_OK = True
except ImportError:
    DEFEATBETA_OK = False

DATABASE_URL         = os.environ.get("DATABASE_URL")
GEMINI_API_KEY       = os.environ.get("GEMINI_API_KEY")
API_NINJAS_KEY       = os.environ.get("API_NINJAS_KEY")
EARNINGSCALL_API_KEY = os.environ.get("EARNINGSCALL_API_KEY")
WATCHLIST_BASE_URL   = (os.environ.get("WATCHLIST_BASE_URL") or "").rstrip("/")
TICKER_LIMIT         = int(os.environ.get("TICKER_LIMIT") or 0)

GEMINI_MODEL = "gemini-2.5-flash"

# Seconds between transcript-provider calls / Gemini calls (rate-limit safety)
PROVIDER_PAUSE = 1.5
GEMINI_PAUSE   = 5

# How many trailing calendar quarters to look back per ticker, and how many
# analyzed quarters we want on file (latest + prior → QoQ trend).
LOOKBACK_QUARTERS = 5
QUARTERS_WANTED   = 2

# ── UNIVERSE ──────────────────────────────────────────────
# Hyperscalers are always scanned: "we are capacity constrained on AI compute"
# from MSFT is the demand-side signal that drives every track below it.
HYPERSCALERS = ["AMZN", "MSFT", "GOOG", "META", "ORCL"]

# Fallback mirror of CAPEX_DATA in src/App.jsx, used when the live /capex
# endpoint is unreachable. Keep roughly in sync — the live endpoint wins.
DEFAULT_MAP_TICKERS = [
    # compute
    "NVDA", "AMD", "INTC", "MU", "WDC", "STX", "AVGO", "MRVL", "QCOM", "TSM",
    "AMAT", "LRCX", "ASML", "AMKR", "ASX", "CAMT", "ONTO", "KLAC",
    # networking
    "ANET", "CSCO", "HPE", "GLW", "PANW", "CRWD", "ZS",
    # photonics
    "LITE", "COHR", "AAOI", "ALMU", "MTSI", "FN", "POET", "SIVE",
    "AXTI", "VECO", "TSEM", "GFS", "APH", "TEL", "ALAB",
    # neoclouds & data centers
    "EQIX", "DLR", "AMT", "IRM", "CIFR", "IREN", "CORZ", "APLD", "CRWV",
    "NBIS", "SMCI", "DELL", "FIX", "EME", "MTZ",
    # power & cooling
    "VST", "NEE", "BE", "OKLO", "SMR", "LEU", "ASPI", "ETN", "VRT", "PLPC",
    "ENS", "NVT", "MOD",
    # frontier
    "IONQ", "RGTI", "QUBT", "ARQQ", "ARM", "OSS", "RKLB", "ASTS",
    "PLTR", "SNOW", "NOW", "TER", "SYM", "TSLA", "NEM",
]

# Transcript providers index some tickers under a different symbol.
TRANSCRIPT_ALIAS = {"GOOG": "GOOGL"}


def get_universe():
    """Live capex-map tickers from /capex (falls back to the embedded list)."""
    tickers = list(DEFAULT_MAP_TICKERS)
    if WATCHLIST_BASE_URL:
        try:
            res = requests.get(f"{WATCHLIST_BASE_URL}/capex", timeout=20)
            res.raise_for_status()
            data = res.json().get("capexData")
            if data and data.get("tracks"):
                live = [t for track in data["tracks"]
                        for sub in track.get("subsectors", [])
                        for t in sub.get("tickers", [])]
                if live:
                    tickers = live
                    print(f"Loaded {len(set(live))} tickers from live /capex endpoint.")
        except Exception as e:
            print(f"WARN: /capex fetch failed ({e}) — using embedded default list.")

    universe = list(dict.fromkeys(HYPERSCALERS + tickers))  # dedupe, keep order
    if TICKER_LIMIT > 0:
        universe = universe[:TICKER_LIMIT]
        print(f"TICKER_LIMIT={TICKER_LIMIT} — restricting run to {universe}")
    return universe


# ── STAGE 1: SUPPLY-STRESS LEXICON ────────────────────────
# Weighted phrase patterns. Weight 3 = unambiguous shortage language,
# weight 1 = weak/contextual. Patterns are deliberately phrase-level to avoid
# false positives (bare "allocation" would match "capital allocation" in
# nearly every call — "on allocation" is the shortage idiom).
LEXICON = [
    (re.compile(r"\bon allocation\b", re.I), 3),
    (re.compile(r"\bsold out\b", re.I), 3),
    (re.compile(r"\b(?:capacity|supply)[- ]constrained\b", re.I), 3),
    (re.compile(r"\bshortages?\b", re.I), 3),
    (re.compile(r"\bdouble[- ]order(?:ing|s|ed)?\b", re.I), 3),
    (re.compile(r"\blead[- ]?times? (?:have |has |are |is )?"
                r"(?:extend|stretch|lengthen|push|grow|increas)\w*", re.I), 3),
    (re.compile(r"\b(?:extended|stretched|longer) lead[- ]?times?\b", re.I), 3),
    (re.compile(r"\b(?:unable|not able|struggling) to "
                r"(?:meet|keep up with|satisfy) demand\b", re.I), 3),
    (re.compile(r"\bdemand\b[^.!?]{0,40}?\b(?:exceed|outstrip|outpac)\w*\b"
                r"[^.!?]{0,30}?\b(?:supply|capacity)\b", re.I), 3),
    (re.compile(r"\brationing\b", re.I), 3),
    (re.compile(r"\b(?:fully|completely) booked\b", re.I), 2),
    (re.compile(r"\bbooked (?:out )?(?:through|into|until)\b", re.I), 2),
    (re.compile(r"\b(?:supply|capacity) (?:remains|is|stays|still) "
                r"(?:very |extremely )?tight\b", re.I), 2),
    (re.compile(r"\btight (?:supply|capacity)\b", re.I), 2),
    (re.compile(r"\btightness\b", re.I), 2),
    (re.compile(r"\bexpedite(?:d|s)? (?:fees?|charges?|orders?|shipments?)\b", re.I), 2),
    (re.compile(r"\bbottlenecks?\b", re.I), 2),
    (re.compile(r"\bsupply chain constraints?\b", re.I), 2),
    (re.compile(r"\bcapacity is (?:full|sold|committed|spoken for)\b", re.I), 2),
    (re.compile(r"\bprepay(?:ment)?s? (?:for|to secure) (?:capacity|supply)\b", re.I), 2),
    (re.compile(r"\bconstrain(?:ed|t|ts|ing)?\b", re.I), 1),
    (re.compile(r"\blead[- ]?times?\b", re.I), 1),
    (re.compile(r"\bbacklog\b", re.I), 1),
    (re.compile(r"\bwait[- ]?list(?:ed|s)?\b", re.I), 1),
]

SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'“])")
MAX_EXCERPT_CHARS = 12000


def lexicon_scan(text):
    """
    Returns (weighted_hits, raw_hits, excerpt) where excerpt is the matched
    sentences plus one neighbor each side, deduped, capped at MAX_EXCERPT_CHARS.
    """
    sentences = SENTENCE_SPLIT.split(text)
    weighted, raw = 0, 0
    keep = set()

    for i, sentence in enumerate(sentences):
        hit = False
        for pattern, weight in LEXICON:
            n = len(pattern.findall(sentence))
            if n:
                weighted += n * weight
                raw += n
                hit = True
        if hit:
            keep.update({max(0, i - 1), i, min(len(sentences) - 1, i + 1)})

    excerpt_parts, total = [], 0
    for i in sorted(keep):
        s = sentences[i].strip()
        if total + len(s) > MAX_EXCERPT_CHARS:
            break
        excerpt_parts.append(s)
        total += len(s)

    return weighted, raw, "\n".join(excerpt_parts)


def lexicon_score(weighted_hits, word_count):
    """Normalize weighted hits to a 0-100 scale: weighted hits per 10k words ×8, capped."""
    if not word_count:
        return 0.0
    per_10k = weighted_hits / word_count * 10000
    return round(min(100.0, per_10k * 8), 1)


# ── TRANSCRIPT PROVIDERS ──────────────────────────────────

# Transcripts shorter than this are stubs (e.g. a lone operator paragraph) —
# skip them and walk back to an earlier quarter instead.
MIN_TRANSCRIPT_WORDS = 300


def defeatbeta_transcripts(ticker):
    """
    Free provider. Returns {"obj": transcripts_handle, "quarters": [(fy, fq, report_date), ...]}
    newest first, or None if the ticker isn't covered.
    """
    symbol = TRANSCRIPT_ALIAS.get(ticker, ticker)
    try:
        handle = DefeatBetaTicker(symbol).earning_call_transcripts()
        lst = handle.get_transcripts_list()
        if lst is None or len(lst) == 0:
            return None
        lst = lst.sort_values(["fiscal_year", "fiscal_quarter"], ascending=False)
        quarters = [(int(r.fiscal_year), int(r.fiscal_quarter), str(r.report_date) if r.report_date else None)
                    for r in lst.itertuples()]
        return {"obj": handle, "quarters": quarters}
    except Exception as e:
        print(f"    {ticker}: defeatbeta list error — {e}")
        return None


def defeatbeta_text(handle, fiscal_year, fiscal_quarter):
    """Full transcript text ('Speaker: paragraph' per line) or None."""
    try:
        df = handle.get_transcript(fiscal_year, fiscal_quarter)
        if df is None or len(df) == 0:
            return None
        return "\n".join(f"{r.speaker}: {r.content}" for r in df.itertuples())
    except Exception:
        return None


def fetch_api_ninjas(ticker, year, quarter):
    """API Ninjas earnings transcript endpoint. Returns (text, call_date) or None."""
    res = requests.get(
        "https://api.api-ninjas.com/v1/earningstranscript",
        params={"ticker": ticker, "year": year, "quarter": quarter},
        headers={"X-Api-Key": API_NINJAS_KEY},
        timeout=30,
    )
    if res.status_code != 200:
        return None
    data = res.json()
    if isinstance(data, list):
        data = data[0] if data else None
    if not data or not data.get("transcript"):
        return None
    return data["transcript"], data.get("date")


def fetch_earningscall(ticker, year, quarter):
    """earningscall.biz transcript endpoint. Tries NASDAQ then NYSE. Returns (text, None) or None."""
    for exchange in ("NASDAQ", "NYSE"):
        res = requests.get(
            "https://v2.api.earningscall.biz/transcript",
            params={"apikey": EARNINGSCALL_API_KEY, "exchange": exchange,
                    "symbol": ticker, "year": year, "quarter": quarter},
            timeout=30,
        )
        if res.status_code == 200:
            text = res.json().get("text")
            if text:
                return text, None
        time.sleep(0.5)
    return None


def fetch_transcript(ticker, year, quarter):
    """Try each configured provider in order. Returns (text, call_date, provider) or None."""
    symbol = TRANSCRIPT_ALIAS.get(ticker, ticker)
    providers = []
    if API_NINJAS_KEY:
        providers.append(("api-ninjas", fetch_api_ninjas))
    if EARNINGSCALL_API_KEY:
        providers.append(("earningscall", fetch_earningscall))

    for name, fn in providers:
        try:
            result = fn(symbol, year, quarter)
            if result:
                return result[0], result[1], name
        except Exception as e:
            print(f"    {ticker} {year}Q{quarter}: {name} error — {e}")
        time.sleep(PROVIDER_PAUSE)
    return None


def recent_quarters(n=LOOKBACK_QUARTERS):
    """Last n COMPLETED calendar quarters, newest first, as (year, quarter)."""
    today = date.today()
    y, q = today.year, (today.month - 1) // 3 + 1
    out = []
    for _ in range(n):
        q -= 1
        if q == 0:
            y, q = y - 1, 4
        out.append((y, q))
    return out


# ── STAGE 2: GEMINI CLASSIFICATION ────────────────────────

STRESS_PROMPT = """You are a supply-chain analyst for AI infrastructure. Below are excerpts from the {year} Q{quarter} earnings call of {ticker}. Each excerpt was flagged because it contains supply/capacity language.

Score ONLY supply-chain stress evidence — demand strength, capacity limits, lead times, allocation, input shortages. Ignore general sentiment, guidance beats, and macro commentary.

Classify the company's position:
- "constrained_supplier": the company ITSELF cannot make enough of what it sells (it owns the bottleneck — pricing power, sold-out capacity)
- "constrained_buyer": the company cannot get enough INPUTS it needs (it is downstream of a bottleneck)
- "both": clearly both at once
- "neutral": flagged language turned out to be routine (e.g., normal backlog commentary, improving lead times)

stress_score guide: 0-15 routine commentary; 16-39 mild tightness mentioned; 40-69 clear, repeated constraint language; 70-100 explicit allocation/sold-out/shortage statements about current operations.

Quotes MUST be verbatim substrings of the excerpts. Max 5, pick the most load-bearing.

Respond with ONLY a valid JSON object — no markdown fences, no preamble:
{{
  "stress_score": <integer 0-100>,
  "direction": "constrained_supplier" | "constrained_buyer" | "both" | "neutral",
  "summary": "<one or two sentences: what is constrained and how severe>",
  "quotes": [{{"quote": "<verbatim>", "signal": "<3-8 word label>"}}]
}}

EXCERPTS:
{excerpts}"""


def call_gemini(prompt, max_retries=3):
    """Mirrors functions/capex-intel.js: REST call, fence-strip, JSON parse, backoff on 429/5xx."""
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}")
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 2048,
            # Force structured output — no markdown fences, no prose.
            "responseMimeType": "application/json",
            # gemini-2.5-flash "thinks" by default and thinking tokens count
            # against maxOutputTokens, which truncated responses mid-JSON.
            # This is a mechanical classification — no thinking needed.
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    delay = 15
    for attempt in range(max_retries):
        res = requests.post(url, json=body, timeout=60)
        if res.status_code in (429, 500, 503, 529):
            print(f"    Gemini {res.status_code} — waiting {delay}s (retry {attempt + 1}/{max_retries})...")
            time.sleep(delay)
            delay *= 2
            continue
        res.raise_for_status()
        data = res.json()
        parts = data.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts).strip()
        if not text:
            raise ValueError("Empty Gemini response")
        text = re.sub(r"^```json\s*|^```\s*|```\s*$", "", text, flags=re.I | re.M).strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            if attempt < max_retries - 1:
                print(f"    Gemini returned malformed JSON ({e}) — retrying...")
                continue
            raise
    raise RuntimeError("Gemini retries exhausted")


def classify_with_gemini(ticker, year, quarter, excerpts):
    """Returns validated dict or None (caller falls back to lexicon-only score)."""
    try:
        result = call_gemini(STRESS_PROMPT.format(
            ticker=ticker, year=year, quarter=quarter, excerpts=excerpts))
        score = result.get("stress_score")
        direction = result.get("direction")
        if not isinstance(score, (int, float)) or not (0 <= score <= 100):
            raise ValueError(f"bad stress_score: {score!r}")
        if direction not in ("constrained_supplier", "constrained_buyer", "both", "neutral"):
            direction = "neutral"
        quotes = [
            {"quote": str(q.get("quote", ""))[:500], "signal": str(q.get("signal", ""))[:80]}
            for q in (result.get("quotes") or [])[:5]
            if isinstance(q, dict) and q.get("quote")
        ]
        return {
            "stress_score": round(float(score), 1),
            "direction": direction,
            "summary": str(result.get("summary", ""))[:600],
            "quotes": quotes,
        }
    except Exception as e:
        print(f"    {ticker} {year}Q{quarter}: Gemini classification failed — {e}")
        return None


# ── DATABASE ──────────────────────────────────────────────

def connect_db(url, max_retries=3):
    """
    psycopg2.connect with a fast timeout and retries. GitHub runner → Neon
    connections occasionally hit a network blackout (TCP timeout on every
    pooler IP); the default OS timeout burns ~2 min per IP and then the job
    dies. A 20s cap plus fresh attempts usually lands on a healthy path.
    """
    delay = 10
    last_err = None
    for attempt in range(max_retries):
        try:
            return psycopg2.connect(url, connect_timeout=20)
        except psycopg2.OperationalError as e:
            last_err = e
            print(f"DB connect failed (attempt {attempt + 1}/{max_retries}): {e}")
            if attempt < max_retries - 1:
                time.sleep(delay)
                delay *= 2
    raise last_err


BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS transcript_stress (
        ticker          TEXT    NOT NULL,
        fiscal_year     INTEGER NOT NULL,
        fiscal_quarter  INTEGER NOT NULL,
        call_date       DATE,
        provider        TEXT,
        word_count      INTEGER,
        lexicon_hits    INTEGER,
        lexicon_score   DOUBLE PRECISION,
        stress_score    DOUBLE PRECISION,
        direction       TEXT,
        summary         TEXT,
        quotes          JSONB,
        model           TEXT,
        analyzed_at     TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (ticker, fiscal_year, fiscal_quarter)
    );
"""

UPSERT_SQL = """
    INSERT INTO transcript_stress
        (ticker, fiscal_year, fiscal_quarter, call_date, provider, word_count,
         lexicon_hits, lexicon_score, stress_score, direction, summary, quotes, model)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (ticker, fiscal_year, fiscal_quarter) DO UPDATE SET
        call_date     = EXCLUDED.call_date,
        provider      = EXCLUDED.provider,
        word_count    = EXCLUDED.word_count,
        lexicon_hits  = EXCLUDED.lexicon_hits,
        lexicon_score = EXCLUDED.lexicon_score,
        stress_score  = EXCLUDED.stress_score,
        direction     = EXCLUDED.direction,
        summary       = EXCLUDED.summary,
        quotes        = EXCLUDED.quotes,
        model         = EXCLUDED.model,
        analyzed_at   = now();
"""


def get_existing_keys(conn):
    """
    Set of (ticker, year, quarter) we can skip. A row is final if it got a
    Gemini classification (model set) or never needed one (zero lexicon hits).
    Lexicon-only rows WITH hits are degraded — Gemini was down or returned
    garbage when they were written — so when a Gemini key is available we
    leave them out of this set and the upsert upgrades them in place.
    """
    with conn.cursor() as cur:
        if GEMINI_API_KEY:
            cur.execute("""
                SELECT ticker, fiscal_year, fiscal_quarter FROM transcript_stress
                WHERE model IS NOT NULL OR COALESCE(lexicon_hits, 0) = 0
            """)
        else:
            cur.execute("SELECT ticker, fiscal_year, fiscal_quarter FROM transcript_stress")
        return {(t, y, q) for t, y, q in cur.fetchall()}


# ── MAIN ─────────────────────────────────────────────────

def analyze_ticker(conn, ticker, calendar_quarters, existing):
    """Analyze the most recent transcripts for one ticker; upsert anything missing."""
    # Candidate plan: defeatbeta's own quarter list is authoritative (it uses
    # each company's FISCAL calendar). The calendar-quarter walk only applies
    # to the paid fallback providers.
    dbeta = defeatbeta_transcripts(ticker) if DEFEATBETA_OK else None
    if dbeta:
        candidates = [(fy, fq, rd, "defeatbeta") for fy, fq, rd in dbeta["quarters"][:LOOKBACK_QUARTERS]]
    elif API_NINJAS_KEY or EARNINGSCALL_API_KEY:
        candidates = [(y, q, None, "paid") for y, q in calendar_quarters]
    else:
        print(f"  {ticker}: not covered by defeatbeta and no paid provider key — skipped")
        return

    on_file = sum(1 for (y, q, _, _) in candidates if (ticker, y, q) in existing)

    for year, quarter, call_date, source in candidates:
        if on_file >= QUARTERS_WANTED:
            break
        if (ticker, year, quarter) in existing:
            continue

        if source == "defeatbeta":
            text, provider = defeatbeta_text(dbeta["obj"], year, quarter), "defeatbeta"
        else:
            fetched = fetch_transcript(ticker, year, quarter)
            if not fetched:
                continue
            text, call_date, provider = fetched

        if not text:
            continue
        word_count = len(text.split())
        if word_count < MIN_TRANSCRIPT_WORDS:
            print(f"  {ticker} {year}Q{quarter}: stub transcript ({word_count}w) — skipped")
            continue
        weighted, raw, excerpt = lexicon_scan(text)
        lex = lexicon_score(weighted, word_count)

        ai, model_used = None, None
        if excerpt and GEMINI_API_KEY:
            ai = classify_with_gemini(ticker, year, quarter, excerpt)
            model_used = GEMINI_MODEL if ai else None
            time.sleep(GEMINI_PAUSE)

        if ai:
            stress, direction = ai["stress_score"], ai["direction"]
            summary, quotes = ai["summary"], ai["quotes"]
        else:
            # Lexicon-only fallback: capped at 40 — keyword density alone
            # should never claim "severe", that judgment needs the LLM pass.
            stress, direction = min(lex, 40.0), None
            summary, quotes = None, []

        with conn.cursor() as cur:
            cur.execute(UPSERT_SQL, (
                ticker, year, quarter, call_date, provider, word_count,
                raw, lex, stress, direction, summary,
                psycopg2.extras.Json(quotes), model_used,
            ))
        conn.commit()
        existing.add((ticker, year, quarter))
        on_file += 1
        print(f"  {ticker} {year}Q{quarter}: stress={stress} "
              f"({'gemini' if ai else 'lexicon-only'}, hits={raw}, {word_count}w, {provider})")


if __name__ == "__main__":
    print("=== Transcript Stress ETL ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")
    if not DEFEATBETA_OK and not API_NINJAS_KEY and not EARNINGSCALL_API_KEY:
        raise SystemExit("No transcript source: pip install defeatbeta-api (free) "
                         "or set API_NINJAS_KEY / EARNINGSCALL_API_KEY.")
    if not DEFEATBETA_OK:
        print("WARN: defeatbeta-api not installed — relying on paid providers only.")
    if not GEMINI_API_KEY:
        print("WARN: GEMINI_API_KEY not set — scores will be lexicon-only (capped at 40).")

    universe = get_universe()
    quarters = recent_quarters()
    print(f"Universe: {len(universe)} tickers · quarters: "
          + ", ".join(f"{y}Q{q}" for y, q in quarters))

    conn = connect_db(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
        conn.commit()

        existing = get_existing_keys(conn)
        print(f"{len(existing)} transcript analyses already on file.")

        for n, ticker in enumerate(universe, 1):
            print(f"[{n}/{len(universe)}] {ticker}")
            try:
                analyze_ticker(conn, ticker, quarters, existing)
            except psycopg2.Error:
                raise  # DB problems are fatal — don't grind through the whole list
            except Exception as e:
                print(f"  {ticker}: skipped — {e}")
    finally:
        conn.close()

    print("=== Transcript Stress ETL complete ===")
