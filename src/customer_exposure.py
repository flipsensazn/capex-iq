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
#   CUSTOMER_EXPOSURE_MIN_POSITIVE_RETENTION
#                       optional  prior positive-ticker safety floor (default .75)

import json
import math
import os
import re
import time
import unicodedata
from datetime import date, datetime

import psycopg2
import psycopg2.extras
import requests

# Shared helpers from the sibling ETLs
from transcript_stress import get_universe, call_gemini, connect_db, GEMINI_API_KEY
from etl_health import (
    CoverageError,
    RunStats,
    begin_run,
    evaluate_health,
    finish_run,
    record_failure_safely,
    threshold_from_env,
    write_run,
)

DATABASE_URL = os.environ.get("DATABASE_URL")
SEC_HEADERS  = {"User-Agent": "WizzlesWatchlist flipsensazn@gmail.com"}
SEC_PAUSE    = 0.15
GEMINI_PAUSE = 5

AUTHORITATIVE_ANNUAL_FORMS = ("10-K", "20-F")
ANNUAL_AMENDMENT_FORMS = ("10-K/A", "20-F/A")
ANNUAL_FORMS    = (*AUTHORITATIVE_ANNUAL_FORMS, *ANNUAL_AMENDMENT_FORMS)
AUTHORITATIVE_QUARTERLY_FORMS = ("10-Q",)
QUARTERLY_AMENDMENT_FORMS = ("10-Q/A",)
QUARTERLY_FORMS = (*AUTHORITATIVE_QUARTERLY_FORMS, *QUARTERLY_AMENDMENT_FORMS)
EXPOSURE_BASES  = ("revenue", "accounts_receivable")


class IncompleteExposureScan(RuntimeError):
    """A ticker scan that must not replace its last known-good rows."""


class NoSupportedFilings(RuntimeError):
    """The SEC index is complete, but this issuer has no supported form."""


class ExposureRetentionError(RuntimeError):
    """A staged run would destructively remove too many prior positive tickers."""


class ExposurePublishRegression(RuntimeError):
    """A concurrent publisher made the staged replacement stale."""

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
    low = normalize_verbatim(label)
    for alias, ticker in sorted(CUSTOMER_ALIASES, key=lambda x: -len(x[0])):
        normalized_alias = normalize_verbatim(alias)
        if re.search(
            rf"(?<!\w){re.escape(normalized_alias)}(?!\w)", low
        ):
            return ticker
    return None


# ── EDGAR FETCH ───────────────────────────────────────────

def get_cik_map():
    res = requests.get("https://www.sec.gov/files/company_tickers.json",
                       headers=SEC_HEADERS, timeout=30)
    res.raise_for_status()
    return {v["ticker"]: str(v["cik_str"]).zfill(10) for v in res.json().values()}


def _parse_iso_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def latest_filings(cik):
    """Newest originals plus useful amendments, with SEC report dates.

    Amendments may add facts, but their silence cannot prove that the original
    filing had no disclosure. Keep the newest original and amendment for each
    cadence so ``scan_ticker`` can extract from both while creating absence
    markers only from an original annual filing.
    """
    try:
        res = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json",
                           headers=SEC_HEADERS, timeout=30)
    except requests.RequestException as exc:
        raise IncompleteExposureScan(f"SEC submissions fetch failed for CIK {cik}") from exc
    if res.status_code != 200:
        raise IncompleteExposureScan(
            f"SEC submissions fetch returned HTTP {res.status_code} for CIK {cik}"
        )
    try:
        recent = res.json()["filings"]["recent"]
    except (KeyError, TypeError, ValueError) as exc:
        raise IncompleteExposureScan(f"invalid SEC submissions payload for CIK {cik}") from exc
    if not isinstance(recent, dict):
        raise IncompleteExposureScan(f"invalid SEC submissions payload for CIK {cik}")
    columns = [
        recent.get("form"),
        recent.get("accessionNumber"),
        recent.get("primaryDocument"),
        recent.get("filingDate"),
        recent.get("reportDate"),
    ]
    if not all(isinstance(column, list) for column in columns):
        raise IncompleteExposureScan(f"invalid SEC submissions arrays for CIK {cik}")
    if len({len(column) for column in columns}) != 1:
        raise IncompleteExposureScan(f"incomplete SEC submissions arrays for CIK {cik}")
    rows = list(zip(*columns))
    selected = {}
    for position, (form, acc, doc, filed, report_date) in enumerate(rows):
        if form in AUTHORITATIVE_ANNUAL_FORMS:
            kind = "annual_original"
        elif form in ANNUAL_AMENDMENT_FORMS:
            kind = "annual_amendment"
        elif form in AUTHORITATIVE_QUARTERLY_FORMS:
            kind = "quarterly_original"
        elif form in QUARTERLY_AMENDMENT_FORMS:
            kind = "quarterly_amendment"
        else:
            kind = None
        if kind and kind not in selected and not all(
            isinstance(value, str) and value
            for value in (acc, doc, filed, report_date)
        ):
            raise IncompleteExposureScan(f"incomplete supported filing metadata for CIK {cik}")
        if kind and kind not in selected and (
            _parse_iso_date(filed) is None or _parse_iso_date(report_date) is None
        ):
            raise IncompleteExposureScan(f"invalid supported filing dates for CIK {cik}")
        if kind and kind not in selected:
            selected[kind] = (
                position, (form, acc, doc, filed, report_date)
            )
    out = [row for _, row in sorted(selected.values())]
    if not out:
        raise NoSupportedFilings(f"no supported SEC filings found for CIK {cik}")
    return out


TAG_RE    = re.compile(r"<(?:script|style)[^>]*>.*?</(?:script|style)>", re.S | re.I)
HTML_RE   = re.compile(r"<[^>]+>")
ENTITY_RE = re.compile(r"&(?:nbsp|#160|amp|#38|lt|gt|#\d+|[a-z]+);", re.I)
WS_RE     = re.compile(r"\s+")
PERCENT_VALUE_RE = re.compile(r"\b(100|\d{1,2})(?:\.(\d+))?\s*(?:%|percent\b)", re.I)

