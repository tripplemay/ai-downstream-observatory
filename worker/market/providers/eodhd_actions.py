"""Exact, bounded third-party action drafts; never absence or research approval."""

from datetime import date, timedelta
from decimal import Decimal
from hashlib import sha256
import json
import re
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from worker.accounting.decimal_math import canonical, fact_decimal
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp


PARSER_VERSION = "eodhd-action-draft-v1"
HOST = "eodhd.com"
SYMBOLS = ("VT.US", "BND.US")
KINDS = ("div", "splits")
MAX_BYTES = 262144
MAX_RECORDS = 2048
ZONE = ZoneInfo("America/New_York")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z", re.ASCII)
_INSTANT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z\Z", re.ASCII)
_DIVIDEND_REQUIRED = {"date", "value", "unadjustedValue", "currency"}
_DIVIDEND_OPTIONAL = {"declarationDate", "recordDate", "paymentDate", "period"}


def _check(value, code="INVALID"):
    if not value:
        raise WorkbenchError("EODHD_ACTION_" + code)


def _day(value):
    _check(type(value) is str and _DATE.fullmatch(value))
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise WorkbenchError("EODHD_ACTION_INVALID") from None


def action_window(at):
    _check(type(at) is str and _INSTANT.fullmatch(at))
    end = instant(at).astimezone(ZONE).date() - timedelta(days=1)
    return (end - timedelta(days=364)).isoformat(), end.isoformat()


def action_url(kind, symbol, start_date, end_date):
    """Credential-free provenance URL, not the complete authenticated request."""
    _check(type(kind) is str and kind in KINDS and type(symbol) is str and symbol in SYMBOLS, "FIXED_TARGET_REQUIRED")
    _check((_day(end_date) - _day(start_date)).days == 364, "WINDOW_REQUIRED")
    return f"https://{HOST}/api/{kind}/{symbol}?" + urlencode({"fmt": "json", "from": start_date, "to": end_date})


def _number(token):
    _check(len(token) <= 80)
    return Decimal(token)


def _amount(value, *, positive=False):
    _check(type(value) is Decimal)
    amount = fact_decimal(value)
    _check(amount > 0 if positive else amount >= 0)
    return canonical(amount)


def _rows(raw):
    def pairs(items):
        value = {}
        for key, entry in items:
            _check(key not in value)
            value[key] = entry
        return value
    _check(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES)
    value = json.loads(raw.decode("utf-8"), parse_int=_number, parse_float=_number,
        parse_constant=lambda _: (_ for _ in ()).throw(ValueError()), object_pairs_hook=pairs)
    _check(type(value) is list and len(value) <= MAX_RECORDS)
    return value


def parse_eodhd_actions(raw, *, kind, symbol, start_date, end_date, retrieved_at):
    try:
        url = action_url(kind, symbol, start_date, end_date)
        _check((start_date, end_date) == action_window(retrieved_at), "CURRENT_PRIOR_DAY_WINDOW_REQUIRED")
        rows = _rows(raw)
        records, seen = [], set()
        for row in rows:
            _check(type(row) is dict)
            if kind == "div":
                _check(_DIVIDEND_REQUIRED <= set(row) <= _DIVIDEND_REQUIRED | _DIVIDEND_OPTIONAL)
            else:
                _check(set(row) == {"date", "split"})
            day = _day(row["date"]).isoformat()
            _check(start_date <= day <= end_date)
            key = content_hash({"kind": kind, "symbol": symbol, "date": day})
            _check(key not in seen, "DUPLICATE_EVENT")
            seen.add(key)
            event = {"derived_event_key": key, "date": day, "date_precision": "date_not_instant", "published_at": None}
            if kind == "div":
                _check(type(row["currency"]) is str and re.fullmatch(r"[A-Z]{3}", row["currency"], re.ASCII))
                event.update(value=_amount(row["value"]), unadjusted_value=_amount(row["unadjustedValue"]),
                    reported_currency=row["currency"], amount_basis="provider_reported_not_issuer_verified", tax_per_unit=None)
                for original, field in (("declarationDate", "declaration_date"), ("recordDate", "record_date"), ("paymentDate", "payment_date")):
                    value = row.get(original)
                    event[field] = None if value is None else _day(value).isoformat()
                period = row.get("period")
                _check(period is None or type(period) is str and len(period) <= 100 and all(ord(char) >= 32 and ord(char) != 127 for char in period))
                event["reported_period"] = period
            else:
                ratio = row["split"]
                _check(type(ratio) is str and re.fullmatch(r"[0-9]{1,12}(?:\.[0-9]{1,12})?/[0-9]{1,12}(?:\.[0-9]{1,12})?", ratio, re.ASCII))
                numerator, denominator = ratio.split("/")
                event.update(numerator=_amount(Decimal(numerator), positive=True), denominator=_amount(Decimal(denominator), positive=True),
                    ratio_direction="provider_reported_not_issuer_verified")
            records.append(event)
        return {"schema_version": PARSER_VERSION, "source": {"provider": "eodhd", "url_without_credentials": url,
            "kind": kind, "requested_symbol": symbol, "range_start": start_date, "range_end": end_date,
            "retrieved_at": stamp(instant(retrieved_at)), "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw),
            "record_count": len(records), "network_origin_verified_by_parser": False, "instrument_identity_verified_by_payload": False},
            "records": sorted(records, key=lambda record: (record["date"], record["derived_event_key"])),
            "owner_reviewed": False, "corporate_actions_complete": False, "research_admitted": False,
            "empty_is_not_absence_proof": not records,
            "gaps": ["INSTRUMENT_IDENTITY_BINDING_REQUIRED", "ISSUER_CROSS_CHECK_REQUIRED", "HISTORY_AND_ABSENCE_REVIEW_REQUIRED",
                "ANNOUNCEMENT_TIME_NOT_SUPPLIED", "DATE_TO_INSTANT_RECONSTRUCTION_REQUIRED", "TAX_AND_AMOUNT_BASIS_REVIEW_REQUIRED"]}
    except WorkbenchError:
        raise
    except Exception:
        raise WorkbenchError("EODHD_ACTION_INVALID") from None
