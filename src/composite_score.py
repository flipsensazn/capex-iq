# composite_score.py
#
# The Composite Bottleneck Score (CBS): one 0-100 number per ticker that
# blends everything the system knows about a node's OWN bottleneck evidence:
#
#   transcript stress   (weight 0.50)  what management SAID on the call
#   XBRL gauge score    (weight 0.35)  what the balance sheet PROVES
#   customer concentration (0.15)      how levered the name is to few buyers
#
# Weights renormalize over the components a ticker actually has — a name with
# only transcript data is scored on that alone, honestly, rather than diluted
# by phantom zeros. Inputs and effective weights are stored per row (JSONB)
# so every score is auditable.
#
# Graph-inherited risk is deliberately NOT in the CBS: it is a property of a
# node's position, not its own evidence, and the dependency graph already
# visualizes it. CBS = intrinsic heat; the graph radiates it.
#
# Runs weekly right after xbrl_gauges.py (same workflow), snapshots to the
# composite_scores table keyed (ticker, as_of_date) so history accumulates,
# and sends a Telegram digest of meaningful movers (Δ ≥ 15 or crossing 70)
# vs the previous snapshot.
#
# Env vars:
#   DATABASE_URL                        required
#   TELEGRAM_BOT_TOKEN / _CHAT_ID       optional (digest skipped if unset)

import hashlib
import json
import os
from datetime import date, datetime, timezone

import psycopg2
import psycopg2.extras

from etl_health import (
    CoverageError,
    RunStats,
    begin_run,
    finish_run,
    record_failure_safely,
)
from transcript_stress import connect_db, send_telegram

DATABASE_URL = os.environ.get("DATABASE_URL")

W_TRANSCRIPT = 0.50
W_GAUGE      = 0.35
W_CONC       = 0.15

TRANSCRIPT_MAX_AGE_DAYS = 365
GAUGE_MAX_AGE_DAYS = 365
CONCENTRATION_MAX_AGE_DAYS = 550
ELIGIBILITY_METHODOLOGY_VERSION = 1

CBS_METHODOLOGY_VERSION = 1
CBS_METHODOLOGY = "cbs-v1"
CBS_METHODOLOGY_SPEC = {
    "version": CBS_METHODOLOGY_VERSION,
    "weights": {
        "transcript": W_TRANSCRIPT,
        "gauge": W_GAUGE,
        "concentration": W_CONC,
    },
    "renormalizeMissingComponents": True,
    "inventoryFallbackCap": 40,
    "concentrationMultiplier": 1.5,
    "eligibility": {
        "version": ELIGIBILITY_METHODOLOGY_VERSION,
        "transcriptMaxAgeDays": TRANSCRIPT_MAX_AGE_DAYS,
        "gaugeMaxAgeDays": GAUGE_MAX_AGE_DAYS,
        "concentrationMaxAgeDays": CONCENTRATION_MAX_AGE_DAYS,
        "excludeDegradedTranscriptHits": True,
    },
}

TRANSCRIPT_SOURCE_METHODOLOGY = "transcript-stress-v1"
TRANSCRIPT_UNVERIFIED_SOURCE_METHODOLOGY = (
    "transcript-stress-v1:unverified-provider"
)
GAUGE_SOURCE_METHODOLOGY = "xbrl-gauges-v2-score-period"
GAUGE_PERIOD_PROVENANCE_METHODOLOGY = "xbrl-gauge-score-period-v1"
GAUGE_UNVERIFIED_SOURCE_METHODOLOGY = "xbrl-gauges-legacy-unverified-period"
CONCENTRATION_SOURCE_METHODOLOGY = "customer-exposure-v2-single-customer-period"

ALERT_DELTA     = 15
BOTTLENECK_LINE = 70


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def stable_signature(value):
    """Deterministic SHA-256 signature for methodology and source vintages."""
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        default=lambda item: item.isoformat()
        if isinstance(item, (date, datetime)) else str(item),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


CBS_METHODOLOGY_SIGNATURE = stable_signature(CBS_METHODOLOGY_SPEC)


def iso_value(value):
    if value is None:
        return None
    return value.isoformat() if isinstance(value, (date, datetime)) else str(value)


