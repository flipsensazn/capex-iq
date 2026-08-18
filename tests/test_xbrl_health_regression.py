import importlib
import re
import sys
import types
import unittest
from datetime import date
from pathlib import Path
from unittest import mock


try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    sys.modules["requests"] = types.ModuleType("requests")

try:
    importlib.import_module("psycopg2.extras")
except ModuleNotFoundError:
    psycopg2_stub = sys.modules.get("psycopg2") or types.ModuleType("psycopg2")
    psycopg2_stub.__path__ = []
    extras_stub = types.ModuleType("psycopg2.extras")
    extras_stub.Json = lambda value: value
    psycopg2_stub.extras = extras_stub
    sys.modules["psycopg2"] = psycopg2_stub
    sys.modules["psycopg2.extras"] = extras_stub

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import xbrl_gauges


def duration_fact(start, end, value):
    return {
        "start": start, "end": end, "val": value,
        "form": "10-Q", "filed": "2026-08-01",
    }


def instant_fact(end, value):
    return {
        "end": end, "val": value,
        "form": "10-Q", "filed": "2026-08-01",
    }


def company_facts(*, revenue, cogs=None, inventory=None, rpo=None):
    concepts = {
        "Revenues": {"units": {"USD": revenue}},
    }
    for tag, rows in (
        ("CostOfRevenue", cogs),
        ("InventoryNet", inventory),
        ("RevenueRemainingPerformanceObligation", rpo),
    ):
        if rows is not None:
            concepts[tag] = {"units": {"USD": rows}}
    return {"facts": {"us-gaap": concepts}}


REVENUE_QUARTERS = [
    duration_fact("2025-04-01", "2025-06-30", 80),
    duration_fact("2025-07-01", "2025-09-30", 85),
    duration_fact("2025-10-01", "2025-12-31", 90),
    duration_fact("2026-01-01", "2026-03-31", 95),
    duration_fact("2026-04-01", "2026-06-30", 100),
]


class FakeResponse:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self.payload = payload or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


