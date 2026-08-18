import os
import sys
import unittest
from datetime import date
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import radar_scores


def map_payload(track, subsector, tickers):
    return {
        "tracks": [{
            "id": track.lower(),
            "label": track,
            "subsectors": [{
                "id": subsector.lower(),
                "label": subsector,
                "tickers": tickers,
            }],
        }]
    }


def live_maps():
    return {
        "ai": map_payload("AI Track", "AI Subsector", ["ALL", "AMZN"]),
        "musk": map_payload("Musk Track", "Musk Subsector", ["ALL"]),
        "robotics": map_payload(
            "Robotics Track", "Robotics Subsector", ["ALL"]
        ),
    }


class FakeResponse:
    def __init__(self, payload, status_code=200, text=""):
        self.payload = payload
        self.status_code = status_code
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self.payload


class FakeCursor:
    def __init__(self):
        self.execute_calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=None):
        self.execute_calls.append((sql, params))


class FakeConnection:
    def __init__(self):
        self.cursor_instance = FakeCursor()
        self.commits = 0
        self.closes = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self):
        self.commits += 1

    def rollback(self):
        return None

    def close(self):
        self.closes += 1


def json_value(value):
    return getattr(value, "adapted", value)


def scored_result(ticker="ALL", coverage="scored"):
    quality = None
    technical = None
    if coverage == "scored":
        quality = {"score": 81, "components": [{"key": "growth", "score": 80}]}
        technical = {
            "score": 72,
            "components": [{"key": "momentum", "score": 70}],
        }
    return {
        "ticker": ticker,
        "coverage": coverage,
        "qualityScore": quality,
        "technicalScore": technical,
        "price": 20.5,
        "marketCap": 2050,
        "fiscalYearBasis": 2025,
        "chainCount": 3,
        "chains": ["ai", "musk", "robotics"],
        "memberships": {"ai": ["AI Track / AI Subsector"]},
        "methodologyVersion": "radar-v1",
        "methodologySignature": "method-sig",
        "inputSignature": "input-sig",
    }