NORMALIZE_TRANSLATION = str.maketrans({
    "\u00a0": " ",
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
})

MONTH_NUMBERS = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
}
MONTH_PATTERN = "|".join(MONTH_NUMBERS)
PERIOD_DATE_RE = re.compile(
    rf"\b({MONTH_PATTERN})\s+(\d{{1,2}}),?\s+((?:19|20)\d{{2}})\b",
    re.I,
)
PERIOD_QUARTER_RE = re.compile(
    r"(?:\bq([1-4])\s*((?:19|20)\d{2})\b|"
    r"\b((?:19|20)\d{2})\s*q([1-4])\b|"
    r"\b(?:first|second|third|fourth)\s+quarter(?:\s+of)?\s+((?:19|20)\d{2})\b)",
    re.I,
)


def normalize_verbatim(value):
    """Normalize typography and whitespace without changing the words."""
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    return WS_RE.sub(" ", normalized.translate(NORMALIZE_TRANSLATION)).strip().casefold()


def statement_semantics(text):
    """Classify a concentration sentence before it can become a filed fact."""
    normalized = normalize_verbatim(text)
    if not normalized:
        return "unknown"

    negative_subject = (
        r"(?:\bno\s+(?:(?:single|individual|one)\s+)?customers?\b|"
        r"\bnone\s+of\s+(?:our\s+|the\s+)?customers?\b|"
        r"\bcustomers?\b[^.;]{0,40}\b(?:did|does|do|was|were)\s+not\b|"
        r"\b(?:did|does|do|was|were)\s+not\b[^.;]{0,40}\bcustomers?\b)"
    )
    negative_share_clause = re.search(
        rf"{negative_subject}[^.;]{{0,100}}"
        r"\b(?:account(?:ed)?\s+for|represent(?:ed)?|compris(?:ed|e)|"
        r"constitut(?:ed|e)|generat(?:ed|e)|contribut(?:ed|e)|"
        r"made\s+up|make\s+up)\b"
        rf"[^.;]{{0,80}}{PERCENT_VALUE_RE.pattern}[^.;]{{0,90}}"
        r"\b(?:revenues?|sales|accounts?\s+receivable|receivables)\b",
        normalized,
    )
    if negative_share_clause:
        return "negative"

    if re.search(
        r"\b(?:defined|considered|regarded)\s+as\b|"
        r"\b(?:major|significant)\s+customer\s+(?:is|means)\b|"
        r"\b(?:more|greater|less)\s+than\s+\d|"
        r"\bat\s+least\s+\d|\bin\s+excess\s+of\s+\d|"
        r"\d+(?:\.\d+)?\s*(?:%|percent)\s+or\s+(?:more|greater|less)\b",
        normalized,
    ):
        return "threshold"

    respectively = "respectively" in normalized
    if respectively and _respective_customer_pairs(normalized):
        return "single_customer"
    aggregate = re.search(
        r"\b(?:collectively|combined|in\s+aggregate|as\s+a\s+group)\b|"
        r"\b(?:top\s+)?(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+"
        r"(?:largest\s+|major\s+|significant\s+)?customers\b|"
        r"\bcustomer\b.{0,60}\band\s+(?:another\s+)?customer\b|"
        r"\bcustomer\s+[^.;]{0,40}\band\b[^.;]{0,40}"
        r"\b(?:accounted|represented|comprised|constituted|generated)\b",
        normalized,
    )
    plural_fact = re.search(
        r"\bcustomers\b.{0,100}\b(?:accounted|represented|comprised|constituted|generated)\b",
        normalized,
    )
    one_of_customers = re.search(r"\bone\s+of\s+(?:our\s+|the\s+)?customers\b", normalized)
    if aggregate or (plural_fact and not respectively and not one_of_customers):
        return "aggregate"

    percentage_pattern = PERCENT_VALUE_RE.pattern
    basis_pattern = r"\b(?:revenues?|sales|accounts?\s+receivable|receivables)\b"
    share_construction = re.search(
        rf"\b(?:accounted\s+for|represented|comprised|constituted|generated|contributed|made\s+up)\b"
        rf"[^.;]{{0,90}}{percentage_pattern}[^.;]{{0,90}}{basis_pattern}|"
        rf"{percentage_pattern}[^.;]{{0,90}}{basis_pattern}[^.;]{{0,90}}"
        rf"\b(?:was|were)\s+(?:attributable\s+to|derived\s+from|generated\s+by)\b",
        normalized,
    )
    has_customer = bool(re.search(r"\bcustomer\b", normalized))
    if share_construction and has_customer:
        return "single_customer"
    return "unknown"


def period_end(period):
    """Return only an end date explicitly printed in the disclosed period."""
    normalized = normalize_verbatim(period)
    match = PERIOD_DATE_RE.search(normalized)
    if match:
        month, day, year = match.groups()
        try:
            return date(int(year), MONTH_NUMBERS[month.lower()], int(day))
        except ValueError:
            return None

    return None


def resolved_period_end(period, report_date=None):
    """Resolve an explicit date or apply the SEC fiscal month/day to one year."""
    explicit = period_end(period)
    if explicit is not None:
        return explicit
    report_period = _parse_iso_date(report_date)
    years = {int(year) for year in re.findall(
        r"\b((?:19|20)\d{2})\b", normalize_verbatim(period)
    )}
    if report_period is None or len(years) != 1:
        return None
    try:
        return date(years.pop(), report_period.month, report_period.day)
    except ValueError:
        return None


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

PCT_RE = re.compile(
    r"\b(?:100|\d{1,2})(?:\.\d{1,2})?\s*(?:%|percent\b)", re.I
)
WINDOW_BASIS_RE = re.compile(
    r"\b(?:revenues?|sales|accounts?\s+receivable|receivables)\b", re.I
)
WINDOW = 450
MAX_EXCERPT_CHARS = 9000


