import importlib
import json
import sys
import types
import unittest
from pathlib import Path


try:
    importlib.import_module("psycopg2")
except ModuleNotFoundError:
    psycopg2_stub = types.ModuleType("psycopg2")
    psycopg2_stub.__path__ = []
    psycopg2_extras_stub = types.ModuleType("psycopg2.extras")
    psycopg2_extras_stub.Json = lambda value: value
    psycopg2_stub.extras = psycopg2_extras_stub
    sys.modules["psycopg2"] = psycopg2_stub
    sys.modules["psycopg2.extras"] = psycopg2_extras_stub

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from etl_health import (
    RunContext,
    RunStats,
    UPSERT_SQL,
    begin_run,
    evaluate_health,
    finish_run,
    record_failure_safely,
    threshold_from_env,
    ticker_limit_from_env,
)


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        self.connection.executed.append((sql, params))

    def fetchone(self):
        return self.connection.baseline


class FakeConnection:
    def __init__(self, baseline=None):
        self.baseline = baseline
        self.executed = []
        self.commits = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1


class StatefulManifestCursor:
    def __init__(self, connection):
        self.connection = connection
        self.result = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        self.connection.executed.append((sql, params))
        if "SELECT usable" in sql:
            rows = [
                row for row in self.connection.rows
                if row["pipeline"] == params[0] and row["state"] == "success"
            ]
            excludes_limited = (
                "details->>'limitedRun'" in sql
                and "details->>'limited_run'" in sql
            )
            if excludes_limited:
                rows = [
                    row for row in rows
                    if not row["details"].get("limitedRun", False)
                    and not row["details"].get("limited_run", False)
                ]
            self.result = (rows[-1]["usable"],) if rows else None
        elif isinstance(params, dict):
            existing_index = next((
                index for index, existing in enumerate(self.connection.rows)
                if (
                    existing["pipeline"], existing["run_id"]
                ) == (params["pipeline"], params["run_id"])
            ), None)
            existing_freshness = (
                self.connection.rows[existing_index]["data_fresh_at"]
                if existing_index is not None else None
            )
            if (
                params["state"] in {"success", "degraded"}
                and not params["limited_run"]
            ):
                self.connection.freshness_clock += 1
                data_fresh_at = self.connection.freshness_clock
            else:
                data_fresh_at = existing_freshness
            row = {
                "pipeline": params["pipeline"],
                "run_id": params["run_id"],
                "state": params["state"],
                "usable": params["usable"],
                "details": json.loads(params["details"]),
                "data_fresh_at": data_fresh_at,
            }
            if existing_index is not None:
                self.connection.rows[existing_index] = row
            else:
                self.connection.rows.append(row)

    def fetchone(self):
        return self.result


class StatefulManifestConnection:
    def __init__(self):
        self.rows = []
        self.executed = []
        self.commits = 0
        self.freshness_clock = 0

    def cursor(self):
        return StatefulManifestCursor(self)

    def commit(self):
        self.commits += 1