def source_provenance(period, available_at, methodology, values, period_end=None):
    """Auditable source identity; availability is separate from content identity."""
    period = iso_value(period)
    period_end = iso_value(period_end)
    available_at = iso_value(available_at)
    provenance = {
        "sourcePeriod": period,
        "sourceAvailableAt": available_at,
        "sourceMethodology": methodology,
        "sourceSignature": stable_signature({
            "period": period,
            "periodEnd": period_end,
            "methodology": methodology,
            "values": values,
        }),
    }
    if period_end:
        provenance["sourcePeriodEnd"] = period_end
    return provenance


def freshness_exclusions(period_end, max_age_days, today=None):
    """Versioned, conservative source-period freshness checks."""
    today = today or date.today()
    if isinstance(period_end, datetime):
        period_end = period_end.date()
    elif isinstance(period_end, str):
        try:
            period_end = date.fromisoformat(period_end[:10])
        except ValueError:
            period_end = None
    if period_end is None:
        return [{"code": "missing_source_period_end"}]
    age_days = (today - period_end).days
    if age_days < -7:
        return [{"code": "future_source_period", "ageDays": age_days}]
    if age_days > max_age_days:
        return [{
            "code": "stale_source_period",
            "ageDays": age_days,
            "maxAgeDays": max_age_days,
        }]
    return []


def verified_gauge_score_period(latest_quarter_end, period_provenance):
    """Return the score-driving period only for the versioned XBRL contract."""
    provenance = period_provenance or {}
    actual_methodology = provenance.get("methodology")
    actual_period_end = provenance.get("scorePeriodEnd")
    expected_period_end = iso_value(latest_quarter_end)
    verified = (
        actual_methodology == GAUGE_PERIOD_PROVENANCE_METHODOLOGY
        and actual_period_end is not None
        and iso_value(actual_period_end) == expected_period_end
    )
    if verified:
        return latest_quarter_end, []
    return None, [{
        "code": "unverified_score_period_provenance",
        "expectedMethodology": GAUGE_PERIOD_PROVENANCE_METHODOLOGY,
        "actualMethodology": actual_methodology,
        "expectedScorePeriodEnd": expected_period_end,
        "actualScorePeriodEnd": iso_value(actual_period_end),
    }]


def transcript_source_methodology(model, provider):
    """Match raw-scoreboard transcript identity across model and provider."""
    provider = str(provider).strip() if provider is not None else ""
    if not provider:
        return TRANSCRIPT_UNVERIFIED_SOURCE_METHODOLOGY
    analysis = f"model:{model}" if model else "lexicon-only"
    return f"{TRANSCRIPT_SOURCE_METHODOLOGY}:{analysis}:provider:{provider}"


def component_part(score, configured_weight, component, **extra):
    reasons = list((component or {}).get("exclusion_reasons") or [])
    if score is None:
        reasons.append({"code": "missing_component_score"})
    eligible = not reasons
    part = {
        "score": score,
        "weight": configured_weight if eligible else 0.0,
        "configuredWeight": configured_weight,
        "eligible": eligible,
        "eligibilityMethodology": CBS_METHODOLOGY,
        "eligibilityMethodologyVersion": ELIGIBILITY_METHODOLOGY_VERSION,
        "exclusionReasons": reasons,
        **extra,
    }
    attach_source(part, component)
    return part


def composite_provenance(parts):
    component_signatures = {
        name: {
            "sourceSignature": part["sourceSignature"],
            "eligible": part.get("eligible", True),
            "exclusionReasons": part.get("exclusionReasons", []),
        }
        for name, part in parts.items()
        if name != "_provenance" and part.get("sourceSignature")
    }
    available = [
        part.get("sourceAvailableAt")
        for name, part in parts.items()
        if name != "_provenance" and part.get("eligible", True)
        and part.get("sourceAvailableAt")
    ]
    source_available_at = max(available) if available else None
    return {
        "methodology": CBS_METHODOLOGY,
        "methodologyVersion": CBS_METHODOLOGY_VERSION,
        "methodologySignature": CBS_METHODOLOGY_SIGNATURE,
        "inputSignature": stable_signature(component_signatures),
        "sourceAvailableAt": source_available_at,
    }


def attach_source(part, component):
    source = (component or {}).get("source") or {}
    for key in (
        "sourcePeriod", "sourcePeriodEnd", "sourceAvailableAt",
        "sourceMethodology", "sourceSignature",
    ):
        if source.get(key) is not None:
            part[key] = source[key]


