import importlib
import math
import sys
import types
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# These regression tests exercise the pure SEC period selectors. Stub the
# pipeline's optional runtime clients so the tests do not need network/DB/data
# packages merely to import those helpers.
for module_name in ("requests", "pandas", "yfinance"):
    try:
        importlib.import_module(module_name)
    except ModuleNotFoundError:
        sys.modules[module_name] = types.ModuleType(module_name)

try:
    importlib.import_module("numpy")
except ModuleNotFoundError:
    numpy_stub = types.ModuleType("numpy")
    numpy_stub.nan = float("nan")
    sys.modules["numpy"] = numpy_stub

try:
    importlib.import_module("psycopg2.extras")
except ModuleNotFoundError:
    psycopg2_stub = types.ModuleType("psycopg2")
    psycopg2_stub.__path__ = []
    psycopg2_extras_stub = types.ModuleType("psycopg2.extras")
    psycopg2_extras_stub.Json = lambda value: value
    psycopg2_stub.extras = psycopg2_extras_stub
    sys.modules["psycopg2"] = psycopg2_stub
    sys.modules["psycopg2.extras"] = psycopg2_extras_stub

import etl_pipeline


def companyfacts(tag, units):
    return {
        "facts": {
            "us-gaap": {
                tag: {"units": {"USD": units}},
            }
        }
    }


class SecPeriodSelectionRegressionTests(unittest.TestCase):
    def test_annual_pair_ignores_nine_month_and_q4_facts_carried_in_10k(self):
        facts = companyfacts("Revenues", [
            {
                "start": "2025-07-01", "end": "2026-03-31",
                "val": 343_813_000, "form": "10-Q", "filed": "2026-05-08",
            },
            {
                "start": "2025-04-01", "end": "2025-06-30",
                "val": 114_611_000, "form": "10-K", "filed": "2025-08-20",
            },
            {
                "start": "2024-07-01", "end": "2025-06-30",
                "val": 441_073_000, "form": "10-K", "filed": "2025-08-20",
            },
            {
                "start": "2023-07-01", "end": "2024-06-30",
                "val": 420_000_000, "form": "10-K", "filed": "2024-08-22",
            },
        ])

        self.assertEqual(
            etl_pipeline.annual_gaap_pair(facts, ["Revenues"]),
            (441_073_000, 420_000_000),
        )

    def test_annual_pair_keeps_latest_filed_value_for_a_repeated_period(self):
        facts = companyfacts("Revenues", [
            {
                "start": "2024-01-01", "end": "2024-12-31",
                "val": 100, "form": "10-K", "filed": "2025-02-01",
            },
            {
                "start": "2024-01-01", "end": "2024-12-31",
                "val": 105, "form": "10-K/A", "filed": "2025-03-01",
            },
            {
                "start": "2023-01-01", "end": "2023-12-31",
                "val": 90, "form": "10-K", "filed": "2024-02-01",
            },
        ])

        self.assertEqual(etl_pipeline.annual_gaap_pair(facts, ["Revenues"]), (105, 90))

    def test_instant_pair_uses_the_same_quarter_from_the_prior_year(self):
        facts = companyfacts("Assets", [
            {"end": "2026-03-31", "val": 500, "form": "10-Q", "filed": "2026-05-01"},
            {"end": "2025-12-31", "val": 475, "form": "10-K", "filed": "2026-02-01"},
            {"end": "2025-03-31", "val": 400, "form": "10-Q", "filed": "2025-05-01"},
        ])

        self.assertEqual(etl_pipeline.instant_gaap_pair(facts, ["Assets"]), (500, 400))

    def test_missing_comparable_period_is_nan(self):
        facts = companyfacts("Revenues", [
            {
                "start": "2024-01-01", "end": "2024-12-31",
                "val": 100, "form": "10-K", "filed": "2025-02-01",
            },
            {
                "start": "2022-01-01", "end": "2022-12-31",
                "val": 80, "form": "10-K", "filed": "2023-02-01",
            },
        ])

        latest, previous = etl_pipeline.annual_gaap_pair(facts, ["Revenues"])
        self.assertEqual(latest, 100)
        self.assertTrue(math.isnan(previous))


if __name__ == "__main__":
    unittest.main()
