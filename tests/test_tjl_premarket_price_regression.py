import contextlib
import io
import json
import os
import sys
import tempfile
import time
import types
import unittest
import urllib.request
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCANNER = ROOT / "scanner"
sys.path.insert(0, str(SCANNER))

import tjl_scan  # noqa: E402


class FakeResponse:
    def __init__(self, payload):
        self.body = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.body


def embedded_gappers_python():
    source = (SCANNER / "premarket_gappers.sh").read_text(encoding="utf-8")
    marker = "\"$PY\" - <<'PYEOF'"
    start = source.index("\n", source.index(marker)) + 1
    end = source.rindex("\nPYEOF")
    return source[start:end]


class TjlPremarketPriceRegressionTests(unittest.TestCase):
    def test_tjl_uses_latest_timestamp_aligned_extended_hours_close(self):
        reg_start = 1_900_000_000
        pre_start = reg_start - 7_200
        daily_timestamps = [reg_start - (200 - i) * 86_400 for i in range(200)]
        daily_closes = [100.0] * 199 + [110.0]
        daily_highs = [101.0] * 199 + [112.0]
        daily = {
            "meta": {
                "regularMarketPrice": 90.0,
                "currentTradingPeriod": {
                    "pre": {"start": pre_start},
                    "regular": {"start": reg_start, "end": reg_start + 23_400},
                },
            },
            "timestamp": daily_timestamps,
            "indicators": {
                "quote": [{"high": daily_highs, "close": daily_closes}],
            },
        }
        intraday = {
            "timestamp": [pre_start + 60, pre_start + 120, pre_start + 180, reg_start + 60],
            "indicators": {
                "quote": [{
                    "high": [113.0, 115.0, 116.0, 999.0],
                    "close": [113.0, 115.0, None, 999.0],
                }],
            },
        }

        def chart(_symbol, interval, _range, prepost=False):
            if interval == "1d":
                return daily
            self.assertEqual(interval, "1m")
            self.assertTrue(prepost)
            return intraday

        with (
            mock.patch.object(tjl_scan, "yahoo_chart", side_effect=chart),
            mock.patch.object(tjl_scan.time, "time", return_value=reg_start - 600),
        ):
            result = tjl_scan.evaluate_tjl("TEST")

        self.assertEqual(result["curr_price"], 115.0)
        self.assertEqual(result["result"], "fail_intraday")

    def test_fallback_gappers_require_all_genuine_premarket_fields(self):
        quotes = [
            {
                "symbol": "PRE",
                "preMarketPrice": 7.25,
                "preMarketChangePercent": 12.0,
                "preMarketVolume": 50_000,
                "regularMarketPrice": 6.10,
                "regularMarketChangePercent": 3.0,
                "regularMarketVolume": 1_000_000,
            },
            {
                "symbol": "REGULAR_ONLY",
                "regularMarketPrice": 9.0,
                "regularMarketChangePercent": 15.0,
                "regularMarketVolume": 200_000,
            },
            {
                "symbol": "NO_PREMARKET_VOLUME",
                "preMarketPrice": 8.0,
                "preMarketChangePercent": 10.0,
                "regularMarketVolume": 200_000,
            },
            {
                "symbol": "NO_PREMARKET_CHANGE",
                "preMarketPrice": 8.0,
                "regularMarketChangePercent": 10.0,
                "preMarketVolume": 200_000,
            },
        ]

        def urlopen(request, timeout=20):
            url = request.full_url
            if "/screener/" in url:
                return FakeResponse({
                    "finance": {"result": [{"quotes": quotes}]},
                })
            if "benzinga.com/api/news" in url:
                return FakeResponse([])
            raise AssertionError(f"Unexpected request: {url}")

        fake_telegram = types.SimpleNamespace(send=mock.Mock())
        namespace = {}
        old_cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                with (
                    mock.patch.object(urllib.request, "urlopen", side_effect=urlopen),
                    mock.patch.object(time, "sleep"),
                    mock.patch.dict(sys.modules, {"telegram_notify": fake_telegram}),
                    mock.patch.dict(os.environ, {}, clear=True),
                    contextlib.redirect_stdout(io.StringIO()),
                    contextlib.redirect_stderr(io.StringIO()),
                ):
                    exec(
                        compile(
                            embedded_gappers_python(),
                            str(SCANNER / "premarket_gappers.sh"),
                            "exec",
                        ),
                        namespace,
                    )
            finally:
                os.chdir(old_cwd)

        self.assertEqual(
            namespace["rows"],
            [{
                "symbol": "PRE",
                "price": 7.25,
                "gap_pct": 12.0,
                "premarket_volume": 50_000,
            }],
        )

    def test_fallback_selection_has_no_regular_session_substitution(self):
        source = embedded_gappers_python()
        selection = source[source.index("rows = []"):source.index("rows.sort")]

        self.assertIn('q.get("preMarketPrice")', selection)
        self.assertIn('q.get("preMarketChangePercent")', selection)
        self.assertIn('q.get("preMarketVolume")', selection)
        self.assertNotIn("regularMarket", selection)


if __name__ == "__main__":
    unittest.main()
