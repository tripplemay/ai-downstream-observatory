"""Synthetic SDK objects/processes only; no LongPort install, login or market I/O."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, localcontext
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

from worker.market.providers import longport as provider
from worker.orchestration.db import WorkbenchError, canonical_json


MAPPING = {"listing_id": "listing:synthetic", "provider_symbol": "SYNTH.US", "market": "US", "currency": "USD"}
STARTED = "2025-06-07T12:00:00.123456Z"
RETURNED = "2025-06-07T12:00:01.234567Z"
RANGE = {"mapping": MAPPING, "start_date": "2025-06-05", "end_date": "2025-06-06", "expected_dates": ["2025-06-05", "2025-06-06"]}
SYNTHETIC_CREDENTIALS = {"LONGPORT_APP_KEY": "fixture-only-key", "LONGPORT_APP_SECRET": "fixture-only-secret", "LONGPORT_ACCESS_TOKEN": "fixture-only-token"}


def candle(day="2025-06-05", **overrides):
    values = {"open": Decimal("10.0000"), "high": Decimal("11.0000"), "low": Decimal("9.0"),
              "close": Decimal("10.123456789012345678"), "volume": 9007199254740993,
              "turnover": Decimal("105.0000"), "timestamp": datetime.fromisoformat(day + "T20:00:00.123456+00:00"),
              "trade_session": 0}
    values.update(overrides)
    return types.SimpleNamespace(**values)


def candles():
    return [candle("2025-06-05"), candle("2025-06-06")]


def parse(rows=None, **overrides):
    kwargs = {**RANGE, "sdk_version": provider.SDK_VERSION, "call_started_at": STARTED, "call_returned_at": RETURNED}
    kwargs.update(overrides)
    return provider.normalize_longport_candles(candles() if rows is None else rows, **kwargs)


def fake_sdk(rows):
    client = Mock()
    client.history_candlesticks_by_date.return_value = rows
    sdk = types.SimpleNamespace(Config=types.SimpleNamespace(from_apikey=Mock(return_value=object())),
                                QuoteContext=Mock(return_value=client), Period=types.SimpleNamespace(Day=object()),
                                AdjustType=types.SimpleNamespace(NoAdjust=object()),
                                TradeSessions=types.SimpleNamespace(Intraday=object()))
    return sdk, client


class ProjectionTests(unittest.TestCase):
    def test_exact_projection_and_row_hash_are_not_network_or_calendar_proof(self):
        with localcontext() as context:
            context.prec = 4
            result = parse()
        raw = result["projection_bytes"]
        self.assertEqual(raw, canonical_json(result["projection"]).encode())
        self.assertEqual(result["projection_sha256"], sha256(raw).hexdigest())
        projected = json.loads(raw)["candlesticks"][0]
        self.assertEqual(projected["close"], "10.123456789012345678")
        self.assertEqual(projected["open"], "10.0000")
        self.assertEqual(projected["turnover"], "105.0000")
        self.assertEqual(projected["volume"], "9007199254740993")
        self.assertEqual(projected["timestamp"], "2025-06-05T20:00:00.123456Z")
        source = result["source"]
        self.assertEqual(source["capture_kind"], "sdk_projection")
        self.assertEqual(source["collector_runtime"], "not_verified_by_parser")
        self.assertEqual(source["coverage_status"], "matches_caller_expected_dates_only")
        for key in ("network_bytes_preserved", "calendar_verified_by_adapter", "mapping_verified_by_adapter", "account_buyability_verified"):
            self.assertIs(source[key], False)
        for row in result["records"]:
            self.assertIsNone(row["published_at"])
            self.assertIsNone(row["provider_revision"])
            self.assertEqual(row["ingested_at"], RETURNED)
            self.assertEqual(row["provenance"], "live_observed")
            self.assertEqual(row["time_precision"], "date")
            self.assertEqual(row["projection_sha256"], result["projection_sha256"])

    def test_projection_retains_response_order_while_records_sort_and_point_to_original_row(self):
        result = parse(candles()[::-1])
        self.assertEqual([row["projection_row"] for row in result["records"]], [1, 0])
        self.assertEqual(result["projection"]["candlesticks"][0]["timestamp"], "2025-06-06T20:00:00.123456Z")
        self.assertNotEqual(result["projection_sha256"], parse()["projection_sha256"])

    def test_source_mapping_request_and_server_times_are_in_projection_hash(self):
        baseline = parse()["projection_sha256"]
        for changes in ({"mapping": {**MAPPING, "listing_id": "listing:other"}},
                        {"call_returned_at": "2025-06-07T12:00:02Z"}, {"sdk_version": "4.3.8"}):
            with self.subTest(changes=changes):
                self.assertNotEqual(parse(**changes)["projection_sha256"], baseline)

    def test_listing_identifier_matches_common_contract_without_becoming_a_path(self):
        listing_id = "listing:synthetic.ETF_1-2"
        result = parse(mapping={**MAPPING, "listing_id": listing_id})
        self.assertEqual(result["request"]["mapping"]["listing_id"], listing_id)
        self.assertTrue(all(row["listing_id"] == listing_id for row in result["records"]))
        with self.assertRaisesRegex(WorkbenchError, "MAPPING_INVALID"):
            parse(mapping={**MAPPING, "listing_id": "listing:synthetic/ETF-1"})

    def test_cn_hk_us_mapping_and_timezone_do_not_rewrite_provider_symbol(self):
        for market, symbol, currency, zone in (("CN", "500001.SH", "CNY", "Asia/Shanghai"),
                                               ("CN", "100001.SZ", "CNY", "Asia/Shanghai"),
                                               ("HK", "00123.HK", "HKD", "Asia/Hong_Kong"),
                                               ("HK", "123.HK", "USD", "Asia/Hong_Kong"),
                                               ("HK", "81234.HK", "CNY", "Asia/Hong_Kong"),
                                               ("US", "SYN.A.US", "USD", "America/New_York")):
            with self.subTest(symbol=symbol):
                mapping = {**MAPPING, "market": market, "provider_symbol": symbol, "currency": currency}
                rows = [candle(day, timestamp=datetime.fromisoformat(day + "T10:00:00+00:00")) for day in RANGE["expected_dates"]]
                result = parse(rows, mapping=mapping)
                self.assertEqual(result["request"]["mapping"]["provider_symbol"], symbol)
                self.assertEqual(result["source"]["source_timezone"], zone)

    def test_invalid_scope_suffix_currency_and_extra_metadata_rejected(self):
        for change in ({"market": "CN"}, {"currency": "CNY"}, {"provider_symbol": "synth.US"},
                       {"provider_symbol": "SYNTH.HK"}, {"provider_symbol": "SYNTH.US/secret"},
                       {"listing_id": "../private"}, {"listing_id": True}, {"market": []},
                       {"verified": True}, {"currency": False}):
            with self.subTest(change=change), self.assertRaisesRegex(WorkbenchError, "MAPPING_INVALID"):
                parse(mapping={**MAPPING, **change})

    def test_date_objects_accepted_but_datetimes_bad_dates_and_ranges_not_guessed(self):
        self.assertEqual(parse(start_date=date(2025, 6, 5), end_date=date(2025, 6, 6))["request"], parse()["request"])
        for changes in ({"start_date": datetime(2025, 6, 5)}, {"start_date": "20250605"},
                        {"start_date": "0000-01-01"}, {"end_date": "2025-02-30"},
                        {"end_date": "2025-06-04"}, {"start_date": "2025-05-01"}):
            with self.subTest(changes=changes), self.assertRaises(WorkbenchError):
                parse(**changes)

    def test_expected_calendar_must_be_explicit_nonempty_unique_and_in_range(self):
        for dates in ([], None, "2025-06-05", ["2025-06-05"] * 2, ["2025-06-04"], [True], ["2025-06-05"] * 32):
            with self.subTest(dates=dates), self.assertRaisesRegex(WorkbenchError, "EXPECTED_DATES"):
                parse(expected_dates=dates)

    def test_expected_dates_do_not_become_verified_even_if_they_include_a_weekend(self):
        result = parse([candle("2025-06-01")], start_date="2025-06-01", end_date="2025-06-01", expected_dates=["2025-06-01"])
        self.assertFalse(result["source"]["calendar_verified_by_adapter"])
        self.assertEqual(result["source"]["coverage_status"], "matches_caller_expected_dates_only")

    def test_missing_duplicate_extra_and_empty_bars_never_pass(self):
        cases = [([], "EMPTY"), ([candle()], "COVERAGE_MISMATCH"), ([candle(), candle()], "DUPLICATE"),
                 ([candle("2025-06-04")], "OUTSIDE_REQUEST"), ([candle()] * 1000, "TRUNCATED"),
                 ([candle()] * 32, "CANDLE_COUNT")]
        for rows, code in cases:
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, code):
                parse(rows)

    def test_unexpected_bar_inside_requested_range_still_fails_exact_calendar_set(self):
        with self.assertRaisesRegex(WorkbenchError, "COVERAGE_MISMATCH"):
            parse(expected_dates=["2025-06-05"])

    def test_naive_or_non_datetime_candle_timestamps_are_not_assumed_utc(self):
        for value in (datetime(2025, 6, 5, 20), date(2025, 6, 5), "2025-06-05T20:00:00Z", 1749153600, True):
            with self.subTest(value=value), self.assertRaisesRegex(WorkbenchError, "DATETIME_REQUIRED"):
                parse([candle(timestamp=value), candle("2025-06-06")])

    def test_aware_offset_retains_instant_and_microseconds_and_uses_market_date(self):
        value = datetime(2025, 6, 6, 0, 30, 0, 123456, tzinfo=timezone.utc)
        rows = [candle(timestamp=value), candle("2025-06-06")]
        result = parse(rows)
        self.assertEqual(result["records"][0]["observed_at"], "2025-06-05")
        shifted = value.astimezone(timezone(timedelta(hours=9)))
        self.assertEqual(parse([candle(timestamp=shifted), candle("2025-06-06")]), result)

    def test_current_local_day_not_final_even_if_timestamp_before_collection(self):
        with self.assertRaisesRegex(WorkbenchError, "INCOMPLETE_OR_FUTURE_LOCAL_DATE"):
            parse(call_started_at="2025-06-07T01:00:00Z", call_returned_at="2025-06-07T01:00:01Z")
        with self.assertRaisesRegex(WorkbenchError, "INCOMPLETE_OR_FUTURE_LOCAL_DATE"):
            parse([candle("2025-06-08")])

    def test_call_instants_require_utc_strings_or_aware_datetimes_and_order(self):
        for value in ("2025-06-07", "2025-06-07T12:00:00+00:00", "2025-06-07T12:00:00.1234567Z", datetime(2025, 6, 7), True):
            with self.subTest(value=value), self.assertRaises(WorkbenchError):
                parse(call_started_at=value)
        with self.assertRaisesRegex(WorkbenchError, "CLOCK_INVALID"):
            parse(call_returned_at="2025-06-07T12:00:00Z")

    def test_no_bool_float_nonfinite_negative_or_excess_precision_money(self):
        for value in (True, 10.1, float("nan"), Decimal("NaN"), Decimal("Infinity"), "1e2", "01", "-0", "-1",
                      Decimal("1E+999999"), Decimal("1E-999999"), "0." + "1" * 19, "9" * 39):
            with self.subTest(value=value), self.assertRaises(WorkbenchError):
                parse([candle(close=value), candle("2025-06-06")])

    def test_close_zero_and_impossible_price_ranges_are_rejected_without_fill(self):
        for changes in ({"close": Decimal("0")}, {"low": Decimal("12")}, {"high": Decimal("9")}, {"open": Decimal("12")}):
            with self.subTest(changes=changes), self.assertRaises(WorkbenchError):
                parse([candle(**changes), candle("2025-06-06")])
        self.assertEqual(parse([candle(low=Decimal("0"), open=Decimal("0"), volume=0, turnover=Decimal("0")), candle("2025-06-06")])["projection"]["candlesticks"][0]["volume"], "0")

    def test_session_and_volume_types_are_strict(self):
        for value in (True, 0.0, "0", 1, None):
            with self.subTest(session=value), self.assertRaisesRegex(WorkbenchError, "SESSION"):
                parse([candle(trade_session=value), candle("2025-06-06")])
        for value in (True, 1.0, "1", -1, 2 ** 63):
            with self.subTest(volume=value), self.assertRaisesRegex(WorkbenchError, "VOLUME_INVALID"):
                parse([candle(volume=value), candle("2025-06-06")])

    def test_missing_field_or_unknown_sdk_version_is_not_silently_defaulted(self):
        row = vars(candle()).copy()
        del row["trade_session"]
        with self.assertRaisesRegex(WorkbenchError, "FIELD_MISSING"):
            parse([row, candle("2025-06-06")])
        for version in (None, "", True, "unknown", "4.3.7\nprivate"):
            with self.subTest(version=version), self.assertRaisesRegex(WorkbenchError, "VERSION_REQUIRED"):
                parse(sdk_version=version)


class CollectorTests(unittest.TestCase):
    def test_injected_client_has_exact_day_noadjust_regular_and_internal_clock(self):
        client = Mock()
        client.history_candlesticks_by_date.return_value = candles()
        original = provider.stamp
        moments = iter([STARTED, RETURNED])
        with patch.object(provider, "stamp", side_effect=lambda value=None: next(moments) if value is None else original(value)):
            result = provider.collect_longport_candles(**RANGE, client=client, sdk_version="4.3.7")
        client.history_candlesticks_by_date.assert_called_once_with("SYNTH.US", period="day", adjust_type="none",
                                                                  start=date(2025, 6, 5), end=date(2025, 6, 6), trade_sessions="regular")
        self.assertEqual(result["source"]["collector_runtime"], "injected_test_client")
        self.assertEqual(result["source"]["call_returned_at"], RETURNED)
        self.assertFalse(result["source"]["calendar_verified_by_adapter"])

    def test_provider_failure_never_exposes_exception_or_triggers_retry_refresh(self):
        client = Mock()
        client.history_candlesticks_by_date.side_effect = RuntimeError("fixture-private-token")
        with self.assertRaisesRegex(WorkbenchError, "^LONGPORT_SDK_CALL_FAILED$") as caught:
            provider.collect_longport_candles(**RANGE, client=client, sdk_version="4.3.7")
        self.assertTrue(caught.exception.__suppress_context__)
        client.history_candlesticks_by_date.assert_called_once()
        client.refresh_access_token.assert_not_called()

    def test_invalid_request_prevents_sdk_call_and_no_credentials_prevents_process(self):
        client = Mock()
        with self.assertRaises(WorkbenchError):
            provider.collect_longport_candles(**{**RANGE, "expected_dates": []}, client=client, sdk_version="4.3.7")
        client.history_candlesticks_by_date.assert_not_called()
        with patch.dict(os.environ, {}, clear=True), patch.object(provider.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(WorkbenchError, "CREDENTIALS_REQUIRED"):
                provider.collect_longport_candles(**RANGE)
            spawn.assert_not_called()
        with self.assertRaisesRegex(WorkbenchError, "PRODUCTION_VERSION_NOT_CALLER_CONTROLLED"):
            provider.collect_longport_candles(**RANGE, sdk_version="4.3.7")

    def test_official_wrapper_only_attaches_utc_in_verified_runtime_and_uses_exact_enums(self):
        rows = [candle(day, timestamp=datetime.fromisoformat(day + "T20:00:00")) for day in RANGE["expected_dates"]]
        sdk, client = fake_sdk(rows)
        credentials = dict(zip(("app_key", "app_secret", "access_token"), SYNTHETIC_CREDENTIALS.values()))
        request = provider._request(**RANGE)
        original_tz = os.environ.get("TZ")
        try:
            with patch.dict(os.environ, {"TZ": "UTC"}), patch.object(provider, "_load_sdk", return_value=sdk):
                result = provider._official_call(request, credentials)
            client.history_candlesticks_by_date.assert_called_once_with("SYNTH.US", sdk.Period.Day, sdk.AdjustType.NoAdjust,
                                                                      date(2025, 6, 5), date(2025, 6, 6), sdk.TradeSessions.Intraday)
            args = sdk.Config.from_apikey.call_args.kwargs
            self.assertEqual(args["http_url"], "https://openapi.longportapp.com")
            self.assertEqual(args["quote_ws_url"], "wss://openapi-quote.longportapp.com/v2")
            self.assertFalse(args["enable_print_quote_packages"])
            self.assertFalse(args["enable_overnight"])
            self.assertEqual(result["source"]["sdk_datetime_basis"], "runtime_utc_from_unix_timestamp")
            self.assertEqual(result["source"]["collector_runtime"], "isolated_official_sdk")
            self.assertEqual(result["records"][0]["provider_timestamp"], "2025-06-05T20:00:00.000000Z")
            with patch.dict(os.environ, {"TZ": "Asia/Shanghai"}), patch.object(provider, "_load_sdk") as load:
                with self.assertRaisesRegex(WorkbenchError, "ISOLATED_UTC_REQUIRED"):
                    provider._official_call(request, credentials)
                load.assert_not_called()
        finally:
            if original_tz is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = original_tz
            time.tzset()

    def test_installed_version_is_checked_before_official_module_import(self):
        with patch.object(provider.metadata, "version", return_value="4.3.8"), patch.object(provider, "import_module") as load:
            with self.assertRaisesRegex(WorkbenchError, "VERSION_NOT_APPROVED"):
                provider._load_sdk()
            load.assert_not_called()
        module = object()
        with patch.object(provider.metadata, "version", return_value=provider.SDK_VERSION), patch.object(provider, "import_module", return_value=module) as load:
            self.assertIs(provider._load_sdk(), module)
            load.assert_called_once_with("longport.openapi")

    def _process(self, script, *, timeout=None):
        """Run a real isolated Python child with synthetic provider code only."""
        directory = tempfile.TemporaryDirectory(prefix="longport-test-")
        self.addCleanup(directory.cleanup)
        fixture = Path(directory.name) / "child.py"
        fixture.write_text(script)
        original_popen = subprocess.Popen
        observed = []

        def launch(args, **kwargs):
            self.assertEqual(args, [sys.executable, "-I", str(Path(provider.__file__).resolve()), "--sdk-child"])
            self.assertEqual(set(kwargs["env"]), {"TZ", "HOME", "LANG", "LC_ALL", "PYTHONUTF8"})
            self.assertEqual(kwargs["env"]["TZ"], "UTC")
            self.assertEqual(kwargs["env"]["HOME"], kwargs["cwd"])
            self.assertEqual(Path(kwargs["cwd"]).stat().st_mode & 0o777, 0o700)
            self.assertEqual((Path(kwargs["cwd"]) / ".env").stat().st_mode & 0o777, 0o600)
            self.assertEqual((Path(kwargs["cwd"]) / ".env").read_bytes(), b"")
            self.assertIs(kwargs["stderr"], subprocess.DEVNULL)
            self.assertTrue(kwargs["start_new_session"])
            self.assertNotIn("fixture-only", repr(args))
            process = original_popen([sys.executable, "-I", str(fixture)], **kwargs)
            observed.append((process, kwargs["cwd"]))
            return process

        self.addCleanup(lambda: [process.kill() for process, _ in observed if process.poll() is None])
        env = {**SYNTHETIC_CREDENTIALS, "LONGPORT_HTTP_URL": "https://not-a-provider.invalid",
               "LONGPORT_LOG_PATH": "/fixture/private", "HTTPS_PROXY": "http://fixture.invalid"}
        with patch.dict(os.environ, env), patch.object(provider.subprocess, "Popen", side_effect=launch), \
                patch.object(provider, "CALL_TIMEOUT_SECONDS", provider.CALL_TIMEOUT_SECONDS if timeout is None else timeout):
            try:
                return provider.collect_longport_candles(**RANGE)
            finally:
                for process, cwd in observed:
                    self.assertIsNotNone(process.poll())
                    self.assertFalse(Path(cwd).exists())

    def test_real_child_protocol_has_private_cwd_allowlist_env_stdin_credentials_and_exact_projection(self):
        script = """import json, os, pathlib, sys
