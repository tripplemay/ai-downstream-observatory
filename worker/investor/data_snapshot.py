"""Build history from retained receipts and reviews, never from caller prices."""

from datetime import date
from zoneinfo import ZoneInfo

from worker.market.providers import longport
from worker.market.contracts import validate_contract
from worker.orchestration.db import canonical_json, content_hash, instant, transaction
from worker.research.snapshot import validate_dataset
from .data_evidence import _assert, resolve_capture, resolve_review
from .runtime import _milliseconds


PARSER = "investor-longbridge-reconstructed-v1"


def build_dataset(db, workspace_id, capture_ids, action_review_ids, fx_review_ids, start_date, end_date, *, now=None, allow_synthetic=False, snapshot_at=None):
    return _build_dataset(db, workspace_id, capture_ids, action_review_ids, fx_review_ids, start_date, end_date,
        now=now, allow_synthetic=allow_synthetic, snapshot_at=snapshot_at)


def build_monitor_dataset(db, workspace_id, capture_ids, confirmed_capture_ids, action_review_ids, fx_review_ids, start_date, end_date, *, now=None, snapshot_at=None):
    _assert(type(confirmed_capture_ids) is list and 1 <= len(confirmed_capture_ids) <= 1000
        and all(type(value) is str and value for value in confirmed_capture_ids) and len(set(confirmed_capture_ids)) == len(confirmed_capture_ids))
    return _build_dataset(db, workspace_id, capture_ids, action_review_ids, fx_review_ids, start_date, end_date,
        now=now, snapshot_at=snapshot_at, confirmed_capture_ids=confirmed_capture_ids)


