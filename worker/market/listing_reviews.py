"""Read-only private listing reviews; never rewrite holdings or grant trading rights."""

from datetime import date
from hashlib import sha256
import json
import re
from zoneinfo import ZoneInfo

from worker.accounting import fact_decimal
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp, transaction
from .contracts import validate_contract


_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}")
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z")
_JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_ERROR = "LISTING_REVIEW_EVIDENCE_INVALID"
_ZONES = {"CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "US": "America/New_York"}


def _assert(value):
    if not value:
        raise WorkbenchError(_ERROR)


def _text(value, limit):
    return (isinstance(value, str) and 1 <= len(value.encode("utf-16-le")) // 2 <= limit
            and bool(value.strip(_JS_WHITESPACE)))


def _identifier(value):
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _human(value):
    return _identifier(value) and not value.startswith("system:")


def _utc(value):
    _assert(isinstance(value, str) and _UTC.fullmatch(value) is not None and stamp(value) == value)
    return instant(value)


def _stored_instant(value):
    _assert(isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z", value))
    return _utc(stamp(value))


def _object(raw, maximum=4 * 1024 * 1024):
    _assert(isinstance(raw, str) and not raw.startswith("\ufeff") and 1 <= len(raw.encode("utf-8")) <= maximum)
    def pairs(values):
        result = {}
        for key, value in values:
            _assert(key not in result)
            result[key] = value
        return result
    def constant(_):
        raise WorkbenchError(_ERROR)
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    _assert(isinstance(value, dict))
    def depth(item, level=0):
        if isinstance(item, (dict, list)):
            _assert(level < 64)
            for child in item.values() if isinstance(item, dict) else item:
                depth(child, level + 1)
    depth(value)
    return value


def _source(connection, source_id, portfolio_id, known_at):
    row = connection.execute("SELECT * FROM market_reference_sources WHERE id=? AND portfolio_id=?",
                             (source_id, portfolio_id)).fetchone()
    _assert(row is not None)
    source = dict(row)
    _object(source["content_text"], 1024 * 1024)
    _assert(_identifier(source["id"]) and _human(source["created_by"]) and _text(source["reference"], 2000)
            and sha256(source["content_text"].encode("utf-8")).hexdigest() == source["content_hash"]
            and _utc(source["known_at"]) <= known_at)
    audits = connection.execute("""SELECT * FROM audit_events WHERE object_type='market_reference_source'
        AND object_id=? AND action='store_market_reference_source'""", (source_id,)).fetchall()
    _assert(len(audits) == 1)
    audit = dict(audits[0])
    _assert(audit["portfolio_id"] == portfolio_id and audit["actor_id"] == source["created_by"]
            and audit["created_at"] == source["known_at"] and audit["ledger_revision"] is None)
    expected = {"actor_kind": "human", "input_hash": content_hash({key: source[key] for key in
                ("portfolio_id", "reference", "content_text")}),
                "result": {key: source[key] for key in ("id", "portfolio_id", "reference", "content_hash", "known_at")}}
    _assert(_object(audit["payload_json"]) == expected)
    return source, audit


def _facts(document):
    facts = document["facts"]
    for key in ("quantity_step", "price_step"):
        if facts[key] is not None:
            _assert(fact_decimal(facts[key]) > 0)
    effective = facts["source_effective_date"]
    if effective is not None:
        local_date = _utc(document["known_at"]).astimezone(ZoneInfo(_ZONES[document["identity_snapshot"]["market"]])).date()
        _assert(date.fromisoformat(effective).isoformat() == effective and date.fromisoformat(effective) <= local_date)
    for value in [facts["fund_identifier"], facts["share_class_identifier"], *facts["risk_classification"].values()]:
        _assert(value is None or _text(value, 160))
    _assert(_text(document["reason"], 2000))
    for key in ("ticker", "exchange"):
        _assert(_text(document["identity_snapshot"][key], 40))


def _review(connection, row, portfolio_id, listing_id):
    document = _object(row["document_json"])
    validate_contract(document, "listing-review.schema.json")
    _assert(row["portfolio_id"] == portfolio_id and row["listing_id"] == listing_id
            and type(row["revision"]) is int and 1 <= row["revision"] <= 9007199254740991
            and _human(row["created_by"]) and content_hash(document) == row["content_hash"]
            and canonical_json(document) == row["document_json"])
    for key in ("id", "portfolio_id", "listing_id", "revision", "source_id", "source_hash", "source_known_at",
                "identity_hash", "known_at", "created_by", "review_until", "reason"):
        _assert(document[key] == row[key])
    identity, facts = _object(row["identity_json"]), _object(row["facts_json"])
    _assert(identity == document["identity_snapshot"] and facts == document["facts"]
            and canonical_json(identity) == row["identity_json"] and canonical_json(facts) == row["facts_json"]
            and identity["listing_id"] == listing_id and content_hash(identity) == row["identity_hash"]
            and _utc(row["review_until"]) > _utc(row["known_at"]))
    _facts(document)
    source, source_audit = _source(connection, row["source_id"], portfolio_id, _utc(row["known_at"]))
    _assert(source["content_hash"] == row["source_hash"] and source["known_at"] == row["source_known_at"])
    audit_rows = connection.execute("SELECT * FROM audit_events WHERE object_type='listing_review' AND object_id=?", (row["id"],)).fetchall()
    _assert(len(audit_rows) == 1)
    audit = dict(audit_rows[0])
    _assert(audit["id"] == row["audit_id"] and audit["action"] == "publish_listing_review" and audit["object_type"] == "listing_review"
            and audit["object_id"] == row["id"] and audit["portfolio_id"] == portfolio_id
            and audit["actor_id"] == row["created_by"] and audit["created_at"] == row["known_at"]
            and audit["ledger_revision"] is None)
    body = _object(audit["payload_json"])
    _assert(set(body) == {"actor_kind", "input", "result"} and body["actor_kind"] == "human")
    expected_result = {key: row[key] for key in ("id", "portfolio_id", "listing_id", "revision", "content_hash",
                      "identity_hash", "source_id", "source_hash", "known_at", "review_until")}
    expected_result["review_basis"] = document["review_basis"]
    _assert(body["result"] == expected_result and not isinstance(body["result"]["revision"], bool))
    # The exact reviewed command is checked independently of its retained result.
    command = body["input"]
    _assert(isinstance(command, dict) and _identifier(command.get("idempotency_key")))
    expected_input = {"portfolio_id": portfolio_id, "listing_id": listing_id,
                      "expected_review_revision": row["revision"] - 1,
                      "expected_identity_hash": row["identity_hash"],
                      "source_id": row["source_id"], "source_hash": row["source_hash"],
                      "facts": facts, "review_until": row["review_until"], "reason": row["reason"],
                      "acknowledgement": True, "idempotency_key": command["idempotency_key"]}
    _assert(command == expected_input and command.get("acknowledgement") is True
            and not isinstance(command.get("expected_review_revision"), bool))
    return document, source, source_audit, audit


def verify_listing_review(connection, portfolio_id, listing_id, known_at, *, now=None, require_current=False):
    """Return eligibility evidence, not an investment, account or market-data permission."""
    if not _identifier(portfolio_id) or not _identifier(listing_id):
        raise WorkbenchError("LISTING_REVIEW_INVALID_QUERY")
    try:
        knowledge, checked = _utc(known_at), _utc(now) if isinstance(now, str) else instant(now)
        _assert(knowledge <= checked)
    except (ValueError, TypeError):
        raise WorkbenchError("LISTING_REVIEW_INVALID_CLOCK") from None
    try:
        _assert(type(require_current) is bool)
        with transaction(connection, immediate=False):
            if connection.execute("SELECT 1 FROM portfolios WHERE id=?", (portfolio_id,)).fetchone() is None:
                raise WorkbenchError("LISTING_REVIEW_PORTFOLIO_NOT_FOUND")
            entry = connection.execute("SELECT created_at FROM catalog_entries WHERE portfolio_id=? AND listing_id=?",
                                       (portfolio_id, listing_id)).fetchone()
            if entry is None:
                raise WorkbenchError("LISTING_REVIEW_OUT_OF_SCOPE")
            listing = connection.execute("SELECT id AS listing_id,instrument_id,market,exchange,ticker,currency,created_at FROM listings WHERE id=?",
                                         (listing_id,)).fetchone()
            _assert(listing is not None)
            identity = {key: listing[key] for key in ("listing_id", "instrument_id", "market", "exchange", "ticker", "currency")}
            validate_contract(identity, "listing-review.schema.json", fragment="$defs/identity")
            _assert(_text(identity["ticker"], 40) and _text(identity["exchange"], 40))
            result = {"portfolio_id": portfolio_id, "listing_id": listing_id, "knowledge_at": stamp(knowledge),
                      "checked_at": stamp(checked), "quality": "blocked", "issues": [], "row": None,
                      "document": None, "source": None, "identity": identity, "proof_hash": None}
            latest = connection.execute("SELECT * FROM listing_review_versions WHERE portfolio_id=? AND listing_id=? ORDER BY revision DESC LIMIT 1",
                                        (portfolio_id, listing_id)).fetchone()
            head = connection.execute("SELECT * FROM listing_review_heads WHERE portfolio_id=? AND listing_id=?",
                                      (portfolio_id, listing_id)).fetchone()
            if latest is None:
                _assert(head is None)
            else:
                _assert(head is not None and dict(head) == {"portfolio_id": portfolio_id, "listing_id": listing_id,
                        "revision": latest["revision"], "version_id": latest["id"], "updated_at": latest["known_at"]})
            selected = connection.execute("""SELECT * FROM listing_review_versions WHERE portfolio_id=? AND listing_id=?
                AND known_at<=? ORDER BY revision DESC LIMIT 1""", (portfolio_id, listing_id, stamp(knowledge))).fetchone()
            if selected is None:
                result["issues"] = ["LISTING_REVIEW_MISSING"]
                return result
            row = dict(selected)
            _assert(_stored_instant(entry["created_at"]) <= _utc(row["known_at"])
                    and _stored_instant(listing["created_at"]) <= _utc(row["known_at"]))
            document, source, source_audit, audit = _review(connection, row, portfolio_id, listing_id)
            virtual_head = {"portfolio_id": portfolio_id, "listing_id": listing_id, "revision": row["revision"],
                            "version_id": row["id"], "updated_at": row["known_at"]}
            result.update(row=row, document=document, source=source, proof_hash=content_hash({
                "version_hash": content_hash(row), "source_row_hash": content_hash(source),
                "source_audit_hash": content_hash(source_audit), "review_audit_hash": content_hash(audit),
                "head_hash": content_hash(virtual_head)}))
            issues, facts = [], document["facts"]
            if checked >= _utc(row["review_until"]):
                issues.append("LISTING_REVIEW_EXPIRED")
            if identity != document["identity_snapshot"]:
                issues.append("LISTING_REVIEW_IDENTITY_CHANGED")
            if facts["instrument_kind"] != "ETF":
                issues.append("LISTING_REVIEW_NOT_ETF")
            if facts["lifecycle_status"] != "active":
                issues.append("LISTING_REVIEW_NOT_ACTIVE")
            structure = facts["product_structure"]
            if structure["leverage"] == "leveraged" or structure["direction"] == "inverse":
                issues.append("LISTING_REVIEW_PRODUCT_NOT_SUPPORTED")
            elif "unknown" in structure.values():
                issues.append("LISTING_REVIEW_PRODUCT_STRUCTURE_UNKNOWN")
            if any(facts[key] is None for key in ("quantity_step", "price_step")):
                issues.append("LISTING_REVIEW_TRADING_UNITS_MISSING")
            if any(value is None for value in facts["risk_classification"].values()):
                issues.append("LISTING_REVIEW_RISK_CLASSIFICATION_MISSING")
            if require_current and row["id"] != latest["id"]:
                issues.append("LISTING_REVIEW_SUPERSEDED")
            result.update(issues=sorted(issues), quality="blocked" if issues else "complete")
            return result
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, UnicodeError, RecursionError) as error:
        if isinstance(error, WorkbenchError) and str(error) in {"LISTING_REVIEW_OUT_OF_SCOPE", "LISTING_REVIEW_PORTFOLIO_NOT_FOUND"}:
            raise
        raise WorkbenchError(_ERROR) from None
