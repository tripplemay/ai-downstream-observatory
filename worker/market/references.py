"""Read-only verification of private, human-reviewed market reference versions."""

from datetime import date, timedelta
from hashlib import sha256
import json
from zoneinfo import ZoneInfo

from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from .contracts import validate_contract
from .providers import longport


ZONES = {"CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "US": "America/New_York"}


def strict_object(text, maximum=1024 * 1024):
    if not isinstance(text, str) or text.startswith("\ufeff") or not 1 <= len(text.encode("utf-8")) <= maximum:
        raise WorkbenchError("MARKET_REFERENCE_JSON_INVALID")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("nonfinite")
    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, TypeError, UnicodeError):
        raise WorkbenchError("MARKET_REFERENCE_JSON_INVALID") from None
    if not isinstance(value, dict):
        raise WorkbenchError("MARKET_REFERENCE_JSON_INVALID")
    return value


def _assert(value):
    if not value:
        raise WorkbenchError("MARKET_REFERENCE_INVALID")


def _utc(value):
    _assert(isinstance(value, str) and stamp(value) == value)
    return instant(value)


def _audit(connection, identity, object_type, action, portfolio_id, actor, at):
    row = connection.execute("SELECT * FROM audit_events WHERE id=?", (identity,)).fetchone()
    _assert(row is not None)
    row = dict(row)
    _assert(row["object_type"] == object_type and row["action"] == action and row["portfolio_id"] == portfolio_id
            and row["actor_id"] == actor and row["created_at"] == at)
    return row, strict_object(row["payload_json"], maximum=4 * 1024 * 1024)


def _source(connection, identity, portfolio_id, known_at):
    row = connection.execute("SELECT * FROM market_reference_sources WHERE id=? AND portfolio_id=?", (identity, portfolio_id)).fetchone()
    _assert(row is not None)
    source = dict(row)
    strict_object(source["content_text"])
    _assert(sha256(source["content_text"].encode("utf-8")).hexdigest() == source["content_hash"]
            and isinstance(source["reference"], str) and 1 <= len(source["reference"].strip()) <= 2000
            and isinstance(source["created_by"], str) and source["created_by"].strip()
            and _utc(source["known_at"]) <= instant(known_at))
    audits = connection.execute("""SELECT id FROM audit_events WHERE object_type='market_reference_source'
        AND object_id=? AND action='store_market_reference_source' AND portfolio_id=?""", (identity, portfolio_id)).fetchall()
    _assert(len(audits) == 1)
    audit, body = _audit(connection, audits[0]["id"], "market_reference_source", "store_market_reference_source",
                         portfolio_id, source["created_by"], source["known_at"])
    expected = {"actor_kind": "human", "input_hash": content_hash({key: source[key] for key in ("portfolio_id", "reference", "content_text")}),
                "result": {key: source[key] for key in ("id", "portfolio_id", "reference", "content_hash", "known_at")}}
    _assert(body == expected)
    return source, audit


def _facts_semantics(kind, facts):
    if kind == "mapping":
        _assert(facts["valid_to"] is None or facts["valid_from"] < facts["valid_to"])
        # Reuse the pinned provider's strict symbol/market/currency constraints.
        longport._request({key: facts[key] for key in ("listing_id", "provider_symbol", "market", "currency")},
                          facts["valid_from"], facts["valid_from"], [facts["valid_from"]])
        return facts["listing_id"]
    start, end = date.fromisoformat(facts["range_start"]), date.fromisoformat(facts["range_end"])
    _assert(0 <= (end - start).days < 3660 and facts["timezone"] == ZONES[facts["market"]])
    expected = [(start + timedelta(days=offset)).isoformat() for offset in range((end - start).days + 1)]
    _assert([row["date"] for row in facts["days"]] == expected)
    previous = None
    for row in facts["days"]:
        if row["kind"] == "closed":
            _assert(row["close_at"] is None)
        else:
            close = _utc(row["close_at"])
            _assert(close.astimezone(ZoneInfo(facts["timezone"])).date().isoformat() == row["date"]
                    and (previous is None or close > previous))
            previous = close
    return facts["market"] + ":" + facts["exchange"]


