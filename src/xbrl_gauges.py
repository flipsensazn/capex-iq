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
#   XBRL_MIN_PROVIDER_COVERAGE / _MIN_USABLE_COVERAGE /
#   _MIN_BASELINE_RETENTION optional health gates (0..1)

import os
import time
from datetime import date, datetime, timedelta

import psycopg2
import psycopg2.extras
import requests

# Universe + DB helpers are shared with the transcript ETL (same directory).
from transcript_stress import get_universe, connect_db
from etl_health import (
    CoverageError,
    RunStats,
    begin_run,
    finish_run,
    record_failure_safely,
    ticker_limit_from_env,
    threshold_from_env,
)

DATABASE_URL = os.environ.get("DATABASE_URL")
TICKER_LIMIT = ticker_limit_from_env(os.environ)
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
MAX_SCORE_PERIOD_MISALIGNMENT_DAYS = 45
PERIOD_PROVENANCE_METHODOLOGY = "xbrl-gauge-score-period-v1"


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

    period_exclusions = []

    def score_period_aligned(component, period_end):
        difference_days = (period_end - rev_end).days
        if abs(difference_days) <= MAX_SCORE_PERIOD_MISALIGNMENT_DAYS:
            return True
        period_exclusions.append({
            "component": component,
            "code": "metric_period_misaligned",
            "periodEnd": period_end.isoformat(),
            "revenuePeriodEnd": rev_end.isoformat(),
            "differenceDays": difference_days,
            "maxAbsoluteDifferenceDays": MAX_SCORE_PERIOD_MISALIGNMENT_DAYS,
        })
        return False

    inventory_period_end = inv[-1][0] if inv else None
    rpo_period_end = rpo[-1][0] if rpo else None

    inventory = inventory_yoy = inventory_days = inventory_days_yoy = None
    if inv and score_period_aligned("inventory", inventory_period_end):
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
    if rpo and score_period_aligned("rpo", rpo_period_end):
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
    backlog_period_end = None
    if order_gap is not None or rpo_yoy is not None:
        s = 0.0
        if order_gap is not None and order_gap > 0:
            s += clamp(order_gap * 1.2, 0, 60)
        if rpo_yoy is not None and rpo_yoy > 0:
            s += clamp(rpo_yoy * 0.4, 0, 40)
        backlog_score = round(clamp(s, 0, 100), 1)
        backlog_period_end = (
            min(rev_end, rpo_period_end)
            if order_gap is not None else rpo_period_end
        )

    score_driver = None
    score_period_end = rev_end
    if backlog_score is not None:
        score_driver = "backlog"
        score_period_end = backlog_period_end
    elif inventory_days_yoy is not None and inventory_days_yoy > 0:
        score_driver = "inventory"
        score_period_end = inventory_period_end

    period_provenance = {
        "methodology": PERIOD_PROVENANCE_METHODOLOGY,
        "revenuePeriodEnd": rev_end.isoformat(),
        "inventoryPeriodEnd": (
            inventory_period_end.isoformat() if inventory_period_end else None
        ),
        "rpoPeriodEnd": rpo_period_end.isoformat() if rpo_period_end else None,
        "backlogPeriodEnd": (
            backlog_period_end.isoformat() if backlog_period_end else None
        ),
        "scorePeriodEnd": score_period_end.isoformat(),
        "scoreDriver": score_driver,
        "maxPeriodMisalignmentDays": MAX_SCORE_PERIOD_MISALIGNMENT_DAYS,
        "exclusions": period_exclusions,
    }

    return {
        "latest_quarter_end":  score_period_end,
        "revenue_period_end":  rev_end,
        "inventory_period_end": inventory_period_end,
        "rpo_period_end":      rpo_period_end,
        "backlog_period_end":  backlog_period_end,
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
        "period_provenance":   period_provenance,
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
    if res.status_code == 404:
        return None
    res.raise_for_status()
    return res.json()


# ── DATABASE ──────────────────────────────────────────────

BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS xbrl_gauges (
        ticker              TEXT NOT NULL,
        as_of_date          DATE NOT NULL,
        latest_quarter_end  DATE,
        revenue_period_end  DATE,
        inventory_period_end DATE,
        rpo_period_end      DATE,
        backlog_period_end  DATE,
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
        period_provenance   JSONB,
        fetched_at          TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (ticker, as_of_date)
    );
"""

MIGRATION_SQL = """
    ALTER TABLE xbrl_gauges
        ADD COLUMN IF NOT EXISTS revenue_period_end DATE,
        ADD COLUMN IF NOT EXISTS inventory_period_end DATE,
        ADD COLUMN IF NOT EXISTS rpo_period_end DATE,
        ADD COLUMN IF NOT EXISTS backlog_period_end DATE,
        ADD COLUMN IF NOT EXISTS period_provenance JSONB;
"""

UPSERT_SQL = """
    INSERT INTO xbrl_gauges
        (ticker, as_of_date, latest_quarter_end, revenue_period_end,
         inventory_period_end, rpo_period_end, backlog_period_end,
         revenue_q, revenue_yoy,
         inventory, inventory_yoy, inventory_days, inventory_days_yoy,
         rpo, rpo_yoy, rpo_to_ttm_revenue, order_gap, backlog_score, tags_used,
         period_provenance)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
            %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (ticker, as_of_date) DO UPDATE SET
        latest_quarter_end = EXCLUDED.latest_quarter_end,
        revenue_period_end = EXCLUDED.revenue_period_end,
        inventory_period_end = EXCLUDED.inventory_period_end,
        rpo_period_end      = EXCLUDED.rpo_period_end,
        backlog_period_end  = EXCLUDED.backlog_period_end,
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
        period_provenance  = EXCLUDED.period_provenance,
        fetched_at         = now()
    WHERE xbrl_gauges.latest_quarter_end IS NULL
       OR (
            EXCLUDED.latest_quarter_end IS NOT NULL
        AND EXCLUDED.latest_quarter_end >= xbrl_gauges.latest_quarter_end
       );
"""


def load_latest_periods(conn):
    """Newest durable source period per ticker, used as a monotonic write guard."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT ticker, MAX(latest_quarter_end)
            FROM xbrl_gauges
            GROUP BY ticker
        """)
        return {
            ticker: period
            for ticker, period in cur.fetchall()
            if ticker and period is not None
        }


# ── MAIN ─────────────────────────────────────────────────

def fmt(x):
    return "—" if x is None else f"{x:.1f}"


def main():
    print("=== XBRL Gauges ETL ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")

    universe = get_universe()
    today = date.today()
    stats = RunStats(expected=len(universe))
    context = None

    conn = connect_db(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
            cur.execute(MIGRATION_SQL)
        conn.commit()
        context = begin_run(conn, "xbrl_gauges", expected=len(universe), details={
            "limitedRun": TICKER_LIMIT > 0,
        })
        latest_periods = load_latest_periods(conn)

        try:
            cik_map = get_cik_map()
        except Exception:
            # The ticker-to-CIK index is a required SEC provider request.  If
            # it is down, classify the whole universe as transiently failed.
            stats.attempted = len(universe)
            stats.transient_failures = len(universe)
            raise

        done = skipped = 0
        for n, ticker in enumerate(universe, 1):
            cik = cik_map.get(ticker)
            if not cik:
                print(f"[{n}/{len(universe)}] {ticker}: no CIK (foreign listing?) — skipped")
                skipped += 1
                stats.known_no_data += 1
                continue
            stats.attempted += 1
            try:
                facts = fetch_companyfacts(cik)
                gauges = compute_gauges(facts) if facts else None
                if not gauges:
                    print(f"[{n}/{len(universe)}] {ticker}: no usable US-GAAP quarterly data — skipped")
                    skipped += 1
                    stats.known_no_data += 1
                    continue
                period_exclusions = (
                    (gauges.get("period_provenance") or {}).get("exclusions") or []
                )
                if period_exclusions:
                    stats.degraded += len(period_exclusions)
                    stats.details["periodExclusions"] = (
                        stats.details.get("periodExclusions", 0)
                        + len(period_exclusions)
                    )
                incoming_period = gauges.get("latest_quarter_end")
                stored_period = latest_periods.get(ticker)
                if (
                    stored_period is not None
                    and (incoming_period is None or incoming_period < stored_period)
                ):
                    print(
                        f"[{n}/{len(universe)}] {ticker}: source period regressed "
                        f"from {stored_period} to {incoming_period} — prior row retained"
                    )
                    skipped += 1
                    stats.degraded += 1
                    stats.details["regressedPeriods"] = (
                        stats.details.get("regressedPeriods", 0) + 1
                    )
                    continue
                with conn.cursor() as cur:
                    cur.execute(UPSERT_SQL, (
                        ticker, today,
                        gauges["latest_quarter_end"],
                        gauges.get("revenue_period_end"),
                        gauges.get("inventory_period_end"),
                        gauges.get("rpo_period_end"),
                        gauges.get("backlog_period_end"),
                        gauges["revenue_q"], gauges["revenue_yoy"],
                        gauges["inventory"], gauges["inventory_yoy"],
                        gauges["inventory_days"], gauges["inventory_days_yoy"],
                        gauges["rpo"], gauges["rpo_yoy"], gauges["rpo_to_ttm_revenue"],
                        gauges["order_gap"], gauges["backlog_score"],
                        psycopg2.extras.Json(gauges["tags_used"]),
                        psycopg2.extras.Json(gauges.get("period_provenance") or {}),
                    ))
                    published = getattr(cur, "rowcount", 1) != 0
                conn.commit()
                if not published:
                    print(
                        f"[{n}/{len(universe)}] {ticker}: a concurrent run "
                        "published a newer source period — prior row retained"
                    )
                    skipped += 1
                    stats.degraded += 1
                    stats.details["concurrentPeriodGuards"] = (
                        stats.details.get("concurrentPeriodGuards", 0) + 1
                    )
                    continue
                done += 1
                stats.usable += 1
                latest_periods[ticker] = incoming_period
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
                stats.transient_failures += 1
            time.sleep(SEC_PAUSE)
        stats.details.update({"loaded": done, "skipped": skipped})
        finish_run(
            conn,
            context,
            stats,
            minimum_provider_coverage=threshold_from_env(
                os.environ, "XBRL_MIN_PROVIDER_COVERAGE", 0.90
            ),
            minimum_usable_coverage=threshold_from_env(
                os.environ, "XBRL_MIN_USABLE_COVERAGE", 0.50
            ),
            minimum_baseline_retention=threshold_from_env(
                os.environ, "XBRL_MIN_BASELINE_RETENTION", 0.75
            ),
            limited_run=TICKER_LIMIT > 0,
        )
    except CoverageError:
        raise
    except Exception as error:
        record_failure_safely(conn, context, stats, error)
        raise
    finally:
        conn.close()

    print(f"=== XBRL Gauges ETL complete: {done} loaded, {skipped} skipped ===")


if __name__ == "__main__":
    main()