def included_value(parts, name, key):
    part = parts.get(name) or {}
    return part.get(key) if part.get("eligible", True) else None


def component_health_counts(parts):
    """Separate expected signal absence from degraded/excluded evidence."""
    counts = {"excluded": 0, "degraded": 0, "structuralMissing": 0}
    for name, part in parts.items():
        if name == "_provenance" or part.get("eligible", True):
            continue
        counts["excluded"] += 1
        reasons = part.get("exclusionReasons") or []
        reason_codes = {
            reason.get("code") if isinstance(reason, dict) else None
            for reason in reasons
        }
        if reason_codes and reason_codes <= {"missing_component_score"}:
            counts["structuralMissing"] += 1
        else:
            counts["degraded"] += 1
    return counts


def compute_composite(transcript, gauge, concentration):
    """
    Weighted blend over AVAILABLE components (weights renormalized).
    Inputs are dicts or None:
      transcript:    {"score": 0-100, "direction": str}
      gauge:         {"backlog_score": 0-100 | None, "inventory_days_yoy": float | None}
      concentration: {"top_pct": float}   # % of revenue from largest customer
    Returns (composite | None, parts dict for the audit trail).
    """
    parts, total_w, total = {}, 0.0, 0.0

    if transcript:
        s = (
            clamp(float(transcript["score"]), 0, 100)
            if transcript.get("score") is not None else None
        )
        parts["transcript"] = component_part(
            s, W_TRANSCRIPT, transcript, direction=transcript.get("direction"),
        )
        if parts["transcript"]["eligible"]:
            total += s * W_TRANSCRIPT
            total_w += W_TRANSCRIPT

    g_score = None
    if gauge:
        if gauge.get("backlog_score") is not None:
            g_score = clamp(float(gauge["backlog_score"]), 0, 100)
        elif gauge.get("inventory_days_yoy") is not None and gauge["inventory_days_yoy"] > 0:
            # No RPO disclosure — a sharp inventory build is the only balance-
            # sheet signal available; capped low since it's ambiguous alone.
            g_score = clamp(float(gauge["inventory_days_yoy"]), 0, 40)
    if gauge:
        parts["gauge"] = component_part(g_score, W_GAUGE, gauge)
        if parts["gauge"]["eligible"]:
            total += g_score * W_GAUGE
            total_w += W_GAUGE

    if concentration:
        c = (
            clamp(float(concentration["top_pct"]) * 1.5, 0, 100)
            if concentration.get("top_pct") is not None else None
        )
        parts["concentration"] = component_part(
            c, W_CONC, concentration, top_pct=concentration.get("top_pct"),
        )
        if parts["concentration"]["eligible"]:
            total += c * W_CONC
            total_w += W_CONC

    parts["_provenance"] = composite_provenance(parts)
    if total_w == 0:
        return None, parts
    return round(total / total_w, 1), parts


# ── DATA LOADING ─────────────────────────────────────────

