"""Shared run-health accounting for scheduled data pipelines.

The dashboard serves snapshots assembled by independent ETLs.  A green process
exit is not enough to say those snapshots are current: provider outages can
produce zero usable rows without raising.  This module gives each pipeline a
durable, queryable run record and one coverage policy.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from dataclasses import dataclass, field
from datetime import date


BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS etl_run_manifest (
        pipeline                  TEXT NOT NULL,
        run_id                    TEXT NOT NULL,
        run_date                  DATE NOT NULL,
        state                     TEXT NOT NULL,
        started_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at               TIMESTAMPTZ,
        data_fresh_at             TIMESTAMPTZ,
        expected                  INTEGER NOT NULL DEFAULT 0,
        attempted                 INTEGER NOT NULL DEFAULT 0,
        usable                    INTEGER NOT NULL DEFAULT 0,
        known_no_data             INTEGER NOT NULL DEFAULT 0,
        transient_failures        INTEGER NOT NULL DEFAULT 0,
        degraded                  INTEGER NOT NULL DEFAULT 0,
        provider_coverage         DOUBLE PRECISION,
        usable_coverage           DOUBLE PRECISION,
        baseline_usable           INTEGER,
        error_message             TEXT,
        details                   JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (pipeline, run_id)
    );
    CREATE INDEX IF NOT EXISTS etl_run_manifest_latest_idx
        ON etl_run_manifest (pipeline, started_at DESC);
"""

UPSERT_SQL = """
    INSERT INTO etl_run_manifest (
        pipeline, run_id, run_date, state, started_at, finished_at,
        data_fresh_at, expected, attempted, usable, known_no_data,
        transient_failures, degraded, provider_coverage, usable_coverage,
        baseline_usable, error_message, details
    ) VALUES (
        %(pipeline)s, %(run_id)s, %(run_date)s, %(state)s, NOW(),
        CASE WHEN %(state)s = 'running' THEN NULL ELSE NOW() END,
        CASE WHEN %(state)s IN ('success', 'degraded')
                  AND NOT %(limited_run)s
             THEN NOW() ELSE NULL END,
        %(expected)s, %(attempted)s, %(usable)s, %(known_no_data)s,
        %(transient_failures)s, %(degraded)s, %(provider_coverage)s,
        %(usable_coverage)s, %(baseline_usable)s, %(error_message)s,
        %(details)s::jsonb
    )
    ON CONFLICT (pipeline, run_id) DO UPDATE SET
        state = EXCLUDED.state,
        finished_at = EXCLUDED.finished_at,
        data_fresh_at = COALESCE(EXCLUDED.data_fresh_at,
                                 etl_run_manifest.data_fresh_at),
        expected = EXCLUDED.expected,
        attempted = EXCLUDED.attempted,
        usable = EXCLUDED.usable,
        known_no_data = EXCLUDED.known_no_data,
        transient_failures = EXCLUDED.transient_failures,
        degraded = EXCLUDED.degraded,
        provider_coverage = EXCLUDED.provider_coverage,
        usable_coverage = EXCLUDED.usable_coverage,
        baseline_usable = EXCLUDED.baseline_usable,
        error_message = EXCLUDED.error_message,
        details = EXCLUDED.details;
"""


@dataclass
class RunStats:
    expected: int = 0
    attempted: int = 0
    usable: int = 0
    known_no_data: int = 0
    transient_failures: int = 0
    degraded: int = 0
    details: dict = field(default_factory=dict)


@dataclass(frozen=True)
class RunContext:
    pipeline: str
    run_id: str
    baseline_usable: int | None
    initial_details: dict = field(default_factory=dict)


@dataclass(frozen=True)
class HealthDecision:
    state: str
    provider_coverage: float
    usable_coverage: float
    reason: str | None = None


class CoverageError(RuntimeError):
    """Raised after a failed coverage decision has been persisted."""


