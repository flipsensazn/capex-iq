# signal_scoreboard.py
#
# Signal Performance Scoreboard — the feedback loop that answers "does the
# edge actually exist?". Every time the system fires a signal, this ETL logs
# it as an event with the price at that moment, then fills in forward returns
# (1w / 1m / 3m) versus QQQ as each horizon matures. The /scoreboard endpoint
# aggregates median excess return and hit rate per signal type.
#
# Event types detected (all from tables the other ETLs already maintain):
#   cbs_cross_70     composite score crossed the 70 bottleneck line
#   cbs_jump_15      composite score jumped >= +15 week-over-week
#   stress_cross_70  transcript stress crossed 70 (event-dated to the CALL
#                    date, so history backfills — see lookahead note below)
#   order_gap_50     XBRL order gap (RPO yoy - revenue yoy) breached +50pp
#   scout_approved   a scout candidate was approved into a map
#
# Lookahead note: transcript events are dated to the earnings call date, which
# for backfilled quarters predates this system going live. That is acceptable
# because the signal is mechanically derivable from the transcript on that
# date — but it is honest to remember the rubric itself was designed later.
# CBS / gauge / scout events carry no such caveat: their event dates are the
# dates the system actually snapshotted them.
#
# Design rules:
#   - one event per (ticker, event_type, event_date); a 90-day refractory per
#     (ticker, type) stops threshold oscillation from spamming events
#   - entry price = first close ON or AFTER the event date; horizon return =
#     first close on/after event_date + 7/30/91 days, filled only once matured
#   - rows are recomputed idempotently until all horizons are filled, so a
#     missing Yahoo quote today is retried next week automatically
#   - no Telegram: the scoreboard is passive measurement, not an alert
#
# Env vars:  DATABASE_URL (required)

import os
import time
from datetime import date, timedelta

import psycopg2
import psycopg2.extras

from transcript_stress import connect_db

DATABASE_URL = os.environ.get("DATABASE_URL")

BENCHMARK       = "QQQ"
HORIZONS        = [("1w", 7), ("1m", 30), ("3m", 91)]
CROSS_LINE      = 70    # CBS / transcript stress bottleneck line
GAP_LINE        = 50    # order-gap breach, percentage points
JUMP_DELTA      = 15    # CBS week-over-week jump
REFRACTORY_DAYS = 90    # min gap between same-type events on one ticker
MAX_ENTRY_LAG   = 7     # trading close must exist within N days of target
YF_PAUSE        = 0.5   # seconds between Yahoo fetches


# ── EVENT DETECTION (pure, unit-testable) ────────────────

def find_crossings(series, line):
    """series: [(event_date | None, value | None)] in chronological order.
    Returns [(date, value, kind)] — kind 'initial' for a first observation
    already at/above the line, 'cross' for a below→above transition. Rows
    with a None value are ignored; rows with a None date still advance the
    previous-value state but cannot themselves become events."""
    events, prev = [], None
    for d, v in series:
        if v is None:
            continue
        if prev is None:
            if v >= line and d is not None:
                events.append((d, v, "initial"))
        elif prev < line <= v and d is not None:
            events.append((d, v, "cross"))
        prev = v
    return events


def find_jumps(series, min_delta):
    """Consecutive-pair jumps of >= min_delta. Returns [(date, value, delta)]."""
    events, prev = [], None
    for d, v in series:
        if v is None:
            continue
        if prev is not None and v - prev >= min_delta and d is not None:
            events.append((d, v, round(v - prev, 1)))
        prev = v
    return events


def apply_refractory(existing_dates, candidates, min_gap=REFRACTORY_DAYS):
    """Drop candidate events within min_gap days of an already-kept event of
    the same (ticker, type). existing_dates come from the DB; candidates are
    (date, ...) tuples, processed chronologically."""
    kept = sorted(existing_dates)
    out = []
    for cand in sorted(candidates, key=lambda c: c[0]):
        d = cand[0]
        if any(abs((d - k).days) < min_gap for k in kept):
            continue
        kept.append(d)
        kept.sort()
        out.append(cand)
    return out


def _group(rows):
    """[(ticker, a, b, ...)] → {ticker: [(a, b, ...)]}, preserving order."""
    grouped = {}
    for row in rows:
        grouped.setdefault(row[0], []).append(row[1:])
    return grouped