def load_signals(conn):
    """Latest signal per ticker from each source table → {ticker: {...}}."""
    signals = {}

    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ON (ticker)
                   ticker, stress_score, direction, fiscal_year, fiscal_quarter,
                   call_date, analyzed_at, model, provider, lexicon_hits
            FROM transcript_stress
            ORDER BY ticker, fiscal_year DESC, fiscal_quarter DESC
        """)
        for (ticker, score, direction, fiscal_year, fiscal_quarter,
             call_date, analyzed_at, model, provider, lexicon_hits) in cur.fetchall():
            source_methodology = transcript_source_methodology(model, provider)
            exclusions = freshness_exclusions(call_date, TRANSCRIPT_MAX_AGE_DAYS)
            if not provider or not str(provider).strip():
                exclusions.append({"code": "missing_source_provider"})
            if model is None and (lexicon_hits or 0) > 0:
                exclusions.append({
                    "code": "degraded_lexicon_only_with_hits",
                    "lexiconHits": int(lexicon_hits),
                })
            signals.setdefault(ticker, {})["transcript"] = {
                "score": float(score) if score is not None else None,
                "direction": direction,
                "exclusion_reasons": exclusions,
                "source": source_provenance(
                    f"{fiscal_year}Q{fiscal_quarter}",
                    analyzed_at,
                    source_methodology,
                    {
                        "score": float(score) if score is not None else None,
                        "direction": direction,
                        "callDate": call_date,
                        "model": model,
                        "provider": provider,
                    },
                    period_end=call_date,
                ),
            }

        cur.execute("""
            SELECT DISTINCT ON (ticker)
                   ticker, backlog_score, inventory_days_yoy, as_of_date,
                   latest_quarter_end, fetched_at, tags_used,
                   to_jsonb(xbrl_gauges)->'period_provenance'
                       AS period_provenance
            FROM xbrl_gauges
            ORDER BY ticker, latest_quarter_end DESC NULLS LAST,
                     as_of_date DESC
        """)
        for (ticker, backlog, inv_yoy, as_of_date, latest_quarter_end,
             fetched_at, tags_used, period_provenance) in cur.fetchall():
            period_provenance = period_provenance or {}
            score_available = (
                backlog is not None
                or (inv_yoy is not None and float(inv_yoy) > 0)
            )
            verified_period_end, provenance_exclusions = verified_gauge_score_period(
                latest_quarter_end, period_provenance,
            )
            verified_period = not provenance_exclusions
            gauge_exclusions = (
                freshness_exclusions(verified_period_end, GAUGE_MAX_AGE_DAYS)
                if verified_period else []
            )
            if score_available and not verified_period:
                gauge_exclusions.extend(provenance_exclusions)
            if not score_available:
                for exclusion in period_provenance.get("exclusions") or []:
                    gauge_exclusions.append({
                        **(exclusion if isinstance(exclusion, dict) else {}),
                        "code": "source_metric_period_misaligned",
                    })
            signals.setdefault(ticker, {})["gauge"] = {
                "backlog_score": float(backlog) if backlog is not None else None,
                "inventory_days_yoy": float(inv_yoy) if inv_yoy is not None else None,
                "exclusion_reasons": gauge_exclusions,
                "source": source_provenance(
                    verified_period_end or as_of_date,
                    fetched_at,
                    (
                        GAUGE_SOURCE_METHODOLOGY
                        if verified_period
                        else GAUGE_UNVERIFIED_SOURCE_METHODOLOGY
                    ),
                    {
                        "backlogScore": float(backlog) if backlog is not None else None,
                        "inventoryDaysYoy": float(inv_yoy) if inv_yoy is not None else None,
                        "tagsUsed": tags_used,
                        "periodProvenance": period_provenance,
                    },
                    period_end=verified_period_end,
                ),
            }

        cur.execute("""
            WITH eligible AS (
                SELECT ticker, pct, customer_label, period, filed, extracted_at,
                       source_form,
                       NULLIF(to_jsonb(customer_exposure)->>'period_end', '')::date
                           AS period_end,
                       NULLIF(to_jsonb(customer_exposure)->>'source_accession', '')
                           AS source_accession
                FROM customer_exposure
                WHERE basis = 'revenue'
                  AND COALESCE(
                      to_jsonb(customer_exposure)->>'statement_type',
                      'unclassified'
                  ) = 'single_customer'
                  AND NULLIF(
                      to_jsonb(customer_exposure)->>'period_end', ''
                  ) IS NOT NULL
            ), latest_vintage AS (
                SELECT DISTINCT ON (ticker)
                       ticker, period_end, filed, source_accession
                FROM eligible
                ORDER BY ticker, period_end DESC, filed DESC NULLS LAST,
                         source_accession DESC NULLS LAST
            )
            SELECT DISTINCT ON (e.ticker)
                   e.ticker, e.pct, e.customer_label, e.period, e.period_end,
                   e.filed, e.extracted_at, e.source_form, e.source_accession
            FROM eligible e
            JOIN latest_vintage v
              ON v.ticker = e.ticker
             AND v.period_end = e.period_end
             AND v.filed IS NOT DISTINCT FROM e.filed
             AND v.source_accession IS NOT DISTINCT FROM e.source_accession
            ORDER BY e.ticker, e.pct DESC, e.customer_label
        """)
        for (ticker, top_pct, customer_label, period, period_end, filed,
             extracted_at, source_form, source_accession) in cur.fetchall():
            signals.setdefault(ticker, {})["concentration"] = {
                "top_pct": float(top_pct) if top_pct is not None else None,
                "exclusion_reasons": freshness_exclusions(
                    period_end, CONCENTRATION_MAX_AGE_DAYS,
                ),
                "source": source_provenance(
                    period_end or period or filed,
                    extracted_at,
                    CONCENTRATION_SOURCE_METHODOLOGY,
                    {
                        "topPct": float(top_pct) if top_pct is not None else None,
                        "customerLabel": customer_label,
                        "filed": filed,
                        "sourceForm": source_form,
                        "sourceAccession": source_accession,
                    },
                    period_end=period_end,
                ),
            }

    return signals


def load_previous(conn):
    """Latest pre-write alert baseline, including an existing row for today."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT ON (ticker)
                   ticker, composite, components,
                   NULLIF(
                       to_jsonb(composite_scores)->>'methodology_signature', ''
                   ) AS methodology_signature,
                   NULLIF(
                       to_jsonb(composite_scores)->>'input_signature', ''
                   ) AS input_signature,
                   computed_at
            FROM composite_scores
            WHERE as_of_date <= %s
            ORDER BY ticker, as_of_date DESC
        """, (date.today(),))
        return {
            ticker: {
                "score": float(score) if score is not None else None,
                "components": components or {},
                "methodologySignature": methodology_signature,
                "inputSignature": input_signature,
                "computedAt": computed_at,
            }
            for (ticker, score, components, methodology_signature,
                 input_signature, computed_at) in cur.fetchall()
        }


# ── DATABASE ─────────────────────────────────────────────

BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS composite_scores (
        ticker               TEXT NOT NULL,
        as_of_date           DATE NOT NULL,
        composite            DOUBLE PRECISION,
        transcript_score     DOUBLE PRECISION,
        transcript_direction TEXT,
        gauge_score          DOUBLE PRECISION,
        concentration_score  DOUBLE PRECISION,
        components           JSONB,
        methodology_version  INTEGER,
        methodology_signature TEXT,
        input_signature       TEXT,
        source_available_at   TIMESTAMPTZ,
        computed_at          TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (ticker, as_of_date)
    );
"""

