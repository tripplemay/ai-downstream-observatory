"""Isolated action capture; only an authorized single-attempt job may persist it."""

import base64
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from worker.market.providers.process import run_memory_process
from worker.market.providers.eodhd_actions import MAX_BYTES, _INSTANT, action_url, action_window, parse_eodhd_actions
from worker.market.providers.eodhd_transport import VERSION as TRANSPORT_VERSION, check_token, download_eodhd_actions
from worker.orchestration.db import WorkbenchError, instant, stamp


VERSION = "eodhd-action-capture-v1"
MAX_OUTPUT = 2 * MAX_BYTES
_CHILD_ERRORS = {name: index for index, name in enumerate(("CONNECTION_TARGET_FORBIDDEN", "NONPUBLIC_ADDRESS_FORBIDDEN",
    "TIMEOUT_INVALID", "DOWNLOAD_TIMEOUT", "DOWNLOAD_FAILED", "REDIRECT_FORBIDDEN", "HTTP_STATUS_REJECTED", "HTTP_UNAUTHORIZED",
    "HTTP_FORBIDDEN", "HTTP_NOT_FOUND", "HTTP_RATE_LIMITED", "HTTP_UNAVAILABLE", "AMBIGUOUS_HTTP_HEADERS",
    "HTTP_CONTENT_TYPE_REJECTED", "HTTP_CONTENT_ENCODING_REJECTED", "HTTP_CONTENT_LENGTH_REJECTED", "HTTP_TRANSFER_ENCODING_REJECTED",
    "DOWNLOAD_TOO_LARGE", "DOWNLOAD_INCOMPLETE", "CLOCK_INVALID", "REFLECTED_CREDENTIAL_REJECTED"), start=2)}
_EXIT_ERRORS = {code: name for name, code in _CHILD_ERRORS.items()}


def _error(code):
    return WorkbenchError("EODHD_CAPTURE_" + code)


def _check(value):
    if not value:
        raise _error("INVALID")


def read_private_token(filename):
    try:
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            _check(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600)
            raw = stream.read(4097)
        _check(len(raw) <= 4096)
        lines = [line.strip() for line in raw.decode("ascii").splitlines() if line.strip() and not line.lstrip().startswith("#")]
        _check(len(lines) == 1 and lines[0].startswith("EODHD_API_TOKEN="))
        token = lines[0].split("=", 1)[1]
        check_token(token)
        return token
    except Exception:
        raise _error("PRIVATE_CREDENTIAL_FILE_REQUIRED") from None


def check_runtime_configuration():
    flag = os.environ.get("WORKBENCH_EODHD_ENABLED", "0")
    if flag not in ("0", "1"):
        raise _error("RUNTIME_NOT_CONFIGURED")
    if flag == "1":
        try:
            _check("EODHD_API_TOKEN" not in os.environ)
            read_private_token(os.environ.get("EODHD_CREDENTIALS_FILE", ""))
        except Exception:
            raise _error("RUNTIME_NOT_CONFIGURED") from None
    return {"available": flag == "1", "network_called": False, "collection_authorized": False}


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


def _request(kind, symbol, start, end, timeout):
    action_url(kind, symbol, start, end)
    _check(type(timeout) is int and 1 <= timeout <= 30)
    return {"kind": kind, "symbol": symbol, "start_date": start, "end_date": end, "timeout_seconds": timeout}


def _receipt(encoded, request, before, after, token):
    value = _object(encoded, MAX_OUTPUT)
    _check(set(value) == {"schema_version", "raw_base64", "url_without_credentials", "request", "started_at", "completed_at",
        "retrieved_at", "http_status", "raw_sha256", "raw_bytes", "redirects_followed", "response_format", "credential_in_receipt"})
    expected = {key: request[key] for key in ("kind", "symbol", "start_date", "end_date")}
    _check(value["schema_version"] == TRANSPORT_VERSION and value["request"] == expected)
    _check(value["url_without_credentials"] == action_url(expected["kind"], expected["symbol"], expected["start_date"], expected["end_date"]))
    _check(type(value["http_status"]) is int and value["http_status"] == 200
        and type(value["redirects_followed"]) is int and value["redirects_followed"] == 0
        and value["response_format"] == "utf8_json_identity" and value["credential_in_receipt"] is False)
    _check(all(type(value[key]) is str and _INSTANT.fullmatch(value[key]) for key in ("started_at", "completed_at", "retrieved_at")))
    _check(instant(before) <= instant(value["started_at"]) <= instant(value["completed_at"]) <= instant(after)
        and value["retrieved_at"] == value["completed_at"])
    _check(type(value["raw_base64"]) is str and len(value["raw_base64"]) <= (MAX_BYTES + 2) // 3 * 4
        and type(value["raw_bytes"]) is int and 0 < value["raw_bytes"] <= MAX_BYTES
        and type(value["raw_sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["raw_sha256"]))
    try:
        raw = base64.b64decode(value.pop("raw_base64"), validate=True)
    except Exception:
        raise _error("INVALID") from None
    _check(len(raw) == value["raw_bytes"] and sha256(raw).hexdigest() == value["raw_sha256"])
    _check(token.encode("ascii") not in raw and token not in json.dumps(value))
    return raw, value


def collect_eodhd_action_draft(*, kind, symbol, start_date, end_date, credentials_file, timeout_seconds=20):
    before = stamp(datetime.now(timezone.utc))
    request = _request(kind, symbol, start_date, end_date, timeout_seconds)
    _check((start_date, end_date) == action_window(before))
    token = read_private_token(credentials_file)
    try:
        with tempfile.TemporaryDirectory(prefix="workbench-eodhd-action-") as directory:
            os.chmod(directory, 0o700)
            encoded = run_memory_process([sys.executable, "-I", str(Path(__file__).resolve()), "--download-child"],
                cwd=directory, environment={"HOME": directory, "TZ": "UTC", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                    "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}, error=_error, timeout=timeout_seconds,
                input_bytes=json.dumps({**request, "token": token}).encode(), max_input=2048, max_output=MAX_OUTPUT,
                exit_error_codes=_EXIT_ERRORS)
        after = stamp(datetime.now(timezone.utc))
        raw, receipt = _receipt(encoded, request, before, after, token)
        draft = parse_eodhd_actions(raw, kind=kind, symbol=symbol, start_date=start_date, end_date=end_date,
            retrieved_at=receipt["retrieved_at"])
        _check(token not in json.dumps(draft))
        return {"schema_version": VERSION, "raw": raw, "receipt": receipt, "draft": draft}
    except WorkbenchError:
        raise
    except Exception:
        raise _error("FAILED") from None


def _download_child():
    value = _object(sys.stdin.buffer.read(2049), 2048)
    _check(set(value) == {"kind", "symbol", "start_date", "end_date", "timeout_seconds", "token"})
    request = _request(value["kind"], value["symbol"], value["start_date"], value["end_date"], value["timeout_seconds"])
    _check((request["start_date"], request["end_date"]) == action_window(stamp(datetime.now(timezone.utc))))
    check_token(value["token"])
    result = download_eodhd_actions(**request, token=value["token"])
    result["raw_base64"] = base64.b64encode(result.pop("raw")).decode("ascii")
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")))


def _child_main():
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        _check(sys.argv[1:] == ["--download-child"])
        _download_child()
    except WorkbenchError as error:
        text = str(error)
        name = text.removeprefix("EODHD_TRANSPORT_") if text.startswith("EODHD_TRANSPORT_") else ""
        sys.exit(_CHILD_ERRORS.get(name, 1))
    except BaseException:
        sys.exit(1)


if __name__ == "__main__":
    _child_main()