def detect_events(conn):
    """Scan the four signal tables → [{ticker, event_type, event_date, score, details}]."""
    found = []

    def emit(ticker, etype, when, score, details):
        found.append({
            "ticker": ticker, "event_type": etype, "event_date": when,
            "score": float(score) if score is not None else None,
            "details": details,
        })

    with conn.cursor() as cur:
        # Composite score: crossings + jumps over weekly snapshots
        cur.execute("""
            SELECT ticker, as_of_date, composite
            FROM composite_scores ORDER BY ticker, as_of_date
        """)
        for ticker, series in _group(cur.fetchall()).items():
            vals = [(d, float(c) if c is not None else None) for d, c in series]
            for d, v, kind in find_crossings(vals, CROSS_LINE):
                emit(ticker, "cbs_cross_70", d, v, {"kind": kind})
            for d, v, delta in find_jumps(vals, JUMP_DELTA):
                emit(ticker, "cbs_jump_15", d, v, {"jump": delta})

        # Transcript stress: crossings over fiscal quarters, dated to the call
        cur.execute("""
            SELECT ticker, call_date, stress_score
            FROM transcript_stress ORDER BY ticker, fiscal_year, fiscal_quarter
        """)
        for ticker, series in _group(cur.fetchall()).items():
            vals = [(d, float(s) if s is not None else None) for d, s in series]
            for d, v, kind in find_crossings(vals, CROSS_LINE):
                emit(ticker, "stress_cross_70", d, v, {"kind": kind})

        # XBRL order gap: breaches over weekly snapshots
        cur.execute("""
            SELECT ticker, as_of_date, order_gap
            FROM xbrl_gauges ORDER BY ticker, as_of_date
        """)
        for ticker, series in _group(cur.fetchall()).items():
            vals = [(d, float(g) if g is not None else None) for d, g in series]
            for d, v, kind in find_crossings(vals, GAP_LINE):
                emit(ticker, "order_gap_50", d, v, {"kind": kind})

        # Scout approvals: dated to the review action
        cur.execute("""
            SELECT ticker, COALESCE(reviewed_at, discovered_at)::date,
                   stress_score, view
            FROM bottleneck_candidates WHERE status = 'approved'
        """)
        for ticker, when, score, view in cur.fetchall():
            if when is not None:
                emit(ticker, "scout_approved", when, score, {"view": view})

    return found


# ── PRICE SERIES / RETURN FILLING ────────────────────────

def load_price_series(ticker, start, end):
    """Daily adjusted closes → [(date, close)] chronological, or None."""
    import yfinance as yf
    try:
        df = yf.Ticker(ticker).history(
            start=start.isoformat(), end=end.isoformat(),
            interval="1d", auto_adjust=True)
        if df is None or df.empty:
            return None
        return [(idx.date(), float(px)) for idx, px in df["Close"].items()
                if px == px]  # px == px drops NaN
    except Exception as e:
        print(f"    price fetch failed for {ticker}: {e}")
        return None


def close_on_or_after(series, target, max_lag=MAX_ENTRY_LAG):
    """First (date, close) with date >= target, within max_lag days. None if
    the series ends before target or the gap is too wide (delisting/halt)."""
    if not series:
        return None
    for d, px in series:
        if d >= target:
            return (d, px) if (d - target).days <= max_lag else None
    return None


def compute_row_fill(event_date, series, bench_series, today):
    """All price fields for one event, or None if entry can't be priced yet.
    Horizons whose target date hasn't passed stay None (filled next runs)."""
    entry = close_on_or_after(series, event_date)
    bench_entry = close_on_or_after(bench_series, event_date)
    if entry is None or bench_entry is None:
        return None
    fill = {
        "entry_date": entry[0], "entry_price": round(entry[1], 4),
        "bench_entry": round(bench_entry[1], 4),
    }
    for name, days in HORIZONS:
        target = event_date + timedelta(days=days)
        ret = bench = None
        if target <= today:
            fwd = close_on_or_after(series, target)
            bfwd = close_on_or_after(bench_series, target)
            if fwd is not None:
                ret = round((fwd[1] / entry[1] - 1) * 100, 2)
            if bfwd is not None:
                bench = round((bfwd[1] / bench_entry[1] - 1) * 100, 2)
        fill[f"ret_{name}"] = ret
        fill[f"bench_{name}"] = bench
    return fill


# ── DATABASE ─────────────────────────────────────────────

BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS signal_events (
        ticker       TEXT NOT NULL,
        event_type   TEXT NOT NULL,
        event_date   DATE NOT NULL,
        score        DOUBLE PRECISION,
        details      JSONB,
        entry_date   DATE,
        entry_price  DOUBLE PRECISION,
        bench_entry  DOUBLE PRECISION,
        ret_1w   DOUBLE PRECISION,  bench_1w DOUBLE PRECISION,
        ret_1m   DOUBLE PRECISION,  bench_1m DOUBLE PRECISION,
        ret_3m   DOUBLE PRECISION,  bench_3m DOUBLE PRECISION,
        created_at   TIMESTAMPTZ DEFAULT now(),
        updated_at   TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (ticker, event_type, event_date)
    );
