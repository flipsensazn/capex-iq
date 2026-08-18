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
        with mock.patch.object(customer_exposure, "call_gemini", return_value=[hallucinated]):
            with self.assertRaisesRegex(ValueError, "verbatim"):
                customer_exposure.extract_disclosures("TEST", "10-K", [SINGLE_EXCERPT])

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
                with self.assertRaisesRegex(ValueError, "one allocation clause"):
                    customer_exposure.extract_disclosures("TEST", "10-K", [quote])

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
            with self.assertRaisesRegex(ValueError, "one allocation clause"):
                customer_exposure.extract_disclosures(
                    "TEST", "10-K", [quote], report_date="2025-09-30"
                )
        with mock.patch.object(
            customer_exposure, "call_gemini", return_value=[dict(base, pct=12)]
        ):
            rows = customer_exposure.extract_disclosures(
                "TEST", "10-K", [quote], report_date="2025-09-30"
            )
        self.assertEqual(rows[0]["pct"], 12)

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
            with self.assertRaisesRegex(ValueError, "one allocation clause"):
                customer_exposure.extract_disclosures(
                    "TEST", "10-K", [cases[0][0]], report_date="2025-12-31"
                )

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
            mock.patch.object(customer_exposure, "concentration_windows", side_effect=[[], [SINGLE_EXCERPT]]),
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
            mock.patch.object(customer_exposure, "concentration_windows", side_effect=[[], [SINGLE_EXCERPT]]),
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
            [receivables_excerpt],
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
                side_effect=[[], [SINGLE_EXCERPT]],
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
            mock.patch.object(customer_exposure, "concentration_windows", return_value=[SINGLE_EXCERPT]),
            mock.patch.object(customer_exposure, "extract_disclosures", side_effect=ValueError("invalid model")),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            with self.assertRaisesRegex(ValueError, "invalid model"):
                customer_exposure.refresh_ticker(conn, "TEST", "0000000000")
        load.assert_not_called()

    def test_excerpt_cap_overflow_is_incomplete_and_never_replaces_rows(self):
        conn = FakeConnection()
        filings = [("10-K", "0000000000-26-000010", "annual.htm", "2026-02-20", "2025-12-31")]
        with (
            mock.patch.object(customer_exposure, "latest_filings", return_value=filings),
            mock.patch.object(
                customer_exposure,
                "fetch_filing_text",
                return_value=(SINGLE_EXCERPT, "https://sec/annual"),
            ),
            mock.patch.object(customer_exposure, "MAX_EXCERPT_CHARS", 10),
            mock.patch.object(customer_exposure, "load_ticker") as load,
            mock.patch.object(customer_exposure.time, "sleep"),
        ):
            with self.assertRaisesRegex(
                customer_exposure.IncompleteExposureScan,
                "extraction cap",
            ):
                customer_exposure.refresh_ticker(conn, "TEST", "0000000000")
        load.assert_not_called()

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
        context = object()
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
                side_effect=[[disclosure()], []],
            ),
            mock.patch.object(customer_exposure, "load_ticker") as load,
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

        self.assertEqual(finish.call_args.args[:3], (conn, context, stats))
        self.assertEqual(finish.call_args.kwargs, {
            "minimum_provider_coverage": 0.90,
            "minimum_usable_coverage": 0.50,
            "minimum_baseline_retention": 0.75,
            "limited_run": False,
        })

    def test_universe_wide_empty_regression_fails_before_any_replacement(self):
        conn = FakeConnection()
        context = object()
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
            mock.patch.object(customer_exposure, "record_failure_safely") as record,
        ):
            with self.assertRaisesRegex(
                customer_exposure.ExposureRetentionError,
                "positive-ticker retention",
            ):
                customer_exposure.main()

        load.assert_not_called()
        finish.assert_not_called()
        record.assert_called_once()
        self.assertEqual(record.call_args.args[:2], (conn, context))
        self.assertIsInstance(
            record.call_args.args[3], customer_exposure.ExposureRetentionError
        )
        failed_stats = record.call_args.args[2]
        self.assertEqual(failed_stats.usable, 0)
        self.assertEqual(failed_stats.known_no_data, 4)
        self.assertEqual(failed_stats.details["retainedPriorPositiveTickers"], 0)
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
            mock.patch.object(
                customer_exposure, "finish_run", wraps=customer_exposure.finish_run
            ) as finish,
            mock.patch.object(customer_exposure, "record_failure_safely") as record,
        ):
            with self.assertRaisesRegex(
                customer_exposure.CoverageError, "coverage failed"
            ):
                customer_exposure.main()

        load.assert_called_once()
        finish.assert_called_once()
        record.assert_not_called()
        failed_stats = finish.call_args.args[2]
        self.assertEqual(failed_stats.usable, 0)
        self.assertEqual(failed_stats.known_no_data, 1)

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
        )
        self.assertEqual(projected, {"BBB", "CCC", "DDD"})

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