def concentration_windows(text):
    spans = []
    for m in PCT_RE.finditer(text):
        lo, hi = max(0, m.start() - WINDOW), min(len(text), m.end() + WINDOW)
        ctx = text[lo:hi].lower()
        if "customer" not in ctx:
            continue
        if not WINDOW_BASIS_RE.search(ctx):
            continue
        if spans and lo <= spans[-1][1]:
            spans[-1] = (spans[-1][0], hi)  # merge overlap
        else:
            spans.append((lo, hi))
    out, total, truncated = [], 0, False
    for lo, hi in spans:
        chunk = text[lo:hi].strip()
        remaining = MAX_EXCERPT_CHARS - total
        if len(chunk) > remaining:
            if remaining >= WINDOW:
                out.append(chunk[:remaining])
                total += remaining
            truncated = True
            break
        out.append(chunk)
        total += len(chunk)
    return out, truncated


# ── GEMINI EXTRACTION ─────────────────────────────────────

EXTRACT_PROMPT = """You are extracting customer-concentration disclosures from excerpts of {ticker}'s {form} SEC filing.

Extract EVERY factual SINGLE-CUSTOMER statement of the form "a customer accounted for X% of revenue/net sales/accounts receivable" AND every explicit negative statement such as "no single customer accounted for more than X%". Rules:
- statement_type: "single_customer" for a positive customer fact; "negative" for an explicit no-customer fact.
- customer: for a positive fact, the name EXACTLY as printed. If anonymous ("one customer", "Customer A"), use the printed label ("Customer A") or "unnamed customer". Omit customer for a negative fact.
- Do NOT guess identities. Do NOT include supplier, geographic, combined-customer, or definition/threshold statements.
- basis: "revenue" for revenue/net sales/total sales; "accounts_receivable" for AR.
- period: copy the exact period wording printed in the quote, e.g. "fiscal 2025" or "three months ended March 31, 2026". If several periods are given for the same customer, emit one row per period.
- pct: the number only.
- quote: a SHORT VERBATIM fragment (≤220 chars) containing the customer, figure, basis, and exact period. Never paraphrase or omit words with ellipses.

Respond with ONLY a valid JSON array (empty array if nothing qualifies):
[{{"statement_type": "single_customer", "customer": "...", "pct": 38.0, "basis": "revenue", "period": "fiscal 2025", "quote": "..."}}]

EXCERPTS:
{excerpts}"""


def _percentage_values(text):
    values = []
    for match in PERCENT_VALUE_RE.finditer(normalize_verbatim(text)):
        whole, decimal = match.groups()
        values.append(float(f"{whole}.{decimal}" if decimal else whole))
    return values


def _quote_is_verbatim(quote, excerpts):
    normalized_quote = normalize_verbatim(quote).strip(" '\".,;:")
    return bool(normalized_quote) and any(
        normalized_quote in normalize_verbatim(excerpt) for excerpt in excerpts
    )


def _allocation_clauses(quote):
    normalized = normalize_verbatim(quote)
    return [
        clause.strip()
        for clause in re.split(r"(?:[.!?]+\s+|;\s*)", normalized)
        if clause.strip()
    ]


def _basis_in_clause(clause, basis):
    if basis == "accounts_receivable":
        return bool(re.search(r"\b(?:accounts?\s+receivable|receivables)\b", clause))
    return bool(re.search(r"\b(?:revenues?|sales)\b", clause))


ALLOCATION_VERB_PATTERN = (
    r"(?:account(?:ed)?\s+for|represent(?:ed)?|compris(?:ed|e)|"
    r"constitut(?:ed|e)|generat(?:ed|e)|contribut(?:ed|e)|"
    r"made\s+up|make\s+up)"
)
ALLOCATION_BASIS_PATTERN = (
    r"(?:revenues?|sales|accounts?\s+receivable|receivables)"
)


def _customer_subject_key(value):
    normalized = normalize_verbatim(value)
    return re.sub(
        r"^(?:(?:our|the)\s+)?customers?\s+", "", normalized
    ).strip(" ,")


def _respective_customer_pairs(clause):
    """Return unambiguous customer/percentage pairs from a respectively list."""
    normalized = normalize_verbatim(clause)
    if "respectively" not in normalized:
        return []
    verb_match = re.search(rf"\b{ALLOCATION_VERB_PATTERN}\b", normalized)
    respectively_match = re.search(r"\brespectively\b", normalized)
    if not verb_match or not respectively_match or verb_match.end() >= respectively_match.start():
        return []

    prefix = normalized[:verb_match.start()].strip(" ,")
    customer_matches = list(re.finditer(r"\bcustomers?\b", prefix))
    if not customer_matches:
        return []
    subject_phrase = prefix[customer_matches[0].start():]
    if re.search(
        r"\b(?:revenues?|sales|receivables?|increased|decreased|grew|declined|while|whereas)\b|"
        + PERCENT_VALUE_RE.pattern,
        subject_phrase,
    ):
        return []
    subjects_text = re.sub(r"^customers?\s+", "", subject_phrase, count=1)
    subjects = [
        _customer_subject_key(subject)
        for subject in re.split(
            r"\s*(?:,\s*(?:and\s+)?|\s+and\s+)(?:customers?\s+)?",
            subjects_text,
        )
    ]
    if len(subjects) < 2 or any(
        not subject or len(subject) > 120 or re.search(r"\bcustomers?\b", subject)
        for subject in subjects
    ):
        return []

    allocation = normalized[verb_match.end():respectively_match.start()]
    if not re.search(rf"\b{ALLOCATION_BASIS_PATTERN}\b", allocation):
        return []
    percentages = _percentage_values(allocation)
    if len(percentages) != len(subjects):
        return []
    return list(zip(subjects, percentages))