class XbrlHealthRegressionTests(unittest.TestCase):
    def test_limited_xbrl_smoke_run_skips_composite_and_scoreboard(self):
        workflow = (
            Path(__file__).resolve().parents[1]
            / ".github" / "workflows" / "xbrl-gauges.yml"
        ).read_text(encoding="utf-8")
        full_run_condition = (
            "if: ${{ github.event_name != 'workflow_dispatch' || "
            "github.event.inputs.ticker_limit == '' || "
            "github.event.inputs.ticker_limit == '0' }}"
        )

        self.assertEqual(workflow.count(full_run_condition), 2)
        self.assertIn("group: xbrl-gauges-etl", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("name: Validate Ticker Limit", workflow)
        self.assertIn("^(0|[1-9][0-9]*)$", workflow)
        self.assertRegex(
            workflow,
            r"name: Compute Composite Bottleneck Scores\n\s+"
            + re.escape(full_run_condition),
        )
        self.assertRegex(
            workflow,
            r"name: Update Signal Scoreboard\n\s+"
            + re.escape(full_run_condition),
        )

    def test_upsert_has_atomic_period_monotonicity_guard(self):
        self.assertIn(
            "EXCLUDED.latest_quarter_end >= xbrl_gauges.latest_quarter_end",
            xbrl_gauges.UPSERT_SQL,
        )
        self.assertIn(
            "WHERE xbrl_gauges.latest_quarter_end IS NULL",
            xbrl_gauges.UPSERT_SQL,
        )
        for column in (
            "revenue_period_end", "inventory_period_end", "rpo_period_end",
            "backlog_period_end", "period_provenance",
        ):
            self.assertIn(f"ADD COLUMN IF NOT EXISTS {column}", xbrl_gauges.MIGRATION_SQL)

    def test_old_rpo_is_excluded_instead_of_borrowing_fresh_revenue_period(self):
        aligned = xbrl_gauges.compute_gauges(company_facts(
            revenue=REVENUE_QUARTERS,
            rpo=[
                instant_fact("2025-06-30", 100),
                instant_fact("2026-06-30", 200),
            ],
        ))
        old_rpo = xbrl_gauges.compute_gauges(company_facts(
            revenue=REVENUE_QUARTERS,
            rpo=[
                instant_fact("2024-12-31", 100),
                instant_fact("2025-12-31", 200),
            ],
        ))

        self.assertIsNotNone(aligned["backlog_score"])
        self.assertEqual(aligned["latest_quarter_end"], date(2026, 6, 30))
        self.assertEqual(aligned["backlog_period_end"], date(2026, 6, 30))
        self.assertEqual(
            aligned["period_provenance"]["scoreDriver"], "backlog",
        )

        self.assertEqual(old_rpo["revenue_period_end"], date(2026, 6, 30))
        self.assertEqual(old_rpo["rpo_period_end"], date(2025, 12, 31))
        self.assertIsNone(old_rpo["rpo"])
        self.assertIsNone(old_rpo["rpo_yoy"])
        self.assertIsNone(old_rpo["order_gap"])
        self.assertIsNone(old_rpo["backlog_score"])
        self.assertEqual(
            old_rpo["period_provenance"]["exclusions"][0]["component"],
            "rpo",
        )

    def test_inventory_score_uses_inventory_period_and_excludes_old_inventory(self):
        aligned = xbrl_gauges.compute_gauges(company_facts(
            revenue=REVENUE_QUARTERS,
            cogs=[
                duration_fact("2025-04-01", "2025-06-30", 100),
                duration_fact("2026-04-01", "2026-06-30", 100),
            ],
            inventory=[
                instant_fact("2025-06-30", 100),
                instant_fact("2026-06-30", 200),
            ],
        ))
        old_inventory = xbrl_gauges.compute_gauges(company_facts(
            revenue=REVENUE_QUARTERS,
            inventory=[
                instant_fact("2024-12-31", 100),
                instant_fact("2025-12-31", 200),
            ],
        ))

        self.assertGreater(aligned["inventory_days_yoy"], 0)
        self.assertEqual(aligned["latest_quarter_end"], date(2026, 6, 30))
        self.assertEqual(
            aligned["period_provenance"]["scoreDriver"], "inventory",
        )
        self.assertEqual(old_inventory["inventory_period_end"], date(2025, 12, 31))
        self.assertIsNone(old_inventory["inventory"])
        self.assertIsNone(old_inventory["inventory_days_yoy"])
        self.assertEqual(
            old_inventory["period_provenance"]["exclusions"][0]["component"],
            "inventory",
        )

    def test_missing_companyfacts_is_known_no_data(self):
        with mock.patch.object(
            xbrl_gauges.requests, "get", return_value=FakeResponse(404), create=True
        ):
            self.assertIsNone(xbrl_gauges.fetch_companyfacts("0000000001"))

    def test_provider_outage_raises_instead_of_looking_like_no_data(self):
        with mock.patch.object(
            xbrl_gauges.requests, "get", return_value=FakeResponse(503), create=True
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                xbrl_gauges.fetch_companyfacts("0000000001")

    def test_main_uses_positive_limit_not_truthiness_for_health_gate(self):
        class Cursor:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, *_args):
                return None

        class Connection:
            def cursor(self):
                return Cursor()

            def commit(self):
                return None

            def close(self):
                return None

        finish = mock.Mock()
        with (
            mock.patch.object(xbrl_gauges, "DATABASE_URL", "postgres://test"),
            mock.patch.object(xbrl_gauges, "TICKER_LIMIT", -1),
            mock.patch.object(xbrl_gauges, "get_universe", return_value=["TEST"]),
            mock.patch.object(xbrl_gauges, "get_cik_map", return_value={}),
            mock.patch.object(xbrl_gauges, "connect_db", return_value=Connection()),
            mock.patch.object(xbrl_gauges, "begin_run", return_value=object()),
            mock.patch.object(xbrl_gauges, "load_latest_periods", return_value={}),
            mock.patch.object(xbrl_gauges, "finish_run", finish),
        ):
            xbrl_gauges.main()

        self.assertEqual(finish.call_args.kwargs["limited_run"], False)

    def test_main_retains_newer_stored_period_when_companyfacts_regresses(self):
        class Cursor:
            def __init__(self, calls):
                self.calls = calls

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, sql, params=None):
                self.calls.append((sql, params))

        class Connection:
            def __init__(self):
                self.calls = []

            def cursor(self):
                return Cursor(self.calls)

            def commit(self):
                return None

            def close(self):
                return None

        gauges = {
            "latest_quarter_end": date(2026, 3, 31),
            "revenue_q": 1.0,
            "revenue_yoy": 2.0,
            "inventory": 3.0,
            "inventory_yoy": 4.0,
            "inventory_days": 5.0,
            "inventory_days_yoy": 6.0,
            "rpo": 7.0,
            "rpo_yoy": 8.0,
            "rpo_to_ttm_revenue": 9.0,
            "order_gap": 10.0,
            "backlog_score": 11.0,
            "tags_used": {},
        }
        conn = Connection()
        finish = mock.Mock()
        with (
            mock.patch.object(xbrl_gauges, "DATABASE_URL", "postgres://test"),
            mock.patch.object(xbrl_gauges, "TICKER_LIMIT", 0),
            mock.patch.object(xbrl_gauges, "get_universe", return_value=["TEST"]),
            mock.patch.object(xbrl_gauges, "get_cik_map", return_value={"TEST": "1"}),
            mock.patch.object(xbrl_gauges, "connect_db", return_value=conn),
            mock.patch.object(xbrl_gauges, "begin_run", return_value=object()),
            mock.patch.object(
                xbrl_gauges,
                "load_latest_periods",
                return_value={"TEST": date(2026, 6, 30)},
            ),
            mock.patch.object(xbrl_gauges, "fetch_companyfacts", return_value={"facts": {}}),
            mock.patch.object(xbrl_gauges, "compute_gauges", return_value=gauges),
            mock.patch.object(xbrl_gauges, "finish_run", finish),
            mock.patch.object(xbrl_gauges.time, "sleep"),
        ):
            xbrl_gauges.main()

        self.assertFalse(any("INSERT INTO xbrl_gauges" in sql for sql, _ in conn.calls))
        stats = finish.call_args.args[2]
        self.assertEqual(stats.usable, 0)
        self.assertEqual(stats.degraded, 1)
        self.assertEqual(stats.details["regressedPeriods"], 1)


if __name__ == "__main__":
    unittest.main()
