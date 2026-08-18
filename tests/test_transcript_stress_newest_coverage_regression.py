import sys
import types
import unittest
from pathlib import Path
from unittest import mock


try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    sys.modules["requests"] = types.ModuleType("requests")

try:
    import psycopg2  # noqa: F401
except ModuleNotFoundError:
    psycopg2 = types.ModuleType("psycopg2")
    psycopg2.__path__ = []
    psycopg2.extras = types.ModuleType("psycopg2.extras")
    psycopg2.extras.Json = lambda value: value
    sys.modules["psycopg2"] = psycopg2
    sys.modules["psycopg2.extras"] = psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import transcript_stress as stress
from etl_health import RunStats, evaluate_health


LONG_TRANSCRIPT = "Routine earnings-call commentary. " * (stress.MIN_TRANSCRIPT_WORDS + 1)


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def execute(self, query, params):
        self.connection.executed.append(params)


class FakeConnection:
    def __init__(self):
        self.executed = []
        self.commits = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1


class TranscriptStressNewestCoverageRegressionTests(unittest.TestCase):
    def test_call_gemini_default_body_preserves_json_mode_and_budget(self):
        response = mock.Mock(status_code=200)
        response.json.return_value = {
            "candidates": [{
                "content": {"parts": [{"text": "{}"}]}
            }]
        }
        with mock.patch.object(
            stress.requests, "post", return_value=response, create=True
        ) as post:
            stress.call_gemini("default prompt", max_retries=1)
            body = post.call_args.kwargs["json"]

        self.assertEqual(body, {
            "contents": [{"parts": [{"text": "default prompt"}]}],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": 2048,
                "responseMimeType": "application/json",
                "thinkingConfig": {"thinkingBudget": 0},
            },
        })
        self.assertEqual(post.call_args.kwargs["timeout"], 60)

    def test_workflow_serializes_scheduled_and_manual_transcript_runs(self):
        workflow = (
            Path(__file__).resolve().parents[1]
            / ".github" / "workflows" / "transcript-stress.yml"
        ).read_text(encoding="utf-8")
        self.assertIn("group: transcript-stress-etl", workflow)
        self.assertIn("cancel-in-progress: false", workflow)
        self.assertIn("name: Validate Ticker Limit", workflow)
        self.assertIn("^(0|[1-9][0-9]*)$", workflow)

    def analyze(self, quarters, existing, transcript_for):
        connection = FakeConnection()
        attempts = []

        def fetch_text(handle, year, quarter):
            attempts.append((year, quarter))
            return transcript_for(year, quarter)

        provider = {"obj": object(), "quarters": quarters}
        with (
            mock.patch.object(stress, "DEFEATBETA_OK", True),
            mock.patch.object(stress, "GEMINI_API_KEY", None),
            mock.patch.object(stress, "defeatbeta_transcripts", return_value=provider),
            mock.patch.object(stress, "defeatbeta_text", side_effect=fetch_text),
        ):
            stress.analyze_ticker(connection, "TEST", [], existing)

        return connection, attempts

    def test_newest_quarter_is_analyzed_when_two_older_quarters_exist(self):
        existing = {("TEST", 2025, 1), ("TEST", 2025, 2)}
        quarters = [
            (2025, 3, "2025-10-01"),
            (2025, 2, "2025-07-01"),
            (2025, 1, "2025-04-01"),
        ]

        connection, attempts = self.analyze(
            quarters, existing, lambda year, quarter: LONG_TRANSCRIPT
        )

        self.assertEqual(attempts, [(2025, 3)])
        self.assertIn(("TEST", 2025, 3), existing)
        self.assertEqual(connection.commits, 1)
        self.assertEqual((connection.executed[0][1], connection.executed[0][2]), (2025, 3))

    def test_failed_newest_transcript_does_not_consume_coverage(self):
        existing = {("TEST", 2025, 3)}
        quarters = [
            (2025, 4, "2026-01-01"),
            (2025, 3, "2025-10-01"),
            (2025, 2, "2025-07-01"),
        ]

        connection, attempts = self.analyze(
            quarters,
            existing,
            lambda year, quarter: None if quarter == 4 else LONG_TRANSCRIPT,
        )

        self.assertEqual(attempts, [(2025, 4), (2025, 2)])
        self.assertIn(("TEST", 2025, 2), existing)
        self.assertEqual(connection.commits, 1)
        self.assertEqual((connection.executed[0][1], connection.executed[0][2]), (2025, 2))

    def test_provider_exceptions_are_not_reclassified_as_no_data(self):
        with (
            mock.patch.object(stress, "API_NINJAS_KEY", "configured"),
            mock.patch.object(stress, "EARNINGSCALL_API_KEY", None),
            mock.patch.object(
                stress, "fetch_api_ninjas", side_effect=RuntimeError("provider down")
            ),
            mock.patch.object(stress.time, "sleep"),
        ):
            with self.assertRaisesRegex(RuntimeError, "provider down"):
                stress.fetch_transcript("TEST", 2026, 2)

    def test_persisted_latest_degraded_score_keeps_second_run_degraded(self):
        class LatestCursor:
            def __init__(self, connection):
                self.connection = connection

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def execute(self, query):
                self.connection.queries.append(query)

            def fetchone(self):
                return (self.connection.latest_degraded,)

        class LatestConnection:
            def __init__(self):
                self.latest_degraded = 1
                self.queries = []

            def cursor(self):
                return LatestCursor(self)

        connection = LatestConnection()
        first_run = RunStats(expected=1, attempted=1, usable=1)
        second_run = RunStats(expected=1, attempted=1, usable=1)

        # Run one writes the fallback. Run two writes nothing, but /stress
        # still serves that same latest lexicon-only row.
        stress.apply_persisted_degraded_health(connection, first_run, 1)
        stress.apply_persisted_degraded_health(connection, second_run, 0)

        self.assertEqual(evaluate_health(first_run).state, "degraded")
        self.assertEqual(evaluate_health(second_run).state, "degraded")
        self.assertEqual(second_run.degraded, 1)
        self.assertEqual(second_run.details["newDegradedRows"], 0)
        self.assertEqual(second_run.details["latestDegradedScores"], 1)
        self.assertIn("SELECT DISTINCT ON (ticker)", connection.queries[-1])
        self.assertIn("model IS NULL", connection.queries[-1])


if __name__ == "__main__":
    unittest.main()
