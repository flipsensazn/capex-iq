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
#   - CBS crossings/jumps require two snapshots under the same CBS methodology
#     and a genuinely newer component vintage; rollout/method changes establish
#     a baseline rather than manufacturing a forward-observed signal
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

from etl_health import (
    CoverageError,
    RunStats,
    begin_run,
    finish_run,
    record_failure_safely,
)
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
GAUGE_SOURCE_METHODOLOGY = "xbrl-gauges-v2-score-period"
GAUGE_PERIOD_PROVENANCE_METHODOLOGY = "xbrl-gauge-score-period-v1"
GAUGE_MAX_AGE_DAYS = 365
GAUGE_FUTURE_TOLERANCE_DAYS = 7
TRANSCRIPT_SOURCE_METHODOLOGY = "transcript-stress-v1"
TRANSCRIPT_MAX_AGE_DAYS = 365
TRANSCRIPT_FUTURE_TOLERANCE_DAYS = 7


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
    if available.astimezone(MARKET_TIMEZONE).date() < event_date:
        # Some providers tolerate a call/report date a few days after the
        # analysis timestamp. Preserve that metadata tolerance, but never
        # price a signal before the event it claims to observe.
        return event_date + timedelta(days=1)
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


CBS_COMPONENTS = ("transcript", "gauge", "concentration")


def _component_parts(components):
    components = components if isinstance(components, dict) else {}
    return {
        name: components[name]
        for name in CBS_COMPONENTS
        if isinstance(components.get(name), dict)
    }


def _cbs_methodologies_match(previous, current):
    previous_method = previous.get("methodology_signature")
    current_method = current.get("methodology_signature")
    if not previous_method or previous_method != current_method:
        return False

    previous_parts = _component_parts(previous.get("components"))
    current_parts = _component_parts(current.get("components"))
    for name in previous_parts.keys() & current_parts.keys():
        previous_source = previous_parts[name].get("sourceMethodology")
        current_source = current_parts[name].get("sourceMethodology")
        if not previous_source or previous_source != current_source:
            return False
    return True


def advanced_component_vintages(previous, current):
    """Comparable components changed at a strictly newer source timestamp."""
    previous_parts = _component_parts(previous.get("components"))
    current_parts = _component_parts(current.get("components"))
    if previous_parts.keys() != current_parts.keys():
        return []
    previous_computed = _parsed_timestamp(previous.get("computed_at"))
    advanced = []

    # A later fetch of an older reporting period is a backfill, not a forward
    # vintage. Baseline the whole CBS comparison because its score may have
    # moved due to that regressed input; equal-period restatements remain valid.
    for name in previous_parts.keys() & current_parts.keys():
        previous_part = previous_parts[name]
        current_part = current_parts[name]
        previous_eligible = previous_part.get("eligible", True)
        current_eligible = current_part.get("eligible", True)
        if previous_eligible != current_eligible:
            return []
        if not previous_eligible:
            continue
        previous_period_end = _parsed_timestamp(previous_part.get("sourcePeriodEnd"))
        current_period_end = _parsed_timestamp(current_part.get("sourcePeriodEnd"))
        if (
            previous_period_end is None
            or current_period_end is None
            or current_period_end < previous_period_end
        ):
            return []

    for name, current_part in current_parts.items():
        if not current_part.get("eligible", True):
            continue
        current_signature = current_part.get("sourceSignature")
        current_available = _parsed_timestamp(current_part.get("sourceAvailableAt"))
        if not current_signature or current_available is None:
            continue

        previous_part = previous_parts.get(name)
        if previous_part is None:
            if previous_computed is not None and current_available > previous_computed:
                advanced.append(name)
            continue

        previous_period_end = _parsed_timestamp(previous_part.get("sourcePeriodEnd"))
        current_period_end = _parsed_timestamp(current_part.get("sourcePeriodEnd"))
        if (
            not previous_part.get("eligible", True)
            or previous_period_end is None
            or current_period_end is None
            or current_period_end < previous_period_end
        ):
            continue

        previous_signature = previous_part.get("sourceSignature")
        previous_available = _parsed_timestamp(previous_part.get("sourceAvailableAt"))
        if (
            previous_signature
            and current_signature != previous_signature
            and previous_available is not None
            and current_available > previous_available
        ):
            advanced.append(name)

    return advanced


