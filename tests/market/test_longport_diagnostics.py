"""Opt-in fixed diagnostics with synthetic SDK objects; no live calls."""

import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from worker.market.providers import longport as provider
from worker.orchestration.db import WorkbenchError, canonical_json
from tests.market.test_longport_provider import RANGE, STARTED, candle, candles, fake_sdk


CREDENTIALS = {"app_key": "fixture-only-key", "app_secret": "fixture-only-secret", "access_token": "fixture-only-token"}


class SDKError(Exception):
    def __init__(self, code):
        super().__init__("fixture-private-token")
        self.code = code


class DiagnosticTests(unittest.TestCase):
    def call(self, sdk, *, diagnose=True):
        request = provider._request(**RANGE)
        with patch.dict(os.environ, {"TZ": "UTC"}), patch.object(provider, "_load_sdk", return_value=sdk), \
                patch.object(provider, "stamp", return_value=STARTED):
            return provider._official_call(request, CREDENTIALS, diagnostic=diagnose)

    def test_success_projection_is_identical_to_default(self):
        sdk, client = fake_sdk(candles())
        before = self.call(sdk, diagnose=False)
        after = self.call(sdk)
        self.assertEqual(before, after)
        self.assertEqual(client.history_candlesticks_by_date.call_count, 2)

    def test_fixed_phase_errors_do_not_output_exception_or_credentials(self):
        for phase in ("CONFIG_CONSTRUCTION_FAILED", "QUOTE_CONTEXT_SETUP_FAILED", "HISTORY_REQUEST_FAILED"):
            sdk, client = fake_sdk(candles())
            target = {"CONFIG_CONSTRUCTION_FAILED": sdk.Config.from_apikey,
                      "QUOTE_CONTEXT_SETUP_FAILED": sdk.QuoteContext,
                      "HISTORY_REQUEST_FAILED": client.history_candlesticks_by_date}[phase]
            target.side_effect = RuntimeError("fixture-private-token: 401 permission 301604")
            with self.subTest(phase=phase), self.assertRaisesRegex(WorkbenchError, "^LONGPORT_" + phase + "$") as caught:
                self.call(sdk)
            self.assertTrue(caught.exception.__suppress_context__)
            with self.assertRaisesRegex(RuntimeError, "fixture-private-token"):
                self.call(sdk, diagnose=False)

    def test_native_history_business_codes_are_exact_typed_and_operation_scoped(self):
        cases = {**provider._HISTORY_ERROR_CODES, 999999: "HISTORY_REQUEST_FAILED",
                 "301604": "HISTORY_REQUEST_FAILED", True: "HISTORY_REQUEST_FAILED"}
        for code, name in cases.items():
            sdk, client = fake_sdk(candles())
            sdk.OpenApiException = SDKError
            client.history_candlesticks_by_date.side_effect = SDKError(code)
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, "^LONGPORT_" + name + "$"):
                self.call(sdk)
            client.history_candlesticks_by_date.assert_called_once()
        for phase in ("CONFIG_CONSTRUCTION_FAILED", "QUOTE_CONTEXT_SETUP_FAILED"):
            sdk, _ = fake_sdk(candles())
            sdk.OpenApiException = SDKError
            target = sdk.Config.from_apikey if phase.startswith("CONFIG") else sdk.QuoteContext
            target.side_effect = SDKError(301607)
            with self.assertRaisesRegex(WorkbenchError, "^LONGPORT_" + phase + "$"):
                self.call(sdk)

    def test_untrusted_error_code_attributes_and_messages_are_not_classification(self):
        sdk, client = fake_sdk(candles())
        sdk.OpenApiException = SDKError
        untrusted = RuntimeError("LONGPORT_HISTORY_PERMISSION_DENIED fixture-private-token")
        untrusted.code = 301604
        client.history_candlesticks_by_date.side_effect = untrusted
        with self.assertRaisesRegex(WorkbenchError, "^LONGPORT_HISTORY_REQUEST_FAILED$"):
            self.call(sdk)

    def test_validation_is_not_weakened_in_diagnostic_mode(self):
        cases = (([candle(close=0)], "CLOSE_NOT_VALUABLE"),
                 ([candle(high=1)], "OHLC_RANGE_INVALID"),
                 ([candle(volume=True)], "VOLUME_INVALID"),
                 ([candle(timestamp="fixture-private-token")], "SDK_DATETIME_REQUIRED"),
                 ([candle(trade_session=1)], "NONREGULAR_OR_INVALID_SESSION"),
                 ([candle(), candle()], "DUPLICATE_CANDLE_DATE"),
                 ([candle()], "EXPECTED_DATE_COVERAGE_MISMATCH"))
        for rows, name in cases:
            sdk, _ = fake_sdk(rows)
            for diagnose in (False, True):
                with self.subTest(name=name, diagnose=diagnose), \
                        self.assertRaisesRegex(WorkbenchError, "^LONGPORT_" + name + "$"):
                    self.call(sdk, diagnose=diagnose)

    def test_response_shape_diagnostics_distinguish_empty_invalid_and_truncated(self):
        for rows, code in (([], "EMPTY_RESPONSE"), (None, "INVALID_RESPONSE_CONTAINER"),
                           ([candle()] * 1000, "POSSIBLY_TRUNCATED_RESPONSE")):
            sdk, _ = fake_sdk(rows)
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, "^LONGPORT_" + code + "$"):
                self.call(sdk)
            with self.assertRaisesRegex(WorkbenchError, "^LONGPORT_EMPTY_OR_POSSIBLY_TRUNCATED_RESPONSE$"):
                self.call(sdk, diagnose=False)

    def child(self, error_code, *, diagnostic):
        script = """import sys
sys.path.insert(0, %r)
from worker.market.providers import longport as p
from worker.orchestration.db import WorkbenchError
def fail(*args, **kwargs):
    raise WorkbenchError(%r)
p._official_call = fail
raise SystemExit(p._child_main(diagnostic=%r))
""" % (str(Path(provider.__file__).resolve().parents[3]), error_code, diagnostic)
        body = canonical_json({"request": provider._request(**RANGE), "credentials": CREDENTIALS}).encode()
        return subprocess.run([sys.executable, "-I", "-c", script], input=body, capture_output=True, timeout=5)

    def test_fixed_child_only_emits_allowlisted_exit_codes_and_no_text(self):
        for exit_code, suffix in provider.DIAGNOSTIC_EXIT_CODES.items():
            result = self.child("LONGPORT_" + suffix, diagnostic=True)
            self.assertEqual(result.returncode, exit_code)
            self.assertEqual((result.stdout, result.stderr), (b"", b""))
        for message in ("LONGPORT_CANDLE_FIELD_MISSING: fixture-private-token", "fixture-private-token", "LONGPORT_UNKNOWN"):
            result = self.child(message, diagnostic=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual((result.stdout, result.stderr), (b"", b""))
        result = self.child("LONGPORT_CANDLE_FIELD_MISSING", diagnostic=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual((result.stdout, result.stderr), (b"", b""))


if __name__ == "__main__":
    unittest.main()
