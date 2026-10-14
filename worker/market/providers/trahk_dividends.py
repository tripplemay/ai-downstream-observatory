"""Issuer distribution projection only; no invented tax, publication or split review."""

from datetime import date
from decimal import Decimal
from hashlib import sha256
import json
import re
from zoneinfo import ZoneInfo

from worker.accounting import fact_decimal
from worker.orchestration.db import WorkbenchError, instant, stamp


PARSER_VERSION = "trahk-issuer-dividends-v1"
SOURCE_URL = "https://rbwm-api.hsbc.com.hk/pws-hk-hase-hsvm2-papi-prod-proxy/v1/hsvm/aem/trahkEtffunddetail?trustNo=H02800"
REFERENCE_PAGE = "https://www.trahk.com.hk/en-hk/trahk-fund/fund-information/"
MAX_BYTES = 2 * 1024 * 1024
_DATE = re.compile(r"([0-9]{4}-[0-9]{2}-[0-9]{2})(?: 00:00:00(?:\.0{1,6})?)?\Z", re.ASCII)
_AMOUNT = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?\Z", re.ASCII)


def _check(value, code="TRAHK_DIVIDEND_INVALID"):
    if not value: raise WorkbenchError(code)


def _day(value):
    _check(type(value) is str)
    match = _DATE.fullmatch(value)
    _check(match is not None)
    try: return date.fromisoformat(match[1])
    except ValueError: raise WorkbenchError("TRAHK_DIVIDEND_INVALID") from None


def _object(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            _check(key not in result)
            result[key] = value
        return result
    try:
        _check(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES)
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=pairs, parse_float=Decimal,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        _check(type(value) is dict)
        stack, count = [(value, 0)], 0
        while stack:
            item, depth = stack.pop(); count += 1
            _check(count <= 50000 and depth <= 16)
            if type(item) is dict: stack.extend((child, depth + 1) for child in item.values())
            elif type(item) is list: stack.extend((child, depth + 1) for child in item)
        return value
    except Exception:
        raise WorkbenchError("TRAHK_DIVIDEND_INVALID") from None


def parse_trahk_dividends(raw, *, retrieved_at, start_date, end_date):
    """Do not use Div_deter_date as an announcement date or Listing_date as proof."""
    try:
        _check(type(retrieved_at) is str and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z", retrieved_at))
        received = instant(retrieved_at)
        start, end = _day(start_date), _day(end_date)
        _check(start_date == start.isoformat() and end_date == end.isoformat() and 0 <= (end - start).days < 3660
            and end <= received.astimezone(ZoneInfo("Asia/Hong_Kong")).date())
        body = _object(raw); fund = body.get("Fund")
        _check(type(fund) is dict and fund.get("Trust_no") == "H02800" and fund.get("ISIN_code") == "HK2800008867"
            and fund.get("Base_Currency") == "HKD" and fund.get("Fund_type") == "L")
        classes = fund.get("FundUnitClass")
        _check(type(classes) is list and 1 <= len(classes) <= 20 and all(type(value) is dict for value in classes))
        matches = [value for value in classes if type(value.get("Fund_code")) in (str, int) and str(value["Fund_code"]) == "2800"
            and value.get("Class_currency") == "HKD"]
        _check(len(matches) == 1 and matches[0].get("Class_ISIN_code") == "HK2800008867")
        dividends = matches[0].get("Dividends")
        _check(type(dividends) is dict)
        rows = dividends.get("Dividend")
        if type(rows) is dict: rows = [rows]
        _check(type(rows) is list and 1 <= len(rows) <= 1000)
        ids, dates, selected, all_dates = set(), set(), [], []
        for row in rows:
            _check(type(row) is dict and set(row) == {"Div", "Div_serial_no", "Ex_div_date", "Record_date", "Payment_date", "Div_deter_date"})
            identity, value = row["Div_serial_no"], row["Div"]
            _check(type(identity) is str and re.fullmatch(r"[A-Za-z0-9_.:-]{1,100}", identity))
            _check(type(value) is str and len(value) <= 58 and _AMOUNT.fullmatch(value) and fact_decimal(value) > 0)
            ex, record, pay, determination = (_day(row[key]) for key in ("Ex_div_date", "Record_date", "Payment_date", "Div_deter_date"))
            _check(ex <= record <= pay)
            _check(identity not in ids and ex not in dates, "TRAHK_DIVIDEND_DUPLICATE")
            ids.add(identity); dates.add(ex); all_dates.append(ex.isoformat())
            if start <= ex <= end:
                selected.append({"issuer_event_id": identity, "symbol": "2800.HK", "currency": "HKD",
                    "gross_per_unit": value, "amount_basis": "issuer_distribution_per_fund_unit",
                    "ex_date": ex.isoformat(), "record_date": record.isoformat(), "pay_date": pay.isoformat(),
                    "date_precision": "date_not_instant", "published_at": None, "tax_per_unit": None,
                    "determination_date_uninterpreted": determination.isoformat()})
        _check(selected, "TRAHK_DIVIDEND_WINDOW_EMPTY")
        return {"schema_version": PARSER_VERSION, "source": {"provider": "trahk_issuer", "url": SOURCE_URL,
            "reference_page": REFERENCE_PAGE, "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw),
            "retrieved_at": stamp(received), "parser_version": PARSER_VERSION, "selected_fund_code": "2800",
            "issuer_currency": "HKD", "archive_record_count": len(rows), "selected_record_count": len(selected),
            "archive_first_ex_date": min(all_dates), "archive_last_ex_date": max(all_dates),
            "range_start": start_date, "range_end": end_date, "network_origin_verified_by_parser": False},
            "records": sorted(selected, key=lambda row: row["ex_date"]), "owner_reviewed": False,
            "corporate_actions_complete": False, "research_admitted": False,
            "gaps": ["ISSUER_ANNOUNCEMENT_TIME_REQUIRED", "DATE_TO_INSTANT_RECONSTRUCTION_REQUIRED",
                "EXPLICIT_TAX_ASSUMPTION_REQUIRED", "SPLIT_COVERAGE_REVIEW_REQUIRED"]}
    except WorkbenchError:
        raise
    except Exception:
        raise WorkbenchError("TRAHK_DIVIDEND_INVALID") from None
