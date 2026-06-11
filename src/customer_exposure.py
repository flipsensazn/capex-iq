# customer_exposure.py
#
# Per-edge revenue-exposure percentages from customer-concentration
# disclosures in SEC filings — turning the supply graph's curated edge
# weights into filed facts.
#
# Companies must disclose customers that exceed ~10% of revenue (ASC 280).
# The disclosures are TEXT, not structured XBRL (concentration facts are
# dimensioned, so they never appear in the companyfacts API), and customers
# are often anonymized ("Customer A"). Pipeline:
#
#   1. EDGAR submissions index → latest annual report (10-K / 20-F) and
#      latest 10-Q per ticker
#   2. Filing HTML → text → narrow excerpt windows: a percentage figure near
#      "customer" + revenue/receivable language
#   3. Gemini extracts structured rows from ONLY those windows — customer
#      name exactly as printed (or the anonymous label), percent, basis
#      (revenue vs accounts receivable), period, and a verbatim quote
#   4. Named customers are mapped to tickers via an alias table — no
#      guessing: anonymous customers stay anonymous
#   5. Rows land in Neon `customer_exposure`, served by GET /exposure, and
#      the supply graph upgrades matching edges from curated criticality to
#      filed exposure percentages
#
# Env vars:
#   DATABASE_URL        required
#   GEMINI_API_KEY      required (text extraction is the whole feature)
#   WATCHLIST_BASE_URL  optional  live capex-map tickers
#   TICKER_LIMIT        optional  cap tickers per run (testing)

import json
import os
import re
import time
from datetime import date

import psycopg2
import psycopg2.extras
import requests

# Shared helpers from the sibling ETLs
from transcript_stress import get_universe, call_gemini, connect_db, GEMINI_API_KEY

DATABASE_URL = os.environ.get("DATABASE_URL")
SEC_HEADERS  = {"User-Agent": "WizzlesWatchlist flipsensazn@gmail.com"}
SEC_PAUSE    = 0.15
GEMINI_PAUSE = 5

ANNUAL_FORMS    = ("10-K", "10-K/A", "20-F")
QUARTERLY_FORMS = ("10-Q", "10-Q/A")

# ── CUSTOMER NAME → TICKER ALIASES ────────────────────────
# Only NAMED customers are mapped. Substring match, case-insensitive,
# longest alias first so "amazon web services" wins over "amazon".
CUSTOMER_ALIASES = [
    ("amazon web services", "AMZN"), ("amazon", "AMZN"), ("aws", "AMZN"),
    ("microsoft", "MSFT"), ("azure", "MSFT"),
    ("alphabet", "GOOG"), ("google", "GOOG"),
    ("meta platforms", "META"), ("facebook", "META"), ("meta", "META"),
    ("oracle", "ORCL"),
    ("nvidia", "NVDA"),
    ("advanced micro devices", "AMD"), ("amd", "AMD"),
    ("taiwan semiconductor", "TSM"), ("tsmc", "TSM"),
    ("broadcom", "AVGO"),
    ("marvell", "MRVL"),
    ("micron", "MU"),
    ("intel", "INTC"),
    ("apple", "AAPL"),
    ("cisco", "CSCO"),
    ("arista", "ANET"),
    ("hewlett packard enterprise", "HPE"), ("hpe", "HPE"),
    ("dell", "DELL"),
    ("super micro", "SMCI"), ("supermicro", "SMCI"),
    ("coreweave", "CRWV"),
    ("lumentum", "LITE"),
    ("coherent", "COHR"),
    ("fabrinet", "FN"),
    ("equinix", "EQIX"),
    ("digital realty", "DLR"),
    ("vertiv", "VRT"),
    ("eaton", "ETN"),
    ("tesla", "TSLA"),
    ("oklo", "OKLO"),
    ("nuscale", "SMR"),
]


def map_customer(label):
    low = label.lower()
    for alias, ticker in sorted(CUSTOMER_ALIASES, key=lambda x: -len(x[0])):
        if alias in low:
            return ticker
    return None


# ── EDGAR FETCH ───────────────────────────────────────────

