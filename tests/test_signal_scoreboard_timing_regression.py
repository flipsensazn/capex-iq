import inspect
import os
import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
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

import signal_scoreboard as scoreboard


class SignalScoreboardTimingRegressionTests(unittest.TestCase):
    def test_null_date_breaks_stress_continuity_before_valid_high(self):
        analyzed_at = datetime(2026, 8, 17, 12, tzinfo=timezone.utc)
        events = scoreboard.find_transcript_stress_events([
            (None, 40.0, analyzed_at, "model-a", "provider-a"),
            (date(2026, 8, 17), 75.0, analyzed_at, "model-a", "provider-a"),
        ])

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["kind"], "initial")
        self.assertEqual(events[0]["date"], date(2026, 8, 17))

    def test_stress_model_or_provider_transition_establishes_baseline(self):
        prior_date = date(2026, 8, 10)
        current_date = date(2026, 8, 17)
        prior_analysis = datetime(2026, 8, 10, 12, tzinfo=timezone.utc)
        current_analysis = datetime(2026, 8, 17, 12, tzinfo=timezone.utc)
        for current_model, current_provider in (
            ("model-b", "provider-a"),
            ("model-a", "provider-b"),
        ):
            with self.subTest(
                current_model=current_model,
                current_provider=current_provider,
            ):
                events = scoreboard.find_transcript_stress_events([
                    (prior_date, 40.0, prior_analysis, "model-a", "provider-a"),
                    (
                        current_date, 75.0, current_analysis,
                        current_model, current_provider,
                    ),
                ])
                self.assertEqual(events, [])

        stable = scoreboard.find_transcript_stress_events([
            (prior_date, 40.0, prior_analysis, "model-a", "provider-a"),
            (current_date, 75.0, current_analysis, "model-a", "provider-a"),
        ])
        self.assertEqual(len(stable), 1)
        self.assertEqual(stable[0]["kind"], "cross")

    def test_stress_freshness_is_stable_at_analysis_observation(self):
        call_date = date(2020, 1, 1)
        old_but_fresh = (
            call_date,
            75.0,
            datetime(2020, 1, 31, 12, tzinfo=timezone.utc),
            "model-a",
            "provider-a",
        )
        stale = (
            call_date,
            75.0,
            datetime(2021, 1, 1, 12, tzinfo=timezone.utc),
            "model-a",
            "provider-a",
        )
        future = (
            date(2020, 2, 8),
            75.0,
            datetime(2020, 1, 31, 12, tzinfo=timezone.utc),
            "model-a",
            "provider-a",
        )

        self.assertEqual(
            len(scoreboard.find_transcript_stress_events([old_but_fresh])),
            1,
        )
        self.assertEqual(scoreboard.find_transcript_stress_events([stale]), [])
        self.assertEqual(scoreboard.find_transcript_stress_events([future]), [])

    def test_detected_stress_persists_source_method_and_period_provenance(self):
        today = date.today()
        analyzed_at = datetime.now(timezone.utc)
        result_sets = [
            [],
            [("TEST", today, 75.0, analyzed_at, "model-a", "provider-a")],
            [],
            [],
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

        events = scoreboard.detect_events(Connection())

        self.assertEqual(len(events), 1)
        event = events[0]
        details = event["details"]
        self.assertEqual(event["event_type"], "stress_cross_70")
        self.assertEqual(
            details["transcriptSourceMethodology"],
            "transcript-stress-v1:model:model-a:provider:provider-a",
        )
        self.assertEqual(details["transcriptSourcePeriodEnd"], today.isoformat())
        self.assertEqual(
            details["transcriptSourceProvenance"]["provider"],
            "provider-a",
        )
        transcript_query = next(
            sql for sql in queries if "FROM transcript_stress" in sql
        )
        self.assertIn("analyzed_at, model, provider", transcript_query)

    def test_order_gap_requires_verified_fresh_score_period(self):
        today = date(2026, 8, 17)

        def row(period, provenance, gap=60.0):
            return (
                today, gap, datetime(2026, 8, 17, 12, tzinfo=timezone.utc),
                period, provenance,
            )

        def provenance(period, methodology="xbrl-gauge-score-period-v1"):
            return {
                "methodology": methodology,
                "scoreDriver": "backlog",
                "scorePeriodEnd": period.isoformat(),
            }

        valid_period = today - timedelta(days=30)
        valid = scoreboard.find_order_gap_events(
            [row(valid_period, provenance(valid_period))],
        )
        self.assertEqual(len(valid), 1)
        self.assertEqual(valid[0]["kind"], "initial")

        invalid_rows = [
            row(valid_period, None),
            row(
                valid_period,
                provenance(valid_period, methodology="xbrl-gauge-score-period-v0"),
            ),
            row(
                valid_period,
                {
                    **provenance(valid_period),
                    "scoreDriver": "inventory",
                },
            ),
            row(
                valid_period,
                provenance(valid_period - timedelta(days=90)),
            ),
            row(
                today - timedelta(days=366),
                provenance(today - timedelta(days=366)),
            ),
            row(
                today + timedelta(days=8),
                provenance(today + timedelta(days=8)),
            ),
        ]
        for invalid in invalid_rows:
            with self.subTest(invalid=invalid[3:]):
                self.assertEqual(
                    scoreboard.find_order_gap_events([invalid]),
                    [],
                )

        tolerated_future = today + timedelta(days=7)
        self.assertEqual(
            len(scoreboard.find_order_gap_events(
                [row(tolerated_future, provenance(tolerated_future))],
            )),
            1,
        )

    def test_ineligible_order_gap_row_breaks_crossing_continuity(self):
        today = date(2026, 8, 17)
        period = today - timedelta(days=30)
        verified = {
            "methodology": "xbrl-gauge-score-period-v1",
            "scoreDriver": "backlog",
            "scorePeriodEnd": period.isoformat(),
        }
        series = [
            (date(2026, 8, 3), 40.0, None, period, verified),
            (date(2026, 8, 10), 60.0, None, period, None),
            (date(2026, 8, 17), 60.0, None, period, verified),
        ]

        events = scoreboard.find_order_gap_events(series)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["date"], date(2026, 8, 17))
        self.assertEqual(events[0]["kind"], "initial")

    def test_order_gap_freshness_is_stable_at_each_observation_date(self):
        source_period = date(2023, 12, 31)
        provenance = {
            "methodology": "xbrl-gauge-score-period-v1",
            "scoreDriver": "backlog",
            "scorePeriodEnd": source_period.isoformat(),
        }
        old_but_fresh_when_observed = (
            date(2024, 1, 31), 60.0, None, source_period, provenance,
        )
        stale_when_observed = (
            source_period + timedelta(days=366),
            60.0, None, source_period, provenance,
        )

        self.assertEqual(
            len(scoreboard.find_order_gap_events([old_but_fresh_when_observed])),
            1,
        )
        self.assertEqual(
            scoreboard.find_order_gap_events([stale_when_observed]),
            [],
        )

    def test_detected_order_gap_persists_exact_period_provenance(self):
        today = date.today()
        period = today - timedelta(days=30)
        fetched_at = datetime.now(timezone.utc)
        period_provenance = {
            "methodology": "xbrl-gauge-score-period-v1",
            "scoreDriver": "backlog",
            "scorePeriodEnd": period.isoformat(),
        }
        result_sets = [
            [],
            [],
            [("TEST", today, 60.0, fetched_at, period, period_provenance)],
            [],
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

        events = scoreboard.detect_events(Connection())

        self.assertEqual(len(events), 1)
        details = events[0]["details"]
        self.assertEqual(events[0]["event_type"], "order_gap_50")
        self.assertEqual(
            details["gaugeSourceMethodology"],
            "xbrl-gauges-v2-score-period",
        )
        self.assertEqual(details["gaugeSourcePeriodEnd"], period.isoformat())
        self.assertEqual(details["gaugeLatestQuarterEnd"], period.isoformat())
        self.assertEqual(details["gaugePeriodProvenance"], period_provenance)
        gauge_query = next(sql for sql in queries if "FROM xbrl_gauges" in sql)
        self.assertIn("to_jsonb(xbrl_gauges)->'period_provenance'", gauge_query)
        self.assertIn("latest_quarter_end", gauge_query)

    def test_order_gap_rollout_migration_is_idempotent_and_pre_maturity(self):
        sql = scoreboard.ORDER_GAP_ROLLOUT_BASELINE_MIGRATION_SQL
        self.assertIn("event_type = 'order_gap_50'", sql)
        self.assertIn("gaugePeriodProvenance,methodology", sql)
        self.assertIn("gaugePeriodProvenance,scoreDriver", sql)
        self.assertIn("gaugePeriodProvenance,scorePeriodEnd", sql)
        self.assertIn("'migration_baseline'", sql)
        self.assertIn("ret_1w IS NULL", sql)
        self.assertIn("ret_3m IS NULL", sql)
        self.assertIn(
            "CURRENT_DATE < COALESCE(entry_date, event_date) + 7", sql,
        )
        self.assertIn(
            "<> 'migration_baseline'",
            sql,
        )
        self.assertIn(
            "<> 'migration_baseline'",
            inspect.getsource(scoreboard.fill_returns),
        )
        merged = scoreboard.merge_event_details(
            {
                "cohort": "retrospective",
                "kind": "migration_baseline",
                "eventClassification": "migration_baseline",
                "baselineReason": "missing_verified_gauge_period_provenance",
            },
            {
                "cohort": "prospective",
                "kind": "cross",
                "timingBasis": "source_timestamp",
            },
        )
        self.assertEqual(merged["cohort"], "retrospective")
        self.assertEqual(merged["kind"], "migration_baseline")
        self.assertEqual(merged["eventClassification"], "migration_baseline")

    def test_stress_rollout_migration_is_idempotent_and_pre_maturity(self):
        sql = scoreboard.STRESS_ROLLOUT_BASELINE_MIGRATION_SQL
        self.assertIn("event_type = 'stress_cross_70'", sql)
        self.assertIn("transcriptSourceMethodology", sql)
        self.assertIn("transcriptSourcePeriodEnd", sql)
        self.assertIn("transcriptSourceProvenance,provider", sql)
        self.assertIn("'migration_baseline'", sql)
        self.assertIn("ret_1w IS NULL", sql)
        self.assertIn("ret_3m IS NULL", sql)
        self.assertIn("<> 'migration_baseline'", sql)
        self.assertIn(
            "CURRENT_DATE < COALESCE(entry_date, event_date) + 7", sql,
        )

    def test_valid_exact_events_are_enriched_before_order_gap_quarantine(self):
        calls = []
        empty_fill = {
            "pendingRows": 0,
            "maturePendingRows": 0,
            "tickerAttempts": 0,
            "tickerFailures": 0,
            "updatedRows": 0,
            "matureFilledRows": 0,
            "unresolvedMatureRows": 0,
            "benchmarkUnavailable": False,
        }
        with (
            mock.patch.object(
                scoreboard, "migrate_methodology",
                side_effect=lambda _conn: calls.append("methodology") or 0,
            ),
            mock.patch.object(
                scoreboard, "migrate_cbs_rollout_baselines",
                side_effect=lambda _conn: calls.append("cbs-migration") or 0,
            ),
            mock.patch.object(
                scoreboard, "record_new_events",
                side_effect=lambda _conn: calls.append("event-enrichment") or 1,
            ),
            mock.patch.object(
                scoreboard, "migrate_stress_rollout_baselines",
                side_effect=lambda _conn: calls.append("stress-migration") or 0,
            ),
            mock.patch.object(
                scoreboard, "migrate_order_gap_rollout_baselines",
                side_effect=lambda _conn: calls.append("order-gap-migration") or 0,
            ),
            mock.patch.object(
                scoreboard, "fill_returns",
                side_effect=lambda _conn: calls.append("return-fill") or empty_fill,
            ),
        ):
            result = scoreboard.refresh_event_pipeline(object())

        self.assertEqual(calls, [
            "methodology",
            "cbs-migration",
            "event-enrichment",
            "stress-migration",
            "order-gap-migration",
            "return-fill",
        ])
        self.assertEqual(result["newEvents"], 1)

    def test_cohort_boundary_keeps_later_discovered_backfills_retrospective(self):
        boundary = date(2026, 8, 17)
        self.assertEqual(
            scoreboard.classify_cohort(date(2026, 8, 16), boundary),
            "retrospective",
        )
        self.assertEqual(
            scoreboard.classify_cohort(date(2026, 8, 17), boundary),
            "prospective",
        )

        details = scoreboard.event_details(
            date(2025, 5, 1),
            {"kind": "cross"},
            datetime(2026, 8, 17, 17, tzinfo=timezone.utc),
        )
        self.assertEqual(details["cohort"], "retrospective")
        self.assertEqual(details["methodologyVersion"], 2)
        self.assertIn("signalAvailableAt", details)

    def test_entry_target_uses_first_eligible_exchange_close(self):
        event_date = date(2026, 8, 17)
        pre_close = {
            "cohort": "prospective",
            "signalAvailableAt": "2026-08-17T19:30:00+00:00",  # 3:30pm ET
        }
        after_close = {
            "cohort": "prospective",
            "signalAvailableAt": "2026-08-17T20:30:00+00:00",  # 4:30pm ET
        }

        self.assertEqual(
            scoreboard.entry_target_date(event_date, pre_close),
            date(2026, 8, 17),
        )
        self.assertEqual(
            scoreboard.entry_target_date(event_date, after_close),
            date(2026, 8, 18),
        )
        self.assertEqual(
            scoreboard.entry_target_date(event_date, {
                "cohort": "prospective",
                "signalAvailableAt": "2026-08-18T02:00:00+00:00",  # 10pm ET Aug 17
            }),
            date(2026, 8, 18),
        )
        self.assertEqual(
            scoreboard.entry_target_date(
                date(2025, 5, 1),
                {"cohort": "retrospective", "signalAvailableAt": "2026-08-17T12:00:00Z"},
            ),
            date(2025, 5, 2),
        )
        self.assertEqual(
            scoreboard.entry_target_date(event_date, {"cohort": "prospective"}),
            date(2026, 8, 18),
        )

    def test_future_dated_transcript_cannot_price_before_call_date(self):
        analyzed_at = datetime(2026, 8, 17, 15, tzinfo=timezone.utc)
        call_date = date(2026, 8, 18)
        events = scoreboard.find_transcript_stress_events([(
            call_date, 75.0, analyzed_at, "model-a", "provider-a",
        )])

        self.assertEqual(len(events), 1)  # one-day metadata tolerance remains
        details = scoreboard.event_details(
            call_date,
            {"kind": events[0]["kind"]},
            events[0]["available_at"],
        )
        self.assertEqual(
            scoreboard.entry_target_date(call_date, details),
            date(2026, 8, 19),
        )

    def test_exchange_calendar_handles_early_close_and_holiday(self):
        self.assertEqual(
            scoreboard.first_market_close_after(
                datetime(2012, 7, 3, 16, 30, tzinfo=timezone.utc)
            ),
            date(2012, 7, 3),
        )
        self.assertEqual(
            scoreboard.first_market_close_after(
                datetime(2012, 7, 3, 17, 30, tzinfo=timezone.utc)
            ),
            date(2012, 7, 5),
        )

    def test_forward_horizons_anchor_to_actual_entry_date(self):
        stock = [
            (date(2026, 1, 5), 100.0),
            (date(2026, 1, 10), 105.0),
            (date(2026, 1, 12), 110.0),
        ]
        benchmark = [
            (date(2026, 1, 5), 200.0),
            (date(2026, 1, 10), 201.0),
            (date(2026, 1, 12), 202.0),
        ]

        fill = scoreboard.compute_row_fill(
            date(2026, 1, 3), stock, benchmark, date(2026, 1, 13)
        )

        self.assertEqual(fill["entry_date"], date(2026, 1, 5))
        self.assertEqual(fill["ret_1w"], 10.0)
        self.assertEqual(fill["bench_1w"], 1.0)
        self.assertIsNone(fill["ret_1m"])

    def test_benchmark_entry_aligns_with_delayed_stock_entry(self):
        stock = [
            (date(2026, 1, 6), 100.0),
            (date(2026, 1, 13), 110.0),
        ]
        benchmark = [
            (date(2026, 1, 5), 200.0),
            (date(2026, 1, 6), 202.0),
            (date(2026, 1, 13), 204.0),
        ]

        fill = scoreboard.compute_row_fill(
            date(2026, 1, 5), stock, benchmark, date(2026, 1, 14)
        )

        self.assertEqual(fill["bench_entry"], 202.0)
        self.assertEqual(fill["bench_1w"], 0.99)

    def test_incomplete_current_day_bar_is_never_used_as_a_close(self):
        fill = scoreboard.compute_row_fill(
            date(2026, 1, 5),
            [(date(2026, 1, 5), 100.0)],
            [(date(2026, 1, 5), 200.0)],
            date(2026, 1, 5),
        )
        self.assertIsNone(fill)

    def test_incremental_fill_sql_preserves_published_values_and_exit_dates(self):
        self.assertIn("ret_1w = COALESCE(ret_1w, %(ret_1w)s)", scoreboard.FILL_SQL)
        self.assertIn("bench_1w = COALESCE(bench_1w, %(bench_1w)s)", scoreboard.FILL_SQL)
        self.assertIn("details->'exitDates'", scoreboard.FILL_SQL)
        self.assertLess(
            scoreboard.FILL_SQL.index("jsonb_strip_nulls"),
            scoreboard.FILL_SQL.index("details->'exitDates'"),
        )

    def test_prospective_boundary_override_is_validated_and_persisted(self):
        with mock.patch.dict(
            os.environ,
            {"SCOREBOARD_PROSPECTIVE_START": "2030-01-01"},
            clear=False,
        ):
            self.assertEqual(
                scoreboard.prospective_start_date(),
                date(2030, 1, 1),
            )
        with mock.patch.dict(
            os.environ,
            {"SCOREBOARD_PROSPECTIVE_START": "not-a-date"},
            clear=False,
        ):
            with self.assertRaises(ValueError):
                scoreboard.prospective_start_date()
        self.assertIn("details->>'observedUnderV2'", scoreboard.METHODOLOGY_MIGRATION_SQL)
        self.assertIn("details->>'cohortBoundary'", scoreboard.METHODOLOGY_MIGRATION_SQL)
        self.assertIn("details->>'signalAvailableAt'", scoreboard.METHODOLOGY_MIGRATION_SQL)
        self.assertEqual(scoreboard.METHODOLOGY_MIGRATION_SQL.count("%s"), 6)

    def test_frozen_entry_date_uses_one_adjusted_price_vintage(self):
        fill = scoreboard.compute_row_fill(
            date(2026, 1, 5),
            [
                (date(2026, 1, 5), 100.0),
                (date(2026, 1, 12), 110.0),
            ],
            [
                (date(2026, 1, 5), 200.0),
                (date(2026, 1, 12), 202.0),
            ],
            date(2026, 1, 13),
            {
                "entry_date": date(2026, 1, 5),
                "entry_price": 200.0,  # pre-split stored adjusted price
                "bench_entry": 200.0,
            },
        )

        self.assertEqual(fill["entry_date"], date(2026, 1, 5))
        self.assertEqual(fill["ret_1w"], 10.0)
        self.assertEqual(fill["bench_1w"], 1.0)

    def test_stock_and_benchmark_exit_on_the_same_actual_date(self):
        fill = scoreboard.compute_row_fill(
            date(2026, 1, 5),
            [
                (date(2026, 1, 5), 100.0),
                (date(2026, 1, 13), 110.0),
            ],
            [
                (date(2026, 1, 5), 200.0),
                (date(2026, 1, 12), 202.0),
                (date(2026, 1, 13), 204.0),
            ],
            date(2026, 1, 14),
        )

        self.assertEqual(fill["exit_1w_date"], date(2026, 1, 13))
        self.assertEqual(fill["bench_1w"], 2.0)

    def test_retrospective_refractory_does_not_suppress_prospective_event(self):
        class Cursor:
            rowcount = 0

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, *_args):
                return None

            def fetchall(self):
                return [(
                    "TEST",
                    "stress_cross_70",
                    date(2026, 8, 1),
                    {"cohort": "retrospective"},
                )]

        class Connection:
            def __init__(self):
                self.commits = 0

            def cursor(self):
                return Cursor()

            def commit(self):
                self.commits += 1

        candidate = {
            "ticker": "TEST",
            "event_type": "stress_cross_70",
            "event_date": date(2026, 8, 17),
            "score": 75.0,
            "details": {
                "cohort": "prospective",
                "methodologyVersion": 2,
                "entryRule": "first_close_after_signal",
            },
        }
        inserted = []

        with (
            mock.patch.object(scoreboard, "detect_events", return_value=[candidate]),
            mock.patch.object(
                scoreboard.psycopg2.extras,
                "execute_values",
                side_effect=lambda _cur, _sql, rows, **_kwargs: inserted.extend(rows),
                create=True,
            ),
        ):
            count = scoreboard.record_new_events(Connection())

        self.assertEqual(count, 1)
        self.assertEqual(inserted[0][0:3], ("TEST", "stress_cross_70", date(2026, 8, 17)))

    def test_exact_legacy_row_is_enriched_and_repriced(self):
        existing_details = {
            "cohort": "retrospective",
            "methodologyVersion": 2,
            "entryRule": "first_close_after_signal",
            "timingBasis": "date_only_conservative",
            "exitDates": {"1w": "2026-08-25"},
        }
        calls = []

        class Cursor:
            rowcount = 0

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, sql, params=None):
                calls.append((sql, params))

            def fetchall(self):
                return [(
                    "TEST", "stress_cross_70", date(2026, 8, 17),
                    existing_details,
                )]

        class Connection:
            def __init__(self):
                self.commits = 0

            def cursor(self):
                return Cursor()

            def commit(self):
                self.commits += 1

        candidate = {
            "ticker": "TEST",
            "event_type": "stress_cross_70",
            "event_date": date(2026, 8, 17),
            "score": 75.0,
            "details": {
                "cohort": "prospective",
                "methodologyVersion": 2,
                "observedUnderV2": True,
                "entryRule": "first_close_after_signal",
                "timingBasis": "source_timestamp",
                "signalAvailableAt": "2026-08-17T19:30:00Z",
            },
        }

        with mock.patch.object(scoreboard, "detect_events", return_value=[candidate]):
            count = scoreboard.record_new_events(Connection())

        self.assertEqual(count, 0)
        update_sql, update_params = calls[-1]
        self.assertEqual(update_sql, scoreboard.REPRICE_EXACT_SQL)
        stored = getattr(update_params["details"], "adapted", update_params["details"])
        self.assertEqual(stored["cohort"], "prospective")
        self.assertNotIn("exitDates", stored)

    def test_exact_enrichment_preserves_earliest_source_availability(self):
        merged = scoreboard.merge_event_details(
            {"signalAvailableAt": "2026-08-17T15:00:00Z"},
            {"signalAvailableAt": "2026-08-17T16:00:00Z"},
        )
        self.assertEqual(merged["signalAvailableAt"], "2026-08-17T15:00:00Z")

        not_downgraded = scoreboard.merge_event_details(
            {
                "cohort": "prospective",
                "timingBasis": "source_timestamp",
                "signalAvailableAt": "2026-08-17T15:00:00Z",
            },
            {
                "cohort": "prospective",
                "timingBasis": "date_only_conservative",
            },
        )
        self.assertEqual(not_downgraded["timingBasis"], "source_timestamp")


if __name__ == "__main__":
    unittest.main()