def find_cbs_events(series):
    """Eligible CBS crossings/jumps from provenance-aware chronological rows.

    A first snapshot, a methodology transition, or a recomputation over the
    same source vintages is a baseline. It cannot enter the prospective record.
    """
    events = []
    previous = None
    for current in series:
        if current.get("score") is None:
            # An explicit unavailable-data snapshot breaks continuity. The
            # next usable CBS establishes a new baseline rather than comparing
            # across a stale-data gap.
            previous = None
            continue
        if previous is None:
            previous = current
            continue

        same_methodology = _cbs_methodologies_match(previous, current)
        input_changed = (
            previous.get("input_signature")
            and current.get("input_signature")
            and previous["input_signature"] != current["input_signature"]
        )
        advanced = (
            advanced_component_vintages(previous, current)
            if same_methodology and input_changed else []
        )
        if advanced:
            common = {
                "date": current["date"],
                "score": float(current["score"]),
                "available_at": current.get("computed_at"),
                "sourceAvailableAt": _iso_timestamp(current.get("source_available_at")),
                "cbsMethodologySignature": current["methodology_signature"],
                "cbsInputSignature": current["input_signature"],
                "advancedComponents": advanced,
            }
            previous_score = float(previous["score"])
            current_score = float(current["score"])
            if previous_score < CROSS_LINE <= current_score:
                events.append({**common, "event_type": "cbs_cross_70", "kind": "cross"})
            delta = current_score - previous_score
            if delta >= JUMP_DELTA:
                events.append({
                    **common,
                    "event_type": "cbs_jump_15",
                    "kind": "jump",
                    "jump": round(delta, 1),
                })
        previous = current
    return events


def _period_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def verified_order_gap_provenance(
    latest_quarter_end, period_provenance, as_of_date,
):
    """Validate the versioned score-period contract for a raw XBRL signal."""
    provenance = period_provenance if isinstance(period_provenance, dict) else {}
    observed_on = _period_date(as_of_date)
    latest_period = _period_date(latest_quarter_end)
    score_period = _period_date(provenance.get("scorePeriodEnd"))
    if (
        provenance.get("methodology") != GAUGE_PERIOD_PROVENANCE_METHODOLOGY
        or provenance.get("scoreDriver") != "backlog"
        or observed_on is None
        or latest_period is None
        or score_period is None
        or score_period != latest_period
    ):
        return None
    age_days = (observed_on - score_period).days
    if age_days < -GAUGE_FUTURE_TOLERANCE_DAYS or age_days > GAUGE_MAX_AGE_DAYS:
        return None
    return {
        "gaugeSourceMethodology": GAUGE_SOURCE_METHODOLOGY,
        "gaugeSourcePeriodEnd": score_period.isoformat(),
        "gaugeLatestQuarterEnd": latest_period.isoformat(),
        "gaugePeriodProvenance": dict(provenance),
    }


def find_order_gap_events(series):
    """Find eligible order-gap breaches while resetting across invalid rows.

    Rows are ``(as_of_date, order_gap, fetched_at, latest_quarter_end,
    period_provenance)``. A legacy, stale, future, or mismatched row breaks
    continuity, so it can neither become an event nor provide the prior side
    of a later crossing.
    """
    events = []
    previous = None
    for as_of_date, order_gap, fetched_at, latest_quarter_end, provenance in series:
        verified = verified_order_gap_provenance(
            latest_quarter_end, provenance, as_of_date,
        )
        if order_gap is None or verified is None:
            previous = None
            continue
        value = float(order_gap)
        kind = None
        if previous is None and value >= GAP_LINE:
            kind = "initial"
        elif previous is not None and previous < GAP_LINE <= value:
            kind = "cross"
        if kind is not None and as_of_date is not None:
            events.append({
                "date": as_of_date,
                "score": value,
                "kind": kind,
                "available_at": fetched_at,
                **verified,
            })
        previous = value
    return events


def _observation_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).date()
    except (TypeError, ValueError):
        return None


