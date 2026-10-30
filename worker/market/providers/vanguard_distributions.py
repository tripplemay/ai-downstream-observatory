"""Exact issuer distribution drafts; never certifies identity, tax or coverage."""

from datetime import date
from decimal import Decimal
from hashlib import sha256
import json
import re
from zoneinfo import ZoneInfo

from worker.accounting.decimal_math import canonical, fact_decimal
from worker.orchestration.db import WorkbenchError, instant, stamp


PARSER_VERSION = "vanguard-distributions-draft-v1"
MAX_BYTES = 1048576
MAX_RECORDS = 2048
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z", re.ASCII)
_INSTANT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z\Z", re.ASCII)
_REQUIRED = {"amount", "exDividendDate", "payableDate", "recordDate", "reinvestDate", "reinvestPrice", "typeCode"}
_COMPONENTS = frozenset(("INC", "CGLT", "CGST"))


def _check(value, code="VANGUARD_DISTRIBUTION_INVALID"):
    if not value:
        raise WorkbenchError(code)


def distribution_url(fund_id, has_distribution_yield):
    _check(type(fund_id) is str and re.fullmatch(r"[0-9]{4}", fund_id))
    _check(type(has_distribution_yield) is bool)
    flag = "true" if has_distribution_yield else "false"
    return f"https://advisors.vanguard.com/investments/products/api/funds/{fund_id}/pricing/distributions?hasDistributionYield={flag}"


def _day(value):
    _check(type(value) is str and _DATE.fullmatch(value))
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise WorkbenchError("VANGUARD_DISTRIBUTION_INVALID") from None


def distribution_window(retrieved_at, start_date, end_date):
    _check(type(retrieved_at) is str and _INSTANT.fullmatch(retrieved_at))
    received = instant(retrieved_at)
    start, end = _day(start_date), _day(end_date)
    _check(0 <= (end - start).days < 3660 and end <= received.astimezone(ZoneInfo("America/New_York")).date())
    return received, start, end


def _number(value):
    _check(len(value) <= 80)
    return Decimal(value)


def _rows(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            _check(key not in result)
            result[key] = value
        return result
    try:
        _check(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES)
        value = json.loads(raw.decode("utf-8-sig"), parse_float=_number, parse_int=_number,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()), object_pairs_hook=pairs)
        _check(type(value) is list and 1 <= len(value) <= MAX_RECORDS)
        return value
    except Exception:
        raise WorkbenchError("VANGUARD_DISTRIBUTION_INVALID") from None


def parse_vanguard_distributions(raw, *, fund_id, has_distribution_yield, retrieved_at, start_date, end_date):
    """Dates and amount are reported fields, not point-in-time economic approval."""
    try:
        url = distribution_url(fund_id, has_distribution_yield)
        received, start, end = distribution_window(retrieved_at, start_date, end_date)
        rows = _rows(raw)
        keys, selected, archive_dates = set(), [], []
        for row in rows:
            _check(type(row) is dict and set(row) in (_REQUIRED, _REQUIRED | {"distributionYieldAmount"}))
            _check(type(row["typeCode"]) is str and row["typeCode"] in _COMPONENTS,
                "VANGUARD_DISTRIBUTION_COMPONENT_UNSUPPORTED")
            _check(type(row["amount"]) is Decimal)
            amount = fact_decimal(row["amount"])
            _check(amount >= 0)
            ex, record, pay = (_day(row[key]) for key in ("exDividendDate", "recordDate", "payableDate"))
            _check(ex <= record <= pay)
            _check(type(row["reinvestDate"]) is str and len(row["reinvestDate"]) <= 100)
            if "distributionYieldAmount" in row:
                _check(type(row["distributionYieldAmount"]) is str and len(row["distributionYieldAmount"]) <= 100)
            identity = {"fund_id": fund_id, "type_code": row["typeCode"], "ex_date": ex.isoformat(),
                "record_date": record.isoformat(), "pay_date": pay.isoformat()}
            # Amount corrections must retain their natural key, not become another payout.
            key = sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            _check(key not in keys, "VANGUARD_DISTRIBUTION_DUPLICATE_COMPONENT")
            keys.add(key); archive_dates.append(ex.isoformat())
            if start <= ex <= end:
                selected.append({"derived_event_key": key, "issuer_type_code": row["typeCode"],
                    "distribution_amount": canonical(amount), "amount_basis": "not_supplied_in_payload",
                    "currency": None, "ex_date": ex.isoformat(), "record_date": record.isoformat(),
                    "pay_date": pay.isoformat(), "date_precision": "date_not_instant",
                    "published_at": None, "tax_per_unit": None})
        return {"schema_version": PARSER_VERSION, "source": {"provider": "vanguard_issuer",
            "url": url,
            "requested_fund_id": fund_id, "requested_has_distribution_yield": has_distribution_yield,
            "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "retrieved_at": stamp(received),
            "parser_version": PARSER_VERSION, "range_start": start_date, "range_end": end_date,
            "archive_record_count": len(rows), "selected_record_count": len(selected),
            "archive_first_ex_date": min(archive_dates), "archive_last_ex_date": max(archive_dates),
            "network_origin_verified_by_parser": False, "fund_identity_verified_by_payload": False},
            "records": sorted(selected, key=lambda row: (row["ex_date"], row["issuer_type_code"], row["derived_event_key"])),
            "owner_reviewed": False, "corporate_actions_complete": False, "research_admitted": False,
            "gaps": ["ISSUER_FUND_IDENTITY_BINDING_REQUIRED", "CURRENCY_AND_AMOUNT_BASIS_CONFIRMATION_REQUIRED",
                "ISSUER_ANNOUNCEMENT_TIME_NOT_SUPPLIED", "DATE_TO_INSTANT_RECONSTRUCTION_REQUIRED",
                "EXPLICIT_TAX_ASSUMPTION_REQUIRED", "SPLIT_AND_DISTRIBUTION_COVERAGE_REVIEW_REQUIRED"]}
    except WorkbenchError:
        raise
    except Exception:
        raise WorkbenchError("VANGUARD_DISTRIBUTION_INVALID") from None