MIGRATION_SQL = """
    ALTER TABLE composite_scores
        ADD COLUMN IF NOT EXISTS methodology_version INTEGER,
        ADD COLUMN IF NOT EXISTS methodology_signature TEXT,
        ADD COLUMN IF NOT EXISTS input_signature TEXT,
        ADD COLUMN IF NOT EXISTS source_available_at TIMESTAMPTZ;
"""

UPSERT_SQL = """
    INSERT INTO composite_scores
        (ticker, as_of_date, composite, transcript_score, transcript_direction,
         gauge_score, concentration_score, components, methodology_version,
         methodology_signature, input_signature, source_available_at)
    VALUES %s
    ON CONFLICT (ticker, as_of_date) DO UPDATE SET
        composite            = EXCLUDED.composite,
        transcript_score     = EXCLUDED.transcript_score,
        transcript_direction = EXCLUDED.transcript_direction,
        gauge_score          = EXCLUDED.gauge_score,
        concentration_score  = EXCLUDED.concentration_score,
        components           = EXCLUDED.components,
        methodology_version  = EXCLUDED.methodology_version,
        methodology_signature = EXCLUDED.methodology_signature,
        input_signature      = EXCLUDED.input_signature,
        source_available_at  = EXCLUDED.source_available_at,
        computed_at          = now()
    WHERE composite_scores.methodology_signature IS NOT DISTINCT FROM
              EXCLUDED.methodology_signature
      AND composite_scores.input_signature IS NOT DISTINCT FROM
              EXCLUDED.input_signature
    RETURNING ticker, composite, components, methodology_signature,
              input_signature, source_available_at, computed_at;
"""


def persist_composite_rows(conn, rows):
    """Persist candidates and return only rows actually inserted or updated."""
    if not rows:
        return []
    with conn.cursor() as cur:
        persisted = psycopg2.extras.execute_values(
            cur, UPSERT_SQL, rows, page_size=200, fetch=True,
        )
    conn.commit()
    return persisted or []


def current_from_persisted_rows(rows):
    """Build mover inputs exclusively from committed UPSERT results."""
    current = {}
    for (ticker, score, components, methodology_signature, input_signature,
         source_available_at, computed_at) in rows:
        current[ticker] = {
            "score": float(score) if score is not None else None,
            "components": components or {},
            "methodologySignature": methodology_signature,
            "inputSignature": input_signature,
            "sourceAvailableAt": source_available_at,
            "computedAt": computed_at,
        }
    return current


