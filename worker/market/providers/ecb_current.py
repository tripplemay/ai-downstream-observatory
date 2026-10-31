"""Bounded current reference-FX capture; unapproved drafts, never trade quotes."""

import base64
from datetime import date, datetime, timedelta, timezone
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

from worker.market.providers import ecb
from worker.market.providers.ecb_history import _midnight
from worker.market.providers.process import run_memory_process
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp


VERSION = "ecb-current-reference-capture-v1"
FEED = "hist_90d"
MAX_OUTPUT = 2 * ecb.MAX_BYTES
_HEADERS = {"content-type", "content-length", "date", "last-modified", "etag"}
_CHILD_ERRORS = {name: index for index, name in enumerate(("CONNECTION_TARGET_FORBIDDEN", "NONPUBLIC_ADDRESS_FORBIDDEN",
    "TIMEOUT_INVALID", "DOWNLOAD_TIMEOUT", "DOWNLOAD_FAILED", "REDIRECT_FORBIDDEN", "HTTP_STATUS_REJECTED",
    "AMBIGUOUS_HTTP_HEADERS", "HTTP_CONTENT_TYPE_REJECTED", "HTTP_CONTENT_ENCODING_REJECTED", "HTTP_CONTENT_LENGTH_REJECTED",
    "HTTP_TRANSFER_ENCODING_REJECTED", "DOWNLOAD_TOO_LARGE", "DOWNLOAD_INCOMPLETE"), start=2)}


def _error(code):
    return WorkbenchError("ECB_CURRENT_" + code)


def _check(value):
    if not value:
        raise _error("INVALID")


def _object(raw, maximum):
    def pairs(items):
        result = {}
        for key, value in items:
            _check(key not in result)
            result[key] = value
        return result
    try:
        _check(type(raw) is bytes and 0 < len(raw) <= maximum)
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        _check(type(value) is dict)
        return value
    except Exception:
        raise _error("INVALID") from None


def _currencies(values):
    _check(type(values) in (list, tuple) and 1 <= len(values) <= 2
        and all(type(value) is str and value in ("USD", "HKD") for value in values) and len(set(values)) == len(values))
    return sorted(values)


def build_current_fx_draft(raw, *, retrieved_at, currencies):
    """Same date/availability convention as historical reconstruction, no clock invention.

    An intraday download may contain today's reference rate before the existing
    conservative next-day assumption. Keep that fact and mark the whole draft
    pending; never trim it to fabricate current eligibility.
    """
    parsed = ecb.parse_ecb_xml(raw, feed=FEED, retrieved_at=retrieved_at, currencies=_currencies(currencies))
    facts = {currency: {"currency": currency, "unit": "CNY_per_unit_currency", "rows": []}
        for currency in parsed["source"]["requested_currencies"]}
    for row in parsed["records"]:
        day = date.fromisoformat(row["rate_date"])
        facts[row["currency"]]["rows"].append({"observed_at": _midnight(day),
            "assumed_available_at": _midnight(day + timedelta(days=1)), "value": row["value_cny_per_unit"]})
    not_before = max(row["assumed_available_at"] for value in facts.values() for row in value["rows"])
    metadata = {**parsed["source"], "availability_policy": "next_calendar_day_midnight_Europe_Berlin",
        "observation_policy": "rate_date_midnight_date_anchor_not_intraday_observation",
        "not_before": not_before, "availability_status": "available" if instant(not_before) <= instant(retrieved_at) else "pending",
        "freshness_status": "not_assessed", "facts_hashes": {currency: content_hash(value) for currency, value in facts.items()}}
    excerpt = ("ECB reference rates, not executable FX. CNY-per-unit is cross-converted from EUR reference legs. "
        "Observed time is a Europe/Berlin date anchor, not an intraday quote or publication time. "
        "Availability is conservatively assumed at next calendar-day midnight Europe/Berlin. "
        "No dates or currency legs are filled. Current download is not a point-in-time archive. " + canonical_json(metadata))
    return {"metadata": metadata, "facts": facts, "source_document": {
        "title": "ECB private current reference FX draft", "reference": ecb.URLS[FEED], "excerpt": excerpt},
        "owner_reviewed": False, "production_admitted": False}


