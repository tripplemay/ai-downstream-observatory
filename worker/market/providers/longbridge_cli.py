"""Bounded OAuth CLI reads in memory; no database or broker write commands.

CLI JSON is a projection, not network bytes or the legacy SDK capture format.
The preview intentionally cannot establish licensing, identity or freshness.
"""

from contextlib import contextmanager
from datetime import date, datetime
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import re
import stat
import tempfile
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.accounting import fact_decimal
from worker.orchestration.db import WorkbenchError, stamp
from .process import child_argv as _child_argv, run_memory_process


CLI_VERSION = "0.28.7"
ADAPTER_VERSION = "longbridge-cli-preview-v1"
APPROVED_BINARIES = {
    ("Darwin", "arm64"): "82168f35303355fb8305ae895889da59b5fbe97124952b15845377240e73bb4a",
}
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_DIAGNOSTIC_BYTES = 16 * 1024
MAX_BINARY_BYTES = 32 * 1024 * 1024
MAX_WINDOW_DAYS = 31
CALL_TIMEOUT_SECONDS = 30
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z", re.ASCII)
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z\Z", re.ASCII)
_VOLUME = re.compile(r"(?:0|[1-9][0-9]{0,18})\Z", re.ASCII)
_MARKETS = (
    (re.compile(r"[0-9]{6}\.(?:SH|SZ)\Z", re.ASCII), "CN", "Asia/Shanghai"),
    (re.compile(r"[0-9]{1,5}\.HK\Z", re.ASCII), "HK", "Asia/Hong_Kong"),
    (re.compile(r"[A-Z][A-Z0-9]{0,14}(?:[.-][A-Z0-9]{1,5})?\.US\Z", re.ASCII), "US", "America/New_York"),
)


def _error(code):
    return WorkbenchError("LONGBRIDGE_" + code)


def _market(symbol):
    if isinstance(symbol, str):
        for pattern, market, zone in _MARKETS:
            if pattern.fullmatch(symbol):
                return market, zone
    raise _error("SYMBOL_INVALID")


def _zone(name):
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        raise _error("TIMEZONE_DATABASE_REQUIRED") from None