def _fraction_env(value, name):
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a decimal between 0 and 1") from exc
    if not 0 <= parsed <= 1:
        raise ValueError(f"{name} must be between 0 and 1")
    return parsed


def threshold_from_env(env, name, default):
    raw = env.get(name)
    return default if raw in (None, "") else _fraction_env(raw, name)


def ticker_limit_from_env(env, name="TICKER_LIMIT"):
    """Parse the canonical nonnegative integer used by limited ETL runs.

    Empty/unset and exactly ``0`` mean a full run. Positive values must use
    ordinary base-10 notation without a sign, whitespace, or leading zeroes.
    """
    raw = env.get(name)
    if raw in (None, ""):
        return 0
    if not isinstance(raw, str) or re.fullmatch(r"(?:0|[1-9][0-9]*)", raw) is None:
        raise ValueError(
            f"{name} must be 0 or a positive base-10 integer without leading zeroes"
        )
    return int(raw)


def evaluate_health(
    stats,
    baseline_usable=None,
    *,
    minimum_provider_coverage=0.90,
    minimum_usable_coverage=0.50,
    minimum_baseline_retention=0.75,
    limited_run=False,
):
    """Classify a run using provider, usable-row, and prior-run coverage.

    ``known_no_data`` is excluded from the usable denominator: a foreign filer
    or a genuinely absent transcript is not a provider failure.  Limited test
    runs still enforce provider/usable coverage but do not compare themselves
    with a full-universe production baseline.
    """
    for label, value in (
        ("minimum_provider_coverage", minimum_provider_coverage),
        ("minimum_usable_coverage", minimum_usable_coverage),
        ("minimum_baseline_retention", minimum_baseline_retention),
    ):
        _fraction_env(value, label)

    expected = max(0, int(stats.expected))
    attempted = max(0, int(stats.attempted))
    usable = max(0, int(stats.usable))
    known_no_data = max(0, int(stats.known_no_data))
    failures = max(0, int(stats.transient_failures))
    eligible = max(0, expected - known_no_data)

    provider_coverage = (
        max(0.0, min(1.0, (attempted - failures) / attempted))
        if attempted else (1.0 if eligible == 0 else 0.0)
    )
    usable_coverage = (
        max(0.0, min(1.0, usable / eligible))
        if eligible else 1.0
    )

    reasons = []
    if expected and usable == 0:
        reasons.append("no usable or confirmed-empty results were produced")
    if eligible and attempted == 0:
        reasons.append("no provider requests completed for an eligible universe")
    if attempted and failures == attempted:
        reasons.append("provider-wide outage: every provider attempt failed")
    if provider_coverage < minimum_provider_coverage:
        reasons.append(
            f"provider coverage {provider_coverage:.1%} is below "
            f"{minimum_provider_coverage:.1%}"
        )
    if usable_coverage < minimum_usable_coverage:
        reasons.append(
            f"usable coverage {usable_coverage:.1%} is below "
            f"{minimum_usable_coverage:.1%}"
        )
    if baseline_usable and not limited_run:
        baseline_floor = math.ceil(baseline_usable * minimum_baseline_retention)
        if usable < baseline_floor:
            reasons.append(
                f"usable count {usable} is below prior-success floor "
                f"{baseline_floor} (baseline {baseline_usable})"
            )

    if reasons:
        return HealthDecision(
            "failure", provider_coverage, usable_coverage, "; ".join(reasons)
        )
    if failures or stats.degraded:
        return HealthDecision("degraded", provider_coverage, usable_coverage)
    return HealthDecision("success", provider_coverage, usable_coverage)


