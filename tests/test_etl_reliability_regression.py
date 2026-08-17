import contextlib
import importlib
import io
import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

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
    psycopg2_stub.extras = psycopg2_extras_stub
    sys.modules["psycopg2"] = psycopg2_stub
    sys.modules["psycopg2.extras"] = psycopg2_extras_stub

import etl_pipeline


class FakeMatrix:
    def to_numpy(self):
        return [["2026-08-17", "TEST", 10.0]]


class FakeLoadFrame:
    def __init__(self):
        self.columns = {"ticker", "price"}

    def __len__(self):
        return 1

    def __setitem__(self, key, _value):
        self.columns.add(key)

    def __getitem__(self, _columns):
        return FakeMatrix()

    def replace(self, _replacements):
        return self


class FakePipelineFrame:
    empty = False


class FakeRankedFrame(FakePipelineFrame):
    def __len__(self):
        return 1

    def __getitem__(self, _columns):
        return self

    def head(self, _count):
        return self

    def to_string(self):
        return "TEST"


SUCCESS_STATS = {
    "attempted": 1,
    "succeeded": 1,
    "failed": 0,
    "response_coverage": 1.0,
    "rows_loaded": 0,
}


class EtlReliabilityRegressionTests(unittest.TestCase):
    def test_invalid_response_coverage_environment_value_fails(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                etl_pipeline.minimum_sec_response_coverage(),
                0.90,
            )

        with mock.patch.dict(
            os.environ,
            {"RANKED_ETL_MIN_SEC_RESPONSE_COVERAGE": "not-a-number"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "must be a decimal"):
                etl_pipeline.minimum_sec_response_coverage()

        with mock.patch.dict(
            os.environ,
            {"RANKED_ETL_MIN_SEC_RESPONSE_COVERAGE": "1.1"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "between 0 and 1"):
                etl_pipeline.minimum_sec_response_coverage()

    def test_below_threshold_response_coverage_raises_with_counts(self):
        stats = {
            "attempted": 10,
            "succeeded": 8,
            "failed": 2,
            "response_coverage": 0.8,
        }
        with self.assertRaisesRegex(
            RuntimeError,
            r"80\.0%.*required 90\.0%.*attempted=10 succeeded=8 failed=2",
        ):
            etl_pipeline.enforce_sec_response_coverage(stats, minimum=0.9)

    def test_load_to_db_reraises_original_insert_error(self):
        original = RuntimeError("ranked insert failed")
        conn = mock.Mock()
        conn.cursor.return_value = mock.Mock()
        conn.rollback.side_effect = RuntimeError("rollback also failed")
        conn.close.side_effect = RuntimeError("close also failed")

        with (
            mock.patch.object(etl_pipeline, "DATABASE_URL", "postgres://test"),
            mock.patch.object(
                etl_pipeline.psycopg2,
                "connect",
                return_value=conn,
                create=True,
            ),
            mock.patch.object(
                etl_pipeline.psycopg2.extras,
                "execute_values",
                side_effect=original,
                create=True,
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            with self.assertRaises(RuntimeError) as raised:
                etl_pipeline.load_to_db(FakeLoadFrame())

        self.assertIs(raised.exception, original)
        conn.rollback.assert_called_once()
        conn.close.assert_called_once()

    def test_failure_manifest_error_does_not_replace_main_exception(self):
        original = ValueError("SEC universe unavailable")
        manifest_error = RuntimeError("manifest database unavailable")

        with (
            mock.patch.object(
                etl_pipeline,
                "record_run_manifest",
                side_effect=[None, manifest_error],
            ),
            mock.patch.object(
                etl_pipeline,
                "get_us_universe",
                side_effect=original,
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            with self.assertRaises(ValueError) as raised:
                etl_pipeline.main()

        self.assertIs(raised.exception, original)

    def test_main_propagates_load_failure_and_records_failure_state(self):
        original = RuntimeError("database load failed")
        manifest = mock.Mock()

        with (
            mock.patch.object(etl_pipeline, "record_run_manifest", manifest),
            mock.patch.object(
                etl_pipeline,
                "get_us_universe",
                return_value=(["TEST"], {"TEST": "0000000001"}),
            ),
            mock.patch.object(
                etl_pipeline,
                "apply_gates",
                return_value=FakePipelineFrame(),
            ),
            mock.patch.object(
                etl_pipeline,
                "fetch_sec_fundamentals",
                return_value=(object(), dict(SUCCESS_STATS)),
            ),
            mock.patch.object(
                etl_pipeline.pd,
                "merge",
                return_value=object(),
                create=True,
            ),
            mock.patch.object(
                etl_pipeline,
                "score",
                return_value=FakeRankedFrame(),
            ),
            mock.patch.object(
                etl_pipeline,
                "load_to_db",
                side_effect=original,
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            with self.assertRaises(RuntimeError) as raised:
                etl_pipeline.main()

        self.assertIs(raised.exception, original)
        self.assertEqual(
            [call.args[0] for call in manifest.call_args_list],
            ["running", "failure"],
        )
        self.assertIs(manifest.call_args_list[-1].kwargs["error"], original)

    def test_manifest_upsert_records_terminal_state_and_freshness_semantics(self):
        conn = mock.Mock()
        cur = mock.Mock()
        conn.cursor.return_value = cur

        with (
            mock.patch.object(etl_pipeline, "DATABASE_URL", "postgres://test"),
            mock.patch.object(
                etl_pipeline.psycopg2,
                "connect",
                return_value=conn,
                create=True,
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            etl_pipeline.record_run_manifest("running", dict(SUCCESS_STATS))
            success_stats = dict(SUCCESS_STATS, rows_loaded=1)
            etl_pipeline.record_run_manifest("success", success_stats)
            etl_pipeline.record_run_manifest(
                "failure",
                success_stats,
                error=RuntimeError("later retry failed"),
            )

        upserts = [
            call for call in cur.execute.call_args_list
            if len(call.args) == 2
        ]
        self.assertEqual([call.args[1][1] for call in upserts],
                         ["running", "success", "failure"])
        self.assertIn("ON CONFLICT (run_date) DO UPDATE", upserts[0].args[0])
        self.assertIn(
            "data_fresh_at = COALESCE",
            etl_pipeline.RUN_MANIFEST_UPSERT_SQL,
        )
        self.assertEqual(upserts[0].args[1][2:4], ("running", "running"))
        self.assertEqual(upserts[1].args[1][2:4], ("success", "success"))
        self.assertEqual(upserts[2].args[1][2:4], ("failure", "failure"))
        self.assertEqual(upserts[1].args[1][3], "success")
        self.assertEqual(upserts[2].args[1][-1], "later retry failed")
        self.assertEqual(conn.commit.call_count, 3)


if __name__ == "__main__":
    unittest.main()