def persisted_health_summary(current):
    """Summarize health only from rows confirmed durable by PostgreSQL."""
    summary = {
        "scoredRows": 0,
        "noEligibleScoreTickers": 0,
        "excludedComponents": 0,
        "degradedComponents": 0,
        "structuralMissingComponents": 0,
        "tickersWithExcludedComponents": 0,
        "tickersWithDegradedComponents": 0,
    }
    for entry in current.values():
        counts = component_health_counts(entry.get("components") or {})
        summary["scoredRows"] += int(entry.get("score") is not None)
        summary["noEligibleScoreTickers"] += int(entry.get("score") is None)
        summary["excludedComponents"] += counts["excluded"]
        summary["degradedComponents"] += counts["degraded"]
        summary["structuralMissingComponents"] += counts["structuralMissing"]
        summary["tickersWithExcludedComponents"] += int(counts["excluded"] > 0)
        summary["tickersWithDegradedComponents"] += int(counts["degraded"] > 0)
    return summary


def _emoji(score):
    if score >= 70: return "🔴"
    if score >= 40: return "🟠"
    if score >= 15: return "🔵"
    return "🟢"


def parsed_timestamp(value):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def mover_input_vintage_advanced(previous, current):
    if (
        not previous.get("methodologySignature")
        or previous["methodologySignature"] != current.get("methodologySignature")
        or not previous.get("inputSignature")
        or previous["inputSignature"] == current.get("inputSignature")
    ):
        return False

    previous_parts = previous.get("components") or {}
    current_parts = current.get("components") or {}
    previous_component_keys = {
        name for name in ("transcript", "gauge", "concentration")
        if isinstance(previous_parts.get(name), dict)
    }
    current_component_keys = {
        name for name in ("transcript", "gauge", "concentration")
        if isinstance(current_parts.get(name), dict)
    }
    if previous_component_keys != current_component_keys:
        return False
    previous_computed = parsed_timestamp(previous.get("computedAt"))

    # A component-method rollout is a baseline for the entire CBS snapshot,
    # even when some other component also happened to advance in this run.
    for name in set(previous_parts) & set(current_parts):
        if name == "_provenance":
            continue
        previous_part = previous_parts.get(name) or {}
        current_part = current_parts.get(name) or {}
        previous_method = previous_part.get("sourceMethodology")
        current_method = current_part.get("sourceMethodology")
        if not previous_method or previous_method != current_method:
            return False
        previous_eligible = previous_part.get("eligible", True)
        current_eligible = current_part.get("eligible", True)
        if previous_eligible != current_eligible:
            return False
        if not previous_eligible:
            continue
        previous_period_end = parsed_timestamp(previous_part.get("sourcePeriodEnd"))
        current_period_end = parsed_timestamp(current_part.get("sourcePeriodEnd"))
        if (
            previous_period_end is None
            or current_period_end is None
            or current_period_end < previous_period_end
        ):
            return False

    for name in ("transcript", "gauge", "concentration"):
        current_part = current_parts.get(name) or {}
        if not current_part.get("eligible", True):
            continue
        current_signature = current_part.get("sourceSignature")
        current_available = parsed_timestamp(current_part.get("sourceAvailableAt"))
        if not current_signature or current_available is None:
            continue

        previous_part = previous_parts.get(name)
        if not previous_part:
            if previous_computed is not None and current_available > previous_computed:
                return True
            continue
        previous_period_end = parsed_timestamp(previous_part.get("sourcePeriodEnd"))
        current_period_end = parsed_timestamp(current_part.get("sourcePeriodEnd"))
        if (
            not previous_part.get("eligible", True)
            or previous_period_end is None
            or current_period_end is None
            or current_period_end < previous_period_end
        ):
            continue
        previous_available = parsed_timestamp(previous_part.get("sourceAvailableAt"))
        if (
            previous_part.get("sourceSignature")
            and previous_part["sourceSignature"] != current_signature
            and previous_available is not None
            and current_available > previous_available
        ):
            return True
    return False


