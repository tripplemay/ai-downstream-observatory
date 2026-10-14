"""Bounded recent calendar reads, never extrapolates unsupported history."""

from datetime import timedelta
import json
import os
from pathlib import Path
import sys
import tempfile
from zoneinfo import ZoneInfo

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp
from worker.market.providers import longport
from worker.market.providers.process import run_memory_process


VERSION = "longport-recent-calendar-v1"
MAX_BYTES = 65536


def _check(value, code="LONGPORT_CALENDAR_INVALID"):
    if not value: raise WorkbenchError(code)


def calendar_request(market, start_date, end_date, collected_at):
    _check(type(market) is str and market in longport._MARKETS)
    first, last = longport._day(start_date), longport._day(end_date)
    _check(type(start_date) is str and type(end_date) is str and 0 <= (last - first).days < 31)
    local_day = longport._instant(collected_at).astimezone(ZoneInfo(longport._MARKETS[market][0])).date()
    _check(local_day - timedelta(days=365) <= first <= last <= local_day,
        "LONGPORT_CALENDAR_OUTSIDE_DOCUMENTED_RECENT_WINDOW")
    return {"market": market, "start_date": first.isoformat(), "end_date": last.isoformat()}


def normalize_calendar(value, *, request, before, after):
    _check(type(value) is dict and set(value) == {"request", "sdk_version", "call_started_at", "call_returned_at", "trading_days", "half_trading_days"})
    _check(value["request"] == request and value["sdk_version"] == longport.SDK_VERSION)
    begin, finish = longport._instant(value["call_started_at"]), longport._instant(value["call_returned_at"])
    _check(longport._instant(before) <= begin <= finish <= longport._instant(after), "LONGPORT_CALENDAR_CLOCK_INVALID")
    calendar_request(request["market"], request["start_date"], request["end_date"], value["call_started_at"])
    lists = []
    for key in ("trading_days", "half_trading_days"):
        rows = value[key]
        _check(type(rows) is list and len(rows) <= 31 and all(type(day) is str for day in rows))
        days = [longport._day(day).isoformat() for day in rows]
        _check(len(set(days)) == len(days) and all(request["start_date"] <= day <= request["end_date"] for day in days))
        lists.append(set(days))
    trading, half = lists
    return {"schema_version": VERSION, "request": request, "source": {"sdk_version": longport.SDK_VERSION,
        "collector_runtime": "isolated_official_sdk", "capture_kind": "sdk_projection_not_wire_bytes",
        "call_started_at": value["call_started_at"], "call_returned_at": value["call_returned_at"],
        "projection_sha256": content_hash(value), "source_timezone": longport._MARKETS[request["market"]][0]},
        "records": [{"date": day, "kind": "half" if day in half else "full"} for day in sorted(trading | half)],
        "absent_dates_are_verified_closed": False, "settlement_calendar_verified": False,
        "owner_reviewed": False, "research_admitted": False, "historical_calendar_verified": False}


def _object(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            _check(key not in result)
            result[key] = value
        return result
    try:
        _check(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES)
        result = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        _check(type(result) is dict)
        return result
    except Exception:
        raise WorkbenchError("LONGPORT_CALENDAR_INVALID") from None


def collect_recent_calendar(*, market, start_date, end_date, credentials_file=None, credentials_env=False):
    before = stamp()
    request = calendar_request(market, start_date, end_date, before)
    _check(type(credentials_env) is bool and int(credentials_file is not None) + int(credentials_env) == 1,
        "LONGPORT_CALENDAR_CREDENTIAL_SOURCE_REQUIRED")
    credentials = longport._credentials() if credentials_env else longport.read_private_credentials_file(credentials_file)
    longport._load_sdk()
    body = canonical_json({"request": request, "credentials": credentials}).encode()
    with tempfile.TemporaryDirectory(prefix="workbench-calendar-") as directory:
        os.chmod(directory, 0o700)
        descriptor = os.open(Path(directory) / ".env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.close(descriptor)
        raw = run_memory_process([sys.executable, "-I", str(Path(__file__).resolve()), "--sdk-child"],
            cwd=directory, environment={"TZ": "UTC", "HOME": directory, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONUTF8": "1"},
            timeout=30, input_bytes=body, max_input=MAX_BYTES, max_output=MAX_BYTES,
            error=lambda code: WorkbenchError("LONGPORT_CALENDAR_" + code))
    return normalize_calendar(_object(raw), request=request, before=before, after=stamp())


def _sdk_child():
    body = _object(sys.stdin.buffer.read(MAX_BYTES + 1))
    _check(set(body) == {"request", "credentials"} and type(body["request"]) is dict)
    request = body["request"]
    _check(set(request) == {"market", "start_date", "end_date"})
    calendar_request(request["market"], request["start_date"], request["end_date"], stamp())
    sdk = longport._load_sdk()
    credentials = body["credentials"]
    _check(type(credentials) is dict and set(credentials) == {"app_key", "app_secret", "access_token"}
        and all(type(value) is str and value for value in credentials.values()))
    config = sdk.Config.from_apikey(**credentials, http_url="https://openapi.longportapp.com",
        quote_ws_url="wss://openapi-quote.longportapp.com/v2", trade_ws_url="wss://openapi-trade.longportapp.com/v2",
        enable_overnight=False, enable_print_quote_packages=False)
    context = sdk.QuoteContext(config)
    started = stamp()
    value = context.trading_days(getattr(sdk.Market, request["market"]), longport._day(request["start_date"]), longport._day(request["end_date"]))
    returned = stamp()
    result = {"request": request, "sdk_version": longport.SDK_VERSION, "call_started_at": started, "call_returned_at": returned,
        "trading_days": [day.isoformat() for day in value.trading_days], "half_trading_days": [day.isoformat() for day in value.half_trading_days]}
    normalize_calendar(result, request=request, before=started, after=returned)
    sys.stdout.write(canonical_json(result))


if __name__ == "__main__":
    try:
        _check(sys.argv[1:] == ["--sdk-child"])
        _sdk_child()
    except BaseException:
        sys.exit(1)
