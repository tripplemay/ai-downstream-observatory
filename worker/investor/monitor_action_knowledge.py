"""Audited action availability for a distinct monitor-only, non-PIT protocol."""

import re

from worker.accounting import fact_decimal
from worker.market.contracts import validate_contract
from worker.orchestration.db import content_hash, instant
from worker.research.snapshot import validate_dataset
from .data_evidence import _assert, resolve_review
from .precision import validate_time_precision


SNAPSHOT = "investor-monitor-source-snapshot-v2"
DATASET = "investor-monitor-source-dataset-v1"


def _instant(value):
    _assert(type(value) is str and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value),
        "INVESTOR_MONITOR_ACTION_KNOWLEDGE_PRECISION")
    return instant(value)


def _availability_refs(db, workspace, resolved_reviews, checked, frozen):
    """Internal builder input must be normal resolver results, not caller objects."""
    from . import managed_actions as managed
    result = []
    for review in resolved_reviews:
        origin = review
        if review["review"]["id"].startswith(managed.PREFIX):
            publication, _ = managed._publication_header(db, workspace, review["review"]["id"], checked)
            _, policy, _ = managed._authority(db, workspace, publication["authority_id"], checked)
            origin = resolve_review(db, workspace, policy["base_review_id"], "actions", now=checked)
            _assert(origin["review"]["content_hash"] == policy["base_review_hash"]
                and origin["facts"]["events"] == review["facts"]["events"]
                and origin["facts"]["listing_id"] == review["facts"]["listing_id"]
                and origin["facts"]["tax_assumption"] == review["facts"]["tax_assumption"], "INVESTOR_MONITOR_ACTION_ORIGIN_CHANGED")
        known = origin["review"]["created_at"]
        _assert(_instant(known) <= _instant(review["review"]["created_at"]) <= _instant(frozen),
            "INVESTOR_MONITOR_ACTION_KNOWLEDGE_AFTER_SNAPSHOT")
        for event in review["facts"]["events"]:
            result.append({"review_id": review["review"]["id"], "review_hash": review["review"]["content_hash"],
                "event_id": event["id"], "event_hash": content_hash(event), "original_review_id": origin["review"]["id"],
                "original_review_hash": origin["review"]["content_hash"], "known_at": known})
    _assert(len(result) <= 10000, "INVESTOR_MONITOR_ACTION_KNOWLEDGE_LIMIT")
    result.sort(key=lambda row: (row["review_id"], row["event_id"]))
    index_availability(resolved_reviews, result, frozen)
    return result


def index_availability(resolved_reviews, refs, frozen):
    """Structural binding only; the source builder independently derives origins."""
    _assert(type(refs) is list and len(refs) <= 10000)
    indexed = {}
    for ref in refs:
        validate_contract(ref, "investor-monitor-source-snapshot-v2.schema.json", fragment="$defs/action_availability")
        key = ref["review_id"], ref["event_id"]
        _assert(key not in indexed, "INVESTOR_MONITOR_ACTION_KNOWLEDGE_DUPLICATE")
        indexed[key] = ref
    expected = {}
    for value in resolved_reviews:
        for event in value["facts"]["events"]:
            key = value["review"]["id"], event["id"]
            _assert(key not in expected, "INVESTOR_MONITOR_ACTION_KNOWLEDGE_DUPLICATE")
            ref = indexed.get(key)
            _assert(ref is not None and ref["review_hash"] == value["review"]["content_hash"] and ref["event_hash"] == content_hash(event),
                "INVESTOR_MONITOR_ACTION_KNOWLEDGE_BINDING")
            _assert(_instant(event["published_at"]) <= _instant(ref["known_at"]) <= _instant(value["review"]["created_at"]) <= _instant(frozen),
                "INVESTOR_MONITOR_ACTION_KNOWLEDGE_AFTER_SNAPSHOT")
            expected[key] = ref
    _assert(set(expected) == set(indexed), "INVESTOR_MONITOR_ACTION_KNOWLEDGE_SCOPE")
    return indexed


def validate_monitor_source_dataset(dataset):
    validate_contract(dataset, "investor-monitor-source-dataset.schema.json")
    validate_time_precision(dataset)
    # Reuse price/calendar checks on explicitly INCOMPLETE market-only facts.
    # This local object is never returned, admitted or claimed to be research.
    market = {key: dataset[key] for key in ("mode", "source_evidence", "license_scope", "historical_archive_verified",
        "assets", "sessions", "settlements", "observations", "publication_refs")}
    market.update(schema_version="research-dataset-v2", corporate_actions_complete=False, actions=[])
    validate_dataset(market)
    assets, ids = {row["listing_id"]: row for row in dataset["assets"]}, set()
    for entry in dataset["reviewed_actions"]:
        event, ref = entry["fact"], entry["availability"]
        _assert(event["id"] not in ids and event["listing_id"] in assets, "INVESTOR_MONITOR_ACTION_IDENTITY")
        ids.add(event["id"])
        _assert(ref["event_id"] == event["id"] and ref["event_hash"] == content_hash(event), "INVESTOR_MONITOR_ACTION_KNOWLEDGE_BINDING")
        _assert(_instant(event["published_at"]) <= _instant(ref["known_at"]) <= _instant(dataset["created_at"]),
            "INVESTOR_MONITOR_ACTION_KNOWLEDGE_AFTER_SNAPSHOT")
        common = {"id", "listing_id", "type", "at", "published_at", "ingested_at", "source_evidence"}
        if event["type"] == "split":
            _assert(set(event) <= common | {"ratio"} and fact_decimal(event["ratio"]) > 0, "INVALID_RESEARCH_SPLIT")
        else:
            _assert(set(event) <= common | {"gross_per_unit", "tax_per_unit", "pay_at"}, "INVALID_RESEARCH_DIVIDEND")
            gross, tax = fact_decimal(event["gross_per_unit"]), fact_decimal(event["tax_per_unit"])
            _assert(0 <= tax <= gross and _instant(event["pay_at"]) >= _instant(event["at"]), "INVALID_RESEARCH_DIVIDEND")
        if "ingested_at" in event:
            _assert(_instant(event["ingested_at"]) <= _instant(ref["known_at"]), "INVESTOR_MONITOR_ACTION_KNOWLEDGE_AFTER_SNAPSHOT")