def _receipt(encoded, before, after):
    value = _object(encoded, MAX_OUTPUT)
    _check(set(value) == {"raw_base64", "source_url", "started_at", "completed_at", "retrieved_at", "http_status",
        "headers", "raw_sha256", "raw_bytes", "redirects_followed"} and value["source_url"] == ecb.URLS[FEED])
    _check(type(value["http_status"]) is int and value["http_status"] == 200
        and type(value["redirects_followed"]) is int and value["redirects_followed"] == 0)
    _check(all(type(value[key]) is str and ecb._UTC.fullmatch(value[key]) for key in ("started_at", "completed_at", "retrieved_at")))
    _check(instant(before) <= instant(value["started_at"]) <= instant(value["completed_at"]) <= instant(after)
        and value["retrieved_at"] == value["completed_at"])
    headers = value["headers"]
    _check(type(headers) is dict and "content-type" in headers and set(headers) <= _HEADERS)
    _check(all(type(text) is str and len(text) <= 1024 and all(32 <= ord(char) != 127 for char in text) for text in headers.values()))
    message = Message(); message["Content-Type"] = headers["content-type"]
    _check(message.get_content_type() in ("text/xml", "application/xml")
        and message.get_content_charset("utf-8").lower() in ("utf-8", "utf8"))
    _check(type(value["raw_base64"]) is str and len(value["raw_base64"]) <= (ecb.MAX_BYTES + 2) // 3 * 4)
    _check(type(value["raw_bytes"]) is int and 0 < value["raw_bytes"] <= ecb.MAX_BYTES
        and type(value["raw_sha256"]) is str and re.fullmatch(r"[a-f0-9]{64}", value["raw_sha256"]))
    try:
        raw = base64.b64decode(value.pop("raw_base64"), validate=True)
    except Exception:
        raise _error("INVALID") from None
    _check(len(raw) == value["raw_bytes"] and sha256(raw).hexdigest() == value["raw_sha256"])
    if "content-length" in headers:
        _check(re.fullmatch(r"[0-9]{1,7}", headers["content-length"]) and int(headers["content-length"]) == len(raw))
    return raw, value


def collect_current_fx_draft(*, currencies, timeout_seconds=20):
    """No database, credentials, authority ID, source approval, retries or age override."""
    currencies = _currencies(currencies)
    _check(type(timeout_seconds) is int and 1 <= timeout_seconds <= 30)
    before = stamp(datetime.now(timezone.utc))
    try:
        with tempfile.TemporaryDirectory(prefix="workbench-ecb-current-") as directory:
            os.chmod(directory, 0o700)
            encoded = run_memory_process([sys.executable, "-I", str(Path(__file__).resolve()), "--download-child"],
                cwd=directory, environment={"HOME": directory, "TZ": "UTC", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
                    "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"}, error=_error, timeout=timeout_seconds,
                input_bytes=json.dumps({"timeout_seconds": timeout_seconds}).encode(), max_input=1024,
                max_output=MAX_OUTPUT, exit_error_codes={code: name for name, code in _CHILD_ERRORS.items()})
        after = stamp(datetime.now(timezone.utc))
        raw, receipt = _receipt(encoded, before, after)
        draft = build_current_fx_draft(raw, retrieved_at=receipt["retrieved_at"], currencies=currencies)
        return {"schema_version": VERSION, "raw": raw, "receipt": receipt, "draft": draft}
    except WorkbenchError:
        raise
    except Exception:
        raise _error("FAILED") from None


def _download_child():
    value = _object(sys.stdin.buffer.read(1025), 1024)
    _check(set(value) == {"timeout_seconds"} and type(value["timeout_seconds"]) is int and 1 <= value["timeout_seconds"] <= 30)
    result = ecb.download_ecb_xml(FEED, timeout_seconds=value["timeout_seconds"])
    result["raw_base64"] = base64.b64encode(result.pop("raw")).decode("ascii")
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")))


def _child_main():
    try:
        _check(sys.argv[1:] == ["--download-child"])
        _download_child()
    except WorkbenchError as error:
        text = str(error)
        name = text.removeprefix("ECB_") if text.startswith("ECB_") else ""
        sys.exit(_CHILD_ERRORS.get(name, 1))
    except BaseException:
        sys.exit(1)


if __name__ == "__main__":
    _child_main()