def verify_reference_version(connection, identity, portfolio_id, known_at, *, require_current=False):
    """Prove the selected latest version at the supplied knowledge instant."""
    try:
        row = connection.execute("SELECT * FROM market_reference_versions WHERE id=? AND portfolio_id=?", (identity, portfolio_id)).fetchone()
        _assert(row is not None)
        version = dict(row)
        document = strict_object(version["document_json"], maximum=4 * 1024 * 1024)
        validate_contract(document, "market-reference-version.schema.json")
        _assert(_utc(version["known_at"]) <= instant(known_at) and content_hash(document) == version["content_hash"])
        for key in ("id", "portfolio_id", "kind", "scope_key", "version", "source_id", "source_hash", "known_at", "created_by"):
            _assert(document[key] == version[key])
        scope = _facts_semantics(version["kind"], document["facts"])
        _assert(scope == version["scope_key"])
        source, source_audit = _source(connection, version["source_id"], portfolio_id, version["known_at"])
        _assert(source["content_hash"] == version["source_hash"] and document["source_known_at"] == source["known_at"])
        audit, body = _audit(connection, version["audit_id"], "market_reference", "publish_market_reference",
                             portfolio_id, version["created_by"], version["known_at"])
        _assert(audit["object_id"] == version["id"] and set(body) == {"actor_kind", "input", "result"}
                and body["actor_kind"] == "human" and isinstance(body["input"], dict))
        expected_input = {"portfolio_id": portfolio_id, "expected_version": version["version"] - 1,
                          "source_id": source["id"], "source_hash": source["content_hash"],
                          "review_reason": document["review_reason"], "acknowledgement": True,
                          "document": {"kind": version["kind"], "facts": document["facts"]}}
        input_body = body["input"]
        _assert(isinstance(input_body.get("idempotency_key"), str) and 1 <= len(input_body["idempotency_key"]) <= 160
                and {key: value for key, value in input_body.items() if key != "idempotency_key"} == expected_input)
        expected_result = {key: version[key] for key in ("id", "portfolio_id", "kind", "scope_key", "version", "source_id", "source_hash", "known_at", "content_hash")}
        expected_result["verification_status"] = "human_reviewed_not_provider_verified"
        _assert(body["result"] == expected_result)
        latest = connection.execute("""SELECT id FROM market_reference_versions
            WHERE portfolio_id=? AND kind=? AND scope_key=? AND known_at<=? ORDER BY version DESC LIMIT 1""",
            (portfolio_id, version["kind"], scope, stamp(known_at))).fetchone()
        _assert(latest is not None and latest["id"] == identity)
        head = {"portfolio_id": portfolio_id, "kind": version["kind"], "scope_key": scope, "version": version["version"],
                "version_id": identity, "updated_at": version["known_at"]}
        if require_current:
            actual = connection.execute("SELECT * FROM market_reference_heads WHERE portfolio_id=? AND kind=? AND scope_key=?",
                                        (portfolio_id, version["kind"], scope)).fetchone()
            _assert(actual is not None and dict(actual) == head)
        proof = {"version_id": identity, "version_hash": content_hash(version), "source_row_hash": content_hash(source),
                 "source_audit_hash": content_hash(source_audit), "review_audit_hash": content_hash(audit)}
        return {"version": version, "document": document, "proof": proof, "head": head}
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, UnicodeError):
        raise WorkbenchError("MARKET_REFERENCE_INVALID") from None