class EtlHealthRegressionTests(unittest.TestCase):
    def test_provider_wide_outage_fails_even_when_loop_would_continue(self):
        decision = evaluate_health(RunStats(
            expected=12,
            attempted=12,
            transient_failures=12,
        ))

        self.assertEqual(decision.state, "failure")
        self.assertIn("provider-wide outage", decision.reason)

    def test_all_empty_first_run_does_not_establish_a_false_green_baseline(self):
        decision = evaluate_health(RunStats(
            expected=12,
            known_no_data=12,
        ))

        self.assertEqual(decision.state, "failure")
        self.assertIn("no usable", decision.reason)

    def test_known_no_data_does_not_reduce_usable_coverage(self):
        decision = evaluate_health(RunStats(
            expected=10,
            attempted=7,
            usable=7,
            known_no_data=3,
        ))

        self.assertEqual(decision.state, "success")
        self.assertEqual(decision.usable_coverage, 1.0)

    def test_partial_failures_are_visible_as_degraded_above_threshold(self):
        decision = evaluate_health(RunStats(
            expected=10,
            attempted=10,
            usable=9,
            transient_failures=1,
        ))

        self.assertEqual(decision.state, "degraded")
        self.assertEqual(decision.provider_coverage, 0.9)

    def test_prior_success_prevents_silent_large_coverage_regression(self):
        decision = evaluate_health(
            RunStats(expected=100, attempted=100, usable=60,
                     known_no_data=40),
            baseline_usable=90,
        )

        self.assertEqual(decision.state, "failure")
        self.assertIn("prior-success floor", decision.reason)

    def test_limited_run_does_not_compare_to_full_baseline(self):
        decision = evaluate_health(
            RunStats(expected=5, attempted=5, usable=5),
            baseline_usable=90,
            limited_run=True,
        )

        self.assertEqual(decision.state, "success")

    def test_limited_success_cannot_replace_next_full_run_baseline(self):
        conn = StatefulManifestConnection()

        full = begin_run(
            conn, "xbrl_gauges", expected=100,
            details={"limitedRun": False},
        )
        finish_run(
            conn, full,
            RunStats(expected=100, attempted=100, usable=100),
        )

        limited = begin_run(
            conn, "xbrl_gauges", expected=1,
            details={"limited_run": True},
        )
        finish_run(
            conn, limited,
            RunStats(expected=1, attempted=1, usable=1),
            limited_run=True,
        )

        next_full = begin_run(
            conn, "xbrl_gauges", expected=100,
            details={"limitedRun": False},
        )

        self.assertIsNone(full.baseline_usable)
        self.assertEqual(limited.baseline_usable, 100)
        self.assertEqual(next_full.baseline_usable, 100)
        full_row = next(row for row in conn.rows if row["run_id"] == full.run_id)
        limited_row = next(
            row for row in conn.rows if row["run_id"] == limited.run_id
        )
        self.assertIsNotNone(full_row["data_fresh_at"])
        self.assertIsNone(limited_row["data_fresh_at"])
        self.assertEqual(
            max(
                row["data_fresh_at"] for row in conn.rows
                if row["data_fresh_at"] is not None
            ),
            full_row["data_fresh_at"],
        )
        baseline_sql = next(
            sql for sql, _ in conn.executed if "SELECT usable" in sql
        )
        self.assertIn("details->>'limitedRun'", baseline_sql)
        self.assertIn("details->>'limited_run'", baseline_sql)
        self.assertIn("AND NOT %(limited_run)s", UPSERT_SQL)

    def test_threshold_environment_values_fail_closed(self):
        self.assertEqual(threshold_from_env({}, "MIN", 0.9), 0.9)
        with self.assertRaisesRegex(ValueError, "between 0 and 1"):
            threshold_from_env({"MIN": "1.1"}, "MIN", 0.9)
        with self.assertRaisesRegex(ValueError, "decimal"):
            threshold_from_env({"MIN": "oops"}, "MIN", 0.9)

    def test_ticker_limit_requires_canonical_nonnegative_integer(self):
        self.assertEqual(ticker_limit_from_env({}), 0)
        self.assertEqual(ticker_limit_from_env({"TICKER_LIMIT": ""}), 0)
        self.assertEqual(ticker_limit_from_env({"TICKER_LIMIT": "0"}), 0)
        self.assertEqual(ticker_limit_from_env({"TICKER_LIMIT": "1"}), 1)
        self.assertEqual(ticker_limit_from_env({"TICKER_LIMIT": "250"}), 250)

        for invalid in ("-1", "00", "01", "+1", " 1", "1 ", "1.0", "one"):
            with self.subTest(invalid=invalid):
                with self.assertRaisesRegex(ValueError, "without leading zeroes"):
                    ticker_limit_from_env({"TICKER_LIMIT": invalid})

    def test_manifest_keeps_one_run_id_from_running_through_terminal_state(self):
        conn = FakeConnection(baseline=(8,))
        context = begin_run(
            conn, "xbrl_gauges", expected=10, details={"limitedRun": True}
        )
        decision = finish_run(
            conn,
            context,
            RunStats(expected=10, attempted=10, usable=10),
        )

        writes = [params for _, params in conn.executed if isinstance(params, dict)]
        self.assertEqual([write["state"] for write in writes], ["running", "success"])
        self.assertIsNone(writes[0]["error_message"])
        self.assertEqual({write["run_id"] for write in writes}, {context.run_id})
        self.assertEqual(context.baseline_usable, 8)
        self.assertTrue(all("limitedRun" in write["details"] for write in writes))
        self.assertEqual(decision.state, "success")
        self.assertEqual(conn.commits, 2)

    def test_failure_manifest_rolls_back_aborted_transaction_first(self):
        class AbortedCursor:
            def __init__(self, connection):
                self.connection = connection

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, sql, params=None):
                if self.connection.aborted:
                    raise RuntimeError("transaction is aborted")
                self.connection.events.append(("execute", params))

        class AbortedConnection:
            def __init__(self, rollback_fails=False):
                self.aborted = True
                self.rollback_fails = rollback_fails
                self.events = []

            def rollback(self):
                self.events.append(("rollback", None))
                if self.rollback_fails:
                    raise RuntimeError("rollback unavailable")
                self.aborted = False

            def cursor(self):
                return AbortedCursor(self)

            def commit(self):
                self.events.append(("commit", None))

        context = RunContext("xbrl_gauges", "run-1", None, {})
        stats = RunStats(expected=1, attempted=1, transient_failures=1)
        original = RuntimeError("primary SQL failure")
        conn = AbortedConnection()

        record_failure_safely(conn, context, stats, original)

        self.assertEqual(conn.events[0][0], "rollback")
        write = next(params for kind, params in conn.events if kind == "execute")
        self.assertEqual(write["state"], "failure")
        self.assertEqual(write["error_message"], str(original))

        # Even if rollback and the follow-up UPSERT both fail, the helper must
        # return normally so the caller can re-raise the original exception.
        broken = AbortedConnection(rollback_fails=True)
        record_failure_safely(broken, context, stats, original)
        self.assertEqual(broken.events, [("rollback", None), ("rollback", None)])


if __name__ == "__main__":
    unittest.main()
