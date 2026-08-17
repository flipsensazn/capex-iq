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
#                    date, so historical rows are explicitly retrospective)
#   order_gap_50     XBRL order gap (RPO yoy - revenue yoy) breached +50pp
#   scout_approved   a scout candidate was approved into a map
#
# Methodology v2 separates forward-observed events from historical
# reconstructions. Events before the frozen prospective boundary remain useful
# exploratory evidence, but are never aggregated into the prospective record.
#
# Design rules:
#   - one event per (ticker, event_type, event_date); a 90-day refractory per
#     (ticker, type, cohort) stops threshold oscillation from spamming events
#   - entry = first regular-session close strictly after signal availability
#     (or the first close after event_date for historical reconstructions).
#   - 1w / 1m / 3m targets anchor to actual entry_date, not event_date.
#   - rows are recomputed idempotently until all horizons are filled, so a
#     missing Yahoo quote today is retried next week automatically
#   - no Telegram: the scoreboard is passive measurement, not an alert
#
# Env vars: DATABASE_URL (required)

import os
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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
METHODOLOGY_VERSION = 2
DEFAULT_PROSPECTIVE_START = date(2026, 8, 17)
MARKET_TIMEZONE = ZoneInfo("America/New_York")


def prospective_start_date():
    """Documented v2 boundary, with an explicit backfill/test override."""
    raw = os.environ.get("SCOREBOARD_PROSPECTIVE_START")
    if not raw:
        return DEFAULT_PROSPECTIVE_START
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(
            "SCOREBOARD_PROSPECTIVE_START must be an ISO date (YYYY-MM-DD)."
        ) from exc


def classify_cohort(event_date, boundary=None):
    """Classify by event date so newly discovered old backfills stay historical."""
    boundary = boundary or prospective_start_date()
    return "prospective" if event_date >= boundary else "retrospective"


