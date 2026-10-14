"""Full ECB history to unapproved private FX review drafts, not live FX quotes."""

from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
from zoneinfo import ZoneInfo

from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp
from .ecb import HISTORY_MAX_BYTES, HISTORY_URL, _CURRENCIES, _ECB, _GESMES, _UTC, _container, _cross, _rate, _xml


PARSER_VERSION = "ecb-history-reference-xml-v1"
MAX_DATES = 10000
MAX_NODES = 400000
_HISTORICAL_CURRENCIES = _CURRENCIES | {"CYP", "EEK", "LTL", "LVL", "MTL", "ROL", "SIT", "SKK", "TRL"}
_ZONE = ZoneInfo("Europe/Berlin")


def _day(value):
    try:
        parsed = date.fromisoformat(value)
        if type(value) is not str or parsed.isoformat() != value:
            raise ValueError()
        return parsed
    except (ValueError, TypeError):
        raise WorkbenchError("ECB_INVALID_RATE_DATE") from None


def parse_history_xml(raw, *, retrieved_at, currencies, start_date, end_date):
    """Validate the entire archive; only cross-convert the explicit date window.

    Pre-CNY archive rows are legitimate outside the requested window. Missing
    CNY or a requested currency inside the window blocks, never fills a rate.
    """
    if not isinstance(retrieved_at, str) or not _UTC.fullmatch(retrieved_at):
        raise WorkbenchError("ECB_RETRIEVAL_UTC_INSTANT_REQUIRED")
    try:
        retrieved = instant(retrieved_at)
    except (ValueError, WorkbenchError):
        raise WorkbenchError("ECB_RETRIEVAL_UTC_INSTANT_REQUIRED") from None
    start, end = _day(start_date), _day(end_date)
    if not 0 <= (end - start).days < 3660 or end > retrieved.astimezone(_ZONE).date():
        raise WorkbenchError("ECB_HISTORY_WINDOW_INVALID")
    if (not isinstance(currencies, (list, tuple)) or not 1 <= len(currencies) <= 2
            or any(type(currency) is not str or currency not in ("USD", "HKD") for currency in currencies)
            or len(set(currencies)) != len(currencies)):
        raise WorkbenchError("ECB_REQUESTED_CURRENCIES_INVALID")
    requested = sorted(currencies)
    root = _xml(raw, maximum_bytes=HISTORY_MAX_BYTES, maximum_nodes=MAX_NODES)
    _container(root, _GESMES + "Envelope")
    children = list(root)
    if [child.tag for child in children] != [_GESMES + "subject", _GESMES + "Sender", _ECB + "Cube"]:
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
    subject, sender, outer = children
    if subject.attrib or list(subject) or (subject.text or "").strip() != "Reference rates" or subject.tail and subject.tail.strip():
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
    _container(sender, _GESMES + "Sender")
    if len(sender) != 1:
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
    name = sender[0]
    if name.tag != _GESMES + "name" or name.attrib or list(name) or (name.text or "").strip() != "European Central Bank" or name.tail and name.tail.strip():
        raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
    _container(outer, _ECB + "Cube")
    if not 1 <= len(outer) <= MAX_DATES:
        raise WorkbenchError("ECB_EMPTY_OR_UNEXPECTED_DATE_COUNT")
    dates, selected_dates, records = set(), set(), []
    raw_hash = sha256(raw).hexdigest()
    for day in outer:
        _container(day, _ECB + "Cube", ("time",))
        day_text = day.attrib["time"]
        parsed_date = _day(day_text)
        if parsed_date > retrieved.astimezone(_ZONE).date():
            raise WorkbenchError("ECB_INVALID_OR_FUTURE_RATE_DATE")
        if day_text in dates:
            raise WorkbenchError("ECB_DUPLICATE_RATE_DATE")
        dates.add(day_text)
        if not 1 <= len(day) <= 64:
            raise WorkbenchError("ECB_EMPTY_OR_UNEXPECTED_CURRENCY_COUNT")
        rates = {}
        for row in day:
            _container(row, _ECB + "Cube", ("currency", "rate"))
            if list(row):
                raise WorkbenchError("ECB_UNEXPECTED_XML_STRUCTURE")
            currency, rate = row.attrib["currency"], row.attrib["rate"]
            if currency not in _HISTORICAL_CURRENCIES or currency == "EUR":
                raise WorkbenchError("ECB_UNKNOWN_OR_UNEXPECTED_CURRENCY")
            if currency in rates:
                raise WorkbenchError("ECB_DUPLICATE_CURRENCY")
            _rate(rate)
            rates[currency] = rate
        if not start <= parsed_date <= end:
            continue
        if "CNY" not in rates or any(currency not in rates for currency in requested):
            raise WorkbenchError("ECB_REQUIRED_CURRENCY_MISSING")
        selected_dates.add(day_text)
        for currency in requested:
            records.append({"rate_date": day_text, "currency": currency,
                "value_cny_per_unit": _cross(rates["CNY"], rates[currency]), "published_at": None,
                "cross": {"formula": "CNY_per_EUR / currency_per_EUR", "numerator": rates["CNY"], "denominator": rates[currency]}})
    if not selected_dates:
        raise WorkbenchError("ECB_HISTORY_WINDOW_EMPTY")
    return {"schema_version": "ecb-history-reference-v1", "source": {
        "provider": "ecb", "feed": "full_history", "url": HISTORY_URL, "parser_version": PARSER_VERSION,
        "raw_sha256": raw_hash, "raw_bytes": len(raw), "retrieved_at": stamp(retrieved),
        "source_timezone": "Europe/Berlin", "rate_kind": "reference_not_executable",
        "publication_time_status": "not_supplied", "network_origin_verified_by_parser": False,
        "historical_archive_verified": False, "requested_currencies": requested,
        "range_start": start_date, "range_end": end_date, "archive_date_count": len(dates),
        "archive_first_date": min(dates), "archive_last_date": max(dates),
        "selected_date_count": len(selected_dates), "first_rate_date": min(selected_dates), "last_rate_date": max(selected_dates),
        "rounding": {"arithmetic": "exact_rational", "method": "ROUND_HALF_EVEN", "scale": 18}},
        "records": sorted(records, key=lambda row: (row["rate_date"], row["currency"]))}


