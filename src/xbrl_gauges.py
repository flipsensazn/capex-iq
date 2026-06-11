# xbrl_gauges.py
#
# SEC XBRL fundamentals as supply-chain stress gauges.
#
# A bottleneck is visible in the financials before it's narrative:
#   • RPO/backlog growing faster than revenue  → orders are mathematically
#     outrunning shipping capacity ("order gap", in percentage points)
#   • Inventory days rising at component BUYERS → hoarding / double-ordering,
#     the classic shortage precursor
#
# Data source: SEC's free companyfacts API (no key, no cost):
#   https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
#
# For every capex-map ticker we extract quarterly series with tag fallbacks
# (companies report the "same" concept under different us-gaap tags), derive
# fiscal Q4 income-statement values from annual totals when only the 10-K
# carries them, and compute YoY gauges. Results are upserted to Neon keyed by
# (ticker, as_of_date) so history accumulates run over run.
#
# Output table: xbrl_gauges       Served by: functions/gauges.js → GET /gauges
# Companion signal: transcript_stress (see transcript_stress.py) — language
# says "constrained", these numbers prove it.
#
# Env vars:
#   DATABASE_URL        required  Neon Postgres connection string
#   WATCHLIST_BASE_URL  optional  deployed site root (live capex-map tickers)
#   TICKER_LIMIT        optional  cap tickers per run (testing)

import os
import time
from datetime import date, datetime, timedelta

import psycopg2
import psycopg2.extras
import requests

# Universe + DB helpers are shared with the transcript ETL (same directory).
from transcript_stress import get_universe, connect_db

DATABASE_URL = os.environ.get("DATABASE_URL")
SEC_HEADERS  = {"User-Agent": "WizzlesWatchlist flipsensazn@gmail.com"}
SEC_PAUSE    = 0.15  # seconds between companyfacts calls (SEC asks for <10 req/s)

# ── XBRL TAG CANDIDATES ───────────────────────────────────
# Tried in order; first tag with a usable series wins. The winning tag per
# metric is recorded in the DB (tags_used) so every number is auditable.
REVENUE_TAGS = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
]
COGS_TAGS = [
    "CostOfGoodsAndServicesSold",
    "CostOfRevenue",
    "CostOfGoodsSold",
    "CostOfSales",
]
INVENTORY_TAGS = [
    "InventoryNet",
    "InventoryGross",
]
RPO_TAGS = [
    "RevenueRemainingPerformanceObligation",
]

QUARTER_DAYS = (70, 100)    # accept durations in this range as "a quarter"
ANNUAL_DAYS  = (330, 380)   # accept durations in this range as "a year"


