import os
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

import signal_scoreboard as scoreboard


class SignalScoreboardTimingRegressionTests(unittest.TestCase):
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