def begin_run(conn, pipeline, expected=0, details=None):
    """Create a running manifest row and return its immutable run context."""
    with conn.cursor() as cur:
        cur.execute(BOOTSTRAP_SQL)
        cur.execute(
            """
            SELECT usable
            FROM etl_run_manifest
            WHERE pipeline = %s AND state = 'success'
              AND COALESCE(details->>'limitedRun', 'false') <> 'true'
              AND COALESCE(details->>'limited_run', 'false') <> 'true'
            ORDER BY data_fresh_at DESC NULLS LAST, started_at DESC
            LIMIT 1
            """,
            (pipeline,),
        )
        row = cur.fetchone()
    baseline = int(row[0]) if row and row[0] is not None else None
    initial_details = dict(details or {})
    ctx = RunContext(pipeline, str(uuid.uuid4()), baseline, initial_details)
    write_run(conn, ctx, "running", RunStats(expected=expected))
    return ctx


def write_run(conn, context, state, stats, decision=None, error=None):
    if state not in {"running", "success", "degraded", "failure"}:
        raise ValueError(f"invalid ETL run state: {state}")
    decision = decision or evaluate_health(
        stats, context.baseline_usable, limited_run=True
    )
    merged_details = {**context.initial_details, **(stats.details or {})}
    limited_run = (
        merged_details.get("limitedRun") is True
        or merged_details.get("limited_run") is True
    )
    params = {
        "pipeline": context.pipeline,
        "run_id": context.run_id,
        "run_date": date.today(),
        "state": state,
        "limited_run": limited_run,
        "expected": int(stats.expected),
        "attempted": int(stats.attempted),
        "usable": int(stats.usable),
        "known_no_data": int(stats.known_no_data),
        "transient_failures": int(stats.transient_failures),
        "degraded": int(stats.degraded),
        "provider_coverage": decision.provider_coverage,
        "usable_coverage": decision.usable_coverage,
        "baseline_usable": context.baseline_usable,
        "error_message": (
            str(error or decision.reason)[:2000]
            if state != "running" and (error or decision.reason)
            else None
        ),
        "details": json.dumps(merged_details, sort_keys=True),
    }
    with conn.cursor() as cur:
        cur.execute(UPSERT_SQL, params)
    conn.commit()


def finish_run(
    conn,
    context,
    stats,
    *,
    minimum_provider_coverage=0.90,
    minimum_usable_coverage=0.50,
    minimum_baseline_retention=0.75,
    limited_run=False,
):
    decision = evaluate_health(
        stats,
        context.baseline_usable,
        minimum_provider_coverage=minimum_provider_coverage,
        minimum_usable_coverage=minimum_usable_coverage,
        minimum_baseline_retention=minimum_baseline_retention,
        limited_run=limited_run,
    )
    write_run(conn, context, decision.state, stats, decision=decision)
    print(
        f"ETL health: pipeline={context.pipeline} state={decision.state} "
        f"provider={decision.provider_coverage:.1%} "
        f"usable={decision.usable_coverage:.1%} "
        f"counts={stats.usable}/{stats.expected}"
    )
    if decision.state == "failure":
        raise CoverageError(f"{context.pipeline} coverage failed: {decision.reason}")
    return decision


def record_failure_safely(conn, context, stats, error):
    """Best-effort failure record that never replaces the primary exception."""
    if not conn or not context:
        return
    try:
        # A SQL error leaves PostgreSQL transactions aborted; clear that state
        # before attempting the manifest UPSERT. Rollback itself is best-effort
        # so failure reporting can never replace the pipeline's primary error.
        try:
            conn.rollback()
        except Exception:
            pass
        decision = HealthDecision(
            "failure",
            max(0.0, min(1.0, (stats.attempted - stats.transient_failures)
                              / stats.attempted)) if stats.attempted else 0.0,
            0.0,
            str(error),
        )
        write_run(conn, context, "failure", stats, decision=decision, error=error)
    except Exception as manifest_error:
        try:
            conn.rollback()
        except Exception:
            pass
        pipeline = getattr(context, "pipeline", "unknown")
        print(f"WARN: could not persist {pipeline} failure manifest: {manifest_error}")