def _iso_timestamp(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def event_details(event_date, details=None, available_at=None):
    """Attach durable cohort and timing provenance to an event's JSON details."""
    payload = dict(details or {})
    cohort = classify_cohort(event_date)
    payload.update({
        "cohort": cohort,
        "cohortBoundary": prospective_start_date().isoformat(),
        "methodologyVersion": METHODOLOGY_VERSION,
        "observedUnderV2": True,
        "entryRule": "first_close_after_signal",
        "timingBasis": (
            "source_timestamp" if available_at is not None
            and cohort == "prospective"
            else "date_only_conservative"
        ),
    })
    available = _iso_timestamp(available_at)
    if available:
        payload["signalAvailableAt"] = available
    return payload


def first_market_close_after(available_at):
    """NYSE session date whose scheduled close is strictly after a timestamp.

    The exchange calendar handles weekends, holidays, and early closes. Import
    lazily so pure detection helpers remain usable without loading pandas.
    """
    import pandas_market_calendars as mcal

    if available_at.tzinfo is None:
        available_at = available_at.replace(tzinfo=timezone.utc)
    available_utc = available_at.astimezone(timezone.utc)
    local_date = available_at.astimezone(MARKET_TIMEZONE).date()
    schedule = mcal.get_calendar("NYSE").schedule(
        start_date=local_date.isoformat(),
        end_date=(local_date + timedelta(days=14)).isoformat(),
    )
    for session, row in schedule.iterrows():
        market_close = row["market_close"]
        if hasattr(market_close, "to_pydatetime"):
            market_close = market_close.to_pydatetime()
        if market_close.tzinfo is None:
            market_close = market_close.replace(tzinfo=timezone.utc)
        if market_close.astimezone(timezone.utc) > available_utc:
            return session.date() if hasattr(session, "date") else session
    raise RuntimeError("NYSE calendar returned no eligible close within 14 days.")


def entry_target_date(event_date, details=None):
    """Earliest calendar date whose regular close occurs after the signal.

    Historical reconstructions and signals lacking an exact timestamp wait
    until the next calendar day. Timestamped prospective events use the actual
    NYSE schedule, including holidays and early closes. If calendar resolution
    fails, the conservative fallback cannot reuse the availability-day close.
    """
    details = details or {}
    if details.get("cohort") != "prospective":
        return event_date + timedelta(days=1)

    raw = details.get("signalAvailableAt")
    if not raw:
        return event_date + timedelta(days=1)
    try:
        available = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return event_date + timedelta(days=1)
    if available.tzinfo is None:
        available = available.replace(tzinfo=timezone.utc)
    try:
        return first_market_close_after(available)
    except Exception as exc:
        print(f"    NYSE calendar unavailable ({exc}); using next-day fallback.")
        return available.astimezone(MARKET_TIMEZONE).date() + timedelta(days=1)


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

    def emit(ticker, etype, when, score, details, available_at=None):
        found.append({
            "ticker": ticker, "event_type": etype, "event_date": when,
            "score": float(score) if score is not None else None,
            "details": event_details(when, details, available_at),
        })

    with conn.cursor() as cur:
        # Composite score: crossings + jumps over weekly snapshots
        cur.execute("""
            SELECT ticker, as_of_date, composite, computed_at
            FROM composite_scores ORDER BY ticker, as_of_date
        """)
        for ticker, series in _group(cur.fetchall()).items():
            vals = [(d, float(c) if c is not None else None)
                    for d, c, _ in series]
            availability = {d: ts for d, _, ts in series}
            for d, v, kind in find_crossings(vals, CROSS_LINE):
                emit(ticker, "cbs_cross_70", d, v, {"kind": kind},
                     availability.get(d))
            for d, v, delta in find_jumps(vals, JUMP_DELTA):
                emit(ticker, "cbs_jump_15", d, v, {"jump": delta},
                     availability.get(d))

        # Transcript stress: crossings over fiscal quarters, dated to the call
        cur.execute("""
            SELECT ticker, call_date, stress_score, analyzed_at
            FROM transcript_stress ORDER BY ticker, fiscal_year, fiscal_quarter
        """)
        for ticker, series in _group(cur.fetchall()).items():
            vals = [(d, float(s) if s is not None else None)
                    for d, s, _ in series]
            availability = {d: ts for d, _, ts in series}
            for d, v, kind in find_crossings(vals, CROSS_LINE):
                emit(ticker, "stress_cross_70", d, v, {"kind": kind},
                     availability.get(d))

        # XBRL order gap: breaches over weekly snapshots
        cur.execute("""
            SELECT ticker, as_of_date, order_gap, fetched_at
            FROM xbrl_gauges ORDER BY ticker, as_of_date
        """)
        for ticker, series in _group(cur.fetchall()).items():
            vals = [(d, float(g) if g is not None else None)
                    for d, g, _ in series]
            availability = {d: ts for d, _, ts in series}
            for d, v, kind in find_crossings(vals, GAP_LINE):
                emit(ticker, "order_gap_50", d, v, {"kind": kind},
                     availability.get(d))

        # Scout approvals: dated to the review action
        cur.execute("""
            SELECT ticker, COALESCE(reviewed_at, discovered_at),
                   stress_score, view
            FROM bottleneck_candidates WHERE status = 'approved'
        """)
        for ticker, available_at, score, view in cur.fetchall():
            if available_at is not None:
                when = available_at.date()
                emit(ticker, "scout_approved", when, score, {"view": view},
                     available_at)

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


def close_on_date(series, target):
    """Return the close for exactly target, or None when that bar is absent."""
    for d, px in series or []:
        if d == target:
            return d, px
        if d > target:
            break
    return None


def compute_row_fill(entry_target, series, bench_series, today, existing=None):
    """All price fields for one event, or None if entry can't be priced yet.
    Horizons anchor to the actual entry date; immature targets stay None.
    Today's daily bar is excluded because an intraday Yahoo row is not a close.
    Once persisted, entry date/prices remain frozen across later Yahoo backfills.
    """
    series = [(d, px) for d, px in (series or []) if d < today]
    bench_series = [(d, px) for d, px in (bench_series or []) if d < today]
    existing = existing or {}

    if existing.get("entry_date") is not None:
        # Freeze the entry date, but re-read both adjusted prices from the same
        # Yahoo vintage used for the exit. Corporate actions can back-adjust
        # history; mixing an old stored price with a new adjusted exit corrupts
        # the return. SQL below preserves the originally published entry fields.
        entry = close_on_date(series, existing["entry_date"])
        bench_entry = close_on_date(bench_series, existing["entry_date"])
        if entry is None or bench_entry is None:
            return None
    else:
        entry = close_on_or_after(series, entry_target)
        if entry is None:
            return None
        bench_entry = close_on_date(bench_series, entry[0])
        if bench_entry is None:
            return None

    fill = {
        "entry_date": entry[0], "entry_price": round(entry[1], 4),
        "bench_entry": round(bench_entry[1], 4),
    }
    for name, days in HORIZONS:
        target = entry[0] + timedelta(days=days)
        ret = bench = None
        exit_date = None
        if target <= today:
            fwd = close_on_or_after(series, target)
            bfwd = close_on_date(bench_series, fwd[0]) if fwd is not None else None
            if fwd is not None and bfwd is not None:
                ret = round((fwd[1] / entry[1] - 1) * 100, 2)
                bench = round((bfwd[1] / bench_entry[1] - 1) * 100, 2)
                exit_date = fwd[0]
        fill[f"ret_{name}"] = ret
        fill[f"bench_{name}"] = bench
        fill[f"exit_{name}_date"] = exit_date
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

METHODOLOGY_MIGRATION_SQL = """
    UPDATE signal_events
    SET details = (COALESCE(details, '{}'::jsonb) - 'exitDates') || jsonb_build_object(
            'cohort', CASE
                WHEN details->>'observedUnderV2' = 'true'
                     AND event_date >= %s::date THEN 'prospective'
                ELSE 'retrospective'
            END,
            'cohortBoundary', %s,
            'methodologyVersion', %s,
            'observedUnderV2', CASE
                WHEN details->>'observedUnderV2' = 'true' THEN true ELSE false
            END,
            'entryRule', 'first_close_after_signal',
            'timingBasis', CASE
                WHEN details->>'observedUnderV2' = 'true'
                     AND event_date >= %s::date
                     AND NULLIF(details->>'signalAvailableAt', '') IS NOT NULL
                    THEN 'source_timestamp'
                ELSE 'date_only_conservative'
            END
        ),
        entry_date = NULL,
        entry_price = NULL,
        bench_entry = NULL,
        ret_1w = NULL,
        bench_1w = NULL,
        ret_1m = NULL,
        bench_1m = NULL,
        ret_3m = NULL,
        bench_3m = NULL,
        updated_at = now()
    WHERE COALESCE(details->>'methodologyVersion', '') <> %s
       OR COALESCE(details->>'cohortBoundary', '') <> %s;
"""

INSERT_SQL = """
    INSERT INTO signal_events (ticker, event_type, event_date, score, details)
    VALUES %s
    ON CONFLICT (ticker, event_type, event_date) DO NOTHING;
"""

FILL_SQL = """
    UPDATE signal_events SET
        entry_date  = COALESCE(entry_date, %(entry_date)s),
        entry_price = COALESCE(entry_price, %(entry_price)s),
        bench_entry = COALESCE(bench_entry, %(bench_entry)s),
        ret_1w = COALESCE(ret_1w, %(ret_1w)s),
        bench_1w = COALESCE(bench_1w, %(bench_1w)s),
        ret_1m = COALESCE(ret_1m, %(ret_1m)s),
        bench_1m = COALESCE(bench_1m, %(bench_1m)s),
        ret_3m = COALESCE(ret_3m, %(ret_3m)s),
        bench_3m = COALESCE(bench_3m, %(bench_3m)s),
        details = COALESCE(details, '{}'::jsonb) || jsonb_build_object(
            'exitDates', jsonb_strip_nulls(jsonb_build_object(
                    '1w', %(exit_1w_date)s,
                    '1m', %(exit_1m_date)s,
                    '3m', %(exit_3m_date)s
                )) || COALESCE(details->'exitDates', '{}'::jsonb)
        ),
        updated_at = now()
    WHERE ticker = %(ticker)s AND event_type = %(event_type)s
      AND event_date = %(event_date)s;
"""

ENRICH_EXACT_SQL = """
    UPDATE signal_events
    SET score = %(score)s,
        details = %(details)s,
        updated_at = now()
    WHERE ticker = %(ticker)s AND event_type = %(event_type)s
      AND event_date = %(event_date)s;
"""

REPRICE_EXACT_SQL = """
    UPDATE signal_events
    SET score = %(score)s,
        details = %(details)s,
        entry_date = NULL,
        entry_price = NULL,
        bench_entry = NULL,
        ret_1w = NULL, bench_1w = NULL,
        ret_1m = NULL, bench_1m = NULL,
        ret_3m = NULL, bench_3m = NULL,
        updated_at = now()
    WHERE ticker = %(ticker)s AND event_type = %(event_type)s
      AND event_date = %(event_date)s;
"""


def migrate_methodology(conn):
    """One-time, idempotent v2 reprice of rows created under old timing rules."""
    with conn.cursor() as cur:
        boundary = prospective_start_date().isoformat()
        cur.execute(
            METHODOLOGY_MIGRATION_SQL,
            (boundary, boundary, METHODOLOGY_VERSION, boundary,
             str(METHODOLOGY_VERSION), boundary),
        )
        reset = cur.rowcount
    conn.commit()
    if reset:
        print(f"Reset {reset} legacy event row(s) for methodology v2 repricing.")
    return reset


def _parsed_timestamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def merge_event_details(existing, detected):
    """Merge exact-key provenance while preserving first known availability."""
    merged = dict(existing or {})
    merged.update(detected or {})
    old_raw = (existing or {}).get("signalAvailableAt")
    new_raw = (detected or {}).get("signalAvailableAt")
    old_ts, new_ts = _parsed_timestamp(old_raw), _parsed_timestamp(new_raw)
    if old_ts is not None and (new_ts is None or old_ts <= new_ts):
        merged["signalAvailableAt"] = old_raw
        if (
            merged.get("cohort") == "prospective"
            and (existing or {}).get("timingBasis") == "source_timestamp"
        ):
            merged["timingBasis"] = "source_timestamp"
    elif new_ts is not None:
        merged["signalAvailableAt"] = new_raw
    merged["observedUnderV2"] = True
    return merged


def _timing_signature(details):
    details = details or {}
    signature = (
        details.get("cohort"),
        details.get("entryRule"),
        details.get("timingBasis"),
    )
    if details.get("timingBasis") == "source_timestamp":
        signature += (details.get("signalAvailableAt"),)
    return signature


def record_new_events(conn):
    """Detect, enrich exact rows, then refractory-filter and insert new rows."""
    with conn.cursor() as cur:
        cur.execute("SELECT ticker, event_type, event_date, details FROM signal_events")
        existing_exact = {
            (ticker, event_type, event_date): dict(details or {})
            for ticker, event_type, event_date, details in cur.fetchall()
        }

    detected = detect_events(conn)
    exact_updates = []
    fresh_detected = []
    for ev in detected:
        exact_key = (ev["ticker"], ev["event_type"], ev["event_date"])
        old_details = existing_exact.get(exact_key)
        if old_details is None:
            fresh_detected.append(ev)
            continue
        merged = merge_event_details(old_details, ev["details"])
        reprice = _timing_signature(old_details) != _timing_signature(merged)
        stored_details = dict(merged)
        if reprice:
            stored_details.pop("exitDates", None)
        exact_updates.append({
            "ticker": ev["ticker"],
            "event_type": ev["event_type"],
            "event_date": ev["event_date"],
            "score": ev["score"],
            "details": psycopg2.extras.Json(stored_details),
            "reprice": reprice,
        })
        existing_exact[exact_key] = merged

    existing = {}
    for (ticker, event_type, event_date), details in existing_exact.items():
        cohort = details.get("cohort") or "retrospective"
        existing.setdefault((ticker, event_type, cohort), set()).add(event_date)

    by_key = {}
    for ev in fresh_detected:
        cohort = ev["details"]["cohort"]
        by_key.setdefault((ev["ticker"], ev["event_type"], cohort), []).append(ev)

    rows = []
    for key, events in by_key.items():
        prior = existing.get(key, set())
        kept = apply_refractory(prior, [
            (ev["event_date"], ev) for ev in events
        ])
        for _, ev in kept:
            rows.append((ev["ticker"], ev["event_type"], ev["event_date"],
                         ev["score"], psycopg2.extras.Json(ev["details"])))

    if exact_updates or rows:
        with conn.cursor() as cur:
            for update in exact_updates:
                sql = REPRICE_EXACT_SQL if update.pop("reprice") else ENRICH_EXACT_SQL
                cur.execute(sql, update)
            if rows:
                psycopg2.extras.execute_values(cur, INSERT_SQL, rows, page_size=200)
        conn.commit()
    print(
        f"{len(detected)} events detected · {len(rows)} new · "
        f"{len(exact_updates)} exact row(s) enriched"
    )
    return len(rows)


def fill_returns(conn):
    """Price every event still missing entry or a matured horizon."""
    today = date.today()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT ticker, event_type, event_date, details, entry_date,
                   entry_price, bench_entry,
                   ret_1w, bench_1w, ret_1m, bench_1m, ret_3m, bench_3m
            FROM signal_events
            WHERE entry_date IS NULL OR entry_price IS NULL OR bench_entry IS NULL
               OR ret_1w IS NULL OR bench_1w IS NULL
               OR ret_1m IS NULL OR bench_1m IS NULL
               OR ret_3m IS NULL OR bench_3m IS NULL
            ORDER BY ticker, event_date
        """)
        pending = cur.fetchall()

    # Only rows where something new is actually computable this run
    todo = []
    for row in pending:
        (ticker, etype, ev_date, details, entry_date, entry, bench_entry,
         r1w, b1w, r1m, b1m, r3m, b3m) = row
        target = entry_target_date(ev_date, details)
        horizon_anchor = entry_date or target
        matured = [(name, days) for name, days in HORIZONS
                   if horizon_anchor + timedelta(days=days) <= today]
        pairs = {"1w": (r1w, b1w), "1m": (r1m, b1m), "3m": (r3m, b3m)}
        needs = any(v is None for v in (entry_date, entry, bench_entry)) or any(
            ret is None or bench_ret is None
            for name, _ in matured for ret, bench_ret in [pairs[name]]
        )
        if needs:
            existing = {
                "entry_date": entry_date,
                "entry_price": entry,
                "bench_entry": bench_entry,
            }
            todo.append((ticker, etype, ev_date, target,
                         entry_date or target, existing))
    if not todo:
        print("No returns to fill.")
        return 0

    tickers = sorted({t for t, _, _, _, _, _ in todo})
    min_date = min(anchor for _, _, _, _, anchor, _ in todo) - timedelta(days=5)
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
            for t, etype, ev_date, target, _, existing in todo:
                if t != ticker:
                    continue
                fill = compute_row_fill(target, series, bench, today, existing)
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

        migrate_methodology(conn)
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