def get_cik_map():
    res = requests.get("https://www.sec.gov/files/company_tickers.json",
                       headers=SEC_HEADERS, timeout=30)
    res.raise_for_status()
    return {v["ticker"]: str(v["cik_str"]).zfill(10) for v in res.json().values()}


def latest_filings(cik):
    """[(form, accession, primary_doc, filed_date)] — newest annual + newest quarterly."""
    res = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json",
                       headers=SEC_HEADERS, timeout=30)
    if res.status_code != 200:
        return []
    recent = res.json().get("filings", {}).get("recent", {})
    rows = list(zip(recent.get("form", []), recent.get("accessionNumber", []),
                    recent.get("primaryDocument", []), recent.get("filingDate", [])))
    out, seen = [], set()
    for form, acc, doc, filed in rows:  # rows are newest-first
        kind = "annual" if form in ANNUAL_FORMS else "quarterly" if form in QUARTERLY_FORMS else None
        if kind and kind not in seen and doc:
            seen.add(kind)
            out.append((form, acc, doc, filed))
        if len(seen) == 2:
            break
    return out


TAG_RE    = re.compile(r"<(?:script|style)[^>]*>.*?</(?:script|style)>", re.S | re.I)
HTML_RE   = re.compile(r"<[^>]+>")
ENTITY_RE = re.compile(r"&(?:nbsp|#160|amp|#38|lt|gt|#\d+|[a-z]+);", re.I)
WS_RE     = re.compile(r"\s+")


def fetch_filing_text(cik, accession, primary_doc):
    url = (f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
           f"{accession.replace('-', '')}/{primary_doc}")
    res = requests.get(url, headers=SEC_HEADERS, timeout=120)
    if res.status_code != 200:
        return None, url
    text = TAG_RE.sub(" ", res.text)
    text = HTML_RE.sub(" ", text)
    text = ENTITY_RE.sub(" ", text)
    return WS_RE.sub(" ", text), url


# ── EXCERPT WINDOWS ───────────────────────────────────────
# A concentration disclosure is a percentage near "customer" plus revenue or
# receivable language. Windows keep the Gemini payload tiny and on-target.

PCT_RE = re.compile(r"\b\d{1,2}(?:\.\d{1,2})?\s?%")
WINDOW = 450
MAX_EXCERPT_CHARS = 9000


def concentration_windows(text):
    spans = []
    for m in PCT_RE.finditer(text):
        lo, hi = max(0, m.start() - WINDOW), min(len(text), m.end() + WINDOW)
        ctx = text[lo:hi].lower()
        if "customer" not in ctx:
            continue
        if not any(k in ctx for k in ("revenue", "net sales", "total sales", "accounts receivable")):
            continue
        if spans and lo <= spans[-1][1]:
            spans[-1] = (spans[-1][0], hi)  # merge overlap
        else:
            spans.append((lo, hi))
    out, total = [], 0
    for lo, hi in spans:
        chunk = text[lo:hi].strip()
        if total + len(chunk) > MAX_EXCERPT_CHARS:
            break
        out.append(chunk)
        total += len(chunk)
    return out


# ── GEMINI EXTRACTION ─────────────────────────────────────

EXTRACT_PROMPT = """You are extracting customer-concentration disclosures from excerpts of {ticker}'s {form} SEC filing.

Extract EVERY statement of the form "a customer accounted for X% of revenue/net sales/accounts receivable". Rules:
- customer: the name EXACTLY as printed. If anonymous ("one customer", "Customer A"), use the printed label ("Customer A") or "unnamed customer".
- Do NOT guess identities. Do NOT include supplier or geographic concentration.
- basis: "revenue" for revenue/net sales/total sales; "accounts_receivable" for AR.
- period: as stated, e.g. "fiscal 2025", "three months ended March 2026". If several periods are given for the same customer, emit one row per period.
- pct: the number only.
- quote: a SHORT verbatim fragment (≤200 chars) containing the figure.

Respond with ONLY a valid JSON array (empty array if nothing qualifies):
[{{"customer": "...", "pct": 38.0, "basis": "revenue", "period": "fiscal 2025", "quote": "..."}}]

EXCERPTS:
{excerpts}"""


