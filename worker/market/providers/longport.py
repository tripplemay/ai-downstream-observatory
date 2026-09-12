"""Read-only LongPort daily candles, preserved as an SDK projection, not wire bytes.

No database, attachment, calendar approval, or publication writes occur here.
The pinned Python SDK creates local naive datetimes from Unix timestamps. Only
the isolated UTC child may attach UTC to those values; the pure parser refuses
naive datetimes. Source: longportapp/openapi@72e9be585d2724358ddaf7d6afbb64bb9e01205d,
python/src/time.rs, python/src/config.rs, rust/src/config.rs.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from hashlib import sha256
from importlib import import_module, metadata
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

if __name__ == "__main__":
    # The fixed child uses -I and an empty private cwd, never a caller module path.
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from worker.accounting import fact_decimal
from worker.orchestration.db import WorkbenchError, canonical_json, stamp


ADAPTER_VERSION = "longport-sdk-candles-v1"
SDK_VERSION = "4.3.7"
SDK_SOURCE_COMMIT = "72e9be585d2724358ddaf7d6afbb64bb9e01205d"
MAX_WINDOW_DAYS = 31
MAX_PROJECTION_BYTES = 2 * 1024 * 1024
MAX_CHILD_INPUT_BYTES = 64 * 1024
CALL_TIMEOUT_SECONDS = 30
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\Z", re.ASCII)
_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:[a-zA-Z0-9.+-]{0,32})?\Z", re.ASCII)
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z", re.ASCII)
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z\Z", re.ASCII)
_MARKETS = {"CN": ("Asia/Shanghai", {"CNY"}),
            "HK": ("Asia/Hong_Kong", {"HKD", "CNY", "USD"}),
            "US": ("America/New_York", {"USD"})}
_SYMBOLS = {"CN": re.compile(r"[0-9]{6}\.(?:SH|SZ)\Z", re.ASCII),
            "HK": re.compile(r"[0-9]{1,5}\.HK\Z", re.ASCII),
            "US": re.compile(r"[A-Z][A-Z0-9]{0,14}(?:[.-][A-Z0-9]{1,5})?\.US\Z", re.ASCII)}
_CANDLE_FIELDS = ("open", "high", "low", "close", "volume", "turnover", "timestamp", "trade_session")
_CREDENTIAL_NAMES = ("LONGPORT_APP_KEY", "LONGPORT_APP_SECRET", "LONGPORT_ACCESS_TOKEN")


def _day(value):
    if type(value) is date:
        return value
    if not isinstance(value, str) or not _DATE.fullmatch(value):
        raise WorkbenchError("LONGPORT_INVALID_DATE")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise WorkbenchError("LONGPORT_INVALID_DATE") from None


def _instant(value):
    if isinstance(value, str):
        if not _UTC.fullmatch(value):
            raise WorkbenchError("LONGPORT_UTC_INSTANT_REQUIRED")
        try:
            value = datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError:
            raise WorkbenchError("LONGPORT_UTC_INSTANT_REQUIRED") from None
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise WorkbenchError("LONGPORT_AWARE_DATETIME_REQUIRED")
    return value.astimezone(timezone.utc)


def _request(mapping, start_date, end_date, expected_dates):
    if (not isinstance(mapping, dict)
            or set(mapping) != {"listing_id", "provider_symbol", "market", "currency"}
            or not isinstance(mapping["listing_id"], str) or not _ID.fullmatch(mapping["listing_id"])
            or not isinstance(mapping["market"], str) or mapping["market"] not in _MARKETS):
        raise WorkbenchError("LONGPORT_MAPPING_INVALID")
    market = mapping["market"]
    if (not isinstance(mapping["provider_symbol"], str)
            or not _SYMBOLS[market].fullmatch(mapping["provider_symbol"])
            or not isinstance(mapping["currency"], str) or mapping["currency"] not in _MARKETS[market][1]):
        raise WorkbenchError("LONGPORT_MAPPING_INVALID")
    start, end = _day(start_date), _day(end_date)
    if not 0 <= (end - start).days < MAX_WINDOW_DAYS:
        raise WorkbenchError("LONGPORT_WINDOW_REQUIRES_BOUNDED_DATE_TILE")
    if not isinstance(expected_dates, (list, tuple)) or not 1 <= len(expected_dates) <= MAX_WINDOW_DAYS:
        raise WorkbenchError("LONGPORT_EXPECTED_DATES_REQUIRED")
    try:
        expected = [_day(value) for value in expected_dates]
    except WorkbenchError:
        raise WorkbenchError("LONGPORT_EXPECTED_DATES_INVALID") from None
    if len(set(expected)) != len(expected) or any(not start <= value <= end for value in expected):
        raise WorkbenchError("LONGPORT_EXPECTED_DATES_INVALID")
    return {"mapping": dict(mapping), "start_date": start.isoformat(), "end_date": end.isoformat(),
            "period": "day", "adjust_type": "none", "trade_session": "regular",
            "expected_dates": sorted(value.isoformat() for value in expected)}


def _money(value):
    # SDK Decimal spelling/scale is retained. Never use float or Decimal.normalize().
    if type(value) not in (Decimal, int, str):
        raise WorkbenchError("LONGPORT_EXACT_DECIMAL_REQUIRED")
    try:
        number = fact_decimal(value)
    except ValueError:
        raise WorkbenchError("LONGPORT_DECIMAL_INVALID_OR_OUT_OF_RANGE") from None
    if number < 0 or number.is_signed():
        raise WorkbenchError("LONGPORT_NEGATIVE_MARKET_VALUE")
    return format(number, "f"), number


def _field(candle, name):
    try:
        return candle[name] if isinstance(candle, dict) else getattr(candle, name)
    except Exception:
        raise WorkbenchError("LONGPORT_CANDLE_FIELD_MISSING") from None


def _session(value):
    # PyO3 TradeSession is eq_int, not Python's enum.Enum. Do not serialize repr().
    if type(value) is int and value == 0:
        return 0
    if type(value).__name__ == "TradeSession" and value == 0:
        return 0
    raise WorkbenchError("LONGPORT_NONREGULAR_OR_INVALID_SESSION")


def _normalize(candles, *, request, sdk_version, call_started_at, call_returned_at,
               datetime_basis="explicit_aware_datetime", collector_runtime="not_verified_by_parser"):
    if not isinstance(sdk_version, str) or not _VERSION.fullmatch(sdk_version) or len(sdk_version) > 64:
        raise WorkbenchError("LONGPORT_SDK_VERSION_REQUIRED")
    started, returned = _instant(call_started_at), _instant(call_returned_at)
    if returned < started:
        raise WorkbenchError("LONGPORT_CALL_CLOCK_INVALID")
    source_zone = _MARKETS[request["mapping"]["market"]][0]
    today = started.astimezone(ZoneInfo(source_zone)).date()
    if _day(request["end_date"]) >= today:
        raise WorkbenchError("LONGPORT_INCOMPLETE_OR_FUTURE_LOCAL_DATE")
    if not isinstance(candles, (list, tuple)) or not candles:
        raise WorkbenchError("LONGPORT_EMPTY_OR_INVALID_CANDLES")
    if len(candles) >= 1000:
        raise WorkbenchError("LONGPORT_POSSIBLY_TRUNCATED_RESPONSE")
    if len(candles) > MAX_WINDOW_DAYS:
        raise WorkbenchError("LONGPORT_UNEXPECTED_CANDLE_COUNT")
    projected, records, seen = [], [], set()
    for index, candle in enumerate(candles):
        prices = {key: _money(_field(candle, key)) for key in ("open", "high", "low", "close", "turnover")}
        if prices["close"][1] == 0:
            raise WorkbenchError("LONGPORT_CLOSE_NOT_VALUABLE")
        if not (prices["low"][1] <= min(prices["open"][1], prices["close"][1])
                <= max(prices["open"][1], prices["close"][1]) <= prices["high"][1]):
            raise WorkbenchError("LONGPORT_OHLC_RANGE_INVALID")
        volume = _field(candle, "volume")
        if type(volume) is not int or not 0 <= volume <= 2 ** 63 - 1:
            raise WorkbenchError("LONGPORT_VOLUME_INVALID")
        timestamp = _field(candle, "timestamp")
        if not isinstance(timestamp, datetime):
            raise WorkbenchError("LONGPORT_SDK_DATETIME_REQUIRED")
        timestamp = _instant(timestamp)
        day = timestamp.astimezone(ZoneInfo(source_zone)).date().isoformat()
        if timestamp > returned or day >= today.isoformat():
            raise WorkbenchError("LONGPORT_INCOMPLETE_OR_FUTURE_LOCAL_DATE")
        if not request["start_date"] <= day <= request["end_date"]:
            raise WorkbenchError("LONGPORT_CANDLE_OUTSIDE_REQUEST")
        if day in seen:
            raise WorkbenchError("LONGPORT_DUPLICATE_CANDLE_DATE")
        seen.add(day)
        row = {key: value[0] for key, value in prices.items()}
        row.update(volume=str(volume), timestamp=stamp(timestamp),
                   trade_session=_session(_field(candle, "trade_session")))
        projected.append(row)
        records.append({"listing_id": request["mapping"]["listing_id"], "currency": request["mapping"]["currency"],
                        "observed_at": day, "time_precision": "date", "value": prices["close"][0],
                        "metric": "close", "price_basis": "unadjusted", "published_at": None,
                        "provider_revision": None, "ingested_at": stamp(returned),
                        "source_timezone": source_zone, "provenance": "live_observed",
                        "provider_timestamp": stamp(timestamp), "projection_row": index})
    if seen != set(request["expected_dates"]):
        raise WorkbenchError("LONGPORT_EXPECTED_DATE_COVERAGE_MISMATCH")
    source = {"provider": "longport", "capture_kind": "sdk_projection", "sdk_version": sdk_version,
              "adapter_version": ADAPTER_VERSION, "call_started_at": stamp(started), "call_returned_at": stamp(returned),
              "source_timezone": source_zone, "sdk_datetime_basis": datetime_basis,
              "collector_runtime": collector_runtime, "publication_time_status": "not_supplied",
              "provider_revision_status": "not_supplied", "network_bytes_preserved": False,
              "calendar_verified_by_adapter": False, "mapping_verified_by_adapter": False,
              "coverage_status": "matches_caller_expected_dates_only", "account_buyability_verified": False,
              "timestamp_semantics": "provider_bar_timestamp_not_confirmed_close", "volume_encoding": "int64_decimal_string"}
    projection = {"schema_version": "longport-candles-projection-v1", "source": source,
                  "request": request, "candlesticks": projected}
    encoded = canonical_json(projection).encode("utf-8")
    if len(encoded) > MAX_PROJECTION_BYTES:
        raise WorkbenchError("LONGPORT_PROJECTION_TOO_LARGE")
    digest = sha256(encoded).hexdigest()
    for row in records:
        row["projection_sha256"] = digest
    return {"schema_version": "longport-candles-projection-v1", "source": source, "request": request,
            "projection": projection, "projection_sha256": digest, "projection_bytes": encoded,
            "records": sorted(records, key=lambda row: row["observed_at"])}


def normalize_longport_candles(candles, *, mapping, start_date, end_date, expected_dates,
                               sdk_version, call_started_at, call_returned_at):
    """Pure parsing proves expected-set equality, never calendar or network origin."""
    return _normalize(candles, request=_request(mapping, start_date, end_date, expected_dates),
                      sdk_version=sdk_version, call_started_at=call_started_at, call_returned_at=call_returned_at)


def _credentials():
    values = [os.environ.get(name) for name in _CREDENTIAL_NAMES]
    if any(not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > 8192 for value in values):
        raise WorkbenchError("LONGPORT_CREDENTIALS_REQUIRED")
    return dict(zip(("app_key", "app_secret", "access_token"), values))


def _load_sdk():
    if metadata.version("longport") != SDK_VERSION:
        raise WorkbenchError("LONGPORT_SDK_VERSION_NOT_APPROVED")
    return import_module("longport.openapi")


def _official_call(request, credentials):
    if os.environ.get("TZ") != "UTC" or not hasattr(time, "tzset"):
        raise WorkbenchError("LONGPORT_ISOLATED_UTC_REQUIRED")
    time.tzset()
    if time.timezone != 0 or time.daylight != 0 or datetime.fromtimestamp(0) != datetime(1970, 1, 1):
        raise WorkbenchError("LONGPORT_ISOLATED_UTC_REQUIRED")
    # These are fixed public defaults, not user-configurable endpoint overrides.
    sdk = _load_sdk()
    config = sdk.Config.from_apikey(**credentials, http_url="https://openapi.longportapp.com",
                                   quote_ws_url="wss://openapi-quote.longportapp.com/v2",
                                   trade_ws_url="wss://openapi-trade.longportapp.com/v2",
                                   enable_overnight=False, enable_print_quote_packages=False)
    client = sdk.QuoteContext(config)
    started = stamp()
    candles = client.history_candlesticks_by_date(request["mapping"]["provider_symbol"], sdk.Period.Day,
                                                sdk.AdjustType.NoAdjust, _day(request["start_date"]),
                                                _day(request["end_date"]), sdk.TradeSessions.Intraday)
    returned = stamp()
    if not isinstance(candles, (list, tuple)) or not 1 <= len(candles) < 1000:
        raise WorkbenchError("LONGPORT_EMPTY_OR_POSSIBLY_TRUNCATED_RESPONSE")
    rows = []
    for candle in candles:
        row = {key: _field(candle, key) for key in _CANDLE_FIELDS}
        timestamp = row["timestamp"]
        if not isinstance(timestamp, datetime):
            raise WorkbenchError("LONGPORT_SDK_DATETIME_REQUIRED")
        if timestamp.tzinfo is None:
            # Pinned SDK: from_timestamp(unix_seconds, None), in this UTC process.
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        row["timestamp"] = _instant(timestamp)
        rows.append(row)
    return _normalize(rows, request=request, sdk_version=SDK_VERSION, call_started_at=started,
                      call_returned_at=returned, datetime_basis="runtime_utc_from_unix_timestamp",
                      collector_runtime="isolated_official_sdk")


def _strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("non-finite number")

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def _child_main():
    """Fixed private stdin protocol; no arbitrary code, paths, or SDK methods."""
    try:
        import resource
        # Kernel-enforced deadline survives a stalled or terminated parent.
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
        signal.setitimer(signal.ITIMER_REAL, CALL_TIMEOUT_SECONDS)
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PROJECTION_BYTES, MAX_PROJECTION_BYTES))
        body = sys.stdin.buffer.read(MAX_CHILD_INPUT_BYTES + 1)
        if not 1 <= len(body) <= MAX_CHILD_INPUT_BYTES:
            raise ValueError("input bound")
        command = _strict_json(body.decode("utf-8"))
        if not isinstance(command, dict) or set(command) != {"request", "credentials"}:
            raise ValueError("command shape")
        request, credentials = command["request"], command["credentials"]
        if (not isinstance(request, dict) or set(request) != {"mapping", "start_date", "end_date", "expected_dates", "period", "adjust_type", "trade_session"}
                or request != _request(request["mapping"], request["start_date"], request["end_date"], request["expected_dates"])
                or not isinstance(credentials, dict) or set(credentials) != {"app_key", "app_secret", "access_token"}
                or any(not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > 8192 for value in credentials.values())):
            raise ValueError("request shape")
        result = _official_call(request, credentials)
        sys.stdout.buffer.write(result["projection_bytes"])
        sys.stdout.buffer.flush()
        return 0
    except Exception:
        # Provider exception strings may contain credentials or account metadata.
        return 1


def _collect_isolated(request):
    credentials = _credentials()
    encoded = canonical_json({"request": request, "credentials": credentials}).encode("utf-8")
    if len(encoded) > MAX_CHILD_INPUT_BYTES:
        raise WorkbenchError("LONGPORT_CHILD_INPUT_TOO_LARGE")
    parent_started = _instant(stamp())
    with tempfile.TemporaryDirectory(prefix="workbench-longport-") as directory:
        os.chmod(directory, 0o700)
        env_path = Path(directory) / ".env"
        descriptor = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        # Empty .env prevents SDK dotenv from walking into parent/user directories.
        environment = {"TZ": "UTC", "HOME": directory, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONUTF8": "1"}
        with tempfile.TemporaryFile(dir=directory) as output:
            try:
                process = subprocess.Popen([sys.executable, "-I", str(Path(__file__).resolve()), "--sdk-child"],
                                           stdin=subprocess.PIPE, stdout=output, stderr=subprocess.DEVNULL,
                                           cwd=directory, env=environment, start_new_session=True)
                try:
                    process.communicate(encoded, timeout=CALL_TIMEOUT_SECONDS)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.communicate()
                    raise WorkbenchError("LONGPORT_SDK_CALL_TIMEOUT") from None
                except BaseException:
                    # Cancellation must not leave a credential-bearing child alive.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait()
                    raise
                if process.returncode != 0:
                    raise WorkbenchError("LONGPORT_SDK_CALL_FAILED")
                size = output.tell()
                if not 1 <= size <= MAX_PROJECTION_BYTES:
                    raise WorkbenchError("LONGPORT_CHILD_RESPONSE_INVALID")
                output.seek(0)
                raw = output.read(MAX_PROJECTION_BYTES + 1)
            except OSError:
                raise WorkbenchError("LONGPORT_SDK_RUNTIME_FAILED") from None
    parent_returned = _instant(stamp())
    try:
        projection = _strict_json(raw.decode("utf-8"))
        source = projection["source"]
        if (projection["schema_version"] != "longport-candles-projection-v1" or projection["request"] != request
                or source["sdk_version"] != SDK_VERSION
                or not parent_started <= _instant(source["call_started_at"]) <= _instant(source["call_returned_at"]) <= parent_returned):
            raise ValueError("child binding")
        rows = []
        for row in projection["candlesticks"]:
            item = dict(row)
            if not isinstance(item["volume"], str) or not re.fullmatch(r"0|[1-9][0-9]{0,18}", item["volume"]):
                raise ValueError("volume")
            item["volume"] = int(item["volume"])
            item["timestamp"] = _instant(item["timestamp"])
            rows.append(item)
        result = _normalize(rows, request=request, sdk_version=SDK_VERSION,
                            call_started_at=source["call_started_at"], call_returned_at=source["call_returned_at"],
                            datetime_basis="runtime_utc_from_unix_timestamp", collector_runtime="isolated_official_sdk")
        if result["projection_bytes"] != raw:
            raise ValueError("noncanonical child projection")
        return result
    except Exception:
        raise WorkbenchError("LONGPORT_CHILD_RESPONSE_INVALID") from None


def collect_longport_candles(*, mapping, start_date, end_date, expected_dates, client=None, sdk_version=None):
    """Collect one <=31-day tile. `client` is internal test injection, never JSON.

    Injected clients accept the semantic day/none/regular keyword values below;
    the production child binds these to official SDK enum constants. The parent
    timeout includes SDK import, authentication, and the synchronous quote call.
    """
    request = _request(mapping, start_date, end_date, expected_dates)
    if _day(request["end_date"]) >= datetime.now(ZoneInfo(_MARKETS[mapping["market"]][0])).date():
        raise WorkbenchError("LONGPORT_INCOMPLETE_OR_FUTURE_LOCAL_DATE")
    if client is None:
        if sdk_version is not None:
            raise WorkbenchError("LONGPORT_PRODUCTION_VERSION_NOT_CALLER_CONTROLLED")
        return _collect_isolated(request)
    if not isinstance(sdk_version, str) or not _VERSION.fullmatch(sdk_version):
        raise WorkbenchError("LONGPORT_SDK_VERSION_REQUIRED")
    started = stamp()
    try:
        candles = client.history_candlesticks_by_date(request["mapping"]["provider_symbol"],
                                                    period="day", adjust_type="none", start=_day(start_date),
                                                    end=_day(end_date), trade_sessions="regular")
    except Exception:
        raise WorkbenchError("LONGPORT_SDK_CALL_FAILED") from None
    returned = stamp()
    return _normalize(candles, request=request, sdk_version=sdk_version, call_started_at=started,
                      call_returned_at=returned, collector_runtime="injected_test_client")


if __name__ == "__main__":
    raise SystemExit(_child_main() if sys.argv[1:] == ["--sdk-child"] else 2)