def _allocation_percentage_values(clause):
    values = []
    patterns = (
        rf"\b{ALLOCATION_VERB_PATTERN}\b[^.;]{{0,100}}?"
        rf"{PERCENT_VALUE_RE.pattern}[^.;]{{0,100}}?\b{ALLOCATION_BASIS_PATTERN}\b",
        rf"{PERCENT_VALUE_RE.pattern}[^.;]{{0,100}}?\b{ALLOCATION_BASIS_PATTERN}\b"
        r"[^.;]{0,100}?\b(?:was|were)\s+(?:attributable\s+to|derived\s+from|generated\s+by)\b",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, clause, re.I):
            values.extend(_percentage_values(match.group(0)))
    return values


def _label_in_clause(clause, label):
    normalized_label = normalize_verbatim(label)
    if normalized_label in {
        "unnamed customer", "one customer", "a customer", "single customer",
        "individual customer", "major customer", "significant customer",
    }:
        return bool(re.search(
            r"\b(?:(?:one|a|single|individual)(?:\s+(?:major|significant))?|"
            r"major|significant)\s+customer\b",
            clause,
        ))
    return bool(re.search(
        rf"(?<!\w){re.escape(normalized_label)}(?!\w)", clause
    ))


def _matching_allocation_clause(clauses, semantics, pct, basis, period, label=None):
    normalized_period = normalize_verbatim(period)
    for clause in clauses:
        if statement_semantics(clause) != semantics:
            continue
        if normalized_period not in clause or not _basis_in_clause(clause, basis):
            continue
        respective_pairs = _respective_customer_pairs(clause)
        if respective_pairs:
            label_key = _customer_subject_key(label)
            if not any(
                subject == label_key and abs(value - pct) < 0.0001
                for subject, value in respective_pairs
            ):
                continue
        else:
            if not any(
                abs(value - pct) < 0.0001
                for value in _allocation_percentage_values(clause)
            ):
                continue
            if label is not None and not _label_in_clause(clause, label):
                continue
        return clause
    return None


def _validate_respective_period(quote, period, pct):
    """Reject a model-swapped value when one quote lists parallel periods."""
    normalized_quote = normalize_verbatim(quote)
    if "respectively" not in normalized_quote:
        return
    percentages = _percentage_values(normalized_quote)
    quote_years = re.findall(r"\b(?:19|20)\d{2}\b", normalized_quote)
    period_years = re.findall(r"\b(?:19|20)\d{2}\b", normalize_verbatim(period))
    if len(percentages) < 2 or len(percentages) != len(quote_years) or not period_years:
        return
    pct_indexes = {i for i, value in enumerate(percentages) if abs(value - pct) < 0.0001}
    year_indexes = {i for i, value in enumerate(quote_years) if value == period_years[-1]}
    if pct_indexes.isdisjoint(year_indexes):
        raise ValueError("model pct does not match the verbatim respectively period")


def _validated_disclosure(r, index, excerpts, report_date):
    if not isinstance(r, dict):
        raise ValueError(f"model row {index} must be an object")

    quote = str(r.get("quote") or "").strip()
    if not quote or len(quote) > 500 or not _quote_is_verbatim(quote, excerpts):
        raise ValueError(f"model row {index} quote is not verbatim from the filing excerpt")
    clauses = _allocation_clauses(quote)
    clause_semantics = {statement_semantics(clause) for clause in clauses}
    if not clause_semantics.intersection(("single_customer", "negative")):
        raise ValueError(f"model row {index} is not a qualifying allocation statement")

    try:
        pct = float(r.get("pct"))
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"model row {index} has an invalid pct") from exc
    if not (1 <= pct <= 100):
        raise ValueError(f"model row {index} pct must be between 1 and 100")

    period = str(r.get("period") or "").strip()
    basis = r.get("basis")
    if not period or len(period) > 120:
        raise ValueError(f"model row {index} has an invalid period")
    if basis not in ("revenue", "accounts_receivable"):
        raise ValueError(f"model row {index} has an invalid basis")

    normalized_quote = normalize_verbatim(quote)
    normalized_period = normalize_verbatim(period)
    if normalized_period not in normalized_quote:
        raise ValueError(f"model row {index} period is not verbatim in the quote")
    if not any(abs(value - pct) < 0.0001 for value in _percentage_values(quote)):
        raise ValueError(f"model row {index} pct is not verbatim in the quote")
    if basis == "accounts_receivable":
        basis_present = re.search(r"\b(?:accounts?\s+receivable|receivables)\b", normalized_quote)
    else:
        basis_present = re.search(r"\b(?:revenues?|sales)\b", normalized_quote)
    if not basis_present:
        raise ValueError(f"model row {index} basis is not verbatim in the quote")

    label = str(r.get("customer") or "").strip()
    single_clause = None
    if label and len(label) <= 120:
        single_clause = _matching_allocation_clause(
            clauses, "single_customer", pct, basis, period, label=label
        )
    negative_clause = _matching_allocation_clause(
        clauses, "negative", pct, basis, period
    )
    if single_clause is not None:
        semantics, matched_clause = "single_customer", single_clause
    elif negative_clause is not None:
        semantics, matched_clause = "negative", negative_clause
    else:
        raise ValueError(
            f"model row {index} fields do not share one allocation clause"
        )

    parsed_period_end = resolved_period_end(period, report_date)
    if parsed_period_end is None:
        raise ValueError(
            f"model row {index} period has no explicit end date or SEC reportDate"
        )
    _validate_respective_period(matched_clause, period, pct)

    if semantics == "negative":
        # This marker participates in newest-vintage selection and remains
        # as provenance after a newer negative clears older positive facts.
        # CBS/API consumers explicitly admit only single_customer rows.
        return {
            "label": "__negative__", "ticker": None, "pct": pct,
            "basis": basis, "period": period, "period_end": parsed_period_end,
            "quote": quote, "statement_type": "negative",
        }

    if not label or len(label) > 120:
        raise ValueError(f"model row {index} has an invalid customer label")
    return {
        "label": label, "ticker": map_customer(label), "pct": pct,
        "basis": basis, "period": period, "period_end": parsed_period_end,
        "quote": quote, "statement_type": "single_customer",
    }