class RadarScoresRegressionTests(unittest.TestCase):
    def test_watchlist_base_url_missing_hard_fails(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(SystemExit, "WATCHLIST_BASE_URL not set"):
                radar_scores.fetch_live_maps()

    def test_any_live_map_fetch_failure_hard_fails(self):
        good = FakeResponse({"capexData": map_payload("Track", "Sub", ["AAA"])})
        with mock.patch.object(
            radar_scores.requests,
            "get",
            side_effect=[good, RuntimeError("provider down")],
        ):
            with self.assertRaisesRegex(SystemExit, "/musk-capex live map fetch failed"):
                radar_scores.fetch_live_maps("https://watchlist.test")

    def test_memberships_and_chain_counts_come_from_all_maps(self):
        metadata = radar_scores.build_universe_metadata(
            ["ALL", "AMZN", "MSFT"], live_maps()
        )

        self.assertEqual(metadata["ALL"]["chains"], ["ai", "musk", "robotics"])
        self.assertEqual(metadata["ALL"]["chain_count"], 3)
        self.assertEqual(
            metadata["ALL"]["memberships"],
            {
                "ai": ["AI Track / AI Subsector"],
                "musk": ["Musk Track / Musk Subsector"],
                "robotics": ["Robotics Track / Robotics Subsector"],
            },
        )
        self.assertEqual(
            metadata["AMZN"]["memberships"]["ai"],
            ["AI Track / AI Subsector"],
        )
        self.assertEqual(metadata["MSFT"]["chains"], ["ai"])
        self.assertEqual(
            metadata["MSFT"]["memberships"],
            {"ai": ["Hyperscalers / Hyperscalers"]},
        )

    def test_authoritative_universe_uses_validated_maps_and_limits_once(self):
        universe = radar_scores.authoritative_universe(
            live_maps(), ticker_limit=6, base_url="https://watchlist.test"
        )

        self.assertEqual(
            universe,
            ["AMZN", "MSFT", "GOOG", "META", "ORCL", "ALL"],
        )

    def test_chunking_invokes_node_scorer_once_per_twenty_five(self):
        records = [{"ticker": f"T{index}"} for index in range(53)]

        def fake_score(batch):
            return [{"ticker": row["ticker"], "coverage": "scored"} for row in batch]

        with mock.patch.object(
            radar_scores, "score_chunk", side_effect=fake_score
        ) as scorer:
            results = radar_scores.score_records_in_chunks(records)

        self.assertEqual([len(call.args[0]) for call in scorer.call_args_list], [25, 25, 3])
        self.assertEqual(
            [result["ticker"] for result in results],
            [record["ticker"] for record in records],
        )

    def test_chart_without_bars_still_preserves_fund_instrument_type(self):
        response = FakeResponse({
            "chart": {
                "result": [{
                    "meta": {"instrumentType": "ETF"},
                    "timestamp": [],
                    "indicators": {"quote": [{"close": []}]},
                }],
                "error": None,
            }
        })
        with mock.patch.object(radar_scores.requests, "get", return_value=response):
            chart, instrument_type = radar_scores.fetch_chart("FUND")

        self.assertIsNone(chart)
        self.assertEqual(instrument_type, "ETF")

    def test_yahoo_session_collects_cookie_before_fetching_crumb(self):
        session = mock.Mock()
        session.headers = {}
        session.get.side_effect = [
            FakeResponse({}, status_code=404),
            FakeResponse({}, text="crumb-token\n"),
        ]

        with mock.patch.object(
            radar_scores.requests, "Session", return_value=session
        ) as session_factory:
            actual_session, crumb = radar_scores.get_yahoo_session()

        session_factory.assert_called_once_with()
        self.assertIs(actual_session, session)
        self.assertEqual(crumb, "crumb-token")
        self.assertEqual(session.headers, radar_scores.YAHOO_HEADERS)
        self.assertEqual(
            session.get.call_args_list,
            [
                mock.call("https://fc.yahoo.com", timeout=30),
                mock.call(
                    "https://query1.finance.yahoo.com/v1/test/getcrumb",
                    timeout=30,
                ),
            ],
        )

    def test_fund_profile_unwraps_raw_values_and_uses_expense_fallback(self):
        response = FakeResponse({
            "quoteSummary": {
                "result": [{
                    "fundProfile": {
                        "categoryName": "Technology",
                        "legalType": "Exchange Traded Fund",
                        "feesExpensesInvestment": {},
                    },
                    "defaultKeyStatistics": {
                        "annualReportExpenseRatio": {
                            "raw": 0.0065,
                            "fmt": "0.65%",
                        },
                    },
                    "summaryDetail": {
                        "totalAssets": {"raw": 1_200_000_000, "fmt": "1.2B"},
                        "yield": {"raw": 0.0123, "fmt": "1.23%"},
                    },
                }],
                "error": None,
            }
        })
        session = mock.Mock()
        session.get.return_value = response

        profile = radar_scores.fetch_fund_profile("FUND", session, "crumb")

        self.assertEqual(profile, {
            "expenseRatio": 0.0065,
            "totalAssets": 1_200_000_000,
            "category": "Technology",
            "yield": 0.0123,
            "legalType": "Exchange Traded Fund",
        })
        session.get.assert_called_once_with(
            "https://query1.finance.yahoo.com/v10/finance/quoteSummary/FUND",
            params={
                "modules": "fundProfile,defaultKeyStatistics,summaryDetail",
                "crumb": "crumb",
            },
            timeout=30,
        )

    def test_fund_enrichment_fetches_one_session_and_reuses_it(self):
        stats = radar_scores.RunStats()
        results = [
            scored_result("ETF1", "fund"),
            scored_result("STOCK", "scored"),
            scored_result("ETF2", "fund"),
        ]
        session = object()
        profiles = [
            {"expenseRatio": 0.001, "totalAssets": 100},
            {"expenseRatio": 0.002, "totalAssets": 200},
        ]

        with mock.patch.object(
            radar_scores, "get_yahoo_session", return_value=(session, "crumb")
        ) as get_session, mock.patch.object(
            radar_scores, "fetch_fund_profile", side_effect=profiles
        ) as fetch_profile, mock.patch.object(
            radar_scores.time, "sleep"
        ) as sleep:
            enriched = radar_scores.enrich_fund_profiles(results, stats)

        self.assertIs(enriched, results)
        get_session.assert_called_once_with()
        self.assertEqual(fetch_profile.call_args_list, [
            mock.call("ETF1", session, "crumb"),
            mock.call("ETF2", session, "crumb"),
        ])
        sleep.assert_called_once_with(0.3)
        self.assertEqual(results[0]["fund_profile"], profiles[0])
        self.assertIsNone(results[1]["fund_profile"])
        self.assertEqual(results[2]["fund_profile"], profiles[1])
        self.assertEqual(stats.degraded, 0)

    def test_quote_summary_failure_keeps_fund_and_marks_run_degraded(self):
        stats = radar_scores.RunStats(expected=1, attempted=1)
        results = radar_scores.apply_result_stats(
            stats, [scored_result("ETF", "fund")]
        )

        with mock.patch.object(
            radar_scores, "get_yahoo_session", return_value=(object(), "crumb")
        ), mock.patch.object(
            radar_scores, "fetch_fund_profile", side_effect=RuntimeError("HTTP 503")
        ), mock.patch("builtins.print") as log:
            enriched = radar_scores.enrich_fund_profiles(results, stats)

        self.assertEqual([result["ticker"] for result in enriched], ["ETF"])
        self.assertIsNone(enriched[0]["fund_profile"])
        self.assertEqual(stats.known_no_data, 1)
        self.assertEqual(stats.transient_failures, 0)
        self.assertEqual(stats.degraded, 1)
        log.assert_called_once_with(
            "ETF: Yahoo fund profile unavailable (HTTP 503)"
        )

    def test_manifest_stats_map_coverage_and_errors(self):
        stats = radar_scores.RunStats(expected=5, attempted=5)
        results = [
            scored_result("AAA", "scored"),
            scored_result("ETF", "fund"),
            scored_result("FOREIGN", "no_filings"),
            {"ticker": "BAD", "coverage": "error", "error": "scorer failed"},
            {"ticker": "UNKNOWN", "coverage": "unexpected"},
        ]

        valid = radar_scores.apply_result_stats(stats, results)

        self.assertEqual([row["ticker"] for row in valid], ["AAA", "ETF", "FOREIGN"])
        self.assertEqual(stats.usable, 1)
        self.assertEqual(stats.known_no_data, 2)
        self.assertEqual(stats.transient_failures, 2)
        self.assertEqual(
            stats.details["coverage"],
            {"scored": 1, "no_filings": 1, "fund": 1, "error": 2},
        )

    def test_upsert_uses_guard_returning_and_expected_row_shape(self):
        conn = FakeConnection()
        result = scored_result()
        row = radar_scores.radar_row(result, date(2026, 8, 18))

        with mock.patch.object(
            radar_scores.psycopg2.extras,
            "execute_values",
            return_value=[("ALL",)],
        ) as execute_values:
            persisted = radar_scores.persist_radar_rows(conn, [row])

        self.assertEqual(persisted, [("ALL",)])
        self.assertEqual(len(row), 17)
        self.assertEqual(
            row[:4], ("ALL", date(2026, 8, 18), "scored", 81)
        )
        self.assertEqual(json_value(row[4]), result["qualityScore"]["components"])
        self.assertEqual(row[5], 72)
        self.assertEqual(json_value(row[6]), result["technicalScore"]["components"])
        self.assertEqual(row[7:9], (3, ["ai", "musk", "robotics"]))
        self.assertEqual(json_value(row[9]), result["memberships"])
        self.assertIsNone(row[10])
        self.assertEqual(row[11:], (
            20.5, 2050, 2025, "radar-v1", "method-sig", "input-sig"
        ))
        self.assertIn(
            "radar_scores.methodology_signature IS NOT DISTINCT FROM",
            radar_scores.UPSERT_SQL,
        )
        self.assertIn(
            "OR radar_scores.input_signature IS DISTINCT FROM",
            radar_scores.UPSERT_SQL,
        )
        self.assertIn("RETURNING ticker", radar_scores.UPSERT_SQL)
        execute_values.assert_called_once_with(
            conn.cursor_instance,
            radar_scores.UPSERT_SQL,
            [row],
            page_size=200,
            fetch=True,
        )
        self.assertEqual(conn.commits, 1)

    def test_fund_profile_is_json_in_upsert_row(self):
        result = scored_result("ETF", "fund")
        result["fund_profile"] = {
            "expenseRatio": 0.0065,
            "totalAssets": 1_200_000_000,
            "category": "Technology",
            "yield": None,
            "legalType": "Exchange Traded Fund",
        }

        row = radar_scores.radar_row(result, date(2026, 8, 18))

        self.assertEqual(json_value(row[10]), result["fund_profile"])
        self.assertIn("fund_profile", radar_scores.UPSERT_SQL)

    def test_migration_adds_fund_profile_column(self):
        normalized_sql = " ".join(radar_scores.MIGRATION_SQL.split())
        self.assertIn(
            "ALTER TABLE radar_scores ADD COLUMN IF NOT EXISTS fund_profile JSONB",
            normalized_sql,
        )


if __name__ == "__main__":
    unittest.main()