def parse_d(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


# ── SERIES EXTRACTION ─────────────────────────────────────

def pick_freshest(candidates):
    """
    candidates: [(series, tag)] — prefer the series with the most RECENT data
    point (companies switch tags mid-history; the first-listed tag can be a
    stale leftover), tie-broken by series length.
    """
    if not candidates:
        return [], None
    series, tag = max(candidates, key=lambda c: (c[0][-1][0], len(c[0])))
    return series, tag


def instant_series(gaap, tags):
    """
    Balance-sheet (instant) concept → ([(end_date, value)], tag) sorted by date.
    Dedupes restatements by keeping the most recently filed value per end date.
    """
    candidates = []
    for tag in tags:
        units = gaap.get(tag, {}).get("units", {}).get("USD")
        if not units:
            continue
        best = {}
        for e in units:
            if e.get("form") not in ("10-Q", "10-K", "10-Q/A", "10-K/A"):
                continue
            end, val, filed = e.get("end"), e.get("val"), e.get("filed", "")
            if end is None or val is None:
                continue
            if end not in best or filed > best[end][1]:
                best[end] = (float(val), filed)
        if len(best) >= 2:
            series = sorted((parse_d(end), v[0]) for end, v in best.items())
            candidates.append((series, tag))
    return pick_freshest(candidates)


def duration_series(gaap, tags):
    """
    Income-statement (duration) concept → ([(end_date, quarterly_value)], tag).
    Keeps true quarterly entries; derives fiscal Q4 as annual − ΣQ1..Q3 when a
    company only reports the year-total in its 10-K (the common case).
    """
    candidates = []
    for tag in tags:
        units = gaap.get(tag, {}).get("units", {}).get("USD")
        if not units:
            continue

        quarters, annuals = {}, {}
        for e in units:
            if e.get("form") not in ("10-Q", "10-K", "10-Q/A", "10-K/A"):
                continue
            start, end, val, filed = e.get("start"), e.get("end"), e.get("val"), e.get("filed", "")
            if not start or not end or val is None:
                continue
            days = (parse_d(end) - parse_d(start)).days
            if QUARTER_DAYS[0] <= days <= QUARTER_DAYS[1]:
                if end not in quarters or filed > quarters[end][1]:
                    quarters[end] = (float(val), filed)
            elif ANNUAL_DAYS[0] <= days <= ANNUAL_DAYS[1]:
                if end not in annuals or filed > annuals[end][1]:
                    annuals[end] = (float(val), filed, parse_d(start))

        # Q4 fill-in: annual total minus the three quarters inside its window
        for end, (aval, _, astart) in annuals.items():
            if end in quarters:
                continue
            inside = [v for qend, (v, _) in quarters.items()
                      if astart < parse_d(qend) < parse_d(end)]
            if len(inside) == 3:
                quarters[end] = (aval - sum(inside), "derived")

        if len(quarters) >= 2:
            series = sorted((parse_d(end), v[0]) for end, v in quarters.items())
            candidates.append((series, tag))
    return pick_freshest(candidates)


def at_or_before(series, target, tolerance_days=45):
    """Series value whose date is closest to target within ±tolerance, else None."""
    best = None
    for d, v in series:
        gap = abs((d - target).days)
        if gap <= tolerance_days and (best is None or gap < best[0]):
            best = (gap, v)
    return best[1] if best else None


def yoy_pct(series, latest_date, latest_val):
    """YoY % change vs the entry ~365 days before latest, or None."""
    prior = at_or_before(series, latest_date - timedelta(days=365))
    if prior is None or prior == 0:
        return None
    return (latest_val - prior) / abs(prior) * 100


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


# ── GAUGE COMPUTATION ─────────────────────────────────────

def compute_gauges(facts):
    """All gauges for one company from its companyfacts JSON, or None."""
    gaap = facts.get("facts", {}).get("us-gaap")
    if not gaap:
        return None  # foreign filer (IFRS) or no XBRL — skip

    rev, rev_tag = duration_series(gaap, REVENUE_TAGS)
    cogs, cogs_tag = duration_series(gaap, COGS_TAGS)
    inv, inv_tag = instant_series(gaap, INVENTORY_TAGS)
    rpo, rpo_tag = instant_series(gaap, RPO_TAGS)

    if not rev:
        return None

    rev_end, rev_q = rev[-1]
    revenue_yoy = yoy_pct(rev, rev_end, rev_q)

    # TTM revenue if the last 4 quarters are contiguous-ish (spans ~1 year)
    ttm_revenue = None
    if len(rev) >= 4 and (rev_end - rev[-4][0]).days <= 300:
        ttm_revenue = sum(v for _, v in rev[-4:])

    inventory = inventory_yoy = inventory_days = inventory_days_yoy = None
    if inv:
        inv_end, inventory = inv[-1]
        inventory_yoy = yoy_pct(inv, inv_end, inventory)
        cogs_q = at_or_before(cogs, inv_end, 10) if cogs else None
        if cogs_q:
            inventory_days = inventory / cogs_q * 91.25
            prior_inv = at_or_before(inv, inv_end - timedelta(days=365))
            prior_cogs = at_or_before(cogs, inv_end - timedelta(days=365), 55)
            if prior_inv and prior_cogs:
                inventory_days_yoy = inventory_days - (prior_inv / prior_cogs * 91.25)

    rpo_val = rpo_yoy = rpo_to_ttm = order_gap = None
    if rpo:
        rpo_end, rpo_val = rpo[-1]
        rpo_yoy = yoy_pct(rpo, rpo_end, rpo_val)
        if ttm_revenue:
            rpo_to_ttm = rpo_val / ttm_revenue
        if rpo_yoy is not None and revenue_yoy is not None:
            order_gap = rpo_yoy - revenue_yoy

    # Heuristic 0-100: how hard are orders outrunning delivery? Order gap
    # dominates; absolute backlog growth contributes. Inputs are visible in
    # the same row, so the score is always auditable.
    backlog_score = None
    if order_gap is not None or rpo_yoy is not None:
        s = 0.0
        if order_gap is not None and order_gap > 0:
            s += clamp(order_gap * 1.2, 0, 60)
        if rpo_yoy is not None and rpo_yoy > 0:
            s += clamp(rpo_yoy * 0.4, 0, 40)
        backlog_score = round(clamp(s, 0, 100), 1)

    return {
        "latest_quarter_end":  rev_end,
        "revenue_q":           rev_q,
        "revenue_yoy":         revenue_yoy,
        "inventory":           inventory,
        "inventory_yoy":       inventory_yoy,
        "inventory_days":      inventory_days,
        "inventory_days_yoy":  inventory_days_yoy,
        "rpo":                 rpo_val,
        "rpo_yoy":             rpo_yoy,
        "rpo_to_ttm_revenue":  rpo_to_ttm,
        "order_gap":           order_gap,
        "backlog_score":       backlog_score,
        "tags_used": {"revenue": rev_tag, "cogs": cogs_tag,
                      "inventory": inv_tag, "rpo": rpo_tag},
    }


# ── SEC FETCH ─────────────────────────────────────────────

def get_cik_map():
    res = requests.get("https://www.sec.gov/files/company_tickers.json",
                       headers=SEC_HEADERS, timeout=30)
    res.raise_for_status()
    return {v["ticker"]: str(v["cik_str"]).zfill(10) for v in res.json().values()}


def fetch_companyfacts(cik):
    res = requests.get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
                       headers=SEC_HEADERS, timeout=60)
    if res.status_code != 200:
        return None
    return res.json()


