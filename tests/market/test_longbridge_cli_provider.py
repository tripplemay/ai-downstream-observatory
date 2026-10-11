"""Synthetic fixtures only; no OAuth, provider requests or database writes."""

from contextlib import contextmanager
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from worker.market import __main__ as market_cli
from worker.market.providers import longbridge_cli as provider
from worker.orchestration.db import WorkbenchError


SYMBOL = "SYNTH.US"
DATES = ["2025-06-05", "2025-06-06"]
CALL = {"call_started_at": "2025-06-07T12:00:00Z", "call_returned_at": "2025-06-07T12:00:01Z"}
REQUEST = {"symbol": SYMBOL, "start_date": DATES[0], "end_date": DATES[1], "expected_dates": DATES}


def encoded(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode("utf-8")


def quote(symbol=SYMBOL, **changes):
    return {"symbol": symbol, "last": "10.1250", "prev_close": "10.0000", "status": "Normal", **changes}


def candle(day=DATES[0], **changes):
    return {"time": day + "T04:00:00Z", "open": "10", "high": "12", "low": "9",
            "close": "10.1250", "volume": 12345, "turnover": "123456.2500", **changes}


def parse_candles(rows=None, **changes):
    args = {**REQUEST, **CALL, **changes}
    return provider.normalize_cli_candles(encoded(rows if rows is not None else [candle(day) for day in DATES]), **args)


class ProjectionTests(unittest.TestCase):
    def test_quotes_use_cli_fields_and_never_claim_freshness(self):
        result = provider.normalize_cli_quotes(encoded([quote(timestamp="2025-06-07T12:00:00Z",
                                                               access_token="synthetic-do-not-output")]),
                                               symbols=[SYMBOL], **CALL)
        row = result["records"][0]
        self.assertEqual(row["last"], "10.1250")
        self.assertIsNone(row["source_timestamp"])
        self.assertEqual(row["freshness"], "not_verified")
        self.assertNotIn("synthetic-do-not-output", json.dumps(result))
        self.assertEqual(result["source"]["capture_kind"], "cli_projection")
        self.assertEqual(result["source"]["collector_runtime"], "not_verified_by_parser")
        self.assertFalse(result["source"]["data_use_license_verified"])

    def test_unknown_quote_status_is_sanitized_not_a_normal_quote(self):
        result = provider.normalize_cli_quotes(encoded([quote(status="synthetic-private-diagnostic")]), symbols=[SYMBOL], **CALL)
        self.assertEqual(result["records"][0]["status"], "not_normal_or_unknown")
        self.assertNotIn("synthetic-private-diagnostic", json.dumps(result))

    def test_quote_symbol_set_is_exact_and_bounded(self):
        for rows, symbols in (([], [SYMBOL]), ([quote("OTHER.US")], [SYMBOL]),
                              ([quote(), quote()], [SYMBOL, "OTHER.US"]), ([quote()], []),
                              ([quote()], [SYMBOL, SYMBOL]), ([quote()], [SYMBOL] * 5)):
            with self.subTest(symbols=symbols), self.assertRaises(WorkbenchError):
                provider.normalize_cli_quotes(encoded(rows), symbols=symbols, **CALL)
        rows = [quote("123.HK"), quote("500001.SH"), quote()]
        result = provider.normalize_cli_quotes(encoded(rows), symbols=[SYMBOL, "500001.SH", "123.HK"], **CALL)
        self.assertEqual({row["market"] for row in result["records"]}, {"CN", "HK", "US"})

    def test_legacy_sdk_quote_shape_does_not_pass(self):
        row = {"symbol": SYMBOL, "last_done": "10", "prev_close": "9", "trade_status": "Normal"}
        with self.assertRaisesRegex(WorkbenchError, "QUOTE_FIELDS_INVALID"):
            provider.normalize_cli_quotes(encoded([row]), symbols=[SYMBOL], **CALL)

    def test_bad_quote_values_are_not_coerced(self):
        for value in (True, 10, 10.1, "NaN", "Infinity", "1e2", "01", "-0", "-1", "0", "9" * 39,
                      "0." + "1" * 19):
            with self.subTest(value=value), self.assertRaises(WorkbenchError):
                provider.normalize_cli_quotes(encoded([quote(last=value)]), symbols=[SYMBOL], **CALL)

    def test_json_duplicate_nonfinite_invalid_utf8_and_limits_are_sanitized(self):
        cases = (b'{"synthetic-secret":1,"synthetic-secret":2}', b"[NaN]", b"[Infinity]", b"[1.1]",
                 b"\xff", b"not json", b"", b" " * (provider.MAX_OUTPUT_BYTES + 1), b"[" * 2000)
        for raw in cases:
            with self.subTest(length=len(raw)), self.assertRaises(WorkbenchError) as caught:
                provider._json(raw)
            self.assertNotIn("synthetic-secret", str(caught.exception))

    def test_decimal_and_int64_spelling_remain_exact(self):
        close = "9007199254740993.123456789123456789"
        row = candle(open=close, close=close, low="9007199254740993", high="9007199254740994",
                     volume=2 ** 63 - 1)
        result = parse_candles([row, candle(DATES[1])])
        self.assertEqual(result["records"][0]["close"], close)
        self.assertEqual(result["records"][0]["volume"], str(2 ** 63 - 1))
        self.assertEqual(result["records"][1]["close"], "10.1250")

    def test_cn_and_hk_utc_previous_day_is_local_trading_day(self):
        rows = [candle(time="2025-06-04T16:00:00Z"), candle(time="2025-06-05T16:00:00Z")]
        for symbol, zone in (("500001.SH", "Asia/Shanghai"), ("100001.SZ", "Asia/Shanghai"),
                             ("00123.HK", "Asia/Hong_Kong")):
            with self.subTest(symbol=symbol):
                result = parse_candles(rows, symbol=symbol)
                self.assertEqual([row["observed_at"] for row in result["records"]], DATES)
                self.assertEqual(result["request"]["source_timezone"], zone)

    def test_us_midnight_boundary_and_dst_are_not_fixed_utc_offset(self):
        for timestamp, day in (("2025-01-06T04:30:00Z", "2025-01-05"),
                               ("2025-06-06T04:30:00Z", "2025-06-06"),
                               ("2025-06-06T00:30:00Z", "2025-06-05")):
            with self.subTest(timestamp=timestamp):
                result = parse_candles([candle(time=timestamp)], start_date=day, end_date=day, expected_dates=[day])
                self.assertEqual(result["records"][0]["observed_at"], day)
                self.assertFalse(result["source"]["calendar_verified"])

    def test_request_does_not_invent_calendar_or_accept_shell_flags(self):
        for symbol in ("--execute", "SYNTH.US;order", "../private", "synth.US", "SYNTH.US\n", True, []):
            with self.subTest(symbol=symbol), self.assertRaisesRegex(WorkbenchError, "SYMBOL_INVALID"):
                parse_candles(symbol=symbol)
        for changes in ({"start_date": "20250605"}, {"end_date": "2025-02-30"},
                        {"end_date": "2025-06-04"}, {"start_date": "2025-05-01"},
                        {"expected_dates": []}, {"expected_dates": [DATES[0]] * 2},
                        {"expected_dates": ["2025-06-04"]}, {"expected_dates": "2025-06-05"}):
            with self.subTest(changes=changes), self.assertRaises(WorkbenchError):
                parse_candles(**changes)

    def test_missing_extra_duplicate_empty_and_reordered_bars_block(self):
        for rows, code in (([], "CANDLE_COUNT"), ([candle()], "COVERAGE_MISMATCH"),
                           ([candle(), candle()], "DUPLICATE"), ([candle("2025-06-04")], "OUTSIDE_REQUEST"),
                           ([candle(DATES[1]), candle()], "ORDER_INVALID"), ([candle()] * 32, "CANDLE_COUNT")):
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, code):
                parse_candles(rows)
        with self.assertRaisesRegex(WorkbenchError, "COVERAGE_MISMATCH"):
            parse_candles(expected_dates=[DATES[0]])

    def test_naive_offsets_alias_only_current_and_future_bars_block(self):
        for timestamp in ("2025-06-05", "2025-06-05T04:00:00", "2025-06-05T04:00:00+00:00", 123, True):
            with self.subTest(timestamp=timestamp), self.assertRaisesRegex(WorkbenchError, "UTC_INSTANT_REQUIRED"):
                parse_candles([candle(time=timestamp), candle(DATES[1])])
        row = candle()
        row["timestamp"] = row.pop("time")
        with self.assertRaisesRegex(WorkbenchError, "CANDLE_FIELDS_INVALID"):
            parse_candles([row, candle(DATES[1])])
        for call in ({"call_started_at": "2025-06-06T23:00:00Z", "call_returned_at": "2025-06-06T23:00:01Z"},
                     {"call_started_at": "2025-06-07T12:00:01Z", "call_returned_at": "2025-06-07T12:00:00Z"}):
            with self.subTest(call=call), self.assertRaises(WorkbenchError):
                parse_candles(**call)

    def test_ohlc_volume_turnover_and_fields_are_strict(self):
        cases = ({"close": "0"}, {"close": True}, {"high": "9"}, {"low": "11"},
                 {"open": "13"}, {"volume": True}, {"volume": 1.1}, {"volume": "01"},
                 {"volume": -1}, {"volume": 2 ** 63}, {"turnover": "-0"}, {"turnover": 10})
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(WorkbenchError):
                parse_candles([candle(**changes), candle(DATES[1])])
        row = candle()
        del row["turnover"]
        with self.assertRaisesRegex(WorkbenchError, "CANDLE_FIELDS_INVALID"):
            parse_candles([row, candle(DATES[1])])
        self.assertEqual(parse_candles([candle(volume="0", turnover="0"), candle(DATES[1])])["records"][0]["volume"], "0")


