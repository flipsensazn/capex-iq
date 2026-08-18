import inspect
import sys
import types
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    sys.modules["requests"] = types.ModuleType("requests")

try:
    import psycopg2.extras  # noqa: F401
except ModuleNotFoundError:
    psycopg2_stub = types.ModuleType("psycopg2")
    psycopg2_stub.__path__ = []
    extras_stub = types.ModuleType("psycopg2.extras")
    extras_stub.Json = lambda value: value
    extras_stub.execute_values = lambda *args, **kwargs: None
    psycopg2_stub.extras = extras_stub
    sys.modules["psycopg2"] = psycopg2_stub
    sys.modules["psycopg2.extras"] = extras_stub

import composite_score
import signal_scoreboard as scoreboard
from etl_health import evaluate_health


def component(
    signature,
    available_at,
    methodology="transcript-stress-v1:model",
    *,
    eligible=True,
    period_end="2026-06-30",
):
    return {
        "score": 50.0,
        "eligible": eligible,
        "sourcePeriod": "2026Q2",
        "sourcePeriodEnd": period_end,
        "sourceAvailableAt": available_at,
        "sourceMethodology": methodology,
        "sourceSignature": signature,
    }


def cbs_row(
    when,
    score,
    input_signature,
    source_signature,
    source_available_at,
    *,
    methodology_signature="cbs-method-1",
    source_methodology="transcript-stress-v1:model",
    source_period_end="2026-06-30",
):
    return {
        "date": when,
        "score": score,
        "components": {
            "transcript": component(
                source_signature, source_available_at, source_methodology,
                period_end=source_period_end,
            ),
        },
        "methodology_signature": methodology_signature,
        "input_signature": input_signature,
        "source_available_at": source_available_at,
        "computed_at": datetime.combine(
            when, datetime.min.time(), tzinfo=timezone.utc,
        ).replace(hour=18),
    }


def mover_entry(
    score,
    input_signature,
    source_signature,
    source_available_at,
    *,
    methodology_signature="cbs-method-1",
    source_methodology="transcript-stress-v1:model",
    source_period_end="2026-06-30",
    computed_at="2026-08-17T18:00:00+00:00",
):
    return {
        "score": score,
        "components": {
            "transcript": component(
                source_signature, source_available_at, source_methodology,
                period_end=source_period_end,
            ),
        },
        "methodologySignature": methodology_signature,
        "inputSignature": input_signature,
        "sourceAvailableAt": source_available_at,
        "computedAt": computed_at,
    }