def _day(value):
    if isinstance(value, str) and _DATE.fullmatch(value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise _error("DATE_INVALID")


def _instant(value):
    if isinstance(value, str) and _UTC.fullmatch(value):
        try:
            return datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError:
            pass
    raise _error("UTC_INSTANT_REQUIRED")


def _request(symbol, start_date, end_date, expected_dates):
    market, zone = _market(symbol)
    start, end = _day(start_date), _day(end_date)
    if not 0 <= (end - start).days < MAX_WINDOW_DAYS:
        raise _error("BOUNDED_WINDOW_REQUIRED")
    if not isinstance(expected_dates, (list, tuple)) or not 1 <= len(expected_dates) <= MAX_WINDOW_DAYS:
        raise _error("EXPECTED_DATES_REQUIRED")
    days = [_day(value) for value in expected_dates]
    if len(set(days)) != len(days) or any(not start <= value <= end for value in days):
        raise _error("EXPECTED_DATES_INVALID")
    return {"symbol": symbol, "market": market, "source_timezone": zone,
            "start_date": start_date, "end_date": end_date,
            "expected_dates": sorted(value.isoformat() for value in days),
            "period": "day", "adjust": "none", "session": "intraday"}


def _json(raw):
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= MAX_OUTPUT_BYTES:
        raise _error("RESPONSE_SIZE_INVALID")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise _error("DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    def invalid_number(_):
        raise _error("NON_EXACT_JSON_NUMBER")

    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                          parse_float=invalid_number, parse_constant=invalid_number)
    except WorkbenchError:
        raise
    except (UnicodeError, ValueError, RecursionError):
        raise _error("JSON_INVALID") from None


def _amount(value, *, positive=False):
    if not isinstance(value, str) or len(value) > 80:
        raise _error("EXACT_DECIMAL_STRING_REQUIRED")
    try:
        number = fact_decimal(value)
    except ValueError:
        raise _error("DECIMAL_INVALID") from None
    if number.is_signed() or number < 0 or (positive and number == 0):
        raise _error("MARKET_VALUE_INVALID")
    return number


def _source(started_at, returned_at):
    started, returned = _instant(started_at), _instant(returned_at)
    if returned < started:
        raise _error("CALL_CLOCK_INVALID")
    return {"provider": "longbridge", "capture_kind": "cli_projection",
            "cli_version": CLI_VERSION, "adapter_version": ADAPTER_VERSION,
            "call_started_at": started_at, "call_returned_at": returned_at,
            "network_bytes_preserved": False, "collector_runtime": "not_verified_by_parser",
            "publication_time_status": "not_supplied", "calendar_verified": False,
            "identity_verified": False, "data_use_license_verified": False}


def normalize_cli_quotes(raw, *, symbols, call_started_at, call_returned_at):
    """Pure parser; source time is unknown even if a future field claims it."""
    if not isinstance(symbols, (list, tuple)) or not 1 <= len(symbols) <= 4:
        raise _error("SYMBOL_SET_INVALID")
    for symbol in symbols:
        _market(symbol)
    if len(set(symbols)) != len(symbols):
        raise _error("SYMBOL_SET_INVALID")
    source = _source(call_started_at, call_returned_at)
    rows = _json(raw)
    if not isinstance(rows, list) or len(rows) != len(symbols):
        raise _error("QUOTE_COVERAGE_MISMATCH")
    records, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or not {"symbol", "last", "prev_close", "status"} <= row.keys():
            raise _error("QUOTE_FIELDS_INVALID")
        symbol = row["symbol"]
        if not isinstance(symbol, str) or symbol not in symbols or symbol in seen:
            raise _error("QUOTE_COVERAGE_MISMATCH")
        seen.add(symbol)
        _amount(row["last"], positive=True)
        _amount(row["prev_close"])
        if not isinstance(row["status"], str) or not 1 <= len(row["status"]) <= 64:
            raise _error("QUOTE_STATUS_INVALID")
        records.append({"symbol": symbol, "market": _market(symbol)[0],
                        "last": row["last"], "prev_close": row["prev_close"],
                        "status": "Normal" if row["status"] == "Normal" else "not_normal_or_unknown",
                        "source_timestamp": None, "freshness": "not_verified"})
    return {"schema_version": "longbridge-cli-quotes-preview-v1", "source": source,
            "records": sorted(records, key=lambda row: row["symbol"]),
            "issues": ["QUOTE_SOURCE_TIME_NOT_SUPPLIED", "QUOTE_FRESHNESS_NOT_VERIFIED"]}


def normalize_cli_candles(raw, *, symbol, start_date, end_date, expected_dates,
                          call_started_at, call_returned_at):
    """Exact prices and local dates; expected-date equality is not a calendar."""
    request = _request(symbol, start_date, end_date, expected_dates)
    source = _source(call_started_at, call_returned_at)
    source.update(timestamp_semantics="provider_bar_time_not_confirmed_close",
                  coverage_status="matches_caller_expected_dates_only",
                  company_actions_verified=False, total_return_verified=False)
    zone = _zone(request["source_timezone"])
    today = _instant(call_started_at).astimezone(zone).date().isoformat()
    if end_date >= today:
        raise _error("INCOMPLETE_OR_FUTURE_LOCAL_DATE")
    rows = _json(raw)
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_WINDOW_DAYS:
        raise _error("CANDLE_COUNT_INVALID")
    records, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or not {"time", "open", "high", "low", "close", "volume", "turnover"} <= row.keys():
            raise _error("CANDLE_FIELDS_INVALID")
        timestamp = _instant(row["time"])
        day = timestamp.astimezone(zone).date().isoformat()
        if timestamp > _instant(call_returned_at) or day >= today:
            raise _error("INCOMPLETE_OR_FUTURE_LOCAL_DATE")
        if not start_date <= day <= end_date:
            raise _error("CANDLE_OUTSIDE_REQUEST")
        if day in seen:
            raise _error("DUPLICATE_CANDLE_DATE")
        if records and day <= records[-1]["observed_at"]:
            raise _error("CANDLE_ORDER_INVALID")
        seen.add(day)
        prices = {key: _amount(row[key], positive=True) for key in ("open", "high", "low", "close")}
        if not prices["low"] <= min(prices["open"], prices["close"]) <= max(prices["open"], prices["close"]) <= prices["high"]:
            raise _error("OHLC_RANGE_INVALID")
        _amount(row["turnover"])
        volume = row["volume"]
        if type(volume) is int:
            volume = str(volume)
        if not isinstance(volume, str) or not _VOLUME.fullmatch(volume) or int(volume) > 2 ** 63 - 1:
            raise _error("VOLUME_INVALID")
        records.append({"symbol": symbol, "observed_at": day, "provider_timestamp": row["time"],
                        "source_timezone": request["source_timezone"], "price_basis": "unadjusted",
                        **{key: row[key] for key in prices}, "volume": volume, "turnover": row["turnover"],
                        "published_at": None, "provider_revision": None})
    if seen != set(request["expected_dates"]):
        raise _error("EXPECTED_DATE_COVERAGE_MISMATCH")
    return {"schema_version": "longbridge-cli-candles-preview-v1", "source": source,
            "request": request, "records": records}


def _private_home(value):
    try:
        path = Path(value)
        info = path.lstat()
        if (not path.is_absolute() or not stat.S_ISDIR(info.st_mode)
                or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077
                or path.resolve() == Path.home().resolve()):
            raise _error("ISOLATED_PRIVATE_HOME_REQUIRED")
        return str(path.resolve())
    except (TypeError, OSError, ValueError):
        raise _error("ISOLATED_PRIVATE_HOME_REQUIRED") from None


@contextmanager
def _verified_runtime(binary_path):
    expected = APPROVED_BINARIES.get((platform.system(), platform.machine()))
    if expected is None:
        raise _error("PLATFORM_NOT_APPROVED")
    try:
        path = Path(binary_path)
        info = path.lstat()
        if (not path.is_absolute() or not stat.S_ISREG(info.st_mode)
                or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022
                or not 0 < info.st_size <= MAX_BINARY_BYTES):
            raise _error("BINARY_INVALID")
        with tempfile.TemporaryDirectory(prefix="workbench-longbridge-") as directory:
            os.chmod(directory, 0o700)
            copy = Path(directory) / "longbridge"
            digest, total = sha256(), 0
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as original, copy.open("xb") as target:
                opened = os.fstat(original.fileno())
                if (not stat.S_ISREG(opened.st_mode) or opened.st_uid != os.geteuid()
                        or stat.S_IMODE(opened.st_mode) & 0o022 or not 0 < opened.st_size <= MAX_BINARY_BYTES):
                    raise _error("BINARY_INVALID")
                while chunk := original.read(65536):
                    total += len(chunk)
                    if total > MAX_BINARY_BYTES:
                        raise _error("BINARY_INVALID")
                    digest.update(chunk)
                    target.write(chunk)
            if digest.hexdigest() != expected:
                raise _error("BINARY_DIGEST_NOT_APPROVED")
            os.chmod(copy, 0o700)
            # Avoid any dotenv discovery in the project or parent directory.
            with (Path(directory) / ".env").open("xb") as empty:
                os.chmod(empty.name, 0o600)
            yield str(copy), directory, expected
    except OSError:
        raise _error("RUNTIME_IO_FAILED") from None


def _run(argv, *, home, cwd, timeout=CALL_TIMEOUT_SECONDS):
    environment = {"HOME": home, "PATH": "/usr/bin:/bin", "TZ": "UTC",
                   "LANG": "en_US.UTF-8", "LONGBRIDGE_REGION": "global"}
    return run_memory_process(argv, cwd=cwd, environment=environment, error=_error,
                              timeout=timeout, max_output=MAX_OUTPUT_BYTES,
                              max_diagnostic=MAX_DIAGNOSTIC_BYTES)


def inspect_longbridge_cli(*, binary_path, oauth_home, symbol, start_date, end_date, expected_dates):
    """Only version, quote and a fixed daily window; returns no price values."""
    request = _request(symbol, start_date, end_date, expected_dates)
    if end_date >= datetime.now(_zone(request["source_timezone"])).date().isoformat():
        raise _error("INCOMPLETE_OR_FUTURE_LOCAL_DATE")
    home = _private_home(oauth_home)
    with _verified_runtime(binary_path) as (binary, cwd, digest):
        version = _run([binary, "--version"], home=home, cwd=cwd)
        if version.strip() != ("longbridge " + CLI_VERSION).encode("ascii"):
            raise _error("VERSION_NOT_APPROVED")
        started = stamp()
        raw = _run([binary, "quote", symbol, "--format", "json"], home=home, cwd=cwd)
        quotes = normalize_cli_quotes(raw, symbols=[symbol], call_started_at=started, call_returned_at=stamp())
        started = stamp()
        raw = _run([binary, "kline", "history", symbol, "--start", start_date, "--end", end_date,
                    "--period", "day", "--adjust", "none", "--session", "intraday", "--format", "json"],
                   home=home, cwd=cwd)
        candles = normalize_cli_candles(raw, symbol=symbol, start_date=start_date, end_date=end_date,
                                       expected_dates=expected_dates, call_started_at=started, call_returned_at=stamp())
    return {"schema_version": ADAPTER_VERSION, "status": "sample_read_ok",
            "symbol": symbol, "market": request["market"], "source_timezone": request["source_timezone"],
            "cli_version": CLI_VERSION, "binary_sha256": digest, "capture_kind": "cli_projection",
            "collector_runtime": "isolated_verified_cli", "quote_record_count": len(quotes["records"]),
            "quote_price_valid": True, "quote_status": quotes["records"][0]["status"],
            "quote_source_timestamp": None, "quote_freshness": "not_verified",
            "quote_requested_at": quotes["source"]["call_started_at"],
            "candle_requested_at": candles["source"]["call_started_at"],
            "candle_count": len(candles["records"]),
            "market_dates": [row["observed_at"] for row in candles["records"]],
            "expected_date_coverage": "matches_caller_expected_dates_only", "ohlcv_sanity": "passed",
            "calendar_verified": False, "identity_verified": False, "data_use_license_verified": False,
            "company_actions_verified": False, "total_return_verified": False,
            "production_ready": False, "workbench_database_accessed": False,
            "market_values_output": False, "market_values_persisted_by_adapter": False,
            "oauth_local_state_may_refresh": True, "trade_commands_executed": False,
            "issues": quotes["issues"] + (["QUOTE_STATUS_NOT_NORMAL_OR_UNKNOWN"]
                                            if quotes["records"][0]["status"] != "Normal" else [])}