"""

INSERT_SQL = """
    INSERT INTO signal_events (ticker, event_type, event_date, score, details)
    VALUES %s
    ON CONFLICT (ticker, event_type, event_date) DO NOTHING;
"""

FILL_SQL = """
    UPDATE signal_events SET
        entry_date  = %(entry_date)s,
        entry_price = %(entry_price)s,
        bench_entry = %(bench_entry)s,
        ret_1w = %(ret_1w)s, bench_1w = %(bench_1w)s,
        ret_1m = %(ret_1m)s, bench_1m = %(bench_1m)s,
        ret_3m = %(ret_3m)s, bench_3m = %(bench_3m)s,
        updated_at = now()
    WHERE ticker = %(ticker)s AND event_type = %(event_type)s
      AND event_date = %(event_date)s;
"""


def record_new_events(conn):
    """Detect, dedupe against existing rows + refractory windows, insert."""
    with conn.cursor() as cur:
        cur.execute("SELECT ticker, event_type, event_date FROM signal_events")
        existing = {}
        for t, e, d in cur.fetchall():
            existing.setdefault((t, e), set()).add(d)

    detected = detect_events(conn)
    by_key = {}
    for ev in detected:
        by_key.setdefault((ev["ticker"], ev["event_type"]), []).append(ev)

    rows = []
    for key, events in by_key.items():
        prior = existing.get(key, set())
        fresh = [ev for ev in events if ev["event_date"] not in prior]
        kept = apply_refractory(prior, [(ev["event_date"], ev) for ev in fresh])
        for _, ev in kept:
            rows.append((ev["ticker"], ev["event_type"], ev["event_date"],
                         ev["score"], psycopg2.extras.Json(ev["details"])))

    if rows:
        with conn.cursor() as cur:
            psycopg2.extras.execute_values(cur, INSERT_SQL, rows, page_size=200)
        conn.commit()
    print(f"{len(detected)} events detected · {len(rows)} new (rest already logged or in refractory)")
    return len(rows)


def fill_returns(conn):
    """Price every event still missing entry or a matured horizon."""
    today = date.today()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT ticker, event_type, event_date, entry_price, ret_1w, ret_1m, ret_3m
            FROM signal_events
            WHERE entry_price IS NULL OR ret_1w IS NULL
               OR ret_1m IS NULL OR ret_3m IS NULL
            ORDER BY ticker, event_date
        """)
        pending = cur.fetchall()

    # Only rows where something new is actually computable this run
    todo = []
    for ticker, etype, ev_date, entry, r1w, r1m, r3m in pending:
        matured = [(name, days) for name, days in HORIZONS
                   if ev_date + timedelta(days=days) <= today]
        needs = entry is None or any(
            {"1w": r1w, "1m": r1m, "3m": r3m}[name] is None for name, _ in matured)
        if needs:
            todo.append((ticker, etype, ev_date))
    if not todo:
        print("No returns to fill.")
        return 0

    tickers = sorted({t for t, _, _ in todo})
    min_date = min(d for _, _, d in todo) - timedelta(days=5)
    end = today + timedelta(days=1)
    print(f"Filling returns for {len(todo)} event(s) across {len(tickers)} ticker(s)...")

    bench = load_price_series(BENCHMARK, min_date, end)
    if not bench:
        print(f"Benchmark {BENCHMARK} unavailable — skipping fills this run.")
        return 0

    filled = 0
    with conn.cursor() as cur:
        for ticker in tickers:
            series = load_price_series(ticker, min_date, end)
            time.sleep(YF_PAUSE)
            if not series:
                continue
            for t, etype, ev_date in todo:
                if t != ticker:
                    continue
                fill = compute_row_fill(ev_date, series, bench, today)
                if fill is None:
                    continue
                fill.update({"ticker": t, "event_type": etype, "event_date": ev_date})
                cur.execute(FILL_SQL, fill)
                filled += 1
    conn.commit()
    print(f"{filled} event row(s) updated with prices/returns.")
    return filled


# ── MAIN ─────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Signal Performance Scoreboard ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")

    conn = connect_db(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
        conn.commit()

        record_new_events(conn)
        fill_returns(conn)

        with conn.cursor() as cur:
            cur.execute("""
                SELECT event_type, COUNT(*), COUNT(ret_1m)
                FROM signal_events GROUP BY event_type ORDER BY event_type
            """)
            for etype, n, matured in cur.fetchall():
                print(f"  {etype:<18} {n:>4} events · {matured} with 1m returns")
    finally:
        conn.close()

    print("=== Signal Performance Scoreboard complete ===")