assert os.environ['TZ'] == 'UTC'
assert 'LONGPORT_APP_KEY' not in os.environ
assert 'LONGPORT_HTTP_URL' not in os.environ
assert 'HTTPS_PROXY' not in os.environ
assert pathlib.Path('.env').read_bytes() == b''
body = json.load(sys.stdin)
assert set(body) == {'request', 'credentials'}
assert body['credentials']['app_key'] == 'fixture-only-key'
sys.path.insert(0, %r)
from worker.market.providers import longport as p
from tests.market.test_longport_provider import candles
result = p._normalize(candles(), request=body['request'], sdk_version=p.SDK_VERSION,
    call_started_at=p.stamp(), call_returned_at=p.stamp(),
    datetime_basis='runtime_utc_from_unix_timestamp', collector_runtime='isolated_official_sdk')
sys.stdout.buffer.write(result['projection_bytes'])
""" % str(Path(provider.__file__).resolve().parents[3])
        result = self._process(script)
        self.assertEqual(len(result["records"]), 2)
        self.assertEqual(result["source"]["collector_runtime"], "isolated_official_sdk")

    def test_real_child_timeout_is_killed_and_private_runtime_removed(self):
        with self.assertRaisesRegex(WorkbenchError, "SDK_CALL_TIMEOUT"):
            self._process("import time; time.sleep(10)", timeout=0.1)

    def test_fixed_child_protocol_runs_official_wrapper_with_synthetic_sdk_and_naive_datetimes(self):
        script = """import sys
