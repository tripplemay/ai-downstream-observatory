"""Bounded, resumable daily history from current owner-reviewed sources only."""

from datetime import timedelta
import re
import time
from zoneinfo import ZoneInfo

from worker.market.providers import longport
from worker.orchestration.db import assert_writable, content_hash, instant, transaction
from .data_evidence import USES, _assert, _object, _owner, collect_prices, resolve_capture, resolve_review
from .runtime import _milliseconds


VERSION = "investor-history-plan-v1"
MAX_HISTORY_DAYS = 3660
MAX_RETAINED_CAPTURES = 1000
MAX_BATCH_CALLS = 4


def _design(db, workspace, rights_id, listing_id, calendar_id, start, end, checked):
    _assert(type(start) is str and type(end) is str)
    first, last = longport._day(start), longport._day(end)
    _assert(0 <= (last - first).days < MAX_HISTORY_DAYS, "INVESTOR_DATA_HISTORY_RANGE_INVALID")
    refs = {kind: resolve_review(db, workspace, identity, kind, now=checked)
        for kind, identity in (("rights", rights_id), ("listing", listing_id), ("calendar", calendar_id))}
    grant, asset, calendar = (refs[kind]["facts"] for kind in ("rights", "listing", "calendar"))
    _assert(USES <= set(grant["uses"]) and asset["market"] in grant["markets"]
        and instant(grant["valid_from"]) <= instant(checked) < instant(grant["valid_until"]), "INVESTOR_DATA_USE_NOT_GRANTED")
    _assert(asset["market"] == calendar["market"] and calendar["range_start"] <= start <= end <= calendar["range_end"],
        "INVESTOR_DATA_HISTORY_CALENDAR_COVERAGE_REQUIRED")
    zone = ZoneInfo(longport._MARKETS[asset["market"]][0])
    _assert(last < instant(checked).astimezone(zone).date(), "INVESTOR_DATA_WINDOW_NOT_COMPLETE")
    days = [row["date"] for row in calendar["days"] if start <= row["date"] <= end and row["kind"] != "closed"
        and instant(row["close_at"]) >= instant(asset["tradable_from"])
        and (asset["tradable_until"] is None or instant(row["close_at"]) < instant(asset["tradable_until"]))]
    _assert(days, "INVESTOR_DATA_WINDOW_NOT_COMPLETE")
    mapping = {key: asset[key] for key in ("listing_id", "provider_symbol", "market", "currency")}
    tiles, cursor = [], first
    while cursor <= last:
        finish = min(last, cursor + timedelta(days=longport.MAX_WINDOW_DAYS - 1))
        expected = [day for day in days if cursor.isoformat() <= day <= finish.isoformat()]
        request = longport._request(mapping, cursor.isoformat(), finish.isoformat(), expected) if expected else None
        tiles.append({"start_date": cursor.isoformat(), "end_date": finish.isoformat(), "request": request})
        cursor = finish + timedelta(days=1)
    design = {"schema_version": VERSION, "workspace_id": workspace, "range_start": start, "range_end": end,
        "review_refs": {kind: {"id": row["review"]["id"], "content_hash": row["review"]["content_hash"]} for kind, row in refs.items()},
        "tiles": tiles}
    expiry = min([grant["valid_until"], *(row["review"]["valid_until"] for row in refs.values())], key=instant)
    return design, expiry