def extract_disclosures(ticker, form, excerpts, report_date=None, diagnostics=None):
    raw = call_gemini(EXTRACT_PROMPT.format(ticker=ticker, form=form,
                                            excerpts="\n---\n".join(excerpts)))
    if not isinstance(raw, list):
        raise ValueError("model response must be a JSON array")
    rows = []
    dropped_rows = 0
    for index, model_row in enumerate(raw):
        try:
            row = _validated_disclosure(
                model_row, index, excerpts, report_date
            )
        except ValueError as exc:
            dropped_rows += 1
            print(f"{ticker} {form}: dropped model row {index} — {exc}")
            continue
        rows.append(row)
    if diagnostics is not None:
        diagnostics["dropped_rows"] = (
            diagnostics.get("dropped_rows", 0) + dropped_rows
        )
    return rows


def _filed_ordinal(value):
    if isinstance(value, datetime):
        return value.date().toordinal()
    if isinstance(value, date):
        return value.toordinal()
    try:
        return date.fromisoformat(str(value)).toordinal()
    except (TypeError, ValueError):
        return date.min.toordinal()


def _row_vintage(row):
    parsed_period = row.get("period_end") or period_end(row.get("period", ""))
    return (
        parsed_period.toordinal() if parsed_period else date.min.toordinal(),
        _filed_ordinal(row.get("filed")),
        str(row.get("accession") or ""),
    )


def _row_recency(row):
    return (
        *_row_vintage(row),
        float(row.get("pct") or 0),
        normalize_verbatim(row.get("quote", "")),
    )


def best_rows(all_rows):
    """
    Use one globally newest disclosure vintage per basis. Explicit negative
    observations suppress older positives and remain durable provenance, while
    downstream CBS/API queries admit only statement_type='single_customer'.
    """
    selected = {}
    bases = sorted({row["basis"] for row in all_rows})
    for basis in bases:
        basis_rows = [row for row in all_rows if row["basis"] == basis]
        newest_vintage = max(_row_vintage(row) for row in basis_rows)
        for row in basis_rows:
            if _row_vintage(row) != newest_vintage:
                continue
            statement_type = row.get("statement_type", "single_customer")
            key = (statement_type, normalize_verbatim(row["label"]), basis)
            if key not in selected or _row_recency(row) > _row_recency(selected[key]):
                selected[key] = row
    return [selected[key] for key in sorted(selected)]


def confirmed_empty_markers(scanned_filings, present_bases=()):
    """Create non-scoring, provenance-bearing observations for absent bases."""
    if not scanned_filings:
        raise IncompleteExposureScan("confirmed-empty scan has no filing provenance")
    newest = max(
        scanned_filings,
        key=lambda filing: (
            (_parse_iso_date(filing.get("report_date")) or date.min).toordinal(),
            _filed_ordinal(filing.get("filed")),
            str(filing.get("accession") or ""),
        ),
    )
    if _filed_ordinal(newest.get("filed")) == date.min.toordinal():
        raise IncompleteExposureScan("confirmed-empty scan has invalid filing provenance")
    report_period_end = _parse_iso_date(newest.get("report_date"))
    if report_period_end is None:
        raise IncompleteExposureScan("confirmed-empty scan has no SEC reportDate")
    present = set(present_bases)
    return [{
        "label": "__confirmed_empty__",
        "ticker": None,
        "pct": 0.0,
        "basis": basis,
        "period": f"filing filed {newest['filed']}",
        "period_end": report_period_end,
        "quote": "Completed filing scan found no qualifying single-customer disclosure.",
        "statement_type": "confirmed_empty",
        "form": newest["form"],
        "accession": newest["accession"],
        "url": newest["url"],
        "filed": newest["filed"],
    } for basis in EXPOSURE_BASES if basis not in present]


# ── DATABASE ──────────────────────────────────────────────

BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS customer_exposure (
        ticker          TEXT NOT NULL,
        customer_label  TEXT NOT NULL,
        customer_ticker TEXT,
        pct             DOUBLE PRECISION NOT NULL,
        basis           TEXT NOT NULL,
        statement_type  TEXT NOT NULL DEFAULT 'unclassified',
        period          TEXT,
        period_end      DATE,
        source_form     TEXT,
        source_accession TEXT,
        source_url      TEXT,
        filed           DATE,
        quote           TEXT,
        extracted_at    TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (ticker, customer_label, basis)
    );
    ALTER TABLE customer_exposure
        ADD COLUMN IF NOT EXISTS statement_type TEXT NOT NULL DEFAULT 'unclassified';
    ALTER TABLE customer_exposure
        ADD COLUMN IF NOT EXISTS period_end DATE;
    ALTER TABLE customer_exposure
        ADD COLUMN IF NOT EXISTS source_accession TEXT;