def _build_dataset(db, workspace_id, capture_ids, action_review_ids, fx_review_ids, start_date, end_date, *, now=None, allow_synthetic=False, snapshot_at=None, confirmed_capture_ids=None):
    _assert(type(allow_synthetic) is bool)
    for rows, maximum in ((capture_ids, 1000), (action_review_ids, 20), (fx_review_ids, 2)):
        _assert(type(rows) is list and len(rows) <= maximum and all(type(value) is str and value for value in rows) and len(rows) == len(set(rows)))
    _assert(capture_ids or confirmed_capture_ids)
    _assert(len(capture_ids) + len(confirmed_capture_ids or []) <= 1000)
    start, end = longport._day(start_date), longport._day(end_date)
    _assert(type(start_date) is str and type(end_date) is str)
    _assert(0 <= (end - start).days < 3660)
    checked = _milliseconds(now)
    frozen_at = checked if snapshot_at is None else _milliseconds(snapshot_at)
    _assert(frozen_at <= checked, "INVESTOR_DATA_SNAPSHOT_IN_FUTURE")
    # Freeze all local references in one read transaction. No network call,
    # financial write, default quote, or mutable-latest price lookup is involved.
    with transaction(db, immediate=False):
        captures = [resolve_capture(db, workspace_id, identity, now=checked, allow_synthetic=allow_synthetic) for identity in capture_ids]
        for row in captures:
            row["capture_kind"] = "historical_sdk"
        if confirmed_capture_ids:
            from .confirmed_capture import resolve_confirmed_capture
            _assert(not allow_synthetic)
            for identity in confirmed_capture_ids:
                value = resolve_confirmed_capture(db, workspace_id, identity, now=checked)
                for binding in value["bindings"]:
                    listing_id = binding["listing"]["facts"]["listing_id"]
                    captures.append({"capture": {**value["capture"], "qualification": "isolated_official_sdk", "projection_sha256": value["capture"]["payload_sha256"]},
                        "capture_kind": "confirmed_sdk", "binding": binding, "records": [row for row in value["records"] if row["listing_id"] == listing_id]})
        actions = [resolve_review(db, workspace_id, identity, "actions", now=checked) for identity in action_review_ids]
        rates = [resolve_review(db, workspace_id, identity, "fx", now=checked) for identity in fx_review_ids]
    capture_reviews = [row["binding"][kind] for row in captures for kind in ("rights", "listing", "calendar")]
    _assert(all(row["capture"]["created_at"] <= frozen_at for row in captures)
        and all(row["review"]["created_at"] <= frozen_at for row in [*actions, *rates, *capture_reviews]),
        "INVESTOR_DATA_SOURCE_AFTER_SNAPSHOT")
    modes = {row["capture"]["qualification"] for row in captures}
    _assert(len(modes) == 1, "INVESTOR_DATA_MIXED_CAPTURE_MODES")
    synthetic = modes == {"injected_test_client"}
    _assert(not synthetic or allow_synthetic, "INVESTOR_DATA_SYNTHETIC_CAPTURE_FORBIDDEN")
    assets, calendars, quote_by_day, reviews = {}, {}, {}, {}
    for row in captures:
        bound = row["binding"]
        asset, calendar = bound["listing"], bound["calendar"]
        identity, market = asset["facts"]["listing_id"], asset["facts"]["market"]
        _assert(identity not in assets or assets[identity]["review"]["id"] == asset["review"]["id"], "INVESTOR_DATA_LISTING_VERSIONS_CONFLICT")
        _assert(market not in calendars or calendars[market]["review"]["id"] == calendar["review"]["id"], "INVESTOR_DATA_CALENDAR_VERSIONS_CONFLICT")
        assets[identity], calendars[market] = asset, calendar
        for kind in ("rights", "listing", "calendar"):
            review = bound[kind]; reviews[review["review"]["id"]] = review
        for price in row["records"]:
            if start_date <= price["observed_at"] <= end_date:
                key = identity, price["observed_at"]
                _assert(key not in quote_by_day, "INVESTOR_DATA_OVERLAPPING_PRICE_CAPTURES")
                quote_by_day[key] = row, price
    _assert(0 < len(assets) <= 20)
    action_by_listing = {}
    for row in actions:
        facts = row["facts"]
        _assert(facts["listing_id"] in assets and facts["listing_id"] not in action_by_listing)
        _assert(facts["range_start"] <= start_date <= end_date <= facts["range_end"], "INVESTOR_DATA_ACTION_COVERAGE_INCOMPLETE")
        action_by_listing[facts["listing_id"]] = row
        reviews[row["review"]["id"]] = row
    _assert(set(action_by_listing) == set(assets), "INVESTOR_DATA_ACTION_COVERAGE_INCOMPLETE")
    currencies = {row["facts"]["currency"] for row in assets.values()} - {"CNY"}
    rate_by_currency = {}
    for row in rates:
        currency = row["facts"]["currency"]
        _assert(currency in currencies and currency not in rate_by_currency)
        rate_by_currency[currency] = row; reviews[row["review"]["id"]] = row
    _assert(set(rate_by_currency) == currencies, "INVESTOR_DATA_FX_COVERAGE_INCOMPLETE")
    sessions, settlements, observations, expected = [], [], [], set()
    for market, row in sorted(calendars.items()):
        facts = row["facts"]
        _assert(facts["range_start"] <= start_date <= end_date <= facts["range_end"])
        for day in facts["days"]:
            if not start_date <= day["date"] <= end_date or day["kind"] == "closed":
                continue
            _assert(instant(day["available_at"]) <= instant(frozen_at), "INVESTOR_DATA_CALENDAR_NOT_COMPLETE")
            sessions.append({"market": market, "session_date": day["date"], "close_at": day["close_at"], "available_at": day["available_at"], "trade_allowed": True})
            settlements.append({"market": market, "session_date": day["date"], "settled_at": day["settled_at"],
                "published_at": day["settlement_rule_known_at"], "source_evidence": "review:" + row["review"]["id"]})
            for identity, asset in assets.items():
                spec = asset["facts"]
                if spec["market"] != market or instant(day["close_at"]) < instant(spec["tradable_from"]) or spec["tradable_until"] and instant(day["close_at"]) >= instant(spec["tradable_until"]):
                    continue
                key = identity, day["date"]; expected.add(key)
                _assert(key in quote_by_day, "INVESTOR_DATA_PRICE_COVERAGE_INCOMPLETE")
                capture, price = quote_by_day[key]
                source = capture["capture"]
                _assert(price["currency"] == spec["currency"] and price["listing_id"] == identity)
                observation_key = {"capture": source["id"], "date": day["date"]}
                if capture["capture_kind"] == "confirmed_sdk": observation_key["listing_id"] = identity
                observations.append({"id": "price:" + content_hash(observation_key),
                    "batch_id": source["id"], "source_id": "provider:longport:research", "series_key": identity, "listing_id": identity,
                    "metric": "close", "value": price["value"], "unit": spec["currency"], "observed_at": day["close_at"],
                    "assumed_available_at": day["available_at"], "ingested_at": price["ingested_at"],
                    "source_timezone": longport._MARKETS[market][0], "time_precision": "second", "price_basis": "unadjusted",
                    "revision_id": source["id"], "raw_hash": source["projection_sha256"], "parser_version": "investor-confirmed-monitor-v1" if capture["capture_kind"] == "confirmed_sdk" else PARSER,
                    "provenance": "reconstructed"})
    _assert(expected == set(quote_by_day), "INVESTOR_DATA_PRICE_CALENDAR_MISMATCH")
    for currency, row in sorted(rate_by_currency.items()):
        for rate in row["facts"]["rows"]:
            _assert(instant(rate["assumed_available_at"]) <= instant(row["review"]["created_at"]))
            if instant(rate["observed_at"]) > instant(end_date + "T23:59:59.999999Z"):
                continue
            observations.append({"id": "fx:" + content_hash({"review": row["review"]["id"], "at": rate["observed_at"]}),
                "batch_id": row["review"]["id"], "source_id": "reviewed:fx:" + row["source"]["id"], "series_key": "FX:" + currency,
                "metric": "fx_cny_per_unit", "value": rate["value"], "unit": "CNY_per_unit_currency", "observed_at": rate["observed_at"],
                "assumed_available_at": rate["assumed_available_at"], "ingested_at": row["review"]["created_at"], "source_timezone": "UTC",
                "time_precision": "second", "price_basis": "not_applicable", "revision_id": row["review"]["id"],
                "raw_hash": row["source"]["content_hash"], "parser_version": PARSER, "provenance": "reconstructed"})
    events = []
    for identity, row in sorted(action_by_listing.items()):
        zone = ZoneInfo(longport._MARKETS[assets[identity]["facts"]["market"]][0])
        for event in row["facts"]["events"]:
            event_date = instant(event["at"]).astimezone(zone).date().isoformat()
            _assert(row["facts"]["range_start"] <= event_date <= row["facts"]["range_end"])
            if start_date <= event_date <= end_date:
                events.append({**event, "source_evidence": "review:" + row["review"]["id"]})
    manifest = {"schema_version": "investor-data-snapshot-v1", "workspace_id": workspace_id, "created_at": frozen_at,
        "range_start": start_date, "range_end": end_date, "mode": "synthetic" if synthetic else "reconstructed",
        "capture_refs": sorted(({"capture_id": row["capture"]["id"], "receipt_hash": row["capture"]["receipt_hash"], "projection_sha256": row["capture"]["projection_sha256"]} for row in captures), key=lambda row: row["capture_id"]),
        "review_refs": sorted(({"review_id": identity, "review_hash": row["review"]["content_hash"], "source_id": row["source"]["id"], "source_hash": row["source"]["content_hash"]} for identity, row in reviews.items()), key=lambda row: row["review_id"]),
        "publication_times": "reconstructed_assumptions_not_provider_published_at", "universe_basis": "retrospectively_selected_not_survivorship_free",
        "review_basis": "owner_reviewed_not_provider_certified", "external_ai_authorized": False, "live_advice_eligible": False}
    if confirmed_capture_ids:
        refs = {}
        for row in captures:
            source, kind = row["capture"], row["capture_kind"]
            refs[source["id"]] = {"capture_id": source["id"], "receipt_hash": source["receipt_hash"], "kind": kind,
                "payload_sha256" if kind == "confirmed_sdk" else "projection_sha256": source["projection_sha256"]}
        _assert(len(refs) <= 1000 and not synthetic)
        manifest.update(schema_version="investor-monitor-price-snapshot-v1", use_scope="monitor_only",
            capture_refs=sorted(refs.values(), key=lambda row: row["capture_id"]),
            publication_times="mixed_assumptions_and_sdk_callback_receipt_not_provider_published_at")
    validate_contract(manifest, "investor-monitor-price-snapshot.schema.json" if confirmed_capture_ids else "investor-data-snapshot.schema.json")
    manifest_hash = content_hash(manifest)
    dataset = {"schema_version": "research-dataset-v2", "mode": manifest["mode"], "source_evidence": "investor-data-snapshot:" + manifest_hash,
        "license_scope": "Recorded private research/retention/display/backup only; owner-reviewed sources, not provider certification; no external AI authority inferred",
        "historical_archive_verified": False, "corporate_actions_complete": True, "publication_refs": [],
        "assets": [{"listing_id": identity, "market": row["facts"]["market"], "currency": row["facts"]["currency"], "quantity_step": row["facts"]["quantity_step"],
            "tradable_from": row["facts"]["tradable_from"], **({"tradable_until": row["facts"]["tradable_until"]} if row["facts"]["tradable_until"] else {}),
            "source_evidence": "review:" + row["review"]["id"]} for identity, row in sorted(assets.items())],
        "sessions": sorted(sessions, key=lambda row: (row["close_at"], row["market"])), "settlements": sorted(settlements, key=lambda row: (row["session_date"], row["market"])),
        "observations": sorted(observations, key=lambda row: row["id"]), "actions": sorted(events, key=lambda row: (row["at"], row["id"]))}
    _assert(len(observations) <= 100000)
    _assert(len(canonical_json(dataset).encode()) + len(canonical_json(manifest).encode()) <= 16 * 1024 * 1024,
        "INVESTOR_DATA_SNAPSHOT_LIMIT")
    validate_dataset(dataset)
    return {"dataset": dataset, "manifest": manifest, "manifest_hash": manifest_hash, "dataset_hash": content_hash(dataset),
        "valid_until": min([row["review"]["valid_until"] for row in reviews.values()] + [row["capture"]["retain_until"] for row in captures]),
        "catalog": {identity: row["facts"] for identity, row in sorted(assets.items())}, "live_advice_eligible": False}