def plan_history(db, workspace, actor, rights_id, listing_id, calendar_id, start, end, *, now=None, allow_synthetic=False):
    """No credentials, provider call, mutation or automatic latest-price selection."""
    _assert(type(allow_synthetic) is bool)
    checked = _milliseconds(now)
    with transaction(db, immediate=False):
        _owner(db, workspace, actor)
        design, expiry = _design(db, workspace, rights_id, listing_id, calendar_id, start, end, checked)
        rows = db.execute("""SELECT c.* FROM investor_price_captures c JOIN investor_price_payloads p ON p.capture_id=c.id
            WHERE c.workspace_id=? AND c.rights_review_id=? AND c.listing_review_id=? AND c.calendar_review_id=?
              AND c.retain_until>? ORDER BY c.created_at,c.id LIMIT ?""",
            (workspace, rights_id, listing_id, calendar_id, checked, MAX_RETAINED_CAPTURES + 1)).fetchall()
        _assert(len(rows) <= MAX_RETAINED_CAPTURES, "INVESTOR_DATA_HISTORY_CAPTURE_LIMIT")
        retained = {}
        by_window = {(tile["start_date"], tile["end_date"]): tile for tile in design["tiles"]}
        for row in rows:
            receipt = _object(row["receipt_json"])
            _assert(content_hash(receipt) == row["receipt_hash"])
            request = receipt.get("request")
            _assert(type(request) is dict and type(request.get("start_date")) is str and type(request.get("end_date")) is str)
            window = (longport._day(request["start_date"]).isoformat(), longport._day(request["end_date"]).isoformat())
            _assert(window[0] <= window[1])
            if window[1] < start or window[0] > end:
                continue
            _assert(row["created_at"] <= checked, "INVESTOR_DATA_HISTORY_SOURCE_AFTER_CLOCK")
            _assert(window in by_window and window not in retained and request == by_window[window]["request"],
                "INVESTOR_DATA_HISTORY_CAPTURE_WINDOWS_CONFLICT")
            captured = resolve_capture(db, workspace, row["id"], now=checked, allow_synthetic=allow_synthetic)
            _assert(captured["receipt"]["request"] == request)
            retained[window] = row["id"]
            expiry = min(expiry, row["retain_until"], key=instant)
    tiles = []
    for index, tile in enumerate(design["tiles"]):
        capture = retained.get((tile["start_date"], tile["end_date"]))
        tiles.append({"index": index, "start_date": tile["start_date"], "end_date": tile["end_date"],
            "expected_date_count": len(tile["request"]["expected_dates"]) if tile["request"] else 0,
            "status": "retained" if capture else "missing" if tile["request"] else "no_sessions", "capture_id": capture})
    return {"schema_version": VERSION, "plan_hash": content_hash(design), "workspace_id": workspace,
        "range_start": start, "range_end": end, "review_refs": design["review_refs"], "checked_at": checked, "valid_until": expiry,
        "max_window_days": longport.MAX_WINDOW_DAYS, "tiles": tiles,
        "expected_date_count": sum(tile["expected_date_count"] for tile in tiles),
        "retained_tile_count": sum(tile["status"] == "retained" for tile in tiles),
        "missing_tile_count": sum(tile["status"] == "missing" for tile in tiles),
        "no_session_tile_count": sum(tile["status"] == "no_sessions" for tile in tiles),
        "price_coverage_complete": all(tile["status"] != "missing" for tile in tiles),
        "provider_calls": 0, "market_values_output": False, "research_queue_updated": False,
        "review_basis": "owner_reviewed_not_provider_certified", "calendar_verified_by_provider": False,
        "company_actions_verified": False, "total_return_verified": False, "historical_archive_verified": False,
        "live_advice_eligible": False}


def collect_history(db, workspace, actor, rights_id, listing_id, calendar_id, start, end, *, plan_hash,
                    max_calls=1, credentials_file=None, now=None, client=None, sdk_version=None):
    """Each capture commits separately; failure stops without retry or empty data."""
    _assert(client is not None or now is None, "INVESTOR_DATA_PRODUCTION_CLOCK_NOT_CALLER_CONTROLLED")
    _assert(type(max_calls) is int and 1 <= max_calls <= MAX_BATCH_CALLS, "INVESTOR_DATA_HISTORY_CALL_LIMIT")
    _assert(type(plan_hash) is str and re.fullmatch(r"[0-9a-f]{64}", plan_hash), "INVESTOR_DATA_HISTORY_PLAN_INVALID")
    assert_writable(db)
    arguments = (db, workspace, actor, rights_id, listing_id, calendar_id, start, end)
    collected, last_call = [], None
    while len(collected) < max_calls:
        planned = plan_history(*arguments, now=now, allow_synthetic=client is not None)
        _assert(planned["plan_hash"] == plan_hash, "INVESTOR_DATA_HISTORY_PLAN_CHANGED")
        missing = next((tile for tile in planned["tiles"] if tile["status"] == "missing"), None)
        if missing is None:
            break
        if last_call is not None and client is None:
            time.sleep(max(0, 1 - (time.monotonic() - last_call)))
        last_call = time.monotonic()
        row = collect_prices(db, workspace, actor, rights_id, listing_id, calendar_id, missing["start_date"], missing["end_date"],
            credentials_file=credentials_file, now=now, client=client, sdk_version=sdk_version, prevent_retained_overlap=True)
        collected.append(row["id"])
    result = plan_history(*arguments, now=now, allow_synthetic=client is not None)
    _assert(result["plan_hash"] == plan_hash, "INVESTOR_DATA_HISTORY_PLAN_CHANGED")
    return {**result, "provider_calls": len(collected), "collected_capture_ids": collected, "max_calls": max_calls,
        "stopped_at_call_limit": bool(result["missing_tile_count"] and len(collected) == max_calls)}