def transcript_source_methodology(model, provider):
    """Stable analysis/source method; observation timestamps are not identity."""
    provider = str(provider).strip() if provider is not None else ""
    if not provider:
        return None
    analysis = f"model:{model}" if model else "lexicon-only"
    return f"{TRANSCRIPT_SOURCE_METHODOLOGY}:{analysis}:provider:{provider}"


def verified_transcript_provenance(call_date, analyzed_at, model, provider):
    """Validate transcript source date against its own analysis observation."""
    source_period = _period_date(call_date)
    observed_on = _observation_date(analyzed_at)
    methodology = transcript_source_methodology(model, provider)
    if source_period is None or observed_on is None or methodology is None:
        return None
    age_days = (observed_on - source_period).days
    if (
        age_days < -TRANSCRIPT_FUTURE_TOLERANCE_DAYS
        or age_days > TRANSCRIPT_MAX_AGE_DAYS
    ):
        return None
    analyzed = _iso_timestamp(analyzed_at)
    return {
        "transcriptSourceMethodology": methodology,
        "transcriptSourcePeriodEnd": source_period.isoformat(),
        "transcriptAnalyzedAt": analyzed,
        "transcriptSourceAgeDays": age_days,
        "transcriptSourceProvenance": {
            "methodology": methodology,
            "sourcePeriodEnd": source_period.isoformat(),
            "analyzedAt": analyzed,
            "ageDaysAtAnalysis": age_days,
            "provider": provider,
            "model": model,
        },
    }


def find_transcript_stress_events(series):
    """Find stress breaches with source-method baselines and invalid gaps.

    Rows are ``(call_date, stress_score, analyzed_at, model, provider)``.
    Missing/stale/future rows break continuity. A model/provider transition is
    a new baseline and cannot itself emit a crossing.
    """
    events = []
    previous = None
    for call_date, stress_score, analyzed_at, model, provider in series:
        provenance = verified_transcript_provenance(
            call_date, analyzed_at, model, provider,
        )
        if stress_score is None or provenance is None:
            previous = None
            continue
        value = float(stress_score)
        methodology = provenance["transcriptSourceMethodology"]
        kind = None
        if previous is None:
            if value >= CROSS_LINE:
                kind = "initial"
        elif previous["methodology"] == methodology:
            if previous["score"] < CROSS_LINE <= value:
                kind = "cross"
        # A method transition is intentionally only a baseline.
        if kind is not None:
            events.append({
                "date": _period_date(call_date),
                "score": value,
                "kind": kind,
                "available_at": analyzed_at,
                **provenance,
            })
        previous = {"score": value, "methodology": methodology}
    return events


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
        # Composite score: provenance-eligible crossings + jumps over snapshots.
        # A recompute over the same inputs, or a methodology rollout, is a
        # baseline rather than a forward-observed event.
        cur.execute("""
            SELECT ticker, as_of_date, composite, components,
                   NULLIF(
                       to_jsonb(composite_scores)->>'methodology_signature', ''
                   ) AS methodology_signature,
                   NULLIF(
                       to_jsonb(composite_scores)->>'input_signature', ''
                   ) AS input_signature,
                   NULLIF(
                       to_jsonb(composite_scores)->>'source_available_at', ''
                   )::timestamptz AS source_available_at,
                   computed_at
            FROM composite_scores ORDER BY ticker, as_of_date
        """)
        for ticker, series in _group(cur.fetchall()).items():
            records = [{
                "date": d,
                "score": float(c) if c is not None else None,
                "components": components or {},
                "methodology_signature": methodology_signature,
                "input_signature": input_signature,
                "source_available_at": source_available_at,
                "computed_at": computed_at,
            } for (d, c, components, methodology_signature, input_signature,
                   source_available_at, computed_at) in series]
            for event in find_cbs_events(records):
                details = {
                    "kind": event["kind"],
                    "advancedComponents": event["advancedComponents"],
                    "sourceAvailableAt": event["sourceAvailableAt"],
                    "cbsMethodologySignature": event["cbsMethodologySignature"],
                    "cbsInputSignature": event["cbsInputSignature"],
                }
                if "jump" in event:
                    details["jump"] = event["jump"]
                emit(
                    ticker, event["event_type"], event["date"], event["score"],
                    details, event["available_at"],
                )

        # Transcript stress: only observation-valid rows under a stable source
        # method may cross. Missing/stale/future rows break continuity.
        cur.execute("""
            SELECT ticker, call_date, stress_score, analyzed_at, model, provider
            FROM transcript_stress ORDER BY ticker, fiscal_year, fiscal_quarter
        """)
        for ticker, series in _group(cur.fetchall()).items():
            for event in find_transcript_stress_events(series):
                emit(
                    ticker,
                    "stress_cross_70",
                    event["date"],
                    event["score"],
                    {
                        "kind": event["kind"],
                        "transcriptSourceMethodology": (
                            event["transcriptSourceMethodology"]
                        ),
                        "transcriptSourcePeriodEnd": (
                            event["transcriptSourcePeriodEnd"]
                        ),
                        "transcriptAnalyzedAt": event["transcriptAnalyzedAt"],
                        "transcriptSourceAgeDays": (
                            event["transcriptSourceAgeDays"]
                        ),
                        "transcriptSourceProvenance": (
                            event["transcriptSourceProvenance"]
                        ),
                    },
                    event["available_at"],
                )

        # XBRL order gap: only versioned, fresh score-driving periods may
        # participate. Legacy/ineligible rows explicitly break continuity.
        cur.execute("""
            SELECT ticker, as_of_date, order_gap, fetched_at,
                   latest_quarter_end,
                   to_jsonb(xbrl_gauges)->'period_provenance'
                       AS period_provenance
            FROM xbrl_gauges ORDER BY ticker, as_of_date
        """)
        for ticker, series in _group(cur.fetchall()).items():
            for event in find_order_gap_events(series):
                emit(
                    ticker,
                    "order_gap_50",
                    event["date"],
                    event["score"],
                    {
                        "kind": event["kind"],
                        "gaugeSourceMethodology": event["gaugeSourceMethodology"],
                        "gaugeSourcePeriodEnd": event["gaugeSourcePeriodEnd"],
                        "gaugeLatestQuarterEnd": event["gaugeLatestQuarterEnd"],
                        "gaugePeriodProvenance": event["gaugePeriodProvenance"],
                    },
                    event["available_at"],
                )

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