@unittest.skipUnless(os.name == "posix", "The worker runtime requires POSIX process groups and timers")
class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.home = self.directory / "oauth-home"
        self.home.mkdir(mode=0o700)

    def test_private_home_no_global_fallback(self):
        self.assertEqual(provider._private_home(str(self.home)), str(self.home.resolve()))
        self.home.chmod(0o755)
        with self.assertRaisesRegex(WorkbenchError, "PRIVATE_HOME_REQUIRED"):
            provider._private_home(str(self.home))
        self.home.chmod(0o700)
        link = self.directory / "linked-home"
        link.symlink_to(self.home)
        for value in (str(link), ".", "/nonexistent-synthetic-directory", str(Path.home())):
            with self.subTest(value=value), self.assertRaisesRegex(WorkbenchError, "PRIVATE_HOME_REQUIRED"):
                provider._private_home(value)

    def test_verified_private_binary_copy_not_unchecked_path(self):
        for name, value in (("system", "Darwin"), ("machine", "arm64")):
            mocked = patch.object(provider.platform, name, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)
        binary = self.directory / "binary"
        binary.write_bytes(b"synthetic-binary")
        binary.chmod(0o700)
        digest = sha256(binary.read_bytes()).hexdigest()
        with patch.dict(provider.APPROVED_BINARIES, {(provider.platform.system(), provider.platform.machine()): digest}):
            with provider._verified_runtime(str(binary)) as (copy, cwd, actual):
                self.assertNotEqual(copy, str(binary))
                self.assertEqual(Path(copy).read_bytes(), b"synthetic-binary")
                self.assertEqual(actual, digest)
                self.assertEqual(Path(cwd).stat().st_mode & 0o777, 0o700)
                self.assertEqual(Path(copy).stat().st_mode & 0o777, 0o700)
                self.assertEqual((Path(cwd) / ".env").read_bytes(), b"")
            self.assertFalse(Path(copy).exists())
        with self.assertRaisesRegex(WorkbenchError, "DIGEST_NOT_APPROVED"):
            with provider._verified_runtime(str(binary)):
                self.fail("unchecked binary")
        binary.chmod(0o722)
        with self.assertRaisesRegex(WorkbenchError, "BINARY_INVALID"):
            with provider._verified_runtime(str(binary)):
                self.fail("writable binary")
        with patch.object(provider.platform, "system", return_value="not-approved"):
            with self.assertRaisesRegex(WorkbenchError, "PLATFORM_NOT_APPROVED"):
                with provider._verified_runtime(str(binary)):
                    self.fail("unchecked platform")

    def run_script(self, script, **changes):
        return provider._run([sys.executable, "-I", "-c", script], home=str(self.home),
                             cwd=str(self.directory), **changes)

    def test_no_inherited_credentials_proxies_or_database_and_no_stdin(self):
        private = {"LONGBRIDGE_APP_SECRET": "synthetic-secret", "LONGPORT_ACCESS_TOKEN": "synthetic-token",
                   "HTTPS_PROXY": "synthetic-proxy", "LONGBRIDGE_HTTP_URL": "synthetic-host",
                   "WORKBENCH_DB_PATH": "synthetic-db"}
        with patch.dict(os.environ, private):
            result = json.loads(self.run_script("import os,sys,json;print(json.dumps({'env':dict(os.environ),'stdin':sys.stdin.read()}))"))
        self.assertEqual(result["env"]["HOME"], str(self.home))
        self.assertEqual(result["env"]["LONGBRIDGE_REGION"], "global")
        self.assertEqual(result["stdin"], "")
        for key in private:
            self.assertNotIn(key, result["env"])

    def test_process_errors_never_echo_raw_diagnostics(self):
        for text, code in (("401 synthetic-token", "AUTHENTICATION_FAILED"),
                           ("403 synthetic-token", "PERMISSION_OR_ENTITLEMENT_FAILED"),
                           ("429 synthetic-token", "RATE_LIMITED"), ("synthetic-token", "PROVIDER_CALL_FAILED")):
            script = "import sys;sys.stderr.write(" + repr(text) + ");sys.exit(1)"
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, code) as caught:
                self.run_script(script)
            self.assertNotIn("synthetic-token", str(caught.exception))

    def test_stdout_and_stderr_caps(self):
        for descriptor, constant in ((1, "MAX_OUTPUT_BYTES"), (2, "MAX_DIAGNOSTIC_BYTES")):
            with patch.object(provider, constant, 64):
                with self.assertRaisesRegex(WorkbenchError, "PROCESS_OUTPUT_LIMIT"):
                    self.run_script(f"import os;os.write({descriptor},b'x'*100)")

    def test_parent_deadline_and_independent_kernel_alarm(self):
        started = time.monotonic()
        with self.assertRaisesRegex(WorkbenchError, "CALL_TIMEOUT"):
            self.run_script("import time;time.sleep(10)", timeout=0.15)
        self.assertLess(time.monotonic() - started, 3)
        argv = provider._child_argv([sys.executable, "-I", "-c", "import time;time.sleep(10)"], 0.15)
        result = subprocess.run(argv, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, -signal.SIGALRM)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")

    def test_inspection_exact_command_allowlist_and_summary_only(self):
        @contextmanager
        def runtime(_):
            yield "/synthetic/verified-binary", str(self.directory), "a" * 64

        output = [("longbridge " + provider.CLI_VERSION + "\n").encode(), encoded([quote()]),
                  encoded([candle(day) for day in DATES])]
        with patch.object(provider, "_verified_runtime", runtime), patch.object(provider, "_run", side_effect=output) as runner:
            result = provider.inspect_longbridge_cli(binary_path="/synthetic/input", oauth_home=str(self.home), **REQUEST)
        calls = [call.args[0] for call in runner.call_args_list]
        self.assertEqual(calls, [
            ["/synthetic/verified-binary", "--version"],
            ["/synthetic/verified-binary", "quote", SYMBOL, "--format", "json"],
            ["/synthetic/verified-binary", "kline", "history", SYMBOL, "--start", DATES[0], "--end", DATES[1],
             "--period", "day", "--adjust", "none", "--session", "intraday", "--format", "json"],
        ])
        self.assertEqual(result["market_dates"], DATES)
        for field in ("production_ready", "workbench_database_accessed", "market_values_output",
                      "market_values_persisted_by_adapter", "trade_commands_executed", "calendar_verified"):
            self.assertFalse(result[field])
        self.assertNotIn("10.1250", json.dumps(result))
        self.assertNotIn(str(self.home), json.dumps(result))
        self.assertEqual(result["quote_freshness"], "not_verified")

    def test_validation_failure_never_starts_binary_or_returns_partial_success(self):
        with patch.object(provider, "_run") as runner:
            for change in ({"symbol": "--execute"}, {"end_date": "9999-12-31", "start_date": "9999-12-31",
                                                       "expected_dates": ["9999-12-31"]}):
                with self.subTest(change=change), self.assertRaises(WorkbenchError):
                    provider.inspect_longbridge_cli(binary_path="/synthetic/input", oauth_home=str(self.home),
                                                     **{**REQUEST, **change})
            runner.assert_not_called()
        @contextmanager
        def runtime(_):
            yield "/synthetic/verified-binary", str(self.directory), "a" * 64
        with patch.object(provider, "_verified_runtime", runtime), patch.object(provider, "_run", return_value=b"wrong version") as runner:
            with self.assertRaisesRegex(WorkbenchError, "VERSION_NOT_APPROVED"):
                provider.inspect_longbridge_cli(binary_path="/synthetic/input", oauth_home=str(self.home), **REQUEST)
            self.assertEqual(runner.call_count, 1)

    def test_cli_dispatch_has_no_database_or_raw_value_output(self):
        args = ["inspect-longbridge", "--cli-binary", "/synthetic/binary", "--oauth-home", str(self.home),
                "--symbol", SYMBOL, "--start", DATES[0], "--end", DATES[1]]
        for day in DATES:
            args.extend(["--expected-date", day])
        with patch.object(market_cli, "open_database", side_effect=AssertionError("database access")), \
                patch.object(provider, "inspect_longbridge_cli", return_value={"status": "sample_read_ok"}) as inspect, \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(market_cli.main(args), 0)
            self.assertEqual(json.loads(output.getvalue()), {"status": "sample_read_ok"})
            self.assertEqual(inspect.call_args.kwargs["expected_dates"], DATES)
        with patch.object(provider, "inspect_longbridge_cli") as inspect, patch("sys.stderr", new_callable=io.StringIO):
            with self.assertRaises(SystemExit) as caught:
                market_cli.main(args + ["--execute"])
            self.assertEqual(caught.exception.code, 2)
            inspect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