def extract_disclosures(ticker, form, excerpts):
    raw = call_gemini(EXTRACT_PROMPT.format(ticker=ticker, form=form,
                                            excerpts="\n---\n".join(excerpts)))
    if not isinstance(raw, list):
        return []
    rows = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        try:
            pct = float(r.get("pct"))
        except (TypeError, ValueError):
            continue
        if not (1 <= pct <= 100):
            continue
        label = str(r.get("customer") or "unnamed customer").strip()[:120]
        basis = r.get("basis") if r.get("basis") in ("revenue", "accounts_receivable") else "revenue"
        rows.append({
            "label": label, "ticker": map_customer(label), "pct": pct,
            "basis": basis, "period": str(r.get("period") or "")[:80],
            "quote": str(r.get("quote") or "")[:300],
        })
    return rows


def best_rows(all_rows):
    """
    One row per (customer label, basis): filings repeat the same customer for
    multiple periods and across the 10-K and 10-Q — keep the highest-pct row
    from the NEWEST filing batch that mentions it (rows arrive newest-first).
    """
    best = {}
    for r in all_rows:
        key = (r["label"].lower(), r["basis"])
        if key not in best:
            best[key] = r
    return list(best.values())


# ── DATABASE ──────────────────────────────────────────────

BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS customer_exposure (
        ticker          TEXT NOT NULL,
        customer_label  TEXT NOT NULL,
        customer_ticker TEXT,
        pct             DOUBLE PRECISION NOT NULL,
        basis           TEXT NOT NULL,
        period          TEXT,
        source_form     TEXT,
        source_url      TEXT,
        filed           DATE,
        quote           TEXT,
        extracted_at    TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (ticker, customer_label, basis)
    );
"""


def load_ticker(conn, ticker, rows):
    """Replace this supplier's rows wholesale — customer sets change between filings."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM customer_exposure WHERE ticker = %s", (ticker,))
        psycopg2.extras.execute_values(cur, """
            INSERT INTO customer_exposure
                (ticker, customer_label, customer_ticker, pct, basis, period,
                 source_form, source_url, filed, quote)
            VALUES %s
        """, [(ticker, r["label"], r["ticker"], r["pct"], r["basis"], r["period"],
               r["form"], r["url"], r["filed"], r["quote"]) for r in rows])
    conn.commit()


# ── MAIN ─────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Customer Exposure ETL ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")
    if not GEMINI_API_KEY:
        raise SystemExit("GEMINI_API_KEY not set — text extraction requires it.")

    universe = get_universe()
    cik_map = get_cik_map()

    conn = connect_db(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
        conn.commit()

        loaded = skipped = 0
        for n, ticker in enumerate(universe, 1):
            cik = cik_map.get(ticker)
            if not cik:
                print(f"[{n}/{len(universe)}] {ticker}: no CIK — skipped")
                skipped += 1
                continue
            try:
                filings = latest_filings(cik)
                time.sleep(SEC_PAUSE)
                candidates = []
                for form, acc, doc, filed in filings:
                    text, url = fetch_filing_text(cik, acc, doc)
                    time.sleep(SEC_PAUSE)
                    if not text:
                        continue
                    windows = concentration_windows(text)
                    if not windows:
                        continue
                    rows = extract_disclosures(ticker, form, windows)
                    time.sleep(GEMINI_PAUSE)
                    for r in rows:
                        r.update({"form": form, "url": url, "filed": filed})
                    candidates.extend(rows)

                final = best_rows(candidates)
                if final:
                    load_ticker(conn, ticker, final)
                    loaded += 1
                    named = [f"{r['label']}={r['pct']:.0f}%" for r in final if r["basis"] == "revenue"][:4]
                    print(f"[{n}/{len(universe)}] {ticker}: {len(final)} rows ({', '.join(named) or 'AR only'})")
                else:
                    print(f"[{n}/{len(universe)}] {ticker}: no concentration disclosures found")
                    skipped += 1
            except psycopg2.Error:
                raise
            except Exception as e:
                print(f"[{n}/{len(universe)}] {ticker}: error — {e}")
                skipped += 1
    finally:
        conn.close()

    print(f"=== Customer Exposure ETL complete: {loaded} suppliers loaded, {skipped} skipped ===")