CBS_ROLLOUT_BASELINE_MIGRATION_SQL = """
    UPDATE signal_events
    SET details = (COALESCE(details, '{}'::jsonb) - 'exitDates') || jsonb_build_object(
            'cohort', 'retrospective',
            'kind', 'migration_baseline',
            'eventClassification', 'migration_baseline',
            'baselineReason', 'missing_cbs_source_provenance',
            'baselineOriginalKind', COALESCE(details->>'kind', event_type),
            'timingBasis', 'date_only_conservative'
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
    WHERE event_type IN ('cbs_cross_70', 'cbs_jump_15')
      AND COALESCE(details->>'cohort', '') = 'prospective'
      AND COALESCE(details->>'cbsMethodologySignature', '') = ''
      AND COALESCE(details->>'eventClassification', '') <> 'migration_baseline'
      AND ret_1w IS NULL AND bench_1w IS NULL
      AND ret_1m IS NULL AND bench_1m IS NULL
      AND ret_3m IS NULL AND bench_3m IS NULL
      AND CURRENT_DATE < COALESCE(entry_date, event_date) + 7;
"""

ORDER_GAP_ROLLOUT_BASELINE_MIGRATION_SQL = """
    UPDATE signal_events
    SET details = (COALESCE(details, '{}'::jsonb) - 'exitDates') || jsonb_build_object(
            'cohort', 'retrospective',
            'kind', 'migration_baseline',
            'eventClassification', 'migration_baseline',
            'baselineReason', 'missing_verified_gauge_period_provenance',
            'baselineOriginalKind', COALESCE(details->>'kind', event_type),
            'timingBasis', 'date_only_conservative'
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
    WHERE event_type = 'order_gap_50'
      AND COALESCE(details->>'cohort', '') = 'prospective'
      AND (
           COALESCE(details->>'gaugeSourceMethodology', '')
               <> 'xbrl-gauges-v2-score-period'
        OR COALESCE(details->>'gaugeSourcePeriodEnd', '') = ''
        OR COALESCE(details->>'gaugeLatestQuarterEnd', '') = ''
        OR COALESCE(details#>>'{gaugePeriodProvenance,methodology}', '')
               <> 'xbrl-gauge-score-period-v1'
        OR COALESCE(details#>>'{gaugePeriodProvenance,scoreDriver}', '')
               <> 'backlog'
        OR COALESCE(details#>>'{gaugePeriodProvenance,scorePeriodEnd}', '')
               <> COALESCE(details->>'gaugeSourcePeriodEnd', '')
        OR COALESCE(details->>'gaugeLatestQuarterEnd', '')
               <> COALESCE(details->>'gaugeSourcePeriodEnd', '')
      )
      AND COALESCE(details->>'eventClassification', '') <> 'migration_baseline'
      AND ret_1w IS NULL AND bench_1w IS NULL
      AND ret_1m IS NULL AND bench_1m IS NULL
      AND ret_3m IS NULL AND bench_3m IS NULL
      AND CURRENT_DATE < COALESCE(entry_date, event_date) + 7;
"""

