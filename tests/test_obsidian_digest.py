import os
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


try:
    import requests  # noqa: F401
except ModuleNotFoundError:
    sys.modules["requests"] = types.ModuleType("requests")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import obsidian_digest as digest


class ObsidianDigestServiceTokenTests(unittest.TestCase):
    def response(self):
        response = mock.Mock()
        response.json.return_value = {"ok": True}
        return response

    def test_get_json_attaches_configured_service_token(self):
        response = self.response()
        with mock.patch.dict(
            os.environ, {"SIGNALS_SERVICE_TOKEN": "weekly-secret"}
        ), mock.patch.object(
            digest.requests, "get", return_value=response, create=True
        ) as get:
            result = digest.get_json("/composite")

        self.assertEqual(result, {"ok": True})
        get.assert_called_once_with(
            f"{digest.BASE_URL}/composite",
            timeout=30,
            headers={"X-Service-Token": "weekly-secret"},
        )

    def test_get_json_omits_header_when_service_token_is_absent_or_empty(self):
        for token in (None, ""):
            with self.subTest(token=token):
                response = self.response()
                with mock.patch.dict(os.environ, {}, clear=False):
                    if token is None:
                        os.environ.pop("SIGNALS_SERVICE_TOKEN", None)
                    else:
                        os.environ["SIGNALS_SERVICE_TOKEN"] = token
                    with mock.patch.object(
                        digest.requests, "get", return_value=response, create=True
                    ) as get:
                        result = digest.get_json("/stress")

                self.assertEqual(result, {"ok": True})
                get.assert_called_once_with(
                    f"{digest.BASE_URL}/stress", timeout=30
                )


if __name__ == "__main__":
    unittest.main()