def select_references(connection, portfolio_id, payload, known_at, *, require_current=False):
    try:
        validate_contract(payload, "market-price-collect.schema.json")
        start, end = date.fromisoformat(payload["start_date"]), date.fromisoformat(payload["end_date"])
        _assert(0 <= (end - start).days < longport.MAX_WINDOW_DAYS)
        mappings = [verify_reference_version(connection, identity, portfolio_id, known_at, require_current=require_current)
                    for identity in payload["mapping_version_ids"]]
        calendars = [verify_reference_version(connection, identity, portfolio_id, known_at, require_current=require_current)
                     for identity in payload["calendar_version_ids"]]
        _assert(all(row["version"]["kind"] == "mapping" for row in mappings)
                and all(row["version"]["kind"] == "calendar" for row in calendars))
        market_set = {row["document"]["facts"]["market"] for row in [*mappings, *calendars]}
        _assert(len(market_set) == 1)
        market = next(iter(market_set))
        _assert(payload["end_date"] < instant(known_at).astimezone(ZoneInfo(ZONES[market])).date().isoformat())
        by_exchange = {row["document"]["facts"]["exchange"]: row for row in calendars}
        _assert(len(by_exchange) == len(calendars))
        mapping_proofs, selected, used, identities = [], [], set(), set()
        for row in sorted(mappings, key=lambda row: row["document"]["facts"]["listing_id"]):
            facts = row["document"]["facts"]
            identity = facts["listing_id"]
            _assert(identity not in identities and facts["valid_from"] <= payload["start_date"]
                    and (facts["valid_to"] is None or payload["end_date"] < facts["valid_to"]))
            identities.add(identity)
            listing = connection.execute("SELECT id,market,exchange,currency,created_at FROM listings WHERE id=?", (identity,)).fetchone()
            entry = connection.execute("SELECT * FROM catalog_entries WHERE portfolio_id=? AND listing_id=?", (portfolio_id, identity)).fetchone()
            _assert(listing is not None and entry is not None and instant(listing["created_at"]) <= instant(known_at)
                    and instant(entry["created_at"]) <= instant(known_at)
                    and all(listing[key] == facts[key] for key in ("market", "exchange", "currency")))
            calendar = by_exchange.get(facts["exchange"])
            _assert(calendar is not None)
            days = calendar["document"]["facts"]
            _assert(days["range_start"] <= payload["start_date"] and payload["end_date"] <= days["range_end"])
            expected = [day["date"] for day in days["days"] if payload["start_date"] <= day["date"] <= payload["end_date"] and day["kind"] != "closed"]
            _assert(expected)
            used.add(calendar["version"]["id"])
            proof = {**row["proof"], "listing_id": identity, "listing_identity_hash": content_hash(dict(listing)),
                     "catalog_entry_hash": content_hash(dict(entry)), "calendar_version_id": calendar["version"]["id"],
                     "expected_dates": expected}
            mapping_proofs.append(proof)
            selected.append({"mapping": {key: facts[key] for key in ("listing_id", "provider_symbol", "market", "currency")},
                             "mapping_version_id": row["version"]["id"], "calendar_version_id": calendar["version"]["id"],
                             "expected_dates": expected})
        _assert(used == {row["version"]["id"] for row in calendars})
        proof = {"schema_version": "market-reference-selection-v1", "portfolio_id": portfolio_id, "market": market,
                 "start_date": payload["start_date"], "end_date": payload["end_date"], "known_at": stamp(known_at),
                 "mappings": mapping_proofs, "calendars": sorted((row["proof"] for row in calendars), key=lambda row: row["version_id"]),
                 "heads": sorted((row["head"] for row in [*mappings, *calendars]), key=lambda row: (row["kind"], row["scope_key"]))}
        proof["binding_id"] = content_hash(proof)
        return proof, selected
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        raise WorkbenchError("MARKET_REFERENCE_SELECTION_INVALID") from None


def price_collection_scope(portfolio_id, references):
    identity = {"portfolio_id": portfolio_id, "market": references["market"],
                "listing_ids": sorted(row["listing_id"] for row in references["mappings"])}
    return "provider:longport:prices:" + content_hash(identity)


def price_calendar_session(connection, batch_id, portfolio_id, listing_id, cutoff_at, known_at):
    """A reviewed session close is not a provider quote's publication instant."""
    from .price_collection import verify_price_provider_capture
    try:
        verify_price_provider_capture(connection, batch_id, known_at=known_at)
        capture = connection.execute("SELECT normalized_json FROM market_sdk_captures WHERE batch_id=?", (batch_id,)).fetchone()
        normalized = strict_object(capture["normalized_json"], maximum=4 * 1024 * 1024)
        _assert(normalized["portfolio_id"] == portfolio_id)
        matches = [row for row in normalized["references"]["mappings"] if row["listing_id"] == listing_id]
        _assert(len(matches) == 1)
        mapping = verify_reference_version(connection, matches[0]["version_id"], portfolio_id, known_at)
        calendar = verify_reference_version(connection, matches[0]["calendar_version_id"], portfolio_id, known_at)
        facts, days = mapping["document"]["facts"], calendar["document"]["facts"]
        cutoff = instant(cutoff_at)
        _assert(cutoff <= instant(known_at))
        local_date = cutoff.astimezone(ZoneInfo(days["timezone"])).date().isoformat()
        _assert(facts["valid_from"] <= local_date and (facts["valid_to"] is None or local_date < facts["valid_to"])
                and days["range_start"] <= local_date <= days["range_end"])
        available = [day["date"] for day in days["days"] if day["kind"] != "closed"
                     and facts["valid_from"] <= day["date"]
                     and (facts["valid_to"] is None or day["date"] < facts["valid_to"])
                     and instant(day["close_at"]) <= cutoff]
        _assert(available)
        return max(available)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        raise WorkbenchError("PRICE_CALENDAR_EVIDENCE_INVALID") from None