STRESS_ROLLOUT_BASELINE_MIGRATION_SQL = """
    UPDATE signal_events
    SET details = (COALESCE(details, '{}'::jsonb) - 'exitDates') || jsonb_build_object(
            'cohort', 'retrospective',
            'kind', 'migration_baseline',
            'eventClassification', 'migration_baseline',
            'baselineReason', 'missing_verified_transcript_source_provenance',
            'baselineOriginalKind', COALESCE(details->>'kind', event_type),
            'timingBasis', 'date_only_conservative'
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
    WHERE event_type = 'stress_cross_70'
      AND COALESCE(details->>'cohort', '') = 'prospective'
      AND (
           COALESCE(details->>'transcriptSourceMethodology', '')
               NOT LIKE 'transcript-stress-v1:%:provider:%'
        OR COALESCE(details->>'transcriptSourcePeriodEnd', '') = ''
        OR COALESCE(details->>'transcriptAnalyzedAt', '') = ''
        OR COALESCE(details->>'transcriptSourceAgeDays', '') = ''
        OR COALESCE(details#>>'{transcriptSourceProvenance,methodology}', '')
               <> COALESCE(details->>'transcriptSourceMethodology', '')
        OR COALESCE(details#>>'{transcriptSourceProvenance,sourcePeriodEnd}', '')
               <> COALESCE(details->>'transcriptSourcePeriodEnd', '')
        OR COALESCE(details#>>'{transcriptSourceProvenance,analyzedAt}', '')
               <> COALESCE(details->>'transcriptAnalyzedAt', '')
        OR COALESCE(details#>>'{transcriptSourceProvenance,provider}', '') = ''
      )
      AND COALESCE(details->>'eventClassification', '') <> 'migration_baseline'
      AND ret_1w IS NULL AND bench_1w IS NULL
      AND ret_1m IS NULL AND bench_1m IS NULL
      AND ret_3m IS NULL AND bench_3m IS NULL
      AND CURRENT_DATE < COALESCE(entry_date, event_date) + 7;
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


def migrate_cbs_rollout_baselines(conn):
    """Quarantine provenance-blind rollout events before any return matures."""
    with conn.cursor() as cur:
        cur.execute(CBS_ROLLOUT_BASELINE_MIGRATION_SQL)
        reset = cur.rowcount
    conn.commit()
    if reset:
        print(
            f"Reclassified {reset} provenance-blind CBS rollout event(s) "
            "as retrospective migration baselines."
        )
    return reset


def migrate_order_gap_rollout_baselines(conn):
    """Quarantine provenance-blind order-gap events before returns mature."""
    with conn.cursor() as cur:
        cur.execute(ORDER_GAP_ROLLOUT_BASELINE_MIGRATION_SQL)
        reset = cur.rowcount
    conn.commit()
    if reset:
        print(
            f"Reclassified {reset} provenance-blind order-gap event(s) "
            "as retrospective migration baselines."
        )
    return reset


def migrate_stress_rollout_baselines(conn):
    """Quarantine provenance-blind transcript events before returns mature."""
    with conn.cursor() as cur:
        cur.execute(STRESS_ROLLOUT_BASELINE_MIGRATION_SQL)
        reset = cur.rowcount
    conn.commit()
    if reset:
        print(
            f"Reclassified {reset} provenance-blind transcript event(s) "
            "as retrospective migration baselines."
        )
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
    if (existing or {}).get("eventClassification") == "migration_baseline":
        # Exact-key rediscovery must never promote a quarantined rollout row
        # back into the prospective record.
        merged.update({
            "cohort": "retrospective",
            "kind": "migration_baseline",
            "eventClassification": "migration_baseline",
            "timingBasis": "date_only_conservative",
        })
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
    """Price pending events and report enough coverage to audit the run."""
    today = date.today()
    with conn.cursor() as cur:
        cur.execute("""
            SELECT ticker, event_type, event_date, details, entry_date,
                   entry_price, bench_entry,
                   ret_1w, bench_1w, ret_1m, bench_1m, ret_3m, bench_3m
            FROM signal_events
            WHERE COALESCE(details->>'eventClassification', '')
                      <> 'migration_baseline'
              AND (
                   entry_date IS NULL OR entry_price IS NULL OR bench_entry IS NULL
                OR ret_1w IS NULL OR bench_1w IS NULL
                OR ret_1m IS NULL OR bench_1m IS NULL
                OR ret_3m IS NULL OR bench_3m IS NULL
              )
            ORDER BY ticker, event_date
        """)
        pending = cur.fetchall()

    # Only rows where something new is actually computable this run
    todo = []
    mature_return_pending = False
    for row in pending:
        (ticker, etype, ev_date, details, entry_date, entry, bench_entry,
         r1w, b1w, r1m, b1m, r3m, b3m) = row
        target = entry_target_date(ev_date, details)
        horizon_anchor = entry_date or target
        matured = [(name, days) for name, days in HORIZONS
                   if horizon_anchor + timedelta(days=days) <= today]
        pairs = {"1w": (r1w, b1w), "1m": (r1m, b1m), "3m": (r3m, b3m)}
        missing_mature_names = tuple(
            name for name, _ in matured
            if pairs[name][0] is None or pairs[name][1] is None
        )
        missing_mature = bool(missing_mature_names)
        mature_return_pending = mature_return_pending or missing_mature
        needs = any(v is None for v in (entry_date, entry, bench_entry)) or missing_mature
        if needs:
            existing = {
                "entry_date": entry_date,
                "entry_price": entry,
                "bench_entry": bench_entry,
            }
            todo.append((ticker, etype, ev_date, target,
                         entry_date or target, existing, missing_mature_names))
    if not todo:
        print("No returns to fill.")
        return {
            "pendingRows": 0,
            "maturePendingRows": 0,
            "tickerAttempts": 0,
            "tickerFailures": 0,
            "updatedRows": 0,
            "matureFilledRows": 0,
            "unresolvedMatureRows": 0,
            "benchmarkUnavailable": False,
        }

    tickers = sorted({t for t, _, _, _, _, _, _ in todo})
    min_date = min(anchor for _, _, _, _, anchor, _, _ in todo) - timedelta(days=5)
    end = today + timedelta(days=1)
    print(f"Filling returns for {len(todo)} event(s) across {len(tickers)} ticker(s)...")

    bench = load_price_series(BENCHMARK, min_date, end)
    if not bench:
        if mature_return_pending:
            raise RuntimeError(
                f"Benchmark {BENCHMARK} unavailable with matured returns pending"
            )
        print(f"Benchmark {BENCHMARK} unavailable — skipping fills this run.")
        return {
            "pendingRows": len(todo),
            "maturePendingRows": 0,
            "tickerAttempts": 0,
            "tickerFailures": 0,
            "updatedRows": 0,
            "matureFilledRows": 0,
            "unresolvedMatureRows": 0,
            "benchmarkUnavailable": True,
        }

    filled = 0
    ticker_failures = 0
    mature_pending_rows = sum(bool(item[6]) for item in todo)
    mature_filled_rows = 0
    with conn.cursor() as cur:
        for ticker in tickers:
            series = load_price_series(ticker, min_date, end)
            time.sleep(YF_PAUSE)
            if not series:
                ticker_failures += 1
                continue
            for t, etype, ev_date, target, _, existing, missing_mature_names in todo:
                if t != ticker:
                    continue
                fill = compute_row_fill(target, series, bench, today, existing)
                if fill is None:
                    continue
                if missing_mature_names and all(
                    fill.get(f"ret_{name}") is not None
                    and fill.get(f"bench_{name}") is not None
                    for name in missing_mature_names
                ):
                    mature_filled_rows += 1
                fill.update({"ticker": t, "event_type": etype, "event_date": ev_date})
                cur.execute(FILL_SQL, fill)
                filled += 1
    unresolved_mature_rows = mature_pending_rows - mature_filled_rows
    if mature_pending_rows and mature_filled_rows == 0:
        raise RuntimeError(
            "Event price series unavailable or incomplete for every row "
            f"with matured returns pending ({mature_pending_rows} row(s), "
            f"{ticker_failures}/{len(tickers)} ticker fetches failed)"
        )
    conn.commit()
    print(f"{filled} event row(s) updated with prices/returns.")
    return {
        "pendingRows": len(todo),
        "maturePendingRows": mature_pending_rows,
        "tickerAttempts": len(tickers),
        "tickerFailures": ticker_failures,
        "updatedRows": filled,
        "matureFilledRows": mature_filled_rows,
        "unresolvedMatureRows": unresolved_mature_rows,
        "benchmarkUnavailable": False,
    }


def refresh_event_pipeline(conn):
    """Enrich exact events before quarantining unverifiable raw rows."""
    repriced = migrate_methodology(conn)
    cbs_baselines = migrate_cbs_rollout_baselines(conn)
    new_events = record_new_events(conn)
    stress_baselines = migrate_stress_rollout_baselines(conn)
    order_gap_baselines = migrate_order_gap_rollout_baselines(conn)
    return_fill = fill_returns(conn)
    return {
        "repriced": repriced,
        "cbsBaselines": cbs_baselines,
        "stressBaselines": stress_baselines,
        "orderGapBaselines": order_gap_baselines,
        "newEvents": new_events,
        "returnFill": return_fill,
    }


# ── MAIN ─────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Signal Performance Scoreboard ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")

    conn = connect_db(DATABASE_URL)
    run_context = None
    run_stats = RunStats(expected=1, details={"benchmark": BENCHMARK})
    try:
        run_context = begin_run(
            conn, "signal_scoreboard", expected=1,
            details={"benchmark": BENCHMARK, "methodologyVersion": METHODOLOGY_VERSION},
        )
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
        conn.commit()

        refresh = refresh_event_pipeline(conn)
        repriced = refresh["repriced"]
        cbs_baselines = refresh["cbsBaselines"]
        stress_baselines = refresh["stressBaselines"]
        order_gap_baselines = refresh["orderGapBaselines"]
        new_events = refresh["newEvents"]
        return_fill = refresh["returnFill"]

        with conn.cursor() as cur:
            cur.execute("""
                SELECT event_type, COUNT(*), COUNT(ret_1m)
                FROM signal_events GROUP BY event_type ORDER BY event_type
            """)
            for etype, n, matured in cur.fetchall():
                print(f"  {etype:<18} {n:>4} events · {matured} with 1m returns")
        run_stats.attempted = 1
        run_stats.usable = 1
        run_stats.degraded = (
            return_fill["tickerFailures"]
            + return_fill["unresolvedMatureRows"]
            + int(return_fill["benchmarkUnavailable"])
        )
        run_stats.details.update({
            "methodologyRowsRepriced": repriced,
            "migrationBaselines": (
                cbs_baselines + stress_baselines + order_gap_baselines
            ),
            "cbsMigrationBaselines": cbs_baselines,
            "stressMigrationBaselines": stress_baselines,
            "orderGapMigrationBaselines": order_gap_baselines,
            "newEvents": new_events,
            "returnRowsFilled": return_fill["updatedRows"],
            "returnFill": return_fill,
        })
        finish_run(conn, run_context, run_stats)
    except CoverageError:
        raise
    except Exception as error:
        try:
            conn.rollback()
        except Exception:
            pass
        run_stats.attempted = 1
        run_stats.transient_failures = 1
        record_failure_safely(conn, run_context, run_stats, error)
        raise
    finally:
        conn.close()

    print("=== Signal Performance Scoreboard complete ===")