"""


def load_ticker(conn, ticker, rows):
    """Replace one ticker only while its staged vintage is still current."""
    invalid_types = {
        row.get("statement_type", "single_customer")
        for row in rows
        if row.get("statement_type", "single_customer")
        not in ("single_customer", "negative", "confirmed_empty")
    }
    if invalid_types:
        raise ValueError(f"non-persistable statement types: {sorted(invalid_types)}")
    try:
        with conn.cursor() as cur:
            # Serialize publishers for this pipeline/ticker. The global
            # preflight can be stale by the time a long run reaches this row,
            # so re-read current provenance under the transaction lock before
            # executing any destructive statement.
            cur.execute(
                "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
                ("customer_exposure", ticker),
            )
            stored = _stored_winning_vintages_from_cursor(cur, ticker=ticker)
            _, rejected = filter_monotonic_staged_rows({ticker: rows}, stored)
            if ticker in rejected:
                raise ExposurePublishRegression(
                    f"{ticker} publish rejected after locked vintage recheck: "
                    + "; ".join(rejected[ticker])
                )
            cur.execute("DELETE FROM customer_exposure WHERE ticker = %s", (ticker,))
            if rows:
                psycopg2.extras.execute_values(cur, """
                    INSERT INTO customer_exposure
                        (ticker, customer_label, customer_ticker, pct, basis,
                         statement_type, period, period_end, source_form,
                         source_accession, source_url, filed, quote)
                    VALUES %s
                """, [(
                    ticker, r["label"], r["ticker"], r["pct"], r["basis"],
                    r.get("statement_type", "single_customer"), r["period"],
                    r.get("period_end") or period_end(r["period"]), r["form"],
                    r.get("accession"), r["url"], r["filed"], r["quote"],
                ) for r in rows])
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def scan_ticker(ticker, cik, diagnostics=None):
    """Scan every selected filing, returning only a complete replacement set."""
    filings = latest_filings(cik)
    time.sleep(SEC_PAUSE)
    candidates = []
    degraded = False
    for form, accession, primary_doc, filed, report_date in filings:
        try:
            text, url = fetch_filing_text(cik, accession, primary_doc)
        except requests.RequestException as exc:
            raise IncompleteExposureScan(
                f"filing fetch failed for {ticker} accession {accession}"
            ) from exc
        time.sleep(SEC_PAUSE)
        if not text:
            raise IncompleteExposureScan(
                f"filing fetch was incomplete for {ticker} accession {accession}"
            )
        filing_provenance = {
            "form": form,
            "accession": accession,
            "url": url,
            "filed": filed,
            "report_date": report_date,
        }
        windows, truncated = concentration_windows(text)
        if truncated:
            degraded = True
            if diagnostics is not None:
                diagnostics["degraded"] = True
            print(
                f"{ticker} {form}: qualifying excerpts truncated at "
                f"{MAX_EXCERPT_CHARS} characters"
            )
        extraction_diagnostics = {}
        rows = []
        if windows:
            rows = extract_disclosures(
                ticker, form, windows, report_date=report_date,
                diagnostics=extraction_diagnostics,
            )
            time.sleep(GEMINI_PAUSE)
        dropped_rows = extraction_diagnostics.get("dropped_rows", 0)
        if dropped_rows:
            degraded = True
        if truncated and not rows:
            raise IncompleteExposureScan(
                f"truncated filing scan produced no valid rows for {ticker} "
                f"accession {accession}"
            )
        if dropped_rows and not rows:
            raise IncompleteExposureScan(
                f"all model rows failed validation for {ticker} accession {accession}"
            )
        for row in rows:
            row.update({
                "form": form,
                "accession": accession,
                "url": url,
                "filed": filed,
            })
        # Original annual forms are the authoritative complete concentration
        # disclosure. Their absence is an observation in the same vintage
        # race; a silent amendment or quarter is not.
        if (
            form in AUTHORITATIVE_ANNUAL_FORMS
            and not truncated
            and not dropped_rows
        ):
            rows.extend(confirmed_empty_markers(
                [filing_provenance],
                present_bases={row["basis"] for row in rows},
            ))
        candidates.extend(rows)
    selected = best_rows(candidates)
    if not selected:
        raise IncompleteExposureScan(
            "completed scan has no annual or explicit disclosure provenance"
        )
    if diagnostics is not None:
        diagnostics["degraded"] = degraded
    return sorted(
        selected,
        key=lambda row: (row["basis"], row.get("statement_type", ""), row["label"]),
    )


def refresh_ticker(conn, ticker, cik):
    """Atomically replace one ticker after, and only after, a complete scan."""
    rows = scan_ticker(ticker, cik)
    load_ticker(conn, ticker, rows)
    return rows


def get_positive_tickers(conn):
    """Return the safety baseline, including pre-migration positive rows."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ticker
            FROM customer_exposure
            WHERE COALESCE(
                to_jsonb(customer_exposure)->>'statement_type',
                'unclassified'
            ) IN ('single_customer', 'unclassified')
        """)
        return {row[0] for row in cur.fetchall() if row and row[0]}


def _stored_winning_vintages_from_cursor(cur, ticker=None):
    """Read publication provenance using the caller's current transaction."""
    ticker_filter = " AND ticker = %s" if ticker is not None else ""
    cur.execute("""
            SELECT ticker, basis,
                   COALESCE(
                       to_jsonb(customer_exposure)->>'statement_type',
                       'unclassified'
                   ) AS statement_type,
                   NULLIF(
                       to_jsonb(customer_exposure)->>'period_end', ''
                   )::date AS period_end,
                   filed,
                   NULLIF(
                       to_jsonb(customer_exposure)->>'source_accession', ''
                   ) AS source_accession
            FROM customer_exposure
            WHERE COALESCE(
                to_jsonb(customer_exposure)->>'statement_type',
                'unclassified'
            ) IN ('single_customer', 'negative', 'confirmed_empty', 'unclassified')
        """ + ticker_filter, (ticker,) if ticker is not None else None)
    stored = {}
    for (
        stored_ticker, basis, statement_type, stored_period_end, filed, accession
    ) in cur.fetchall():
        row = {
            "statement_type": statement_type,
            "period_end": stored_period_end,
            "filed": filed,
            "accession": accession,
        }
        key = (stored_ticker, basis)
        if key not in stored or (
            _publication_order(row), _evidence_strength(row)
        ) > (
            _publication_order(stored[key]), _evidence_strength(stored[key])
        ):
            stored[key] = row
    return stored


def get_stored_winning_vintages(conn):
    """Return current publication provenance keyed by (ticker, basis)."""
    with conn.cursor() as cur:
        return _stored_winning_vintages_from_cursor(cur)


def scoring_rows(rows):
    return [
        row for row in rows
        if row.get("statement_type", "single_customer") == "single_customer"
    ]


