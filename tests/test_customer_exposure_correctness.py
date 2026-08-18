import os
import sys
import types
import unittest
from datetime import date
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

try:
    import psycopg2.extras  # noqa: F401
except ImportError:
    psycopg2_stub = types.ModuleType("psycopg2")
    psycopg2_stub.__path__ = []
    psycopg2_stub.Error = type("DatabaseError", (Exception,), {})
    psycopg2_stub.OperationalError = type("OperationalError", (psycopg2_stub.Error,), {})
    extras_stub = types.ModuleType("psycopg2.extras")
    extras_stub.execute_values = lambda *args, **kwargs: None
    extras_stub.Json = lambda value: value
    psycopg2_stub.extras = extras_stub
    sys.modules["psycopg2"] = psycopg2_stub
    sys.modules["psycopg2.extras"] = extras_stub

if not hasattr(psycopg2, "Error"):
    psycopg2.Error = type("DatabaseError", (Exception,), {})

try:
    import requests  # noqa: F401
except ImportError:
    requests_stub = types.ModuleType("requests")
    requests_stub.RequestException = type("RequestException", (Exception,), {})
    requests_stub.get = lambda *args, **kwargs: None
    sys.modules["requests"] = requests_stub

previous_transcript_stress = sys.modules.get("transcript_stress")
transcript_stress_stub = types.ModuleType("transcript_stress")
transcript_stress_stub.get_universe = lambda: []
transcript_stress_stub.call_gemini = lambda prompt: []
transcript_stress_stub.connect_db = lambda database_url: None
transcript_stress_stub.GEMINI_API_KEY = None
sys.modules["transcript_stress"] = transcript_stress_stub

import customer_exposure

if previous_transcript_stress is None:
    del sys.modules["transcript_stress"]
else:
    sys.modules["transcript_stress"] = previous_transcript_stress


SINGLE_EXCERPT = (
    "For the year ended December 31, 2025, Customer A accounted for 23% "
    "of total revenue."
)


def disclosure(**overrides):
    row = {
        "label": "Customer A",
        "ticker": None,
        "pct": 23.0,
        "basis": "revenue",
        "period": "year ended December 31, 2025",
        "quote": SINGLE_EXCERPT,
        "form": "10-K",
        "url": "https://www.sec.gov/example",
        "filed": "2026-02-20",
        "accession": "0000000000-26-000010",
    }
    row.update(overrides)
    return row


def disclosure_heavy_filing():
    clauses = [SINGLE_EXCERPT]
    clauses.extend(
        f"For the year ended December 31, 2025, Customer {index} accounted "
        f"for {10 + index}% of total revenue."
        for index in range(1, 12)
    )
    return ("x" * 1000).join(clauses), clauses


class FakeCursor:
    def __init__(self, fetchall_rows=None):
        self.execute_calls = []
        self.fetchall_rows = list(fetchall_rows or [])

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        self.execute_calls.append((sql, params))

    def fetchall(self):
        return list(self.fetchall_rows)


class FakeConnection:
    def __init__(self, fetchall_rows=None):
        self.cursor_instance = FakeCursor(fetchall_rows)
        self.commits = 0
        self.rollbacks = 0
        self.closes = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closes += 1