def _midnight(day):
    return datetime.combine(day, time(), tzinfo=_ZONE).astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_fx_drafts(raw, *, retrieved_at, currencies, start_date, end_date):
    """Existing facts contract; no auto approval, writes, queue or financial facts."""
    parsed = parse_history_xml(raw, retrieved_at=retrieved_at, currencies=currencies, start_date=start_date, end_date=end_date)
    facts = {currency: {"currency": currency, "unit": "CNY_per_unit_currency", "rows": []} for currency in parsed["source"]["requested_currencies"]}
    for row in parsed["records"]:
        day = _day(row["rate_date"])
        facts[row["currency"]]["rows"].append({"observed_at": _midnight(day),
            "assumed_available_at": _midnight(day + timedelta(days=1)), "value": row["value_cny_per_unit"]})
    metadata = {**parsed["source"], "availability_policy": "next_calendar_day_midnight_Europe_Berlin",
        "observation_policy": "rate_date_midnight_date_anchor_not_intraday_observation",
        "facts_hashes": {currency: content_hash(value) for currency, value in facts.items()}}
    excerpt = ("ECB dated reference rates, not executable FX. observed_at is a date anchor, not an intraday quote or publication timestamp. "
        "assumed_available_at is the next calendar day at midnight Europe/Berlin, a conservative reconstruction assumption. "
        "No missing dates or currency legs are filled. Retrieved history is not a point-in-time archive. " + canonical_json(metadata))
    return {"metadata": metadata, "facts": facts, "source_document": {
        "title": "ECB private reconstructed historical FX input", "reference": HISTORY_URL, "excerpt": excerpt},
        "owner_reviewed": False, "production_admitted": False}