def _filing_vintage(row):
    return (
        _filed_ordinal(row.get("filed")),
        str(row.get("accession") or row.get("source_accession") or ""),
    )


def _publication_order(row):
    parsed_period = row.get("period_end") or period_end(row.get("period", ""))
    return (
        parsed_period.toordinal() if parsed_period else date.min.toordinal(),
        *_filing_vintage(row),
    )


def _evidence_strength(row):
    return 1 if row.get("statement_type") in ("single_customer", "unclassified") else 0


def staged_vintage_is_not_older(staged, stored):
    """Compare period-first facts, falling back to filing age for empty markers."""
    staged_filing = _filing_vintage(staged)
    stored_filing = _filing_vintage(stored)
    if staged_filing[0] == date.min.toordinal() or not staged_filing[1]:
        return False
    if stored_filing[0] == date.min.toordinal():
        return False

    staged_period = staged.get("period_end") or period_end(staged.get("period", ""))
    stored_period = stored.get("period_end") or period_end(stored.get("period", ""))
    if staged_period is None or stored_period is None:
        return staged_filing >= stored_filing
    return (
        staged_period.toordinal(), *staged_filing
    ) >= (
        stored_period.toordinal(), *stored_filing
    )


def filter_monotonic_staged_rows(staged_rows, stored_vintages):
    """Reject whole-ticker replacements if any stored basis would regress."""
    accepted, rejected = {}, {}
    for ticker, rows in staged_rows.items():
        stored_bases = {
            basis for stored_ticker, basis in stored_vintages
            if stored_ticker == ticker
        }
        if not rows:
            if stored_bases:
                rejected[ticker] = ["completed scan has no filing provenance"]
            else:
                accepted[ticker] = rows
            continue

        rows_by_basis = {
            basis: [row for row in rows if row["basis"] == basis]
            for basis in {row["basis"] for row in rows}
        }
        reasons = []
        for missing_basis in sorted(stored_bases - set(rows_by_basis)):
            reasons.append(f"missing staged provenance for {missing_basis}")
        for basis, basis_rows in rows_by_basis.items():
            stored = stored_vintages.get((ticker, basis))
            if stored is None:
                continue
            staged = max(basis_rows, key=_publication_order)
            if not staged_vintage_is_not_older(staged, stored):
                reasons.append(f"{basis} staged vintage is older than stored vintage")
            elif (
                _publication_order(staged) == _publication_order(stored)
                and _evidence_strength(stored) > 0
                and not any(_evidence_strength(row) > 0 for row in basis_rows)
            ):
                reasons.append(
                    f"{basis} same-vintage non-scoring result cannot clear stored evidence"
                )
        if reasons:
            rejected[ticker] = reasons
        else:
            accepted[ticker] = rows
    return accepted, rejected


def projected_positive_tickers(prior_positive, staged_rows):
    """Project post-load positives; unstaged failures/skips remain preserved."""
    projected = set(prior_positive) - set(staged_rows)
    projected.update(
        ticker for ticker, rows in staged_rows.items() if scoring_rows(rows)
    )
    return projected


def explicit_negative_tickers(staged_rows):
    return {
        ticker
        for ticker, rows in staged_rows.items()
        if any(row.get("statement_type") == "negative" for row in rows)
        and not scoring_rows(rows)
    }


def enforce_positive_retention(
    prior_positive,
    staged_rows,
    minimum_retention,
    *,
    provider_coverage,
    minimum_provider_coverage,
):
    """Fail before any replacement if prior scoring-ticker retention is unsafe."""
    projected = projected_positive_tickers(prior_positive, staged_rows)
    retained_prior = set(prior_positive) & projected
    # A normalized, verbatim explicit negative is deterministic evidence that
    # clearing this ticker is intentional rather than a model-wide empty-array
    # regression. Credit it only when provider coverage is healthy, without
    # calling it a positive fact.
    negative_evidence = set()
    if provider_coverage >= minimum_provider_coverage:
        negative_evidence = (
            set(prior_positive) & explicit_negative_tickers(staged_rows)
        )
    effective_retained = retained_prior | negative_evidence
    baseline_count = len(prior_positive)
    required = math.ceil(baseline_count * minimum_retention)
    if len(effective_retained) < required:
        raise ExposureRetentionError(
            "projected positive-ticker retention "
            f"{len(effective_retained)}/{baseline_count} is below required "
            f"{required}/{baseline_count} ({minimum_retention:.1%})"
        )
    return projected


def reconnect_for_publish(conn, database_url):
    """Open a fresh DB session before preflight; keep the old one if this fails."""
    fresh = connect_db(database_url)
    try:
        conn.close()
    except Exception:
        pass
    return fresh


# ── MAIN ─────────────────────────────────────────────────