sys.path.insert(0, %r)
from datetime import datetime
from worker.market.providers import longport as p
from tests.market.test_longport_provider import candle, fake_sdk
rows = [candle(day, timestamp=datetime.fromisoformat(day + 'T20:00:00')) for day in ['2025-06-05', '2025-06-06']]
sdk, client = fake_sdk(rows)
p._load_sdk = lambda: sdk
raise SystemExit(p._child_main())
""" % str(Path(provider.__file__).resolve().parents[3])
        result = self._process(script)
        self.assertEqual(result["source"]["sdk_datetime_basis"], "runtime_utc_from_unix_timestamp")
        self.assertEqual(result["records"][0]["provider_timestamp"], "2025-06-05T20:00:00.000000Z")

    def test_fixed_child_stdin_rejects_duplicates_extra_keys_and_bad_credentials_before_sdk(self):
        for body in ('{"request":{},"request":{},"credentials":{}}',
                     '{"request":{},"credentials":{},"method":"trade"}',
                     canonical_json({"request": provider._request(**RANGE), "credentials": {"app_key": True}})):
            script = """import io, sys
sys.path.insert(0, %r)
from worker.market.providers import longport as p
p.sys.stdin = type('Input', (), {'buffer': io.BytesIO(%r)})()
called = []
p._official_call = lambda *args: called.append(True)
status = p._child_main()
if called:
    sys.stdout.write('{}')
    raise SystemExit(0)