def build_movers_digest(previous, current):
    """Telegram blocks for meaningful CBS moves, hottest first."""
    blocks = []
    for ticker, current_entry in current.items():
        provenance_aware = isinstance(current_entry, dict)
        comp = current_entry.get("score") if provenance_aware else current_entry
        if comp is None:
            continue
        previous_entry = previous.get(ticker)
        if provenance_aware:
            if not isinstance(previous_entry, dict):
                continue
            # A null snapshot is an explicit unavailable-data baseline. Never
            # bridge an alert across it or treat recovery as a brand-new mover.
            if previous_entry.get("score") is None:
                continue
            if not mover_input_vintage_advanced(previous_entry, current_entry):
                continue
            old = previous_entry.get("score")
        else:
            old = previous_entry
        if old is None:
            if comp < BOTTLENECK_LINE:
                continue  # brand-new score only alerts if already red-hot
            line = f"{_emoji(comp)} *{ticker}*  — → {comp:.0f}  (new)"
        else:
            delta = comp - old
            crossed = (old < BOTTLENECK_LINE <= comp) or (comp < BOTTLENECK_LINE <= old)
            if abs(delta) < ALERT_DELTA and not crossed:
                continue
            sign = "+" if delta >= 0 else ""
            line = f"{_emoji(comp)} *{ticker}*  {old:.0f} → {comp:.0f}  ({sign}{delta:.0f})"
        blocks.append((comp, line))
    blocks.sort(key=lambda x: -x[0])
    return [b for _, b in blocks]


# ── MAIN ─────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Composite Bottleneck Score ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")

    conn = connect_db(DATABASE_URL)
    run_context = None
    run_stats = RunStats()
    try:
        run_context = begin_run(
            conn, "composite_score",
            details={
                "methodology": CBS_METHODOLOGY,
                "methodologySignature": CBS_METHODOLOGY_SIGNATURE,
            },
        )
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
            cur.execute(MIGRATION_SQL)
        conn.commit()

        signals = load_signals(conn)
        run_stats.expected = len(signals)
        run_stats.attempted = len(signals)
        previous = load_previous(conn)
        print(f"{len(signals)} tickers with signals · {len(previous)} prior snapshots")

        today = date.today()
        rows = []
        for ticker, s in sorted(signals.items()):
            composite, parts = compute_composite(
                s.get("transcript"), s.get("gauge"), s.get("concentration"))
            provenance = parts["_provenance"]
            rows.append((
                ticker, today, composite,
                included_value(parts, "transcript", "score"),
                included_value(parts, "transcript", "direction"),
                included_value(parts, "gauge", "score"),
                included_value(parts, "concentration", "score"),
                psycopg2.extras.Json(parts),
                provenance["methodologyVersion"],
                provenance["methodologySignature"],
                provenance["inputSignature"],
                provenance["sourceAvailableAt"],
            ))

        persisted_rows = persist_composite_rows(conn, rows)
        current = current_from_persisted_rows(persisted_rows)
        summary = persisted_health_summary(current)
        same_day_conflicts = len(rows) - len(persisted_rows)
        print(
            f"{len(persisted_rows)}/{len(rows)} composite scores snapshotted "
            f"for {today}."
        )
        if same_day_conflicts:
            print(
                f"{same_day_conflicts} changed-signature same-day snapshot(s) "
                "retained their first durable value."
            )
        run_stats.usable = summary["scoredRows"]
        run_stats.known_no_data = summary["noEligibleScoreTickers"]
        run_stats.degraded = summary["degradedComponents"] + same_day_conflicts
        run_stats.details.update({
            "methodology": CBS_METHODOLOGY,
            "methodologySignature": CBS_METHODOLOGY_SIGNATURE,
            "rowsAttempted": len(rows),
            "rowsWritten": len(persisted_rows),
            "sameDaySignatureConflicts": same_day_conflicts,
            **summary,
        })

        movers = build_movers_digest(previous, current)
        if movers and previous:
            print(f"{len(movers)} CBS mover(s) — sending Telegram digest.")
            header = (f"⬢ *Composite Bottleneck Score — {len(movers)} "
                      f"mover{'s' if len(movers) != 1 else ''}*\n"
                      f"_week of {today.isoformat()}_")
            send_telegram(header + "\n\n" + "\n".join(movers))
        elif not previous:
            print("First snapshot — baseline recorded, no digest.")
        else:
            print("No meaningful CBS moves — no digest sent.")
        finish_run(conn, run_context, run_stats)
    except CoverageError:
        raise
    except Exception as error:
        try:
            conn.rollback()
        except Exception:
            pass
        run_stats.transient_failures = 1
        record_failure_safely(conn, run_context, run_stats, error)
        raise
    finally:
        conn.close()

    print("=== Composite Bottleneck Score complete ===")
