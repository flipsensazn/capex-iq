import sys
import types
import unittest
from pathlib import Path
from unittest import mock


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


if __name__ == "__main__":
    unittest.main()
