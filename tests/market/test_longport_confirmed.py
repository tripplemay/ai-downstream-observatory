"""SDK callbacks and subprocesses are fictional; no credentials/market access."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from decimal import Decimal, localcontext
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch
from zoneinfo import ZoneInfo

from worker.market.providers import longport, longport_confirmed as receiver
from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, content_hash, stamp


WATCH = "a" * 32
STARTED, RECEIVED = "2026-01-02T06:59:00.123456Z", "2026-01-02T07:02:00.234567Z"
CREDENTIALS = {"app_key": "fixture-only-key", "app_secret": "fixture-only-secret", "access_token": "fixture-only-token"}


def target(market="CN", day="2026-01-02", identity=None):
    close = {"CN": "07", "HK": "08", "US": "21"}[market]
    return {"mapping": {"listing_id": identity or "fictional-" + market, "provider_symbol": {"CN": "501999.SH", "HK": "9999.HK", "US": "FIC01.US"}[market],
        "market": market, "currency": {"CN": "CNY", "HK": "HKD", "US": "USD"}[market]}, "session_date": day,
        "close_at": day + "T" + close + ":00:00.000Z", "available_at": day + "T" + close + ":01:00.000Z", "calendar_hash": "b" * 64}


def candle(market="CN", day="2026-01-02", **overrides):
    row = {"open": Decimal("10.0000"), "high": Decimal("12"), "low": Decimal("9.0"), "close": Decimal("11.250000000000000001"),
        "turnover": Decimal("11250.0000"), "volume": 9007199254740993, "trade_session": 0,
        "timestamp": datetime.fromisoformat(day).replace(tzinfo=ZoneInfo(longport._MARKETS[market][0]))}
    return {**row, **overrides}


def result(target_=None, candle_=None, received=RECEIVED):
    return receiver.normalize_confirmed_day(candle_ or candle(), target_ or target(), watch_id=WATCH, started_at=STARTED, received_at=received)


def frames(bars=None, targets=None):
    request = receiver.make_watch_request(targets or [target()], WATCH, watch_seconds=1)
    values = [{"frame": "ready", "watch_id": WATCH, "request_hash": content_hash(request), "started_at": STARTED,
        "sdk_version": longport.SDK_VERSION, "adapter_version": receiver.ADAPTER_VERSION}]
    for index, bar in enumerate([result()] if bars is None else bars, 1):
        values.append({"frame": "bar", "sequence": index, "projection": bar["projection"], "sha256": bar["projection_sha256"]})
    values.append({"frame": "finished", "watch_id": WATCH, "events": len(values) - 1, "reason": "watch_window_elapsed"})
    return request, values


def parse(request, values):
    raw = b"".join(canonical_json(value).encode() + b"\n" for value in values)
    return receiver.parse_confirmed_watch(raw, request, STARTED, RECEIVED)


class ConfirmedProjectionTests(unittest.TestCase):
    def test_same_day_decimal_microseconds_and_no_exchange_or_calendar_claim(self):
        with localcontext() as context:
            context.prec = 3
            value = result()
        self.assertEqual(value["record"]["value"], "11.250000000000000001")
        self.assertEqual(value["projection"]["candlestick"]["volume"], "9007199254740993")
        self.assertEqual(value["record"]["ingested_at"], RECEIVED)
        self.assertEqual(value["record"]["observed_at"], "2026-01-02")
        self.assertIsNone(value["record"]["published_at"])
        source = value["projection"]["source"]
        self.assertEqual(source["confirmation_semantics"], "pinned_sdk_local_engine_not_exchange_signoff")
        for name in ("calendar_verified_by_adapter", "mapping_verified_by_adapter", "account_buyability_verified", "network_bytes_preserved", "subscription_snapshot_used", "stream_continuity_verified"):
            self.assertFalse(source[name])

    def test_three_markets_and_dst_keep_the_provider_bar_date_separate_from_close(self):
        for market, day, received in (("CN", "2026-01-02", RECEIVED), ("HK", "2026-01-02", "2026-01-02T08:02:00.234567Z"),
                                     ("US", "2026-03-09", "2026-03-09T21:02:00.234567Z")):
            with self.subTest(market=market):
                value = result(target(market, day), candle(market, day), received)
                self.assertEqual(value["record"]["observed_at"], day)
                self.assertNotEqual(value["record"]["provider_timestamp"], value["projection"]["target"]["close_at"])

    def test_before_close_future_wrong_day_naive_and_nonregular_are_rejected(self):
        for value, received in ((candle(), "2026-01-02T07:00:00.234567Z"), (candle(day="2026-01-03"), RECEIVED),
                                (candle(timestamp=datetime(2026, 1, 2)), RECEIVED), (candle(trade_session=1), RECEIVED)):
            with self.subTest(value=value), self.assertRaises(WorkbenchError):
                result(candle_=value, received=received)
        with self.assertRaises(WorkbenchError):
            result(received="2026-01-02T06:58:00.234567Z")

    def test_bad_money_float_bool_volume_and_ohlc_do_not_enter_the_projection(self):
        for change in ({"close": 11.25}, {"volume": True}, {"volume": 9223372036854775808}, {"volume": -1},
                       {"close": "0"}, {"low": "13"}, {"turnover": "-0"}, {"close": "NaN"}):
            with self.subTest(change=change), self.assertRaises(WorkbenchError):
                result(candle_=candle(**change))

    def test_request_rejects_credentials_endpoints_authority_duplicate_scope_and_bad_bounds(self):
        for change in ({"endpoint": "https://fixture.invalid"}, {"credentials": CREDENTIALS}, {"execution_authorized": True},
                       {"calendar_hash": "x"}, {"mapping": {**target()["mapping"], "market": "ZZ"}}):
            with self.subTest(change=change), self.assertRaises(WorkbenchError):
                receiver.make_watch_request([{**target(), **change}], WATCH)
        for seconds in (0, 901, True, 1.5):
            with self.assertRaises(WorkbenchError): receiver.make_watch_request([target()], WATCH, watch_seconds=seconds)
        with self.assertRaises(WorkbenchError): receiver.make_watch_request([target(), target()], WATCH)
        with self.assertRaises(WorkbenchError): receiver.make_watch_request([target()] * 33, WATCH)
        with self.assertRaises(WorkbenchError): receiver.make_watch_request([], WATCH)

    def test_complete_partial_empty_and_pure_parser_qualification_are_explicit(self):
        request, values = frames()
        self.assertEqual(parse(request, values)["status"], "complete")
        self.assertEqual(parse(request, values)["qualification"], "parser_only_not_network_authenticated")
        request, values = frames(targets=[target(), target("HK")])
        self.assertEqual(parse(request, values)["status"], "partial")
        request, values = frames(bars=[])
        self.assertEqual(parse(request, values)["status"], "no_confirmed_events")

    def test_resealed_confirmation_source_scope_time_decimal_and_digest_mutations_fail(self):
        request, values = frames()
        for mutate in (
            lambda v: v[1]["projection"]["source"].update(is_confirmed=False),
            lambda v: v[1]["projection"]["source"].update(subscription_snapshot_used=True),
            lambda v: v[1]["projection"]["source"].update(sdk_version="4.3.8"),
            lambda v: v[1]["projection"]["source"].update(receiver_started_at=RECEIVED),
            lambda v: v[1]["projection"]["source"].update(received_at="2027-01-02T07:02:00.234567Z"),
            lambda v: v[1]["projection"]["target"]["mapping"].update(listing_id="another-listing"),
            lambda v: v[1]["projection"]["candlestick"].update(close=11.25),
            lambda v: v[1].update(sequence=True),
            lambda v: v[-1].update(events=True),
        ):
            changed = deepcopy(values); mutate(changed)
            changed[1]["sha256"] = content_hash(changed[1]["projection"])
            with self.assertRaisesRegex(WorkbenchError, "CHILD_RESPONSE_INVALID"):
                parse(request, changed)

    def test_unfinished_duplicate_extra_noncanonical_and_oversized_frames_fail(self):
        request, values = frames()
        for changed in (values[:-1], values + [values[-1]], [*values[:-1], {**values[1], "sequence": 2}, {**values[-1], "events": 2}],
                        [{**values[0], "secret": "Fictional"}, *values[1:]]):
            with self.assertRaisesRegex(WorkbenchError, "CHILD_RESPONSE_INVALID"): parse(request, changed)
        for raw in (json.dumps(values[0]).encode() + b"\n", b'{"frame":"ready","frame":"finished"}\n', b"NaN\n", b"x" * (receiver.MAX_OUTPUT_BYTES + 1)):
            with self.assertRaisesRegex(WorkbenchError, "CHILD_RESPONSE_INVALID"):
                receiver.parse_confirmed_watch(raw, request, STARTED, RECEIVED)

    def test_bool_integer_aliases_fail_even_with_the_original_replay_digest(self):
        request, values = frames()
        for name, value in (("is_confirmed", 1), ("network_bytes_preserved", 0),
                            ("calendar_verified_by_adapter", 0), ("subscription_snapshot_used", 0)):
            changed = deepcopy(values)
            changed[1]["projection"]["source"][name] = value
            for reseal in (False, True):
                with self.subTest(name=name, reseal=reseal):
                    if reseal:
                        changed[1]["sha256"] = content_hash(changed[1]["projection"])
                    with self.assertRaisesRegex(WorkbenchError, "CHILD_RESPONSE_INVALID"):
                        parse(request, changed)

    def test_historical_adapter_still_rejects_the_current_local_day(self):
        current = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
        request = longport._request(target(day=current)["mapping"], current, current, [current])
        with self.assertRaises(WorkbenchError):
            longport._normalize([candle(day=current)], request=request, sdk_version=longport.SDK_VERSION,
                call_started_at=stamp(), call_returned_at=stamp(),
                datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")


class ConfirmedSdkTests(unittest.TestCase):
    def sdk(self, callbacks):
        client, day, intraday, confirmed = Mock(), object(), object(), object()
        sdk = types.SimpleNamespace(Config=types.SimpleNamespace(from_apikey=Mock(return_value=object())),
            QuoteContext=Mock(return_value=client), Period=types.SimpleNamespace(Day=day),
            TradeSessions=types.SimpleNamespace(Intraday=intraday), PushCandlestickMode=types.SimpleNamespace(Confirmed=confirmed))
        def subscribed(symbol, *_):
            for event in callbacks(day): client.set_on_candlestick.call_args[0][0](symbol, event)
            return [candle(close="9999")]
        client.subscribe_candlesticks.side_effect = subscribed
        return sdk, client

    def watch(self, sdk, request=None):
        emitted = []
        clock = iter([STARTED] + [RECEIVED] * 64)
        def stamped(value=None):
            return next(clock) if value is None else stamp(value)
        try:
            with patch.dict(os.environ, {"TZ": "UTC"}), patch.object(longport, "_load_sdk", return_value=sdk), \
                    patch.object(receiver, "stamp", side_effect=stamped), patch.object(receiver.Event, "wait", return_value=False):
                receiver._watch_with_sdk(request or receiver.make_watch_request([target()], WATCH, watch_seconds=1), CREDENTIALS, emitted.append)
        finally:
            time.tzset()
        return emitted

    def event(self, day, *, confirmed=True, row=None, period=None):
        return types.SimpleNamespace(period=day if period is None else period, is_confirmed=confirmed,
            candlestick=types.SimpleNamespace(**(row or candle())))

    def tearDown(self):
        receiver._CHILD_CONTEXT = None

    def test_config_uses_only_confirmed_daily_regular_and_ignores_snapshot_returns(self):
        sdk, client = self.sdk(lambda day: [])
        values = self.watch(sdk)
        self.assertEqual([v["frame"] for v in values], ["ready", "finished"])
        self.assertEqual(values[-1]["events"], 0)
        arguments = sdk.Config.from_apikey.call_args.kwargs
        self.assertIs(arguments["push_candlestick_mode"], sdk.PushCandlestickMode.Confirmed)
        self.assertFalse(arguments["enable_overnight"]); self.assertFalse(arguments["enable_print_quote_packages"])
        self.assertEqual(arguments["app_key"], "fixture-only-key")
        client.subscribe_candlesticks.assert_called_once_with("501999.SH", sdk.Period.Day, sdk.TradeSessions.Intraday)
        self.assertEqual(client.set_on_candlestick.call_count, 1)

    def test_actual_callback_confirmation_is_required_and_duplicates_are_not_new_evidence(self):
        sdk, client = self.sdk(lambda day: [self.event(day, confirmed=False, row=candle(close="9999")), self.event(day), self.event(day)])
        values = self.watch(sdk)
        self.assertEqual([v["frame"] for v in values], ["ready", "bar", "finished"])
        self.assertEqual(values[-1]["events"], 1)
        self.assertEqual(parse(receiver.make_watch_request([target()], WATCH, watch_seconds=1), values)["status"], "complete")
        callback = client.set_on_candlestick.call_args[0][0]
        callback("501999.SH", self.event(sdk.Period.Day, row=candle(close="10")))
        self.assertEqual(len(values), 3)

    def test_conflicting_confirmation_bad_period_flag_session_or_clock_discard_batch(self):
        for callbacks in (lambda day: [self.event(day), self.event(day, row=candle(close="10"))],
                          lambda day: [self.event(day, period="minute")], lambda day: [self.event(day, confirmed=1)],
                          lambda day: [self.event(day, row=candle(trade_session=1))]):
            sdk, _ = self.sdk(callbacks)
            with self.assertRaisesRegex(WorkbenchError, "CALLBACK_INVALID"):
                self.watch(sdk)

    def test_other_dates_do_not_cover_requested_session_and_utc_sdk_naive_timestamp_is_projected(self):
        sdk, _ = self.sdk(lambda day: [self.event(day, row=candle(day="2026-01-01"))])
        self.assertEqual(self.watch(sdk)[-1]["events"], 0)
        sdk, _ = self.sdk(lambda day: [self.event(day, row=candle(timestamp=datetime(2026, 1, 1, 16)))])
        values = self.watch(sdk)
        self.assertEqual(values[1]["projection"]["candlestick"]["timestamp"], "2026-01-01T16:00:00.000000Z")


class ConfirmedInstalledSdkTests(unittest.TestCase):
    def test_pinned_sdk_exposes_the_callback_contract_without_connecting(self):
        sdk = longport._load_sdk()
        for name in ("is_confirmed", "period", "candlestick"):
            self.assertTrue(hasattr(sdk.PushCandlestick, name))
        self.assertTrue(hasattr(sdk.PushCandlestickMode, "Confirmed"))
        self.assertTrue(hasattr(sdk.QuoteContext, "set_on_candlestick"))
        self.assertTrue(hasattr(sdk.QuoteContext, "subscribe_candlesticks"))


class ConfirmedProcessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="etf-confirmed-test-")
        self.addCleanup(self.temporary.cleanup)
        self.probe = Path(self.temporary.name) / "probe.json"
        self.processes = []

    def request(self):
        day = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
        return receiver.make_watch_request([target(day=day)], WATCH, watch_seconds=1)

    def transport(self, mode, *, stop=None, startup=None, request=None, before_credentials=None):
        actual = subprocess.Popen
        observed = {}
        def credentials():
            if before_credentials:
                before_credentials()
            return CREDENTIALS
        def spawn(arguments, **kwargs):
            self.assertEqual(arguments, [sys.executable, "-I", str(Path(receiver.__file__).resolve()), "--confirmed-sdk-child"])
            self.assertEqual(set(kwargs["env"]), {"TZ", "HOME", "LANG", "LC_ALL", "PYTHONUTF8"})
            self.assertEqual(kwargs["env"]["TZ"], "UTC")
            self.assertEqual(kwargs["env"]["HOME"], kwargs["cwd"])
            self.assertEqual(os.stat(kwargs["cwd"]).st_mode & 0o777, 0o700)
            empty = Path(kwargs["cwd"]) / ".env"
            self.assertEqual(empty.read_bytes(), b""); self.assertEqual(empty.stat().st_mode & 0o777, 0o600)
            self.assertIs(kwargs["stdin"], subprocess.PIPE); self.assertIs(kwargs["stderr"], subprocess.DEVNULL)
            self.assertTrue(kwargs["start_new_session"])
            observed["cwd"] = kwargs["cwd"]
            value = actual([sys.executable, "-I", str(ROOT / "tests/market/confirmed_receiver_fixture.py"), mode, str(self.probe)], **kwargs)
            self.processes.append(value)
            return value
        try:
            with patch.object(longport, "_credentials", side_effect=credentials), patch.object(receiver.subprocess, "Popen", side_effect=spawn), \
                    patch.object(receiver, "STARTUP_SECONDS", receiver.STARTUP_SECONDS if startup is None else startup):
                return receiver.collect_confirmed_days(self.request() if request is None else request, stop_requested=stop)
        finally:
            if "cwd" in observed: self.assertFalse(Path(observed["cwd"]).exists())
            for process in self.processes: self.assertIsNotNone(process.poll())

    def test_private_child_success_and_no_event_are_not_faked_complete_coverage(self):
        value = self.transport("complete")
        self.assertEqual(value["status"], "complete")
        self.assertEqual(value["qualification"], "isolated_official_sdk_callback")
        self.assertFalse(value["stream_continuity_verified"])
        self.assertEqual(value["bars"][0]["record"]["value"], "11.2500")
        self.assertTrue(json.loads(self.probe.read_text())["credentials_are_fictional"])
        self.assertEqual(self.transport("empty")["status"], "no_confirmed_events")

    def test_late_failure_discards_valid_earlier_frames_and_hides_exception_strings(self):
        for mode in ("bad", "late-bad"):
            with self.subTest(mode=mode), self.assertRaisesRegex(WorkbenchError, "^LONGPORT_CONFIRMED_SDK_RECEIVER_FAILED$"):
                self.transport(mode)

    def test_clean_child_exit_cannot_bypass_canonical_replay(self):
        with self.assertRaisesRegex(WorkbenchError, "^LONGPORT_CONFIRMED_CHILD_RESPONSE_INVALID$"):
            self.transport("coerced-bool")

    def test_request_is_snapshotted_before_credentials_io(self):
        request = self.request()
        original = deepcopy(request)
        def mutate():
            request["watch_id"] = "c" * 32
            request["targets"][0]["mapping"]["listing_id"] = "fictional-mutation"
        result = self.transport("complete", request=request, before_credentials=mutate)
        self.assertNotEqual(request, original)
        self.assertEqual(result["request"], original)
        self.assertEqual(result["bars"][0]["record"]["listing_id"], original["targets"][0]["mapping"]["listing_id"])

    def test_stop_and_wall_timeout_reap_only_the_owned_receiver(self):
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            self.transport("stall", stop=Mock(side_effect=[False, False, True]))
        with self.assertRaisesRegex(WorkbenchError, "WATCH_TIMEOUT"):
            self.transport("stall", startup=0)

    def test_independent_kernel_timer_and_core_dump_limit_apply_to_owned_child(self):
        with self.assertRaisesRegex(WorkbenchError, "SDK_RECEIVER_FAILED"):
            self.transport("kernel-stall")
        self.assertEqual(self.processes[-1].returncode, -signal.SIGALRM)
        probe = json.loads(self.probe.read_text())
        self.assertTrue(probe["credentials_are_fictional"])
        self.assertEqual(probe["core_limit"], [0, 0])
        self.assertEqual(probe["file_limit"], [receiver.MAX_OUTPUT_BYTES] * 2)

    def test_stop_after_clean_exit_discards_the_completed_batch(self):
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            self.transport("complete", stop=Mock(side_effect=[False, False, True]))

    def test_invalid_request_or_initial_stop_does_not_read_credentials_or_spawn(self):
        with patch.object(longport, "_credentials") as secrets, patch.object(receiver.subprocess, "Popen") as spawn:
            with self.assertRaises(WorkbenchError): receiver.collect_confirmed_days({"endpoint": "https://fixture.invalid"})
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                receiver.collect_confirmed_days(self.request(), stop_requested=lambda: True)
            secrets.assert_not_called(); spawn.assert_not_called()

    def test_real_child_rejects_bad_shape_duplicate_keys_and_arbitrary_methods_before_sdk(self):
        for raw in (b'{"request":{},"credentials":{},"endpoint":"https://fixture.invalid"}', b'{"request":{},"request":{},"credentials":{}}', b"NaN", b"x" * (longport.MAX_CHILD_INPUT_BYTES + 1)):
            value = subprocess.run([sys.executable, "-I", str(Path(receiver.__file__).resolve()), "--confirmed-sdk-child"],
                input=raw, capture_output=True, cwd=self.temporary.name,
                env={"TZ": "UTC", "HOME": self.temporary.name, "PYTHONUTF8": "1"}, timeout=5)
            self.assertEqual(value.returncode, 1); self.assertEqual(value.stdout, b""); self.assertEqual(value.stderr, b"")


if __name__ == "__main__":
    unittest.main()