class CustomerExposureCorrectnessTests(unittest.TestCase):
    def test_workflow_serializes_customer_exposure_runs(self):
        workflow = (
            Path(__file__).resolve().parents[1]
            / ".github" / "workflows" / "customer-exposure.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("group: customer-exposure-etl", workflow)
        self.assertIn("cancel-in-progress: false", workflow)

    def test_customer_aliases_require_token_boundaries(self):
        self.assertIsNone(customer_exposure.map_customer("Amdocs Limited"))
        self.assertIsNone(customer_exposure.map_customer("Metal Technologies"))
        self.assertEqual(customer_exposure.map_customer("Amazon.com, Inc."), "AMZN")
        self.assertEqual(customer_exposure.map_customer("Advanced Micro Devices"), "AMD")
        self.assertEqual(customer_exposure.map_customer("Meta Platforms, Inc."), "META")

    def test_statement_semantics_distinguish_single_aggregate_threshold_and_negative(self):
        self.assertEqual(
            customer_exposure.statement_semantics(
                "Customer A accounted for 23% of total revenue."
            ),
            "single_customer",
        )
        self.assertEqual(
            customer_exposure.statement_semantics(
                "Our three largest customers collectively accounted for 42% of revenue."
            ),
            "aggregate",
        )
        self.assertEqual(
            customer_exposure.statement_semantics(
                "Customer A and B accounted for 31% of revenue."
            ),
            "aggregate",
        )
        self.assertEqual(
            customer_exposure.statement_semantics(
                "A major customer is one that accounts for 10% or more of revenue."
            ),
            "threshold",
        )
        self.assertEqual(
            customer_exposure.statement_semantics(
                "No single customer accounted for more than 10% of revenue."
            ),
            "negative",
        )

    def test_growth_rate_is_not_customer_concentration(self):
        quote = "Revenue from Customer A increased 25% in fiscal 2025."
        model_row = {
            "customer": "Customer A",
            "pct": 25,
            "basis": "revenue",
            "period": "fiscal 2025",
            "quote": quote,
        }

        self.assertEqual(customer_exposure.statement_semantics(quote), "unknown")
        with mock.patch.object(customer_exposure, "call_gemini", return_value=[model_row]):
            self.assertEqual(
                customer_exposure.extract_disclosures("TEST", "10-K", [quote]),
                [],
            )

    def test_unrelated_no_customer_clause_cannot_clear_positive_exposure(self):
        quote = (
            "No single customer caused the delay. Revenue increased 25% "
            "in fiscal 2025."
        )
        model_row = {
            "statement_type": "negative",
            "pct": 25,
            "basis": "revenue",
            "period": "fiscal 2025",
            "quote": quote,
        }

        self.assertEqual(customer_exposure.statement_semantics(quote), "unknown")
        with mock.patch.object(customer_exposure, "call_gemini", return_value=[model_row]):
            observations = customer_exposure.extract_disclosures(
                "TEST", "10-K", [quote]
            )
        self.assertEqual(observations, [])
        self.assertEqual(
            customer_exposure.explicit_negative_tickers({"TEST": observations}),
            set(),
        )

    def test_extraction_accepts_only_normalized_verbatim_single_customer_quotes(self):
        model_row = {
            "customer": "Customer A",
            "pct": 23,
            "basis": "revenue",
            "period": "year ended December 31, 2025",
            "quote": "For the year ended December 31, 2025,  Customer A accounted "
                     "for 23% of total revenue.",
        }
        with mock.patch.object(customer_exposure, "call_gemini", return_value=[model_row]):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [SINGLE_EXCERPT]
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["pct"], 23.0)
        self.assertEqual(rows[0]["period"], "year ended December 31, 2025")

        hallucinated = dict(model_row, quote=model_row["quote"].replace("23%", "24%"), pct=24)
        diagnostics = {}
        with mock.patch.object(customer_exposure, "call_gemini", return_value=[hallucinated]):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [SINGLE_EXCERPT], diagnostics=diagnostics
            )
        self.assertEqual(rows, [])
        self.assertEqual(diagnostics["dropped_rows"], 1)

    def test_swapped_customer_and_percentage_across_sentences_are_rejected(self):
        period = "year ended December 31, 2025"
        quote = (
            f"Revenue from Customer A increased 25% for the {period}. "
            f"Customer B accounted for 12% of revenue for the {period}."
        )
        swapped_rows = [
            {"customer": "Customer A", "pct": 12, "basis": "revenue", "period": period, "quote": quote},
            {"customer": "Customer B", "pct": 25, "basis": "revenue", "period": period, "quote": quote},
        ]
        for model_row in swapped_rows:
            with (
                self.subTest(customer=model_row["customer"], pct=model_row["pct"]),
                mock.patch.object(customer_exposure, "call_gemini", return_value=[model_row]),
            ):
                diagnostics = {}
                rows = customer_exposure.extract_disclosures(
                    "TEST", "10-K", [quote], diagnostics=diagnostics
                )
                self.assertEqual(rows, [])
                self.assertEqual(diagnostics["dropped_rows"], 1)

    def test_selected_percentage_must_follow_the_allocation_verb(self):
        quote = (
            "Revenue from Customer A increased 25%, while it accounted for "
            "12% of revenue in fiscal 2025."
        )
        base = {
            "customer": "Customer A",
            "basis": "revenue",
            "period": "fiscal 2025",
            "quote": quote,
        }
        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=[dict(base, pct=25)]
        ):
            diagnostics = {}
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [quote], report_date="2025-09-30",
                diagnostics=diagnostics,
            )
        self.assertEqual(rows, [])
        self.assertEqual(diagnostics["dropped_rows"], 1)
        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=[dict(base, pct=12)]
        ):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [quote], report_date="2025-09-30"
            )
        self.assertEqual(rows[0]["pct"], 12)

    def test_allocation_grammar_accepts_real_disclosure_shapes(self):
        nvda_participle = (
            "we generate a significant amount of our revenue from a limited "
            "number of indirect customers, some individually representing 10% "
            "or more of our revenue."
        )
        intc_table = (
            "our three largest customers accounted for the following percentages "
            "of our net revenue: years ended dec 27, 2025 ... customer a 19 % 19 % "
            "19 % customer b 12 % 14 % 11 % ..."
        )
        intc_receivables = (
            "we believe the net accounts receivable balances from our three "
            "largest customers ( 47 % as of december 27, 2025 and december 28, "
            "2024) do not represent a significant credit risk..."
        )
        cases = (
            ("participle", nvda_participle, [10.0]),
            ("table", intc_table, [19.0, 19.0, 19.0, 12.0, 14.0, 11.0]),
            ("receivables", intc_receivables, [47.0]),
        )

        for shape, quote, expected in cases:
            with self.subTest(shape=shape):
                self.assertEqual(
                    customer_exposure._allocation_percentage_values(quote),
                    expected,
                )
                self.assertEqual(
                    customer_exposure.statement_semantics(quote),
                    "single_customer",
                )
        self.assertTrue(
            customer_exposure._basis_in_clause(
                intc_receivables, "accounts_receivable"
            )
        )
        self.assertFalse(
            customer_exposure._basis_in_clause(intc_receivables, "revenue")
        )

    def test_allocation_grammar_rejects_growth_and_geographic_percentages(self):
        non_allocations = (
            "dcai revenue increased 5% from 2024 driven by higher server revenue "
            "due to higher hyperscale customer-related demand",
            "our revenue from sales of products and provision of services to "
            "customers in china was 30%, 33% and 43% for fiscal years 2026, 2025 "
            "and 12 table of contents 2024, respectively",
        )

        for quote in non_allocations:
            with self.subTest(quote=quote):
                self.assertEqual(
                    customer_exposure._allocation_percentage_values(quote), []
                )

    def test_real_disclosure_shapes_survive_full_validation(self):
        nvda_sentence = (
            "we generate a significant amount of our revenue from a limited "
            "number of indirect customers, some individually representing 10% "
            "or more of our revenue."
        )
        cases = (
            (
                "participle",
                f"For fiscal 2025, {nvda_sentence}",
                {
                    "customer": "unnamed customer", "pct": 10,
                    "basis": "revenue", "period": "fiscal 2025",
                },
                "2025-01-26",
            ),
            (
                "table",
                "our three largest customers accounted for the following "
                "percentages of our net revenue: years ended dec 27, 2025 "
                "customer a 19 % 19 % 19 % customer b 12 % 14 % 11 %",
                {
                    "customer": "customer a", "pct": 19,
                    "basis": "revenue",
                    "period": "years ended dec 27, 2025",
                },
                "2025-12-27",
            ),
            (
                "named table",
                "our three largest customers accounted for the following "
                "percentages of our net revenue: years ended dec 27, 2025 "
                "microsoft 19 % google 12 %",
                {
                    "customer": "microsoft", "pct": 19,
                    "basis": "revenue",
                    "period": "years ended dec 27, 2025",
                },
                "2025-12-27",
            ),
            (
                "each",
                "two customers each accounted for 10% or more of our net sales "
                "for the quarter ended March 29, 2025.",
                {
                    "customer": "unnamed customer", "pct": 10,
                    "basis": "revenue",
                    "period": "quarter ended March 29, 2025",
                },
                "2025-03-29",
            ),
        )

        for shape, quote, model_row, report_date in cases:
            with (
                self.subTest(shape=shape),
                mock.patch.object(
                    customer_exposure,
                    "call_gemini",
                    return_value=[dict(model_row, quote=quote)],
                ),
            ):
                diagnostics = {}
                rows = customer_exposure.extract_disclosures(
                    "TEST", "10-K", [quote], report_date=report_date,
                    diagnostics=diagnostics,
                )

                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["label"], model_row["customer"])
                self.assertEqual(rows[0]["pct"], model_row["pct"])
                self.assertEqual(diagnostics["dropped_rows"], 0)

    def test_numbered_customer_lists_stage_each_listed_percentage(self):
        cases = (
            (
                "NVDA receivables",
                "Three direct customers accounted for 30 %, 18 %, and 16 % of "
                "our accounts receivable balance as of April 26, 2026.",
                (30, 18, 16),
                "accounts_receivable",
                "as of April 26, 2026",
                "2026-04-26",
                date(2026, 4, 26),
            ),
            (
                "AMAT revenue",
                "Two customers accounted for approximately 21 % and 15 %, "
                "respectively, of our revenue for the six months ended April "
                "26, 2026.",
                (21, 15),
                "revenue",
                "six months ended April 26, 2026",
                "2026-04-26",
                date(2026, 4, 26),
            ),
            (
                "LRCX receivables",
                "As of June 28, 2026, five customers accounted for approximately "
                "20 %, 16 %, 15 %, 11 %, and 10 % of accounts receivable, "
                "respectively.",
                (20, 16, 15, 11, 10),
                "accounts_receivable",
                "As of June 28, 2026",
                "2026-06-28",
                date(2026, 6, 28),
            ),
            (
                "NVDA revenue",
                "For the first quarter of fiscal year 2027, three direct "
                "customers represented 21 %, 17 %, and 16 % of total revenue",
                (21, 17, 16),
                "revenue",
                "first quarter of fiscal year 2027",
                "2026-04-26",
                date(2026, 4, 26),
            ),
        )

        for shape, quote, percentages, basis, period, report_date, period_end in cases:
            model_rows = [
                {
                    "customer": "unnamed customer", "pct": pct,
                    "basis": basis, "period": period, "quote": quote,
                }
                for pct in percentages
            ]
            with (
                self.subTest(shape=shape),
                mock.patch.object(
                    customer_exposure, "call_gemini", return_value=model_rows
                ),
            ):
                diagnostics = {}
                rows = customer_exposure.extract_disclosures(
                    "TEST", "10-Q", [quote], report_date=report_date,
                    diagnostics=diagnostics,
                )

                self.assertEqual([row["pct"] for row in rows], list(percentages))
                self.assertEqual({row["label"] for row in rows}, {"unnamed customer"})
                self.assertEqual({row["period_end"] for row in rows}, {period_end})
                self.assertEqual(diagnostics["dropped_rows"], 0)

    def test_negative_subject_variants_stage_negative_markers(self):
        cases = (
            (
                "MSFT",
                "No sales to an individual customer or country other than the "
                "United States accounted for more than 10% of revenue for fiscal "
                "years 2026, 2025, or 2024.",
                ("fiscal years 2026", "2025", "2024"),
                "2026-06-30",
            ),
            (
                "GOOG",
                "No in dividual customer or groups of affiliated customers "
                "represented more than 10% of our revenues in 2023",
                ("2023",),
                "2023-12-31",
            ),
            (
                "AMAT",
                "No other customer accounted for greater than 10% of our revenue "
                "for the six months ended April 26, 2026.",
                ("six months ended April 26, 2026",),
                "2026-04-26",
            ),
        )

        for ticker, quote, periods, report_date in cases:
            model_rows = [
                {
                    "statement_type": "negative", "pct": 10,
                    "basis": "revenue", "period": period, "quote": quote,
                }
                for period in periods
            ]
            with (
                self.subTest(ticker=ticker),
                mock.patch.object(
                    customer_exposure, "call_gemini", return_value=model_rows
                ),
            ):
                diagnostics = {}
                rows = customer_exposure.extract_disclosures(
                    ticker, "10-K", [quote], report_date=report_date,
                    diagnostics=diagnostics,
                )

                self.assertEqual(len(rows), len(model_rows))
                self.assertTrue(all(
                    row["statement_type"] == "negative" for row in rows
                ))
                self.assertEqual(diagnostics["dropped_rows"], 0)

    def test_compound_customer_allocations_bind_each_label_to_its_value(self):
        quote = (
            "One customer accounted for approximately 11 % and another customer "
            "accounted for 24 % of the total consolidated accounts receivable "
            "balance as of December 27, 2025"
        )
        base_rows = (
            {"customer": "one customer", "pct": 11},
            {"customer": "another customer", "pct": 24},
        )
        model_rows = [dict(
            row, basis="accounts_receivable",
            period="as of December 27, 2025", quote=quote,
        ) for row in base_rows]
        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=model_rows
        ):
            rows = customer_exposure.extract_disclosures(
                "AMD", "10-K", [quote], report_date="2025-12-27"
            )

        self.assertEqual(
            [(row["label"], row["pct"]) for row in rows],
            [("one customer", 11), ("another customer", 24)],
        )

        swapped_rows = [dict(row, pct=35 - row["pct"]) for row in model_rows]
        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=swapped_rows
        ):
            diagnostics = {}
            rows = customer_exposure.extract_disclosures(
                "AMD", "10-K", [quote], report_date="2025-12-27",
                diagnostics=diagnostics,
            )
        self.assertEqual(rows, [])
        self.assertEqual(diagnostics["dropped_rows"], 2)

    def test_basis_from_customer_values_bind_respective_periods(self):
        quote = (
            "Revenue from one customer was 10 % and 16 % (primarily included in "
            "the CMBU segment) of total revenue for the first nine months of 2026 "
            "and 2025, respectively."
        )
        model_rows = [
            {
                "customer": "one customer", "pct": 10, "basis": "revenue",
                "period": "first nine months of 2026", "quote": quote,
            },
            {
                "customer": "one customer", "pct": 16, "basis": "revenue",
                "period": "2025", "quote": quote,
            },
        ]
        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=model_rows
        ):
            rows = customer_exposure.extract_disclosures(
                "MU", "10-Q", [quote], report_date="2026-05-28"
            )

        self.assertEqual(
            [(row["pct"], row["period"], row["period_end"]) for row in rows],
            [
                (10, "first nine months of 2026", date(2026, 5, 28)),
                (16, "2025", date(2025, 5, 28)),
            ],
        )

        swapped_rows = [
            dict(model_rows[0], period="2025"),
            dict(model_rows[1], period="first nine months of 2026"),
        ]
        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=swapped_rows
        ):
            diagnostics = {}
            rows = customer_exposure.extract_disclosures(
                "MU", "10-Q", [quote], report_date="2026-05-28",
                diagnostics=diagnostics,
            )
        self.assertEqual(rows, [])
        self.assertEqual(diagnostics["dropped_rows"], 2)

    def test_period_date_anchor_accepts_singular_model_period(self):
        quote = (
            "No customer represented 10% or more of total revenue or accounts "
            "receivable for the years ended December 31, 2025, 2024, and 2023."
        )
        model_rows = [
            {
                "statement_type": "negative", "pct": 10, "basis": basis,
                "period": "year ended December 31, 2025", "quote": quote,
            }
            for basis in ("revenue", "accounts_receivable")
        ]
        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=model_rows
        ):
            rows = customer_exposure.extract_disclosures(
                "META", "10-K", [quote], report_date="2025-12-31"
            )

        self.assertEqual(len(rows), 2)
        self.assertEqual(
            {row["period_end"] for row in rows}, {date(2025, 12, 31)}
        )

    def test_table_prompt_requires_context_and_bare_cells_still_fail(self):
        self.assertIn(
            "table's verbatim lead-in or column context naming the basis and "
            "exact period alongside the customer row values",
            customer_exposure.EXTRACT_PROMPT,
        )
        bare_cells = ("Customer A 22 %", "Direct Customer: Customer A 16% 16%")
        for quote in bare_cells:
            model_row = {
                "customer": "Customer A", "pct": 22 if "22" in quote else 16,
                "basis": "revenue", "period": "fiscal 2026", "quote": quote,
            }
            with (
                self.subTest(quote=quote),
                mock.patch.object(
                    customer_exposure, "call_gemini", return_value=[model_row]
                ),
            ):
                self.assertEqual(
                    customer_exposure.extract_disclosures(
                        "TEST", "10-K", [quote], report_date="2026-12-31"
                    ),
                    [],
                )

    def test_table_breakout_binds_each_customer_to_its_values(self):
        quote = (
            "our three largest customers accounted for the following percentages "
            "of our net revenue: years ended dec 27, 2025 customer a 19 % 19 % "
            "19 % customer b 12 % 14 % 11 %"
        )
        swapped_rows = (
            {"customer": "customer a", "pct": 12},
            {"customer": "customer b", "pct": 19},
        )

        for model_row in swapped_rows:
            model_row.update({
                "basis": "revenue", "period": "years ended dec 27, 2025",
                "quote": quote,
            })
            with (
                self.subTest(customer=model_row["customer"]),
                mock.patch.object(
                    customer_exposure, "call_gemini", return_value=[model_row]
                ),
            ):
                diagnostics = {}
                rows = customer_exposure.extract_disclosures(
                    "TEST", "10-K", [quote], report_date="2025-12-27",
                    diagnostics=diagnostics,
                )

                self.assertEqual(rows, [])
                self.assertEqual(diagnostics["dropped_rows"], 1)

    def test_each_construction_cannot_borrow_another_customer_allocation(self):
        quote = (
            "two customers each accounted for support, while Customer A "
            "represented 10% of revenue for fiscal 2025."
        )
        model_row = {
            "customer": "unnamed customer", "pct": 10, "basis": "revenue",
            "period": "fiscal 2025", "quote": quote,
        }

        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=[model_row]
        ):
            diagnostics = {}
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [quote], report_date="2025-12-31",
                diagnostics=diagnostics,
            )

        self.assertEqual(rows, [])
        self.assertEqual(diagnostics["dropped_rows"], 1)

    def test_participle_negative_survives_full_validation(self):
        quote = (
            "For fiscal 2025, no individual customer was identified as "
            "individually representing 10% or more of revenue."
        )
        model_row = {
            "statement_type": "negative", "pct": 10, "basis": "revenue",
            "period": "fiscal 2025", "quote": quote,
        }

        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=[model_row]
        ):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [quote], report_date="2025-12-31"
            )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["statement_type"], "negative")

    def test_non_allocation_controls_fail_full_validation(self):
        cases = (
            (
                "collective",
                "three customers collectively accounted for approximately 40% "
                "of our revenues",
                40,
                "fiscal 2025",
            ),
            (
                "growth",
                "dcai revenue increased 5% from 2024 driven by higher server "
                "revenue due to higher hyperscale customer-related demand",
                5,
                "2024",
            ),
            (
                "geographic",
                "our revenue from sales of products and provision of services to "
                "customers in china was 30%, 33% and 43% for fiscal years 2026, "
                "2025 and 12 table of contents 2024, respectively",
                30,
                "fiscal years 2026",
            ),
            (
                "countries",
                "Net revenue for individual countries included in Other did not "
                "exceed 10% of the Company s net revenue for any of the fiscal "
                "periods presented.",
                10,
                "fiscal periods presented",
            ),
            (
                "single aggregate total",
                "two customers accounted for 30% of revenue in aggregate",
                30,
                "fiscal 2025",
            ),
            (
                "count mismatch",
                "three customers accounted for 30% and 20% of revenue in fiscal 2025",
                30,
                "fiscal 2025",
            ),
        )

        for shape, quote, pct, period in cases:
            model_row = {
                "customer": "Customer A", "pct": pct, "basis": "revenue",
                "period": period, "quote": quote,
            }
            with (
                self.subTest(shape=shape),
                mock.patch.object(
                    customer_exposure, "call_gemini", return_value=[model_row]
                ),
                mock.patch("builtins.print") as output,
            ):
                diagnostics = {}
                rows = customer_exposure.extract_disclosures(
                    "TEST", "10-K", [quote], report_date="2026-12-31",
                    diagnostics=diagnostics,
                )

                self.assertEqual(rows, [])
                self.assertEqual(diagnostics["dropped_rows"], 1)
                self.assertIn(
                    "is not a qualifying allocation statement",
                    output.call_args.args[0],
                )

    def test_plural_revenues_is_valid_basis_language(self):
        quote = "Customer A accounted for 23% of revenues in fiscal 2025."
        model_row = {
            "customer": "Customer A", "pct": 23, "basis": "revenue",
            "period": "fiscal 2025", "quote": quote,
        }
        with mock.patch.object(customer_exposure, "call_gemini", return_value=[model_row]):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [quote], report_date="2025-09-30"
            )
        self.assertEqual(rows[0]["basis"], "revenue")

    def test_mixed_model_rows_drop_invalid_rows_and_keep_valid_row(self):
        no_end_quote = (
            "Customer B accounted for 18% of revenue in fiscal 2025."
        )
        allocation_quote = (
            "Revenue from Customer A increased 25% for the year ended "
            "December 31, 2025. Customer B accounted for 12% of revenue "
            "for the year ended December 31, 2025."
        )
        model_rows = [
            {
                "customer": "Customer A", "pct": 23, "basis": "revenue",
                "period": "year ended December 31, 2025",
                "quote": SINGLE_EXCERPT,
            },
            {
                "customer": "Customer A", "pct": 23, "basis": "revenue",
                "period": "year ended December 30, 2025",
                "quote": SINGLE_EXCERPT,
            },
            {
                "customer": "Customer B", "pct": 18, "basis": "revenue",
                "period": "fiscal 2025", "quote": no_end_quote,
            },
            {
                "customer": "Customer A", "pct": 12, "basis": "revenue",
                "period": "year ended December 31, 2025",
                "quote": allocation_quote,
            },
            {
                "customer": "Customer A", "pct": 0, "basis": "revenue",
                "period": "year ended December 31, 2025",
                "quote": SINGLE_EXCERPT,
            },
            {
                "customer": "Customer A", "pct": 10 ** 1000,
                "basis": "revenue",
                "period": "year ended December 31, 2025",
                "quote": SINGLE_EXCERPT,
            },
        ]
        diagnostics = {}
        excerpts = [SINGLE_EXCERPT, no_end_quote, allocation_quote]
        with (
            mock.patch.object(
                customer_exposure, "call_gemini", return_value=model_rows
            ),
            mock.patch("builtins.print") as output,
        ):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", excerpts, diagnostics=diagnostics
            )

        self.assertEqual([row["label"] for row in rows], ["Customer A"])
        self.assertEqual(diagnostics["dropped_rows"], 5)
        self.assertEqual(output.call_count, 5)
        logs = "\n".join(call.args[0] for call in output.call_args_list)
        self.assertIn("model row 1 period is not verbatim", logs)
        self.assertIn("model row 2 period has no explicit end date", logs)
        self.assertIn("model row 3 fields do not share one allocation clause", logs)
        self.assertIn("model row 4 pct must be between 1 and 100", logs)
        self.assertIn("model row 5 has an invalid pct", logs)

    def test_dropped_row_quote_logs_are_capped_without_capping_diagnostics(self):
        quote = SINGLE_EXCERPT[:-1] + " " + ("x" * 180) + " TAIL_SENTINEL."
        model_rows = [dict(
            customer="Customer A", pct=0, basis="revenue",
            period="year ended December 31, 2025", quote=quote,
        ) for _ in range(25)]
        diagnostics = {}
        drop_log_state = {}

        with (
            mock.patch.object(
                customer_exposure, "call_gemini",
                side_effect=[model_rows[:20], model_rows[20:]],
            ),
            mock.patch("builtins.print") as output,
        ):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [quote], diagnostics=diagnostics,
                _drop_log_state=drop_log_state,
            )
            rows.extend(customer_exposure.extract_disclosures(
                "TEST", "10-Q", [quote], diagnostics=diagnostics,
                _drop_log_state=drop_log_state,
            ))

        self.assertEqual(rows, [])
        self.assertEqual(diagnostics["dropped_rows"], 25)
        self.assertEqual(output.call_count, 20)
        first_log = output.call_args_list[0].args[0]
        self.assertIn("model row 0 pct must be between 1 and 100", first_log)
        self.assertIn(f":: {quote[:160]}", first_log)
        logs = "\n".join(call.args[0] for call in output.call_args_list)
        self.assertIn("dropped model row 19", logs)
        self.assertNotIn("dropped model row 20", logs)
        self.assertNotIn("TEST 10-Q", logs)
        self.assertNotIn("TAIL_SENTINEL", logs)

    def test_respective_multi_customer_pairs_are_bound_without_swaps(self):
        period = "year ended December 31, 2025"
        cases = [
            (
                f"Customer A and Customer B accounted for 25% and 18% of revenues, "
                f"respectively, for the {period}.",
                ("Customer A", "Customer B"),
            ),
            (
                f"Customers A and B accounted for 25% and 18% of revenues, "
                f"respectively, for the {period}.",
                ("A", "B"),
            ),
        ]
        for quote, labels in cases:
            model_rows = [
                {"customer": labels[0], "pct": 25, "basis": "revenue", "period": period, "quote": quote},
                {"customer": labels[1], "pct": 18, "basis": "revenue", "period": period, "quote": quote},
            ]
            with (
                self.subTest(quote=quote),
                mock.patch.object(customer_exposure, "call_gemini", return_value=model_rows),
            ):
                self.assertEqual(
                    customer_exposure.statement_semantics(quote),
                    "single_customer",
                )
                rows = customer_exposure.extract_disclosures(
                    "TEST", "10-K", [quote], report_date="2025-12-31"
                )
                self.assertEqual(
                    [(row["label"], row["pct"]) for row in rows],
                    [(labels[0], 25), (labels[1], 18)],
                )

        swapped = {
            "customer": "Customer A", "pct": 18, "basis": "revenue",
            "period": period, "quote": cases[0][0],
        }
        with mock.patch.object(customer_exposure, "call_gemini", return_value=[swapped]):
            diagnostics = {}
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [cases[0][0]], report_date="2025-12-31",
                diagnostics=diagnostics,
            )
        self.assertEqual(rows, [])
        self.assertEqual(diagnostics["dropped_rows"], 1)

        aggregate = (
            f"Customer A and Customer B collectively accounted for 43% of revenue "
            f"for the {period}."
        )
        self.assertEqual(customer_exposure.statement_semantics(aggregate), "aggregate")

    def test_extraction_drops_aggregate_and_threshold_statements(self):
        candidates = [
            {
                "quote": "Our top three customers collectively accounted for 42% of revenue in fiscal 2025.",
            },
            {
                "quote": "A major customer is one that accounts for 10% or more of revenue in fiscal 2025.",
            },
        ]
        excerpts = [candidate["quote"] for candidate in candidates]
        with mock.patch.object(customer_exposure, "call_gemini", return_value=candidates):
            self.assertEqual(
                customer_exposure.extract_disclosures("TEST", "10-K", excerpts),
                [],
            )

    def test_newer_negative_observation_suppresses_older_positive_vintage(self):
        positive_quote = (
            "For fiscal 2025, Customer A accounted for 23% of total revenue."
        )
        negative_quote = (
            "For fiscal 2026, no single customer accounted for more than 10% "
            "of total revenue."
        )
        model_rows = [
            {
                "customer": "Customer A",
                "pct": 23,
                "basis": "revenue",
                "period": "fiscal 2025",
                "quote": positive_quote,
            },
            {
                "pct": 10,
                "basis": "revenue",
                "period": "fiscal 2026",
                "quote": negative_quote,
            },
        ]
        with mock.patch.object(customer_exposure, "call_gemini", return_value=model_rows):
            observations = customer_exposure.extract_disclosures(
                "TEST", "10-K", [positive_quote, negative_quote],
                report_date="2026-12-31",
            )
        for row in observations:
            row.update({
                "form": "10-K",
                "url": "https://sec/annual",
                "filed": "2027-02-20",
                "accession": "0000000000-27-000010",
            })

        self.assertEqual(
            [row["statement_type"] for row in observations],
            ["single_customer", "negative"],
        )
        selected = customer_exposure.best_rows(observations)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["statement_type"], "negative")
        self.assertFalse(any(
            row["statement_type"] == "single_customer" for row in selected
        ))

        conn = FakeConnection()
        with mock.patch.object(customer_exposure.psycopg2.extras, "execute_values") as insert:
            customer_exposure.load_ticker(conn, "TEST", selected)
        self.assertEqual(insert.call_args.args[2][0][5], "negative")
        projected = customer_exposure.enforce_positive_retention(
            {"TEST"},
            {"TEST": selected},
            1.0,
            provider_coverage=0.90,
            minimum_provider_coverage=0.90,
        )
        self.assertEqual(projected, set())

    def test_best_rows_selects_newest_period_then_newest_accession_deterministically(self):
        rows = [
            disclosure(
                pct=30,
                period="year ended December 31, 2025",
                filed="2026-02-20",
                accession="0000000000-26-000010",
            ),
            disclosure(
                pct=18,
                period="three months ended June 30, 2026",
                filed="2026-08-01",
                accession="0000000000-26-000020",
            ),
            disclosure(
                pct=19,
                period="three months ended June 30, 2026",
                filed="2026-08-10",
                accession="0000000000-26-000021",
                form="10-Q/A",
            ),
        ]

        selected = customer_exposure.best_rows([rows[1], rows[0], rows[2]])

        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["pct"], 19)
        self.assertEqual(selected[0]["accession"], "0000000000-26-000021")

    def test_best_rows_drops_other_customers_from_older_global_vintage(self):
        old_customer = disclosure(
            label="Customer A",
            pct=45,
            period="year ended December 31, 2023",
            filed="2024-02-20",
            accession="0000000000-24-000010",
        )
        current_customer = disclosure(
            label="Customer B",
            pct=16,
            period="three months ended June 30, 2026",
            filed="2026-08-10",
            accession="0000000000-26-000021",
        )

        selected = customer_exposure.best_rows([current_customer, old_customer])

        self.assertEqual([row["label"] for row in selected], ["Customer B"])

    def test_monotonic_guard_rejects_staged_2024_positive_over_stored_2025(self):
        stored = disclosure(period_end=date(2025, 12, 31))
        staged = disclosure(
            period="year ended December 31, 2024",
            period_end=date(2024, 12, 31),
            filed="2025-02-20",
            accession="0000000000-25-000010",
        )
        accepted, rejected = customer_exposure.filter_monotonic_staged_rows(
            {"TEST": [staged]}, {("TEST", "revenue"): stored}
        )
        self.assertEqual(accepted, {})
        self.assertIn("TEST", rejected)

    def test_monotonic_guard_rejects_staged_2024_negative_over_stored_2025(self):
        stored = disclosure(period_end=date(2025, 12, 31))
        staged = disclosure(
            label="__negative__", pct=10, statement_type="negative",
            period="year ended December 31, 2024",
            period_end=date(2024, 12, 31),
            filed="2025-02-20",
            accession="0000000000-25-000010",
        )
        accepted, rejected = customer_exposure.filter_monotonic_staged_rows(
            {"TEST": [staged]}, {("TEST", "revenue"): stored}
        )
        self.assertEqual(accepted, {})
        self.assertIn("TEST", rejected)

    def test_later_filed_q1_empty_cannot_replace_stored_q2_positive(self):
        stored = disclosure(
            period_end=date(2026, 6, 30), filed="2026-08-01",
            accession="0000000000-26-000020",
        )
        q1_empty = customer_exposure.confirmed_empty_markers([{
            "form": "10-Q/A",
            "accession": "0000000000-26-000099",
            "url": "https://sec/q1-amendment",
            "filed": "2026-09-01",
            "report_date": "2026-03-31",
        }], present_bases={"accounts_receivable"})
        accepted, rejected = customer_exposure.filter_monotonic_staged_rows(
            {"TEST": q1_empty}, {("TEST", "revenue"): stored}
        )
        self.assertEqual(accepted, {})
        self.assertIn("TEST", rejected)

    def test_same_vintage_empty_or_negative_cannot_clear_stored_positive(self):
        stored = disclosure(
            statement_type="single_customer", period_end=date(2025, 12, 31),
            filed="2026-02-20", accession="0000000000-26-000010",
        )
        empty = disclosure(
            label="__confirmed_empty__", ticker=None, pct=0,
            statement_type="confirmed_empty", period_end=date(2025, 12, 31),
            filed="2026-02-20", accession="0000000000-26-000010",
        )
        negative = disclosure(
            label="__negative__", ticker=None, pct=10,
            statement_type="negative", period_end=date(2025, 12, 31),
            filed="2026-02-20", accession="0000000000-26-000010",
        )
        for staged in (empty, negative):
            with self.subTest(statement_type=staged["statement_type"]):
                accepted, rejected = customer_exposure.filter_monotonic_staged_rows(
                    {"TEST": [staged]}, {("TEST", "revenue"): stored}
                )
                self.assertEqual(accepted, {})
                self.assertRegex(
                    rejected["TEST"][0],
                    r"same-vintage non-scoring result cannot clear stored evidence",
                )

    def test_locked_publish_recheck_rejects_concurrently_newer_vintage_before_delete(self):
        conn = FakeConnection(fetchall_rows=[(
            "TEST", "revenue", "single_customer", date(2025, 12, 31),
            date(2026, 2, 20), "0000000000-26-000010",
        )])
        staged = disclosure(
            period="year ended December 31, 2024",
            period_end=date(2024, 12, 31),
            filed="2025-02-20",
            accession="0000000000-25-000010",
        )

        with mock.patch.object(
            customer_exposure.psycopg2.extras, "execute_values"
        ) as insert:
            with self.assertRaisesRegex(
                customer_exposure.ExposurePublishRegression,
                "locked vintage recheck",
            ):
                customer_exposure.load_ticker(conn, "TEST", [staged])

        queries = [sql for sql, _ in conn.cursor_instance.execute_calls]
        self.assertIn("pg_advisory_xact_lock", queries[0])
        self.assertFalse(any("DELETE FROM customer_exposure" in sql for sql in queries))
        insert.assert_not_called()
        self.assertEqual(conn.commits, 0)
        self.assertEqual(conn.rollbacks, 1)

    def test_newer_empty_annual_marker_beats_older_quarter_positive(self):
        filings = [
            ("10-K", "0000000000-27-000010", "annual.htm", "2027-02-20", "2026-12-31"),
            ("10-Q", "0000000000-26-000020", "quarter.htm", "2026-08-01", "2026-06-30"),
        ]
        quarter_row = disclosure(
            pct=18, period="three months ended June 30, 2026",
            period_end=date(2026, 6, 30), statement_type="single_customer",
        )
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure, "fetch_filing_text",
                side_effect=[("Annual filing without concentration.", "https://sec/annual"), (SINGLE_EXCERPT, "https://sec/quarter")],
            ),
            mock.patch.object(
                customer_exposure, "concentration_windows",
                side_effect=[([], False), ([SINGLE_EXCERPT], False)],
            ),
            mock.patch.object(customer_exposure, "extract_disclosures", return_value=[quarter_row]),
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            rows = customer_exposure.scan_ticker("TEST", "0000000000")
        revenue = [row for row in rows if row["basis"] == "revenue"]
        self.assertEqual(len(revenue), 1)
        self.assertEqual(revenue[0]["statement_type"], "confirmed_empty")
        self.assertEqual(revenue[0]["period_end"], date(2026, 12, 31))

    def test_quarter_omission_does_not_supersede_annual_positive(self):
        filings = [
            ("10-Q", "0000000000-26-000020", "quarter.htm", "2026-05-01", "2026-03-31"),
            ("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31"),
        ]
        annual_row = disclosure(statement_type="single_customer", period_end=date(2025, 12, 31))
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure, "fetch_filing_text",
                side_effect=[("Silent quarter.", "https://sec/quarter"), (SINGLE_EXCERPT, "https://sec/annual")],
            ),
            mock.patch.object(
                customer_exposure, "concentration_windows",
                side_effect=[([], False), ([SINGLE_EXCERPT], False)],
            ),
            mock.patch.object(customer_exposure, "extract_disclosures", return_value=[annual_row]),
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            rows = customer_exposure.scan_ticker("TEST", "0000000000")
        revenue = [row for row in rows if row["basis"] == "revenue"]
        self.assertEqual(revenue[0]["statement_type"], "single_customer")

    def test_bare_sales_window_prevents_false_confirmed_empty(self):
        sales_excerpt = (
            "Customer A accounted for 25% of sales for fiscal 2025."
        )
        annual_row = disclosure(
            pct=25,
            period="fiscal 2025",
            period_end=date(2025, 12, 31),
            quote=sales_excerpt,
            statement_type="single_customer",
        )
        filings = [(
            "10-K", "0000000000-26-000010", "annual.htm",
            "2026-02-20", "2025-12-31",
        )]
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure,
                "fetch_filing_text",
                return_value=(sales_excerpt, "https://sec/annual"),
            ),
            mock.patch.object(
                customer_exposure, "extract_disclosures", return_value=[annual_row]
            ) as extract,
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            rows = customer_exposure.scan_ticker("TEST", "0000000000")

        extract.assert_called_once()
        self.assertEqual(extract.call_args.args[2], [sales_excerpt])
        revenue = [row for row in rows if row["basis"] == "revenue"]
        self.assertEqual(len(revenue), 1)
        self.assertEqual(revenue[0]["statement_type"], "single_customer")
        self.assertEqual(revenue[0]["pct"], 25)

        receivables_excerpt = (
            "Customer B represented 20% of receivables for fiscal 2025."
        )
        self.assertEqual(
            customer_exposure.concentration_windows(receivables_excerpt),
            ([receivables_excerpt], False),
        )

    def test_silent_annual_amendment_cannot_clear_original_annual_positive(self):
        filings = [
            ("10-K/A", "0000000000-26-000099", "amendment.htm", "2026-03-10", "2025-12-31"),
            ("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31"),
        ]
        original_row = disclosure(
            statement_type="single_customer", period_end=date(2025, 12, 31)
        )
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure, "fetch_filing_text",
                side_effect=[
                    ("Amendment with no concentration disclosure.", "https://sec/amendment"),
                    (SINGLE_EXCERPT, "https://sec/annual"),
                ],
            ),
            mock.patch.object(
                customer_exposure, "concentration_windows",
                side_effect=[([], False), ([SINGLE_EXCERPT], False)],
            ),
            mock.patch.object(
                customer_exposure, "extract_disclosures", return_value=[original_row]
            ),
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            rows = customer_exposure.scan_ticker("TEST", "0000000000")

        revenue = [row for row in rows if row["basis"] == "revenue"]
        self.assertEqual(len(revenue), 1)
        self.assertEqual(revenue[0]["statement_type"], "single_customer")
        self.assertEqual(revenue[0]["accession"], "0000000000-26-000010")

    def test_period_end_and_provenance_are_persisted_with_semantic_marker(self):
        self.assertEqual(
            customer_exposure.period_end("three months ended June 30, 2026"),
            date(2026, 6, 30),
        )
        self.assertIsNone(customer_exposure.period_end("fiscal 2026"))
        self.assertIn("statement_type TEXT NOT NULL DEFAULT 'unclassified'", customer_exposure.BOOTSTRAP_SQL)
        self.assertIn("ADD COLUMN IF NOT EXISTS period_end DATE", customer_exposure.BOOTSTRAP_SQL)
        self.assertIn("ADD COLUMN IF NOT EXISTS source_accession TEXT", customer_exposure.BOOTSTRAP_SQL)

        conn = FakeConnection()
        with mock.patch.object(customer_exposure.psycopg2.extras, "execute_values") as insert:
            customer_exposure.load_ticker(conn, "TEST", [disclosure()])

        inserted_row = insert.call_args.args[2][0]
        self.assertEqual(inserted_row[5], "single_customer")
        self.assertEqual(inserted_row[7], date(2025, 12, 31))
        self.assertEqual(inserted_row[9], "0000000000-26-000010")

    def test_report_date_resolves_non_calendar_and_comparative_fiscal_periods(self):
        annual_quote = "Customer A accounted for 30% of revenue in fiscal 2026."
        quarter_quote = "Customer A accounted for 18% of revenue in fiscal 2026."
        def extracted(quote, pct, form, report_date, filed, accession):
            model_row = {
                "customer": "Customer A", "pct": pct, "basis": "revenue",
                "period": "fiscal 2026", "quote": quote,
            }
            with mock.patch.object(customer_exposure, "call_gemini", return_value=[model_row]):
                row = customer_exposure.extract_disclosures(
                    "TEST", form, [quote], report_date=report_date
                )[0]
            row.update({"form": form, "url": "https://sec", "filed": filed, "accession": accession})
            return row

        annual = extracted(
            annual_quote, 30, "10-K", "2026-01-31", "2026-03-01",
            "0000000000-26-000010",
        )
        quarter = extracted(
            quarter_quote, 18, "10-Q", "2026-06-30", "2026-08-01",
            "0000000000-26-000020",
        )
        self.assertEqual(annual["period_end"], date(2026, 1, 31))
        self.assertEqual(customer_exposure.best_rows([quarter, annual])[0]["pct"], 18)

        comparative_quote = (
            "Customer A accounted for 15% and 30% of revenue in fiscal 2025 "
            "and fiscal 2024, respectively."
        )
        model_rows = [
            {"customer": "Customer A", "pct": 15, "basis": "revenue", "period": "fiscal 2025", "quote": comparative_quote},
            {"customer": "Customer A", "pct": 30, "basis": "revenue", "period": "fiscal 2024", "quote": comparative_quote},
        ]
        with mock.patch.object(customer_exposure, "call_gemini", return_value=model_rows):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [comparative_quote], report_date="2026-01-31"
            )
        for row in rows:
            row.update({"form": "10-K", "url": "https://sec", "filed": "2026-03-01", "accession": "0000000000-26-000010"})
        self.assertEqual({row["pct"]: row["period_end"] for row in rows}, {
            15.0: date(2025, 1, 31), 30.0: date(2024, 1, 31),
        })
        self.assertEqual(customer_exposure.best_rows(rows)[0]["pct"], 15)

    def test_successful_empty_refresh_clears_and_persists_provenance_in_one_transaction(self):
        conn = FakeConnection(fetchall_rows=[(
            "TEST", "revenue", "single_customer", date(2025, 12, 31),
            date(2026, 2, 20), "0000000000-26-000010",
        )])
        markers = customer_exposure.confirmed_empty_markers([{
            "form": "10-K",
            "accession": "0000000000-27-000010",
            "url": "https://sec/annual",
            "filed": "2027-02-20",
            "report_date": "2026-12-31",
        }])
        with (
            mock.patch.object(customer_exposure, "scan_ticker", return_value=markers),
            mock.patch.object(customer_exposure.psycopg2.extras, "execute_values") as insert,
        ):
            rows = customer_exposure.refresh_ticker(conn, "TEST", "0000000000")

        self.assertEqual(rows, markers)
        self.assertEqual(conn.commits, 1)
        self.assertEqual(conn.rollbacks, 0)
        queries = [sql for sql, _ in conn.cursor_instance.execute_calls]
        self.assertIn("pg_advisory_xact_lock", queries[0])
        self.assertTrue(any("DELETE FROM customer_exposure" in sql for sql in queries))
        insert.assert_called_once()

    def test_incomplete_filing_or_model_scan_never_touches_stale_rows(self):
        conn = FakeConnection()
        for error in (
            customer_exposure.IncompleteExposureScan("filing fetch failed"),
            ValueError("model response invalid"),
        ):
            with (
                self.subTest(error=type(error).__name__),
                mock.patch.object(customer_exposure, "scan_ticker", side_effect=error),
                mock.patch.object(customer_exposure, "load_ticker") as load,
            ):
                with self.assertRaises(type(error)):
                    customer_exposure.refresh_ticker(conn, "TEST", "0000000000")
                load.assert_not_called()

    def test_partial_filing_fetch_is_incomplete_even_after_an_earlier_success(self):
        filings = [
            ("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31"),
            ("10-Q", "0000000000-26-000020", "quarterly.htm", "2026-08-01", "2026-06-30"),
        ]
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure,
                "fetch_filing_text",
                side_effect=[("No qualifying windows.", "https://sec/annual"), (None, "https://sec/quarterly")],
            ),
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            with self.assertRaises(customer_exposure.IncompleteExposureScan):
                customer_exposure.scan_ticker("TEST", "0000000000")

    def test_model_failure_during_real_scan_never_replaces_rows(self):
        conn = FakeConnection()
        filings = [("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31")]
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure,
                "fetch_filing_text",
                return_value=(SINGLE_EXCERPT, "https://sec/annual"),
            ),
            mock.patch.object(
                customer_exposure, "concentration_windows",
                return_value=([SINGLE_EXCERPT], False),
            ),
            mock.patch.object(customer_exposure, "extract_disclosures", side_effect=ValueError("invalid model")),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            with self.assertRaisesRegex(ValueError, "invalid model"):
                customer_exposure.refresh_ticker(conn, "TEST", "0000000000")
        load.assert_not_called()

    def test_excerpt_cap_returns_ordered_prefix_and_stages_valid_rows(self):
        filing_text, clauses = disclosure_heavy_filing()
        excerpts, truncated = customer_exposure.concentration_windows(filing_text)

        self.assertEqual(customer_exposure.MAX_EXCERPT_CHARS, 9000)
        self.assertTrue(truncated)
        self.assertTrue(excerpts)
        self.assertLessEqual(sum(map(len, excerpts)), 9000)
        self.assertEqual(
            [filing_text.index(excerpt) for excerpt in excerpts],
            sorted(filing_text.index(excerpt) for excerpt in excerpts),
        )
        self.assertIn(clauses[0], excerpts[0])
        self.assertFalse(any(clauses[-1] in excerpt for excerpt in excerpts))

        filings = [("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31")]
        model_row = {
            "customer": "Customer A", "pct": 23, "basis": "revenue",
            "period": "year ended December 31, 2025", "quote": SINGLE_EXCERPT,
        }
        diagnostics = {}
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure,
                "fetch_filing_text",
                return_value=(filing_text, "https://sec/annual"),
            ),
            mock.patch.object(
                customer_exposure, "call_gemini", return_value=[model_row]
            ),
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            rows = customer_exposure.scan_ticker(
                "TEST", "0000000000", diagnostics=diagnostics
            )

        self.assertEqual(len(customer_exposure.scoring_rows(rows)), 1)
        self.assertEqual(rows[0]["pct"], 23)
        self.assertTrue(diagnostics["degraded"])

    def test_excerpt_cap_trims_single_oversized_merged_span(self):
        segment = "One customer accounted for 12% of revenues. " + ("x" * 800) + " "
        excerpts, truncated = customer_exposure.concentration_windows(segment * 40)

        self.assertTrue(excerpts)
        self.assertEqual(len(excerpts), 1)
        self.assertEqual(
            sum(map(len, excerpts)), customer_exposure.MAX_EXCERPT_CHARS
        )
        self.assertTrue(truncated)

    def test_empty_truncated_scan_is_incomplete_and_never_replaces_rows(self):
        filing_text, _ = disclosure_heavy_filing()
        filings = [("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31")]
        diagnostics = {}
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure,
                "fetch_filing_text",
                return_value=(filing_text, "https://sec/annual"),
            ),
            mock.patch.object(customer_exposure, "call_gemini", return_value=[]),
            mock.patch.object(customer_exposure, "confirmed_empty_markers") as empty,
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            with self.assertRaisesRegex(
                customer_exposure.IncompleteExposureScan,
                "truncated filing scan produced no valid rows",
            ):
                customer_exposure.scan_ticker(
                    "TEST", "0000000000", diagnostics=diagnostics
                )
        empty.assert_not_called()
        self.assertTrue(diagnostics["degraded"])

    def test_all_model_rows_dropped_is_incomplete_and_never_replaces_rows(self):
        conn = FakeConnection()
        filings = [("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31")]
        invalid_row = {
            "customer": "Customer A", "pct": 0, "basis": "revenue",
            "period": "year ended December 31, 2025", "quote": SINGLE_EXCERPT,
        }
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure,
                "fetch_filing_text",
                return_value=(SINGLE_EXCERPT, "https://sec/annual"),
            ),
            mock.patch.object(
                customer_exposure, "call_gemini", return_value=[invalid_row]
            ),
            mock.patch.object(customer_exposure, "confirmed_empty_markers") as empty,
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            with self.assertRaisesRegex(
                customer_exposure.IncompleteExposureScan,
                "all model rows failed validation",
            ):
                customer_exposure.refresh_ticker(conn, "TEST", "0000000000")
        empty.assert_not_called()
        load.assert_not_called()

    def test_mixed_model_scan_stages_valid_rows_and_marks_ticker_degraded(self):
        filings = [("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31")]
        valid_row = {
            "customer": "Customer A", "pct": 23, "basis": "revenue",
            "period": "year ended December 31, 2025", "quote": SINGLE_EXCERPT,
        }
        invalid_row = dict(valid_row, pct=0)
        diagnostics = {}
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure,
                "fetch_filing_text",
                return_value=(SINGLE_EXCERPT, "https://sec/annual"),
            ),
            mock.patch.object(
                customer_exposure,
                "call_gemini",
                return_value=[valid_row, invalid_row],
            ),
            mock.patch.object(customer_exposure, "confirmed_empty_markers") as empty,
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            rows = customer_exposure.scan_ticker(
                "TEST", "0000000000", diagnostics=diagnostics
            )

        self.assertEqual(len(customer_exposure.scoring_rows(rows)), 1)
        self.assertEqual(rows[0]["pct"], 23)
        self.assertTrue(diagnostics["degraded"])
        empty.assert_not_called()

    def test_load_rolls_back_if_replacement_insert_fails(self):
        conn = FakeConnection()
        failure = RuntimeError("insert failed")
        with mock.patch.object(
            customer_exposure.psycopg2.extras,
            "execute_values",
            side_effect=failure,
        ):
            with self.assertRaises(RuntimeError) as raised:
                customer_exposure.load_ticker(conn, "TEST", [disclosure()])

        self.assertIs(raised.exception, failure)
        self.assertEqual(conn.commits, 0)
        self.assertEqual(conn.rollbacks, 1)

    def test_main_reports_confirmed_empty_as_known_no_data_and_wires_health_thresholds(self):
        conn = FakeConnection()
        context = types.SimpleNamespace(
            pipeline="customer_exposure",
            baseline_usable=None,
        )
        markers = customer_exposure.confirmed_empty_markers([{
            "form": "10-K",
            "accession": "0000000000-27-000010",
            "url": "https://sec/annual",
            "filed": "2027-02-20",
            "report_date": "2026-12-31",
        }])
        with (
            mock.patch.dict(os.environ, {"TICKER_LIMIT": "0"}, clear=True),
            mock.patch.object(customer_exposure, "DATABASE_URL", "postgres://test"),
            mock.patch.object(customer_exposure, "GEMINI_API_KEY", "test-key"),
            mock.patch.object(customer_exposure, "get_universe", return_value=["AAA", "BBB"]),
            mock.patch.object(
                customer_exposure,
                "get_cik_map",
                return_value={"AAA": "0000000001", "BBB": "0000000002"},
            ),
            mock.patch.object(customer_exposure, "connect_db", return_value=conn),
            mock.patch.object(customer_exposure, "reconnect_for_publish", return_value=conn),
            mock.patch.object(customer_exposure, "begin_run", return_value=context) as begin,
            mock.patch.object(
                customer_exposure, "get_positive_tickers", return_value={"AAA"}
            ),
            mock.patch.object(
                customer_exposure,
                "get_stored_winning_vintages",
                return_value={("AAA", "revenue"): disclosure()},
            ),
            mock.patch.object(
                customer_exposure,
                "scan_ticker",
                side_effect=[[disclosure()], markers],
            ),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(
                customer_exposure,
                "evaluate_health",
                wraps=customer_exposure.evaluate_health,
            ) as evaluate,
            mock.patch.object(customer_exposure, "finish_run") as finish,
        ):
            stats = customer_exposure.main()

        begin.assert_called_once_with(
            conn,
            "customer_exposure",
            expected=2,
            details={"limitedRun": False},
        )
        self.assertEqual(stats.attempted, 2)
        self.assertEqual(stats.usable, 1)
        self.assertEqual(stats.known_no_data, 1)
        self.assertEqual(stats.transient_failures, 0)
        self.assertEqual(stats.degraded, 0)
        self.assertEqual(stats.details["confirmedEmpty"], 1)
        self.assertEqual(stats.details["retainedPriorPositiveTickers"], 1)
        self.assertEqual(conn.closes, 1)
        self.assertEqual(load.call_count, 2)

        self.assertEqual(evaluate.call_args.args, (stats, None))
        self.assertEqual(evaluate.call_args.kwargs, {
            "minimum_provider_coverage": 0.90,
            "minimum_usable_coverage": 0.50,
            "minimum_baseline_retention": 0.75,
            "limited_run": False,
        })
        self.assertEqual(finish.call_args.args[:3], (conn, context, stats))
        self.assertEqual(finish.call_args.kwargs, {
            "minimum_provider_coverage": 0.90,
            "minimum_usable_coverage": 0.50,
            "minimum_baseline_retention": 0.75,
            "limited_run": False,
        })

    def test_universe_wide_empty_regression_fails_before_any_replacement(self):
        conn = FakeConnection()
        context = types.SimpleNamespace(
            pipeline="customer_exposure",
            baseline_usable=None,
        )
        universe = ["AAA", "BBB", "CCC", "DDD"]
        cik_map = {ticker: str(index).zfill(10) for index, ticker in enumerate(universe, 1)}
        with (
            mock.patch.dict(
                os.environ,
                {
                    "TICKER_LIMIT": "0",
                    "CUSTOMER_EXPOSURE_MIN_POSITIVE_RETENTION": "0.75",
                },
                clear=True,
            ),
            mock.patch.object(customer_exposure, "DATABASE_URL", "postgres://test"),
            mock.patch.object(customer_exposure, "GEMINI_API_KEY", "test-key"),
            mock.patch.object(customer_exposure, "get_universe", return_value=universe),
            mock.patch.object(customer_exposure, "get_cik_map", return_value=cik_map),
            mock.patch.object(customer_exposure, "connect_db", return_value=conn),
            mock.patch.object(customer_exposure, "reconnect_for_publish", return_value=conn),
            mock.patch.object(customer_exposure, "begin_run", return_value=context),
            mock.patch.object(
                customer_exposure, "get_positive_tickers", return_value=set(universe)
            ),
            mock.patch.object(
                customer_exposure,
                "get_stored_winning_vintages",
                return_value={
                    (ticker, "revenue"): disclosure()
                    for ticker in universe
                },
            ),
            mock.patch.object(
                customer_exposure,
                "scan_ticker",
                return_value=customer_exposure.confirmed_empty_markers([{
                    "form": "10-K",
                    "accession": "0000000000-27-000010",
                    "url": "https://sec/annual",
                    "filed": "2027-02-20",
                    "report_date": "2026-12-31",
                }]),
            ),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure, "finish_run") as finish,
            mock.patch.object(customer_exposure, "write_run") as write,
            mock.patch.object(customer_exposure, "record_failure_safely") as record,
        ):
            with self.assertRaisesRegex(
                customer_exposure.CoverageError,
                "coverage failed",
            ):
                customer_exposure.main()

        load.assert_not_called()
        finish.assert_not_called()
        record.assert_not_called()
        write.assert_called_once()
        self.assertEqual(write.call_args.args[:3], (conn, context, "failure"))
        failed_stats = write.call_args.args[3]
        self.assertEqual(write.call_args.kwargs["decision"].state, "failure")
        self.assertEqual(failed_stats.usable, 0)
        self.assertEqual(failed_stats.known_no_data, 4)
        self.assertEqual(failed_stats.details["retainedPriorPositiveTickers"], 0)
        self.assertFalse(any(
            "DELETE FROM customer_exposure" in sql
            for sql, _ in conn.cursor_instance.execute_calls
        ))
        self.assertEqual(conn.closes, 1)

    def test_fresh_all_empty_run_reaches_generic_health_gate_and_fails(self):
        conn = FakeConnection()
        context = types.SimpleNamespace(
            pipeline="customer_exposure",
            run_id="test-run",
            baseline_usable=None,
            initial_details={"limitedRun": False},
        )
        markers = customer_exposure.confirmed_empty_markers([{
            "form": "10-K",
            "accession": "0000000000-27-000010",
            "url": "https://sec/annual",
            "filed": "2027-02-20",
            "report_date": "2026-12-31",
        }])
        with (
            mock.patch.dict(os.environ, {"TICKER_LIMIT": "0"}, clear=True),
            mock.patch.object(customer_exposure, "DATABASE_URL", "postgres://test"),
            mock.patch.object(customer_exposure, "GEMINI_API_KEY", "test-key"),
            mock.patch.object(customer_exposure, "get_universe", return_value=["AAA"]),
            mock.patch.object(
                customer_exposure, "get_cik_map", return_value={"AAA": "0000000001"}
            ),
            mock.patch.object(customer_exposure, "connect_db", return_value=conn),
            mock.patch.object(customer_exposure, "reconnect_for_publish", return_value=conn),
            mock.patch.object(customer_exposure, "begin_run", return_value=context),
            mock.patch.object(customer_exposure, "get_positive_tickers", return_value=set()),
            mock.patch.object(
                customer_exposure, "get_stored_winning_vintages", return_value={}
            ),
            mock.patch.object(customer_exposure, "scan_ticker", return_value=markers),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure, "finish_run") as finish,
            mock.patch.object(
                customer_exposure,
                "write_run",
                wraps=customer_exposure.write_run,
            ) as write,
            mock.patch.object(customer_exposure, "record_failure_safely") as record,
        ):
            with self.assertRaisesRegex(
                customer_exposure.CoverageError, "coverage failed"
            ):
                customer_exposure.main()

        load.assert_not_called()
        finish.assert_not_called()
        record.assert_not_called()
        write.assert_called_once()
        self.assertEqual(write.call_args.args[:3], (conn, context, "failure"))
        failed_stats = write.call_args.args[3]
        self.assertEqual(write.call_args.kwargs["decision"].state, "failure")
        self.assertEqual(failed_stats.usable, 0)
        self.assertEqual(failed_stats.known_no_data, 1)
        manifest_params = next(
            params for sql, params in reversed(conn.cursor_instance.execute_calls)
            if "INSERT INTO etl_run_manifest" in sql
        )
        self.assertEqual(manifest_params["state"], "failure")

    def test_provider_coverage_failure_persists_manifest_without_publish(self):
        conn = FakeConnection()
        context = types.SimpleNamespace(
            pipeline="customer_exposure",
            baseline_usable=None,
        )
        negative = disclosure(
            label="__negative__", ticker=None, statement_type="negative"
        )
        with (
            mock.patch.dict(os.environ, {"TICKER_LIMIT": "0"}, clear=True),
            mock.patch.object(customer_exposure, "DATABASE_URL", "postgres://test"),
            mock.patch.object(customer_exposure, "GEMINI_API_KEY", "test-key"),
            mock.patch.object(
                customer_exposure,
                "get_universe",
                return_value=["AAA", "BBB", "CCC"],
            ),
            mock.patch.object(
                customer_exposure,
                "get_cik_map",
                return_value={
                    "AAA": "0000000001",
                    "BBB": "0000000002",
                    "CCC": "0000000003",
                },
            ),
            mock.patch.object(customer_exposure, "connect_db", return_value=conn),
            mock.patch.object(
                customer_exposure, "reconnect_for_publish", return_value=conn
            ),
            mock.patch.object(customer_exposure, "begin_run", return_value=context),
            mock.patch.object(
                customer_exposure, "get_positive_tickers", return_value={"BBB"}
            ),
            mock.patch.object(
                customer_exposure, "get_stored_winning_vintages", return_value={}
            ),
            mock.patch.object(
                customer_exposure,
                "scan_ticker",
                side_effect=[
                    [disclosure()],
                    [negative],
                    customer_exposure.IncompleteExposureScan("truncated scan"),
                ],
            ),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure, "finish_run") as finish,
            mock.patch.object(customer_exposure, "write_run") as write,
            mock.patch.object(customer_exposure, "record_failure_safely") as record,
        ):
            with self.assertRaises(customer_exposure.CoverageError):
                customer_exposure.main()

        load.assert_not_called()
        finish.assert_not_called()
        record.assert_not_called()
        write.assert_called_once()
        failed_stats = write.call_args.args[3]
        decision = write.call_args.kwargs["decision"]
        self.assertEqual(failed_stats.usable, 1)
        self.assertEqual(failed_stats.known_no_data, 1)
        self.assertEqual(failed_stats.transient_failures, 1)
        self.assertAlmostEqual(decision.provider_coverage, 2 / 3)
        self.assertEqual(decision.state, "failure")
        self.assertEqual(
            failed_stats.details["retentionCreditedExplicitNegativeTickers"],
            0,
        )
        self.assertFalse(any(
            "DELETE FROM customer_exposure" in sql
            for sql, _ in conn.cursor_instance.execute_calls
        ))

    def test_incomplete_scans_are_transient_not_explicit_negatives(self):
        for message in (
            "truncated filing scan produced no valid rows",
            "all model rows failed validation",
        ):
            conn = FakeConnection()
            context = types.SimpleNamespace(
                pipeline="customer_exposure",
                baseline_usable=None,
            )

            def fail_scan(ticker, cik, diagnostics=None):
                if message.startswith("truncated"):
                    diagnostics["degraded"] = True
                raise customer_exposure.IncompleteExposureScan(message)

            with (
                self.subTest(message=message),
                mock.patch.dict(os.environ, {"TICKER_LIMIT": "0"}, clear=True),
                mock.patch.object(customer_exposure, "DATABASE_URL", "postgres://test"),
                mock.patch.object(customer_exposure, "GEMINI_API_KEY", "test-key"),
                mock.patch.object(
                    customer_exposure, "get_universe", return_value=["AAA"]
                ),
                mock.patch.object(
                    customer_exposure,
                    "get_cik_map",
                    return_value={"AAA": "0000000001"},
                ),
                mock.patch.object(customer_exposure, "connect_db", return_value=conn),
                mock.patch.object(
                    customer_exposure, "reconnect_for_publish", return_value=conn
                ),
                mock.patch.object(customer_exposure, "begin_run", return_value=context),
                mock.patch.object(
                    customer_exposure,
                    "get_positive_tickers",
                    return_value={"AAA"},
                ),
                mock.patch.object(
                    customer_exposure,
                    "get_stored_winning_vintages",
                    return_value={
                        ("AAA", "revenue"): disclosure()
                    },
                ),
                mock.patch.object(
                    customer_exposure,
                    "scan_ticker",
                    side_effect=fail_scan,
                ),
                mock.patch.object(customer_exposure, "load_ticker") as load,
                mock.patch.object(customer_exposure, "finish_run") as finish,
                mock.patch.object(customer_exposure, "write_run") as write,
                mock.patch.object(
                    customer_exposure, "record_failure_safely"
                ) as record,
            ):
                with self.assertRaises(customer_exposure.CoverageError):
                    customer_exposure.main()

            load.assert_not_called()
            finish.assert_not_called()
            record.assert_not_called()
            failed_stats = write.call_args.args[3]
            self.assertEqual(failed_stats.transient_failures, 1)
            self.assertEqual(failed_stats.known_no_data, 0)
            self.assertEqual(failed_stats.details["explicitNegative"], 0)
            self.assertEqual(failed_stats.details["stagedTickers"], 0)
            self.assertEqual(failed_stats.details["projectedPositiveTickers"], 1)
            self.assertEqual(
                failed_stats.degraded,
                1 if message.startswith("truncated") else 0,
            )

    def test_limited_main_counts_successful_partial_scan_as_degraded(self):
        conn = FakeConnection()
        context = types.SimpleNamespace(
            pipeline="customer_exposure",
            baseline_usable=100,
        )

        def degraded_scan(ticker, cik, diagnostics=None):
            diagnostics["degraded"] = True
            return [disclosure()]

        with (
            mock.patch.dict(os.environ, {"TICKER_LIMIT": "1"}, clear=True),
            mock.patch.object(customer_exposure, "DATABASE_URL", "postgres://test"),
            mock.patch.object(customer_exposure, "GEMINI_API_KEY", "test-key"),
            mock.patch.object(customer_exposure, "get_universe", return_value=["AAA"]),
            mock.patch.object(
                customer_exposure,
                "get_cik_map",
                return_value={"AAA": "0000000001"},
            ),
            mock.patch.object(customer_exposure, "connect_db", return_value=conn),
            mock.patch.object(
                customer_exposure, "reconnect_for_publish", return_value=conn
            ),
            mock.patch.object(customer_exposure, "begin_run", return_value=context),
            mock.patch.object(
                customer_exposure, "get_positive_tickers", return_value=set()
            ),
            mock.patch.object(
                customer_exposure, "get_stored_winning_vintages", return_value={}
            ),
            mock.patch.object(
                customer_exposure, "scan_ticker", side_effect=degraded_scan
            ),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure, "finish_run") as finish,
        ):
            stats = customer_exposure.main()

        self.assertEqual(stats.usable, 1)
        self.assertEqual(stats.degraded, 1)
        load.assert_called_once_with(conn, "AAA", [disclosure()])
        finish.assert_called_once()
        self.assertTrue(finish.call_args.kwargs["limited_run"])

    def test_publish_reconnect_failure_preserves_all_rows(self):
        conn = FakeConnection()
        context = object()
        with (
            mock.patch.dict(os.environ, {"TICKER_LIMIT": "0"}, clear=True),
            mock.patch.object(customer_exposure, "DATABASE_URL", "postgres://test"),
            mock.patch.object(customer_exposure, "GEMINI_API_KEY", "test-key"),
            mock.patch.object(customer_exposure, "get_universe", return_value=["AAA"]),
            mock.patch.object(customer_exposure, "get_cik_map", return_value={"AAA": "0000000001"}),
            mock.patch.object(customer_exposure, "connect_db", return_value=conn),
            mock.patch.object(customer_exposure, "begin_run", return_value=context),
            mock.patch.object(customer_exposure, "scan_ticker", return_value=[disclosure()]),
            mock.patch.object(
                customer_exposure, "reconnect_for_publish",
                side_effect=RuntimeError("reconnect failed"),
            ),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure, "finish_run") as finish,
            mock.patch.object(customer_exposure, "record_failure_safely") as record,
        ):
            with self.assertRaisesRegex(RuntimeError, "reconnect failed"):
                customer_exposure.main()

        load.assert_not_called()
        finish.assert_not_called()
        record.assert_called_once()

    def test_retention_guard_allows_an_isolated_confirmed_empty(self):
        projected = customer_exposure.enforce_positive_retention(
            {"AAA", "BBB", "CCC", "DDD"},
            {"AAA": []},
            0.75,
            provider_coverage=1.0,
            minimum_provider_coverage=0.90,
        )
        self.assertEqual(projected, {"BBB", "CCC", "DDD"})

    def test_retention_guard_credits_negatives_only_with_healthy_provider(self):
        staged = {
            "AAA": [{
                "statement_type": "negative",
                "basis": "revenue",
                "label": "__negative__",
            }]
        }
        with self.assertRaises(customer_exposure.ExposureRetentionError):
            customer_exposure.enforce_positive_retention(
                {"AAA"},
                staged,
                1.0,
                provider_coverage=0.89,
                minimum_provider_coverage=0.90,
            )

        projected = customer_exposure.enforce_positive_retention(
            {"AAA"},
            staged,
            1.0,
            provider_coverage=0.90,
            minimum_provider_coverage=0.90,
        )
        self.assertEqual(projected, set())

    def test_retention_baseline_includes_legacy_unclassified_rows(self):
        cursor = mock.MagicMock()
        cursor.__enter__.return_value = cursor
        cursor.__exit__.return_value = False
        cursor.fetchall.return_value = [("LEGACY",), ("CURRENT",)]
        conn = mock.MagicMock()
        conn.cursor.return_value = cursor

        tickers = customer_exposure.get_positive_tickers(conn)

        self.assertEqual(tickers, {"LEGACY", "CURRENT"})
        query = cursor.execute.call_args.args[0]
        self.assertIn("'unclassified'", query)
        self.assertIn("'single_customer'", query)

    def test_valid_sec_index_without_supported_forms_is_known_no_data_signal(self):
        response = mock.Mock(status_code=200)
        response.json.return_value = {
            "filings": {
                "recent": {
                    "form": ["6-K"],
                    "accessionNumber": ["0000000000-26-000001"],
                    "primaryDocument": ["report.htm"],
                    "filingDate": ["2026-08-01"],
                    "reportDate": ["2026-06-30"],
                }
            }
        }
        with mock.patch.object(
            customer_exposure.requests, "get", return_value=response, create=True
        ):
            with self.assertRaises(customer_exposure.NoSupportedFilings):
                customer_exposure.latest_filings("0000000000")

    def test_latest_filings_keeps_original_annual_beside_newer_amendment(self):
        response = mock.Mock(status_code=200)
        response.json.return_value = {
            "filings": {
                "recent": {
                    "form": ["10-K/A", "10-K", "10-Q", "8-K"],
                    "accessionNumber": ["a-amend", "a-original", "q-original", "other"],
                    "primaryDocument": ["amend.htm", "annual.htm", "quarter.htm", "other.htm"],
                    "filingDate": ["2026-03-10", "2026-02-20", "2026-05-01", "2026-06-01"],
                    "reportDate": ["2025-12-31", "2025-12-31", "2026-03-31", "2026-05-31"],
                }
            }
        }
        with mock.patch.object(
            customer_exposure.requests, "get", return_value=response, create=True
        ):
            filings = customer_exposure.latest_filings("0000000000")

        self.assertEqual(
            [form for form, *_ in filings], ["10-K/A", "10-K", "10-Q"]
        )

    def test_latest_filings_keeps_original_20f_beside_newer_amendment(self):
        response = mock.Mock(status_code=200)
        response.json.return_value = {
            "filings": {
                "recent": {
                    "form": ["20-F/A", "20-F", "6-K"],
                    "accessionNumber": ["f-amend", "f-original", "other"],
                    "primaryDocument": ["f-amend.htm", "foreign.htm", "other.htm"],
                    "filingDate": ["2026-05-10", "2026-04-20", "2026-06-01"],
                    "reportDate": ["2025-12-31", "2025-12-31", "2026-05-31"],
                }
            }
        }
        with mock.patch.object(
            customer_exposure.requests, "get", return_value=response, create=True
        ):
            filings = customer_exposure.latest_filings("0000000000")

        self.assertEqual(
            [form for form, *_ in filings], ["20-F/A", "20-F"]
        )

    def test_latest_filings_keeps_original_quarter_beside_newer_amendment(self):
        response = mock.Mock(status_code=200)
        response.json.return_value = {
            "filings": {
                "recent": {
                    "form": ["10-Q/A", "10-Q", "10-K"],
                    "accessionNumber": ["q-amend", "q-original", "a-original"],
                    "primaryDocument": ["q-amend.htm", "quarter.htm", "annual.htm"],
                    "filingDate": ["2026-08-10", "2026-08-01", "2026-02-20"],
                    "reportDate": ["2026-06-30", "2026-06-30", "2025-12-31"],
                }
            }
        }
        with mock.patch.object(
            customer_exposure.requests, "get", return_value=response, create=True
        ):
            filings = customer_exposure.latest_filings("0000000000")

        self.assertEqual(
            [form for form, *_ in filings], ["10-Q/A", "10-Q", "10-K"]
        )

    def test_mismatched_sec_submission_arrays_are_incomplete_not_empty(self):
        response = mock.Mock(status_code=200)
        response.json.return_value = {
            "filings": {
                "recent": {
                    "form": ["10-K"],
                    "accessionNumber": [],
                    "primaryDocument": ["report.htm"],
                    "filingDate": ["2026-08-01"],
                    "reportDate": ["2026-06-30"],
                }
            }
        }
        with mock.patch.object(
            customer_exposure.requests, "get", return_value=response, create=True
        ):
            with self.assertRaises(customer_exposure.IncompleteExposureScan):
                customer_exposure.latest_filings("0000000000")


if __name__ == "__main__":
    unittest.main()