# ── DATABASE ──────────────────────────────────────────────

BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS xbrl_gauges (
        ticker              TEXT NOT NULL,
        as_of_date          DATE NOT NULL,
        latest_quarter_end  DATE,
        revenue_q           DOUBLE PRECISION,
        revenue_yoy         DOUBLE PRECISION,
        inventory           DOUBLE PRECISION,
        inventory_yoy       DOUBLE PRECISION,
        inventory_days      DOUBLE PRECISION,
        inventory_days_yoy  DOUBLE PRECISION,
        rpo                 DOUBLE PRECISION,
        rpo_yoy             DOUBLE PRECISION,
        rpo_to_ttm_revenue  DOUBLE PRECISION,
        order_gap           DOUBLE PRECISION,
        backlog_score       DOUBLE PRECISION,
        tags_used           JSONB,
        fetched_at          TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (ticker, as_of_date)
    );
"""

UPSERT_SQL = """
    INSERT INTO xbrl_gauges
        (ticker, as_of_date, latest_quarter_end, revenue_q, revenue_yoy,
         inventory, inventory_yoy, inventory_days, inventory_days_yoy,
         rpo, rpo_yoy, rpo_to_ttm_revenue, order_gap, backlog_score, tags_used)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (ticker, as_of_date) DO UPDATE SET
        latest_quarter_end = EXCLUDED.latest_quarter_end,
        revenue_q          = EXCLUDED.revenue_q,
        revenue_yoy        = EXCLUDED.revenue_yoy,
        inventory          = EXCLUDED.inventory,
        inventory_yoy      = EXCLUDED.inventory_yoy,
        inventory_days     = EXCLUDED.inventory_days,
        inventory_days_yoy = EXCLUDED.inventory_days_yoy,
        rpo                = EXCLUDED.rpo,
        rpo_yoy            = EXCLUDED.rpo_yoy,
        rpo_to_ttm_revenue = EXCLUDED.rpo_to_ttm_revenue,
        order_gap          = EXCLUDED.order_gap,
        backlog_score      = EXCLUDED.backlog_score,
        tags_used          = EXCLUDED.tags_used,
        fetched_at         = now();
"""


# ── MAIN ─────────────────────────────────────────────────

def fmt(x):
    return "—" if x is None else f"{x:.1f}"


if __name__ == "__main__":
    print("=== XBRL Gauges ETL ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")

    universe = get_universe()
    cik_map = get_cik_map()
    today = date.today()

    conn = connect_db(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
        conn.commit()

        done = skipped = 0
        for n, ticker in enumerate(universe, 1):
            cik = cik_map.get(ticker)
            if not cik:
                print(f"[{n}/{len(universe)}] {ticker}: no CIK (foreign listing?) — skipped")
                skipped += 1
                continue
            try:
                facts = fetch_companyfacts(cik)
                gauges = compute_gauges(facts) if facts else None
                if not gauges:
                    print(f"[{n}/{len(universe)}] {ticker}: no usable US-GAAP quarterly data — skipped")
                    skipped += 1
                    continue
                with conn.cursor() as cur:
                    cur.execute(UPSERT_SQL, (
                        ticker, today,
                        gauges["latest_quarter_end"], gauges["revenue_q"], gauges["revenue_yoy"],
                        gauges["inventory"], gauges["inventory_yoy"],
                        gauges["inventory_days"], gauges["inventory_days_yoy"],
                        gauges["rpo"], gauges["rpo_yoy"], gauges["rpo_to_ttm_revenue"],
                        gauges["order_gap"], gauges["backlog_score"],
                        psycopg2.extras.Json(gauges["tags_used"]),
                    ))
                conn.commit()
                done += 1
                og = gauges["order_gap"]
                print(f"[{n}/{len(universe)}] {ticker}: q={gauges['latest_quarter_end']} "
                      f"rev_yoy={fmt(gauges['revenue_yoy'])} rpo_yoy={fmt(gauges['rpo_yoy'])} "
                      f"gap={fmt(og)}pp inv_days={fmt(gauges['inventory_days'])} "
                      f"score={gauges['backlog_score']}")
            except psycopg2.Error:
                raise
            except Exception as e:
                print(f"[{n}/{len(universe)}] {ticker}: error — {e}")
                skipped += 1
            time.sleep(SEC_PAUSE)
    finally:
        conn.close()

    print(f"=== XBRL Gauges ETL complete: {done} loaded, {skipped} skipped ===")