raise SystemExit(status)
""" % (str(Path(provider.__file__).resolve().parents[3]), body.encode())
            with self.subTest(body=body), self.assertRaisesRegex(WorkbenchError, "SDK_CALL_FAILED"):
                self._process(script)

    def test_real_child_failure_stderr_is_not_returned_or_parsed_as_market_data(self):
        with self.assertRaisesRegex(WorkbenchError, "^LONGPORT_SDK_CALL_FAILED$"):
            self._process("import sys; sys.stderr.write('fixture-private-token'); raise SystemExit(1)")

    def test_real_child_bad_json_excess_output_and_clock_or_scope_spoof_are_rejected(self):
        scripts = ["print('{bad-json')", "import sys; sys.stdout.write('x' * (2 * 1024 * 1024 + 1))"]
        for script in scripts:
            with self.subTest(script=script), self.assertRaisesRegex(WorkbenchError, "CHILD_RESPONSE_INVALID"):
                self._process(script)
        for alter in ("result['projection']['request']['mapping']['listing_id'] = 'other'",
                      "result['projection']['source']['call_started_at'] = '2000-01-01T00:00:00Z'",
                      "result['projection']['source']['calendar_verified_by_adapter'] = True"):
            script = """import json, sys
sys.path.insert(0, %r)
from worker.market.providers import longport as p
from tests.market.test_longport_provider import candles
body = json.load(sys.stdin)
result = p._normalize(candles(), request=body['request'], sdk_version=p.SDK_VERSION,
    call_started_at=p.stamp(), call_returned_at=p.stamp(), datetime_basis='runtime_utc_from_unix_timestamp',
    collector_runtime='isolated_official_sdk')
%s
sys.stdout.write(p.canonical_json(result['projection']))
""" % (str(Path(provider.__file__).resolve().parents[3]), alter)
            with self.subTest(alter=alter), self.assertRaisesRegex(WorkbenchError, "CHILD_RESPONSE_INVALID"):
                self._process(script)


if __name__ == "__main__":
    unittest.main()
