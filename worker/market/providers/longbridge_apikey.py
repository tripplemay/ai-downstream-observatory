"""Read-only API Key inspection; memory-only SDK projection, no database."""

from datetime import datetime
import os
from pathlib import Path
import sys
import tempfile
from zoneinfo import ZoneInfo

from worker.orchestration.db import WorkbenchError, canonical_json, stamp
from .credentials import read_private_credentials_file
from . import longport
from .process import run_memory_process


ADAPTER_VERSION = "longbridge-apikey-inspection-v1"


def _error(code):
    return WorkbenchError("LONGPORT_" + code)


def inspect_longbridge_apikey(*, symbol, currency, start_date, end_date, expected_dates,
                              credentials_file=None, credentials_env=False, diagnose=False):
    """Only a fixed daily window. Caller mapping/calendar are not approvals."""
    markets = [market for market, pattern in longport._SYMBOLS.items()
               if isinstance(symbol, str) and pattern.fullmatch(symbol)]
    if len(markets) != 1:
        raise _error("SYMBOL_INVALID")
    market = markets[0]
    request = longport._request({"listing_id": "inspection:" + symbol, "provider_symbol": symbol,
                                "market": market, "currency": currency},
                               start_date, end_date, expected_dates)
    if longport._day(request["end_date"]) >= datetime.now(ZoneInfo(longport._MARKETS[market][0])).date():
        raise _error("INCOMPLETE_OR_FUTURE_LOCAL_DATE")
    if type(credentials_env) is not bool or (int(credentials_file is not None) + int(credentials_env)) != 1:
        raise _error("CREDENTIAL_SOURCE_REQUIRED")
    if type(diagnose) is not bool:
        raise _error("DIAGNOSTIC_MODE_INVALID")
    credentials = longport._credentials() if credentials_env else read_private_credentials_file(credentials_file)
    try:
        longport._load_sdk()
    except Exception:
        raise _error("SDK_RUNTIME_NOT_CONFIGURED") from None
    body = canonical_json({"request": request, "credentials": credentials}).encode("utf-8")
    started = longport._instant(stamp())
    try:
        with tempfile.TemporaryDirectory(prefix="workbench-apikey-inspection-") as directory:
            os.chmod(directory, 0o700)
            descriptor = os.open(Path(directory) / ".env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
            environment = {"TZ": "UTC", "HOME": directory, "LANG": "C.UTF-8",
                           "LC_ALL": "C.UTF-8", "PYTHONUTF8": "1"}
            mode = "--sdk-diagnostic-child" if diagnose else "--sdk-child"
            options = {"exit_error_codes": longport.DIAGNOSTIC_EXIT_CODES} if diagnose else {}
            raw = run_memory_process([sys.executable, "-I", str(Path(longport.__file__).resolve()), mode],
                                     cwd=directory, environment=environment, error=_error,
                                     timeout=longport.CALL_TIMEOUT_SECONDS, input_bytes=body,
                                     max_input=longport.MAX_CHILD_INPUT_BYTES,
                                     max_output=longport.MAX_PROJECTION_BYTES, **options)
    except OSError:
        raise _error("SDK_RUNTIME_FAILED") from None
    result = longport._parse_child_projection(raw, request, started, longport._instant(stamp()))
    return {"schema_version": ADAPTER_VERSION, "status": "sample_read_ok", "auth_mode": "apikey",
            "symbol": symbol, "market": market, "currency_assumption": currency,
            "source_timezone": result["source"]["source_timezone"], "sdk_version": longport.SDK_VERSION,
            "capture_kind": "sdk_projection", "collector_runtime": "isolated_official_sdk",
            "call_started_at": result["source"]["call_started_at"],
            "call_returned_at": result["source"]["call_returned_at"],
            "candle_count": len(result["records"]),
            "market_dates": [row["observed_at"] for row in result["records"]],
            "expected_date_coverage": "matches_caller_expected_dates_only", "ohlcv_sanity": "passed",
            "calendar_verified": False, "identity_verified": False, "data_use_license_verified": False,
            "company_actions_verified": False, "total_return_verified": False,
            "production_ready": False, "workbench_database_accessed": False,
            "market_values_output": False, "market_values_persisted_by_adapter": False,
            "account_data_accessed": False, "trade_commands_executed": False,
            "access_token_refreshed": False}