def main():
    print("=== Customer Exposure ETL ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")
    if not GEMINI_API_KEY:
        raise SystemExit("GEMINI_API_KEY not set — text extraction requires it.")

    universe = get_universe()
    stats = RunStats(expected=len(universe))
    context = None
    limited_run = int(os.environ.get("TICKER_LIMIT") or 0) > 0
    loaded = cleared = explicit_negative = skipped = 0
    degraded_tickers = set()

    conn = connect_db(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
        conn.commit()
        context = begin_run(conn, "customer_exposure", expected=len(universe), details={
            "limitedRun": limited_run,
        })
        minimum_positive_retention = threshold_from_env(
            os.environ, "CUSTOMER_EXPOSURE_MIN_POSITIVE_RETENTION", 0.75
        )
        minimum_provider_coverage = threshold_from_env(
            os.environ, "CUSTOMER_EXPOSURE_MIN_PROVIDER_COVERAGE", 0.90
        )
        minimum_usable_coverage = threshold_from_env(
            os.environ, "CUSTOMER_EXPOSURE_MIN_USABLE_COVERAGE", 0.50
        )
        minimum_baseline_retention = threshold_from_env(
            os.environ, "CUSTOMER_EXPOSURE_MIN_BASELINE_RETENTION", 0.75
        )
        staged_rows = {}

        try:
            cik_map = get_cik_map()
        except Exception:
            stats.attempted = len(universe)
            stats.transient_failures = len(universe)
            raise

        for n, ticker in enumerate(universe, 1):
            cik = cik_map.get(ticker)
            if not cik:
                print(f"[{n}/{len(universe)}] {ticker}: no CIK — skipped")
                skipped += 1
                stats.known_no_data += 1
                continue
            stats.attempted += 1
            scan_diagnostics = {}
            try:
                final = scan_ticker(ticker, cik, diagnostics=scan_diagnostics)
            except NoSupportedFilings as exc:
                print(f"[{n}/{len(universe)}] {ticker}: {exc} — skipped")
                skipped += 1
                stats.known_no_data += 1
                continue
            except psycopg2.Error:
                raise
            except Exception as e:
                print(f"[{n}/{len(universe)}] {ticker}: error — {e}")
                skipped += 1
                if scan_diagnostics.get("degraded"):
                    degraded_tickers.add(ticker)
                    stats.degraded = len(degraded_tickers)
                stats.transient_failures += 1
                continue

            if scan_diagnostics.get("degraded"):
                degraded_tickers.add(ticker)
                stats.degraded = len(degraded_tickers)
            staged_rows[ticker] = final
            scoring_final = scoring_rows(final)
            if scoring_final:
                print(f"[{n}/{len(universe)}] {ticker}: {len(scoring_final)} rows staged")
            else:
                if any(row.get("statement_type") == "negative" for row in final):
                    reason = "explicit no-single-customer disclosure"
                else:
                    reason = "no concentration disclosures found"
                print(f"[{n}/{len(universe)}] {ticker}: {reason} — replacement staged")

        conn = reconnect_for_publish(conn, DATABASE_URL)
        prior_positive = get_positive_tickers(conn)
        stored_vintages = get_stored_winning_vintages(conn)
        staged_rows, vintage_rejections = filter_monotonic_staged_rows(
            staged_rows, stored_vintages
        )
        for ticker, reasons in vintage_rejections.items():
            skipped += 1
            degraded_tickers.add(ticker)
            stats.degraded = len(degraded_tickers)
            print(f"{ticker}: stored rows preserved — {'; '.join(reasons)}")
        for final in staged_rows.values():
            if scoring_rows(final):
                stats.usable += 1
            else:
                stats.known_no_data += 1
            if any(row.get("statement_type") == "negative" for row in final):
                explicit_negative += 1

        decision = evaluate_health(
            stats,
            context.baseline_usable,
            minimum_provider_coverage=minimum_provider_coverage,
            minimum_usable_coverage=minimum_usable_coverage,
            minimum_baseline_retention=minimum_baseline_retention,
            limited_run=limited_run,
        )
        projected_positive = projected_positive_tickers(prior_positive, staged_rows)
        retained_prior = len(set(prior_positive) & projected_positive)
        credited_negative = 0
        if decision.provider_coverage >= minimum_provider_coverage:
            credited_negative = len(
                set(prior_positive) & explicit_negative_tickers(staged_rows)
            )
        effective_retained = retained_prior + credited_negative
        baseline_count = len(prior_positive)
        stats.details.update({
            "priorPositiveTickers": baseline_count,
            "projectedPositiveTickers": len(projected_positive),
            "retainedPriorPositiveTickers": retained_prior,
            "retentionCreditedExplicitNegativeTickers": credited_negative,
            "positiveRetention": (
                effective_retained / baseline_count if baseline_count else 1.0
            ),
            "minimumPositiveRetention": minimum_positive_retention,
            "stagedTickers": len(staged_rows),
            "vintageRejectedTickers": len(vintage_rejections),
            "explicitNegative": explicit_negative,
            "skipped": skipped,
            "loaded": loaded,
            "confirmedEmpty": cleared,
        })
        if decision.state == "failure":
            write_run(conn, context, "failure", stats, decision=decision)
            print(
                f"ETL health: pipeline={context.pipeline} state={decision.state} "
                f"provider={decision.provider_coverage:.1%} "
                f"usable={decision.usable_coverage:.1%} "
                f"counts={stats.usable}/{stats.expected}"
            )
            raise CoverageError(
                f"{context.pipeline} coverage failed: {decision.reason}"
            )
        enforce_positive_retention(
            prior_positive,
            staged_rows,
            minimum_positive_retention,
            provider_coverage=decision.provider_coverage,
            minimum_provider_coverage=minimum_provider_coverage,
        )

        # The complete run has passed its prior-positive safety gate. Only now
        # may per-ticker replacement transactions delete current rows.
        for ticker, final in staged_rows.items():
            load_ticker(conn, ticker, final)
            scoring_final = scoring_rows(final)
            if scoring_final:
                loaded += 1
                named = [
                    f"{row['label']}={row['pct']:.0f}%"
                    for row in scoring_final if row["basis"] == "revenue"
                ][:4]
                print(
                    f"{ticker}: {len(scoring_final)} rows loaded "
                    f"({', '.join(named) or 'AR only'})"
                )
            else:
                cleared += 1
                print(f"{ticker}: stale scoring exposures cleared")

        stats.details.update({
            "loaded": loaded,
            "confirmedEmpty": cleared,
        })
        finish_run(
            conn,
            context,
            stats,
            minimum_provider_coverage=minimum_provider_coverage,
            minimum_usable_coverage=minimum_usable_coverage,
            minimum_baseline_retention=minimum_baseline_retention,
            limited_run=limited_run,
        )
    except CoverageError:
        raise
    except Exception as error:
        record_failure_safely(conn, context, stats, error)
        raise
    finally:
        conn.close()

    print(
        "=== Customer Exposure ETL complete: "
        f"{loaded} suppliers loaded, {cleared} confirmed empty, {skipped} skipped ==="
    )
    return stats


if __name__ == "__main__":
    main()