class CbsProvenanceRegressionTests(unittest.TestCase):
    def test_component_signature_ignores_identical_refetch_time(self):
        first = composite_score.source_provenance(
            "2026Q2", "2026-08-17T12:00:00+00:00", "source-v1",
            {"score": 72.0},
        )
        refetch = composite_score.source_provenance(
            "2026Q2", "2026-08-24T12:00:00+00:00", "source-v1",
            {"score": 72.0},
        )

        self.assertEqual(first["sourceSignature"], refetch["sourceSignature"])
        self.assertNotEqual(first["sourceAvailableAt"], refetch["sourceAvailableAt"])

    def test_composite_persists_component_and_methodology_provenance(self):
        source = composite_score.source_provenance(
            "2026Q2", "2026-08-17T12:00:00+00:00", "transcript-v1",
            {"score": 75.0, "direction": "constrained_supplier"},
        )
        score, parts = composite_score.compute_composite(
            {"score": 75.0, "direction": "constrained_supplier", "source": source},
            None,
            None,
        )

        self.assertEqual(score, 75.0)
        self.assertEqual(parts["transcript"]["sourcePeriod"], "2026Q2")
        self.assertEqual(
            parts["transcript"]["sourceSignature"], source["sourceSignature"],
        )
        provenance = parts["_provenance"]
        self.assertEqual(
            provenance["methodologySignature"],
            composite_score.CBS_METHODOLOGY_SIGNATURE,
        )
        self.assertEqual(
            provenance["sourceAvailableAt"], "2026-08-17T12:00:00+00:00",
        )

    def test_signal_loader_uses_safe_latest_customer_vintage(self):
        fetched_at = datetime(2026, 8, 17, 12, tzinfo=timezone.utc)
        result_sets = [
            [(
                "TEST", 75.0, "constrained_supplier", 2026, 2,
                date(2026, 8, 1), fetched_at, "gemini-2.5-flash",
                "defeatbeta", 0,
            )],
            [(
                "TEST", 60.0, 10.0, date(2026, 8, 17),
                date(2026, 6, 30), fetched_at, {"revenue": "Revenues"},
                {
                    "methodology": "xbrl-gauge-score-period-v1",
                    "scoreDriver": "backlog",
                    "scorePeriodEnd": "2026-06-30",
                },
            )],
            [(
                "TEST", 38.0, "Named Customer", "six months ended June 2026",
                date(2026, 6, 30), date(2026, 8, 5), fetched_at, "10-Q",
                "000000-26-000001",
            )],
        ]
        queries = []

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, sql, *_args):
                queries.append(sql)

            def fetchall(self):
                return result_sets.pop(0)

        class Connection:
            def cursor(self):
                return Cursor()

        signals = composite_score.load_signals(Connection())

        concentration = signals["TEST"]["concentration"]
        self.assertEqual(concentration["top_pct"], 38.0)
        self.assertEqual(concentration["source"]["sourcePeriod"], "2026-06-30")
        customer_sql = queries[-1]
        self.assertIn("statement_type", customer_sql)
        self.assertIn("= 'single_customer'", customer_sql)
        self.assertIn("latest_vintage", customer_sql)
        self.assertIn("period_end DESC", customer_sql)
        self.assertLess(
            customer_sql.index("period_end DESC"),
            customer_sql.rindex("e.pct DESC"),
        )
        gauge_sql = queries[1]
        self.assertIn(
            "latest_quarter_end DESC NULLS LAST", gauge_sql,
        )
        self.assertLess(
            gauge_sql.index("latest_quarter_end DESC NULLS LAST"),
            gauge_sql.index("as_of_date DESC"),
        )
        self.assertEqual(
            signals["TEST"]["gauge"]["source"]["sourcePeriodEnd"],
            "2026-06-30",
        )
        self.assertEqual(
            signals["TEST"]["gauge"]["source"]["sourceMethodology"],
            "xbrl-gauges-v2-score-period",
        )
        self.assertIn("provider", queries[0])
        self.assertEqual(
            signals["TEST"]["transcript"]["source"]["sourceMethodology"],
            "transcript-stress-v1:model:gemini-2.5-flash:provider:defeatbeta",
        )

    def test_legacy_or_mismatched_scored_gauge_fails_closed(self):
        fetched_at = datetime(2026, 8, 17, 12, tzinfo=timezone.utc)
        result_sets = [
            [],
            [
                (
                    "LEGACY", 60.0, 10.0, date(2026, 8, 17),
                    date(2026, 6, 30), fetched_at, {}, None,
                ),
                (
                    "MISMATCH", 60.0, 10.0, date(2026, 8, 17),
                    date(2026, 6, 30), fetched_at, {},
                    {
                        "methodology": "xbrl-gauge-score-period-v1",
                        "scorePeriodEnd": "2026-03-31",
                    },
                ),
                (
                    "WRONGMETHOD", 60.0, 10.0, date(2026, 8, 17),
                    date(2026, 6, 30), fetched_at, {},
                    {
                        "methodology": "xbrl-gauge-score-period-v0",
                        "scorePeriodEnd": "2026-06-30",
                    },
                ),
            ],
            [],
        ]

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, *_args):
                return None

            def fetchall(self):
                return result_sets.pop(0)

        class Connection:
            def cursor(self):
                return Cursor()

        signals = composite_score.load_signals(Connection())

        for ticker in ("LEGACY", "MISMATCH", "WRONGMETHOD"):
            with self.subTest(ticker=ticker):
                gauge = signals[ticker]["gauge"]
                self.assertEqual(
                    {reason["code"] for reason in gauge["exclusion_reasons"]},
                    {"unverified_score_period_provenance"},
                )
                self.assertEqual(
                    gauge["source"]["sourceMethodology"],
                    "xbrl-gauges-legacy-unverified-period",
                )
                self.assertNotIn("sourcePeriodEnd", gauge["source"])
                score, parts = composite_score.compute_composite(None, gauge, None)
                self.assertIsNone(score)
                self.assertFalse(parts["gauge"]["eligible"])

    def test_stale_degraded_transcript_is_audited_but_excluded(self):
        analyzed_at = datetime(2026, 8, 17, 12, tzinfo=timezone.utc)
        result_sets = [
            [(
                "STALE", 40.0, None, 2024, 1, date(2024, 4, 30),
                analyzed_at, None, "defeatbeta", 3,
            )],
            [],
            [],
        ]

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, *_args):
                return None

            def fetchall(self):
                return result_sets.pop(0)

        class Connection:
            def cursor(self):
                return Cursor()

        transcript = composite_score.load_signals(Connection())["STALE"]["transcript"]
        reason_codes = {
            reason["code"] for reason in transcript["exclusion_reasons"]
        }
        self.assertEqual(
            reason_codes,
            {"stale_source_period", "degraded_lexicon_only_with_hits"},
        )

        score, parts = composite_score.compute_composite(transcript, None, None)
        self.assertIsNone(score)
        self.assertFalse(parts["transcript"]["eligible"])
        self.assertEqual(parts["transcript"]["weight"], 0.0)
        self.assertIn("_provenance", parts)
        self.assertIsNone(
            composite_score.included_value(parts, "transcript", "score"),
        )

    def test_missing_transcript_provider_fails_closed(self):
        analyzed_at = datetime(2026, 8, 17, 12, tzinfo=timezone.utc)
        result_sets = [
            [(
                "LEGACY", 75.0, "constrained_supplier", 2026, 2,
                date(2026, 8, 1), analyzed_at, "gemini-2.5-flash", None, 3,
            )],
            [],
            [],
        ]

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, *_args):
                return None

            def fetchall(self):
                return result_sets.pop(0)

        class Connection:
            def cursor(self):
                return Cursor()

        transcript = composite_score.load_signals(Connection())["LEGACY"]["transcript"]
        self.assertEqual(
            transcript["source"]["sourceMethodology"],
            "transcript-stress-v1:unverified-provider",
        )
        self.assertIn(
            "missing_source_provider",
            {reason["code"] for reason in transcript["exclusion_reasons"]},
        )
        score, parts = composite_score.compute_composite(transcript, None, None)
        self.assertIsNone(score)
        self.assertFalse(parts["transcript"]["eligible"])

    def test_transcript_provider_transition_baselines_cbs_and_mover(self):
        provider_a = composite_score.transcript_source_methodology(
            "gemini-2.5-flash", "provider-a",
        )
        provider_b = composite_score.transcript_source_methodology(
            "gemini-2.5-flash", "provider-b",
        )
        previous = cbs_row(
            date(2026, 8, 17), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
            source_methodology=provider_a,
        )
        current = cbs_row(
            date(2026, 8, 24), 80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_methodology=provider_b,
        )
        previous_mover = mover_entry(
            50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
            source_methodology=provider_a,
        )
        current_mover = mover_entry(
            80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_methodology=provider_b,
        )

        self.assertNotEqual(provider_a, provider_b)
        self.assertEqual(scoreboard.find_cbs_events([previous, current]), [])
        self.assertFalse(
            composite_score.mover_input_vintage_advanced(
                previous_mover, current_mover,
            ),
        )
        self.assertEqual(
            composite_score.build_movers_digest(
                {"TEST": previous_mover}, {"TEST": current_mover},
            ),
            [],
        )

    def test_fresh_zero_hit_lexicon_row_remains_eligible(self):
        source = composite_score.source_provenance(
            "2026Q2", "2026-08-17T12:00:00+00:00",
            "transcript-stress-v1:lexicon-only", {"score": 0.0},
            period_end=date(2026, 8, 1),
        )
        score, parts = composite_score.compute_composite(
            {
                "score": 0.0,
                "direction": None,
                "exclusion_reasons": [],
                "source": source,
            },
            None,
            None,
        )

        self.assertEqual(score, 0.0)
        self.assertTrue(parts["transcript"]["eligible"])

    def test_expected_no_score_gauge_is_audited_without_degrading_run(self):
        transcript_source = composite_score.source_provenance(
            "2026Q2", "2026-08-17T12:00:00+00:00", "transcript-v1",
            {"score": 75.0}, period_end=date(2026, 6, 30),
        )
        gauge_source = composite_score.source_provenance(
            "2026Q2", "2026-08-17T12:00:00+00:00",
            "xbrl-gauges-v2-score-period",
            {"backlogScore": None, "inventoryDaysYoy": -2.0},
            period_end=date(2026, 6, 30),
        )

        score, parts = composite_score.compute_composite(
            {"score": 75.0, "source": transcript_source},
            {
                "backlog_score": None,
                "inventory_days_yoy": -2.0,
                "exclusion_reasons": [],
                "source": gauge_source,
            },
            None,
        )
        counts = composite_score.component_health_counts(parts)
        run_stats = composite_score.RunStats(
            expected=1, attempted=1, usable=1,
            degraded=counts["degraded"],
        )

        self.assertEqual(score, 75.0)
        self.assertFalse(parts["gauge"]["eligible"])
        self.assertEqual(
            parts["gauge"]["exclusionReasons"],
            [{"code": "missing_component_score"}],
        )
        self.assertEqual(counts, {
            "excluded": 1, "degraded": 0, "structuralMissing": 1,
        })
        self.assertEqual(evaluate_health(run_stats).state, "success")

    def test_same_methodology_and_newer_input_can_fire_cross_and_jump(self):
        baseline = cbs_row(
            date(2026, 8, 17), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
        )
        unchanged_recompute = cbs_row(
            date(2026, 8, 24), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
        )
        advanced = cbs_row(
            date(2026, 8, 31), 75.0, "input-b", "source-b",
            "2026-08-30T12:00:00+00:00",
        )

        events = scoreboard.find_cbs_events([
            baseline, unchanged_recompute, advanced,
        ])

        self.assertEqual(
            [event["event_type"] for event in events],
            ["cbs_cross_70", "cbs_jump_15"],
        )
        self.assertEqual(events[0]["advancedComponents"], ["transcript"])
        self.assertEqual(events[1]["jump"], 25.0)

    def test_rollout_and_methodology_changes_establish_baselines(self):
        legacy = cbs_row(
            date(2026, 8, 10), 50.0, None, "legacy",
            "2026-08-10T12:00:00+00:00", methodology_signature=None,
        )
        rollout = cbs_row(
            date(2026, 8, 17), 80.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
        )
        changed_method = cbs_row(
            date(2026, 8, 24), 95.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            methodology_signature="cbs-method-2",
        )

        self.assertEqual(
            scoreboard.find_cbs_events([legacy, rollout, changed_method]), [],
        )

    def test_source_methodology_change_cannot_manufacture_event(self):
        baseline = cbs_row(
            date(2026, 8, 17), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
        )
        rescored = cbs_row(
            date(2026, 8, 24), 80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_methodology="transcript-stress-v2:model",
        )

        self.assertEqual(scoreboard.find_cbs_events([baseline, rescored]), [])

    def test_later_fetch_of_older_period_cannot_fire_scoreboard_event(self):
        baseline = cbs_row(
            date(2026, 8, 17), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
            source_period_end="2026-06-30",
        )
        regressed = cbs_row(
            date(2026, 8, 24), 80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_period_end="2026-03-31",
        )

        self.assertEqual(
            scoreboard.advanced_component_vintages(baseline, regressed), [],
        )
        self.assertEqual(scoreboard.find_cbs_events([baseline, regressed]), [])

    def test_missing_to_valid_period_establishes_scoreboard_and_mover_baseline(self):
        baseline = cbs_row(
            date(2026, 8, 17), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
            source_period_end=None,
        )
        advanced = cbs_row(
            date(2026, 8, 24), 80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_period_end="2026-06-30",
        )

        self.assertEqual(
            scoreboard.advanced_component_vintages(baseline, advanced), [],
        )
        self.assertEqual(scoreboard.find_cbs_events([baseline, advanced]), [])

        previous_mover = mover_entry(
            50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
            source_period_end=None,
        )
        current_mover = mover_entry(
            80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_period_end="2026-06-30",
        )
        self.assertFalse(
            composite_score.mover_input_vintage_advanced(
                previous_mover, current_mover,
            ),
        )
        self.assertEqual(
            composite_score.build_movers_digest(
                {"TEST": previous_mover}, {"TEST": current_mover},
            ),
            [],
        )

    def test_excluded_component_recovery_establishes_component_baseline(self):
        excluded = cbs_row(
            date(2026, 8, 17), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
            source_period_end=None,
        )
        excluded["components"]["transcript"]["eligible"] = False
        recovered = cbs_row(
            date(2026, 8, 24), 80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_period_end="2026-06-30",
        )

        self.assertEqual(
            scoreboard.advanced_component_vintages(excluded, recovered), [],
        )
        self.assertEqual(scoreboard.find_cbs_events([excluded, recovered]), [])

        excluded_mover = mover_entry(
            50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
            source_period_end=None,
        )
        excluded_mover["components"]["transcript"]["eligible"] = False
        recovered_mover = mover_entry(
            80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_period_end="2026-06-30",
        )

        self.assertFalse(
            composite_score.mover_input_vintage_advanced(
                excluded_mover, recovered_mover,
            ),
        )
        self.assertEqual(
            composite_score.build_movers_digest(
                {"TEST": excluded_mover}, {"TEST": recovered_mover},
            ),
            [],
        )

    def test_eligibility_transition_baselines_other_advancing_component(self):
        for previous_eligible, current_eligible in ((True, False), (False, True)):
            with self.subTest(
                previous_eligible=previous_eligible,
                current_eligible=current_eligible,
            ):
                previous = cbs_row(
                    date(2026, 8, 17), 50.0, "input-a", "transcript-a",
                    "2026-08-17T12:00:00+00:00",
                )
                current = cbs_row(
                    date(2026, 8, 24), 80.0, "input-b", "transcript-b",
                    "2026-08-24T12:00:00+00:00",
                )
                previous["components"]["transcript"]["eligible"] = previous_eligible
                current["components"]["transcript"]["eligible"] = current_eligible
                previous["components"]["gauge"] = component(
                    "gauge-a", "2026-08-17T12:00:00+00:00", "gauge-v1",
                )
                current["components"]["gauge"] = component(
                    "gauge-b", "2026-08-24T12:00:00+00:00", "gauge-v1",
                )

                self.assertEqual(
                    scoreboard.advanced_component_vintages(previous, current),
                    [],
                )
                self.assertEqual(
                    scoreboard.find_cbs_events([previous, current]),
                    [],
                )

                previous_mover = mover_entry(
                    50.0, "input-a", "transcript-a",
                    "2026-08-17T12:00:00+00:00",
                )
                current_mover = mover_entry(
                    80.0, "input-b", "transcript-b",
                    "2026-08-24T12:00:00+00:00",
                )
                previous_mover["components"]["transcript"]["eligible"] = (
                    previous_eligible
                )
                current_mover["components"]["transcript"]["eligible"] = (
                    current_eligible
                )
                previous_mover["components"]["gauge"] = component(
                    "gauge-a", "2026-08-17T12:00:00+00:00", "gauge-v1",
                )
                current_mover["components"]["gauge"] = component(
                    "gauge-b", "2026-08-24T12:00:00+00:00", "gauge-v1",
                )

                self.assertFalse(
                    composite_score.mover_input_vintage_advanced(
                        previous_mover, current_mover,
                    ),
                )
                self.assertEqual(
                    composite_score.build_movers_digest(
                        {"TEST": previous_mover}, {"TEST": current_mover},
                    ),
                    [],
                )

    def test_component_add_or_remove_baselines_other_advancing_component(self):
        for change in ("add", "remove"):
            with self.subTest(change=change):
                previous = cbs_row(
                    date(2026, 8, 17), 50.0, "input-a", "transcript-a",
                    "2026-08-17T12:00:00+00:00",
                )
                current = cbs_row(
                    date(2026, 8, 24), 80.0, "input-b", "transcript-b",
                    "2026-08-24T12:00:00+00:00",
                )
                extra = component(
                    "gauge-static", "2026-08-17T12:00:00+00:00", "gauge-v1",
                )
                if change == "add":
                    current["components"]["gauge"] = extra
                else:
                    previous["components"]["gauge"] = extra

                self.assertEqual(
                    scoreboard.advanced_component_vintages(previous, current),
                    [],
                )
                self.assertEqual(
                    scoreboard.find_cbs_events([previous, current]),
                    [],
                )

                previous_mover = mover_entry(
                    50.0, "input-a", "transcript-a",
                    "2026-08-17T12:00:00+00:00",
                )
                current_mover = mover_entry(
                    80.0, "input-b", "transcript-b",
                    "2026-08-24T12:00:00+00:00",
                )
                mover_extra = component(
                    "gauge-static", "2026-08-17T12:00:00+00:00", "gauge-v1",
                )
                if change == "add":
                    current_mover["components"]["gauge"] = mover_extra
                else:
                    previous_mover["components"]["gauge"] = mover_extra

                self.assertFalse(
                    composite_score.mover_input_vintage_advanced(
                        previous_mover, current_mover,
                    ),
                )
                self.assertEqual(
                    composite_score.build_movers_digest(
                        {"TEST": previous_mover}, {"TEST": current_mover},
                    ),
                    [],
                )

    def test_excluded_input_cannot_advance_scoreboard_vintage(self):
        baseline = cbs_row(
            date(2026, 8, 17), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
        )
        excluded = cbs_row(
            date(2026, 8, 24), 80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
        )
        excluded["components"]["transcript"]["eligible"] = False

        self.assertEqual(scoreboard.find_cbs_events([baseline, excluded]), [])

    def test_null_snapshot_breaks_scoreboard_continuity(self):
        baseline = cbs_row(
            date(2026, 8, 17), 50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
        )
        unavailable = cbs_row(
            date(2026, 8, 24), None, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
        )
        recovered = cbs_row(
            date(2026, 8, 31), 80.0, "input-c", "source-c",
            "2026-08-31T12:00:00+00:00",
        )

        self.assertEqual(
            scoreboard.find_cbs_events([baseline, unavailable, recovered]), [],
        )

    def test_previous_loader_retains_latest_null_baseline(self):
        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, *_args):
                return None

            def fetchall(self):
                return [(
                    "TEST", None, {"transcript": {"eligible": False}},
                    "cbs-method-1", "input-gap",
                    datetime(2026, 8, 24, 18, tzinfo=timezone.utc),
                )]

        class Connection:
            def cursor(self):
                return Cursor()

        previous = composite_score.load_previous(Connection())

        self.assertIn("TEST", previous)
        self.assertIsNone(previous["TEST"]["score"])

    def test_existing_today_alert_baseline_makes_identical_rerun_idempotent(self):
        yesterday = mover_entry(
            50.0, "input-a", "source-a",
            "2026-08-10T12:00:00+00:00",
        )
        published_today = mover_entry(
            80.0, "input-b", "source-b",
            "2026-08-17T12:00:00+00:00",
        )
        queries = []

        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, sql, params):
                queries.append((sql, params))

            def fetchall(self):
                return [(
                    "TEST",
                    published_today["score"],
                    published_today["components"],
                    published_today["methodologySignature"],
                    published_today["inputSignature"],
                    datetime(2026, 8, 17, 18, tzinfo=timezone.utc),
                )]

        class Connection:
            def cursor(self):
                return Cursor()

        first_digest = composite_score.build_movers_digest(
            {"TEST": yesterday}, {"TEST": published_today},
        )
        rerun_baseline = composite_score.load_previous(Connection())
        second_digest = composite_score.build_movers_digest(
            rerun_baseline, {"TEST": published_today},
        )

        self.assertEqual(len(first_digest), 1)
        self.assertEqual(second_digest, [])
        self.assertIn("WHERE as_of_date <= %s", queries[0][0])
        self.assertEqual(queries[0][1], (date.today(),))

    def test_movers_require_same_methodology_and_advanced_vintage(self):
        previous = {
            "TEST": mover_entry(
                50.0, "input-a", "source-a",
                "2026-08-17T12:00:00+00:00",
            ),
        }
        unchanged = {
            "TEST": mover_entry(
                80.0, "input-a", "source-a",
                "2026-08-17T12:00:00+00:00",
            ),
        }
        rollout = {
            "TEST": mover_entry(
                80.0, "input-b", "source-b",
                "2026-08-24T12:00:00+00:00",
                methodology_signature="cbs-method-2",
            ),
        }
        advanced = {
            "TEST": mover_entry(
                80.0, "input-b", "source-b",
                "2026-08-24T12:00:00+00:00",
            ),
        }

        self.assertEqual(composite_score.build_movers_digest(previous, unchanged), [])
        self.assertEqual(composite_score.build_movers_digest(previous, rollout), [])
        self.assertEqual(len(
            composite_score.build_movers_digest(previous, advanced),
        ), 1)

    def test_movers_do_not_bridge_null_snapshot(self):
        previous = {
            "TEST": mover_entry(
                None, "input-gap", "source-gap",
                "2026-08-24T12:00:00+00:00",
            ),
        }
        recovered = {
            "TEST": mover_entry(
                80.0, "input-fresh", "source-fresh",
                "2026-08-31T12:00:00+00:00",
            ),
        }

        self.assertEqual(
            composite_score.build_movers_digest(previous, recovered), [],
        )

    def test_later_fetch_of_older_period_cannot_emit_mover(self):
        previous = mover_entry(
            50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
            source_period_end="2026-06-30",
        )
        regressed = mover_entry(
            80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
            source_period_end="2026-03-31",
        )

        self.assertFalse(
            composite_score.mover_input_vintage_advanced(previous, regressed),
        )
        self.assertEqual(
            composite_score.build_movers_digest(
                {"TEST": previous}, {"TEST": regressed},
            ),
            [],
        )

    def test_any_component_method_change_baselines_mover(self):
        previous = mover_entry(
            50.0, "input-a", "source-a",
            "2026-08-17T12:00:00+00:00",
        )
        current = mover_entry(
            80.0, "input-b", "source-b",
            "2026-08-24T12:00:00+00:00",
        )
        previous["components"]["gauge"] = component(
            "gauge-a", "2026-08-17T12:00:00+00:00", "gauge-v1",
        )
        current["components"]["gauge"] = component(
            "gauge-b", "2026-08-24T12:00:00+00:00", "gauge-v2",
        )

        self.assertEqual(
            composite_score.build_movers_digest(
                {"TEST": previous}, {"TEST": current},
            ),
            [],
        )

    def test_rollout_migration_is_generic_idempotent_and_pre_maturity(self):
        sql = scoreboard.CBS_ROLLOUT_BASELINE_MIGRATION_SQL
        self.assertIn("event_type IN ('cbs_cross_70', 'cbs_jump_15')", sql)
        self.assertIn("details->>'cbsMethodologySignature'", sql)
        self.assertIn("'migration_baseline'", sql)
        self.assertIn("ret_1w IS NULL", sql)
        self.assertIn("ret_3m IS NULL", sql)
        self.assertIn("details->>'eventClassification'", sql)
        self.assertIn(
            "CURRENT_DATE < COALESCE(entry_date, event_date) + 7", sql,
        )
        self.assertIn(
            "<> 'migration_baseline'",
            inspect.getsource(scoreboard.fill_returns),
        )

    def test_same_day_upsert_only_updates_identical_snapshot(self):
        sql = " ".join(composite_score.UPSERT_SQL.split())
        self.assertIn(
            "WHERE composite_scores.methodology_signature IS NOT DISTINCT "
            "FROM EXCLUDED.methodology_signature",
            sql,
        )
        self.assertIn(
            "AND composite_scores.input_signature IS NOT DISTINCT FROM "
            "EXCLUDED.input_signature",
            sql,
        )
        self.assertIn(
            "RETURNING ticker, composite, components, methodology_signature",
            sql,
        )

    def test_same_day_changed_signature_conflict_is_not_healthy_or_a_mover(self):
        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        class Connection:
            def __init__(self):
                self.commits = 0

            def cursor(self):
                return Cursor()

            def commit(self):
                self.commits += 1

        candidate_rows = [("TEST", date(2026, 8, 17), 80.0)]
        conn = Connection()
        with mock.patch.object(
            composite_score.psycopg2.extras,
            "execute_values",
            return_value=[],
        ) as execute_values:
            persisted = composite_score.persist_composite_rows(
                conn, candidate_rows,
            )

        current = composite_score.current_from_persisted_rows(persisted)
        summary = composite_score.persisted_health_summary(current)
        conflicts = len(candidate_rows) - len(persisted)
        stats = composite_score.RunStats(
            expected=1,
            attempted=1,
            usable=summary["scoredRows"],
            degraded=summary["degradedComponents"] + conflicts,
        )
        previous = {
            "TEST": mover_entry(
                50.0, "input-a", "source-a",
                "2026-08-10T12:00:00+00:00",
            ),
        }

        self.assertEqual(persisted, [])
        self.assertEqual(current, {})
        self.assertEqual(summary["scoredRows"], 0)
        self.assertEqual(conflicts, 1)
        self.assertEqual(stats.usable, 0)
        self.assertEqual(stats.degraded, 1)
        self.assertEqual(evaluate_health(stats).state, "failure")
        self.assertEqual(
            composite_score.build_movers_digest(previous, current), [],
        )
        self.assertEqual(conn.commits, 1)
        self.assertTrue(execute_values.call_args.kwargs["fetch"])

    def test_missing_benchmark_raises_when_a_mature_return_is_pending(self):
        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, *_args):
                return None

            def fetchall(self):
                return [(
                    "TEST", "cbs_cross_70", date(2020, 1, 2),
                    {"cohort": "retrospective"},
                    date(2020, 1, 3), 100.0, 200.0,
                    None, None, None, None, None, None,
                )]

        class Connection:
            def cursor(self):
                return Cursor()

            def commit(self):
                return None

        with mock.patch.object(scoreboard, "load_price_series", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "matured returns pending"):
                scoreboard.fill_returns(Connection())

    def test_provider_wide_event_series_outage_raises_with_matured_returns(self):
        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, *_args):
                return None

            def fetchall(self):
                return [(
                    "TEST", "cbs_cross_70", date(2020, 1, 2), {},
                    date(2020, 1, 3), 100.0, 200.0,
                    None, None, None, None, None, None,
                )]

        class Connection:
            def cursor(self):
                return Cursor()

            def commit(self):
                return None

        benchmark = [(date(2020, 1, 3), 200.0), (date.today(), 250.0)]
        with mock.patch.object(
            scoreboard, "load_price_series", side_effect=[benchmark, None]
        ):
            with self.assertRaisesRegex(RuntimeError, "Event price series unavailable"):
                scoreboard.fill_returns(Connection())


if __name__ == "__main__":
    unittest.main()
