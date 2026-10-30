"""Isolated bounded issuer capture and draft replay, never a data approval."""

import base64
from datetime import datetime, timezone
from email.message import Message
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sys
import tempfile

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from worker.market.providers.process import run_memory_process
from worker.market.providers.vanguard_distributions import MAX_BYTES, _INSTANT, distribution_url, distribution_window, parse_vanguard_distributions
from worker.market.providers.vanguard_transport import VERSION as TRANSPORT_VERSION, download_vanguard_distributions
from worker.orchestration.db import WorkbenchError, instant, stamp


VERSION = "vanguard-distribution-capture-v1"
MAX_OUTPUT = 2 * MAX_BYTES
_HEADERS = {"content-type", "content-length", "date", "last-modified", "etag"}
_CHILD_ERRORS = {name: index for index, name in enumerate(("CONNECTION_TARGET_FORBIDDEN", "NONPUBLIC_ADDRESS_FORBIDDEN",
    "TIMEOUT_INVALID", "DOWNLOAD_TIMEOUT", "DOWNLOAD_FAILED", "REDIRECT_FORBIDDEN", "HTTP_STATUS_REJECTED",
    "HTTP_FORBIDDEN", "HTTP_NOT_FOUND", "HTTP_RATE_LIMITED", "HTTP_UNAVAILABLE", "AMBIGUOUS_HTTP_HEADERS",
    "HTTP_CONTENT_TYPE_REJECTED", "HTTP_CONTENT_ENCODING_REJECTED", "HTTP_CONTENT_LENGTH_REJECTED",
    "HTTP_TRANSFER_ENCODING_REJECTED", "DOWNLOAD_TOO_LARGE", "DOWNLOAD_INCOMPLETE", "CLOCK_INVALID"), start=2)}
_EXIT_ERRORS = {code: name for name, code in _CHILD_ERRORS.items()}


def _error(code):
    return WorkbenchError("VANGUARD_CAPTURE_" + code)


def _check(value):
    if not value:
        raise _error("INVALID")


def _object(raw, maximum):
    def pairs(items):
        value = {}
        for key, entry in items:
            _check(key not in value)
            value[key] = entry
        return value
    try:
        _check(type(raw) is bytes and 0 < len(raw) <= maximum)
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        _check(type(value) is dict)
        return value
    except Exception:
        raise _error("INVALID") from None


def _request(fund_id, flag, timeout):
    distribution_url(fund_id, flag)
    _check(type(timeout) is int and 1 <= timeout <= 30)
    return {"fund_id": fund_id, "has_distribution_yield": flag, "timeout_seconds": timeout}


def _receipt(encoded, request, before, after):
    value = _object(encoded, MAX_OUTPUT)
    _check(set(value) == {"schema_version", "raw_base64", "source_url", "request", "started_at", "completed_at",
        "retrieved_at", "http_status", "headers", "raw_sha256", "raw_bytes", "redirects_followed"})
    expected = {key: request[key] for key in ("fund_id", "has_distribution_yield")}
    _check(value["schema_version"] == TRANSPORT_VERSION and value["request"] == expected
        and type(value["request"]["has_distribution_yield"]) is bool)
    _check(value["source_url"] == distribution_url(expected["fund_id"], expected["has_distribution_yield"]))
    _check(type(value["http_status"]) is int and value["http_status"] == 200
        and type(value["redirects_followed"]) is int and value["redirects_followed"] == 0)
    _check(all(type(value[key]) is str and _INSTANT.fullmatch(value[key]) for key in ("started_at", "completed_at", "retrieved_at")))
    _check(instant(before) <= instant(value["started_at"]) <= instant(value["completed_at"]) <= instant(after)
        and value["retrieved_at"] == value["completed_at"])
    headers = value["headers"]
    _check(type(headers) is dict and "content-type" in headers and set(headers) <= _HEADERS)
    _check(all(type(text) is str and len(text) <= 1024 and all(32 <= ord(char) != 127 for char in text) for text in headers.values()))
    message = Message(); message["Content-Type"] = headers["content-type"]
    _check(message.get_content_type() == "application/json" and message.get_content_charset("utf-8").lower() in ("utf-8", "utf8"))
    _check(type(value["raw_base64"]) is str and len(value["raw_base64"]) <= (MAX_BYTES + 2) // 3 * 4)
    _check(type(value["raw_bytes"]) is int and 0 < value["raw_bytes"] <= MAX_BYTES
        and type(value["raw_sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["raw_sha256"]))
    try:
        raw = base64.b64decode(value.pop("raw_base64"), validate=True)
    except Exception:
        raise _error("INVALID") from None
    _check(len(raw) == value["raw_bytes"] and sha256(raw).hexdigest() == value["raw_sha256"])
    if "content-length" in headers:
        _check(re.fullmatch(r"[0-9]{1,7}", headers["content-length"]) and int(headers["content-length"]) == len(raw))
    return raw, value


def collect_vanguard_distribution_draft(*, fund_id, has_distribution_yield, start_date, end_date, timeout_seconds=20):
    before = stamp(datetime.now(timezone.utc))
    request = _request(fund_id, has_distribution_yield, timeout_seconds)
    distribution_window(before, start_date, end_date)
    try:
        with tempfile.TemporaryDirectory(prefix="workbench-vanguard-capture-") as directory:
            os.chmod(directory, 0o700)
            encoded = run_memory_process([sys.executable, "-I", str(Path(__file__).resolve()), "--download-child"],
                cwd=directory, environment={"HOME": directory, "TZ": "UTC", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                    "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}, error=_error, timeout=timeout_seconds,
                input_bytes=json.dumps(request).encode(), max_input=1024, max_output=MAX_OUTPUT,
                exit_error_codes=_EXIT_ERRORS)
        after = stamp(datetime.now(timezone.utc))
        raw, receipt = _receipt(encoded, request, before, after)
        draft = parse_vanguard_distributions(raw, fund_id=fund_id, has_distribution_yield=has_distribution_yield,
            retrieved_at=receipt["retrieved_at"], start_date=start_date, end_date=end_date)
        return {"schema_version": VERSION, "raw": raw, "receipt": receipt, "draft": draft}
    except WorkbenchError:
        raise
    except Exception:
        raise _error("FAILED") from None


def _download_child():
    value = _object(sys.stdin.buffer.read(1025), 1024)
    _check(set(value) == {"fund_id", "has_distribution_yield", "timeout_seconds"})
    request = _request(value["fund_id"], value["has_distribution_yield"], value["timeout_seconds"])
    result = download_vanguard_distributions(**request)
    result["raw_base64"] = base64.b64encode(result.pop("raw")).decode("ascii")
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")))


def _child_main():
    try:
        _check(sys.argv[1:] == ["--download-child"])
        _download_child()
    except WorkbenchError as error:
        text = str(error)
        name = text.removeprefix("VANGUARD_ISSUER_") if text.startswith("VANGUARD_ISSUER_") else ""
        sys.exit(_CHILD_ERRORS.get(name, 1))
    except BaseException:
        sys.exit(1)


if __name__ == "__main__":
    _child_main()
