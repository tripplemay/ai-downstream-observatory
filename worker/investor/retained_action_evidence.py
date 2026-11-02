"""Original action evidence for private comparison, never current-source admission."""

from zoneinfo import ZoneInfo
from worker.market.providers.longport import _MARKETS
from worker.market.contracts import validate_contract
from worker.orchestration.db import content_hash, instant, transaction
from .data_evidence import _assert, _fact_validation_scope, _owner, resolve_review, review_header, validate_facts
from .model_runtime import _clock
from .no_new_actions import check_no_new_action_extension
from .reviewed_actions import _fact_events


SCHEMA = "investor-retained-action-evidence.schema.json"


def _check(value):
    _assert(value, "INVESTOR_RETAINED_ACTION_EVIDENCE_INVALID")


def _manual(db, workspace, identifier, at, *, market="US"):
    original = review_header(db, workspace, identifier, now=at)
    _check(original["source"]["kind"] == "actions" and original["review"]["decision"] == "approved"
        and at < original["review"]["valid_until"])
    rows = db.execute("SELECT id,version FROM investor_data_reviews WHERE source_id=? AND version>=? ORDER BY version LIMIT 1001",
        (original["source"]["id"], original["review"]["version"])).fetchall()
    _check(0 < len(rows) <= 1000)
    previous = original["review"]["created_at"]
    for version, row in enumerate(rows, original["review"]["version"]):
        value = review_header(db, workspace, row["id"], now=at)
        _check(row["version"] == version and value["review"]["decision"] == "approved"
            and previous <= value["review"]["created_at"]
            and value["facts"]["listing_id"] == original["facts"]["listing_id"])
        validate_facts("actions", value["facts"]); _fact_events(value["facts"], zone=ZoneInfo(_MARKETS[market][0]))
        _check(len({event["id"] for event in value["facts"]["events"]}) == len(value["facts"]["events"]))
        previous = value["review"]["created_at"]
    _check(at < value["review"]["valid_until"])
    return original, value


def _managed(db, workspace, identifier, at):
    from . import managed_actions as managed
    row, doc = managed._publication_header(db, workspace, identifier, at)
    authority, policy, _ = managed._authority(db, workspace, row["authority_id"], at)
    _check(row["status"] == "published" and row["created_at"] < row["valid_until"] and at < row["valid_until"])
    base, latest = _manual(db, workspace, policy["base_review_id"], at)
    listing = resolve_review(db, workspace, policy["listing_review_id"], "listing", now=at)
    asset = listing["facts"]
    _check(base["review"]["content_hash"] == policy["base_review_hash"]
        and listing["review"]["content_hash"] == policy["listing_review_hash"]
        and base["facts"]["listing_id"] == asset["listing_id"] == policy["listing_id"]
        and asset["provider_symbol"] == policy["provider_symbol"] and asset["market"] == "US" and asset["currency"] == "USD"
        and instant(asset["tradable_from"]) <= instant(at) and (asset["tradable_until"] is None or instant(at) < instant(asset["tradable_until"]))
        and base["review"]["created_at"] <= authority["created_at"] and listing["review"]["created_at"] <= authority["created_at"])
    anchor, anchor_report, anchor_limits = managed._captures(db, workspace, authority["actor_id"], policy["listing_review_id"], policy["anchor_captures"], at)
    current, report, limits = managed._captures(db, workspace, authority["actor_id"], policy["listing_review_id"], doc["capture_refs"], at)
    _check(all(value["capture"]["created_at"] <= authority["created_at"] for value in anchor.values())
        and all(value["capture"]["created_at"] <= row["created_at"] for value in current.values()))
    snapshots = {key: value["draft"] for key, value in anchor.items()}
    check_no_new_action_extension(base["facts"], snapshots, snapshots, symbol=policy["provider_symbol"], listing_id=policy["listing_id"])
    anchor_hash = content_hash({"base_review_hash": base["review"]["content_hash"], "listing_review_hash": listing["review"]["content_hash"], "bindings": anchor_report["bindings"]})
    _check(anchor_hash == policy["anchor_binding_hash"] and all(report["bindings"][key][field] == anchor_report["bindings"][key][field]
        for key in report["bindings"] for field in ("authority_id", "authority_hash", "control_id", "control_hash")))
    candidate = check_no_new_action_extension(base["facts"], snapshots, {key: value["draft"] for key, value in current.items()},
        symbol=policy["provider_symbol"], listing_id=policy["listing_id"])
    anchor_limits += [instant(base["review"]["valid_until"]), instant(listing["review"]["valid_until"])]
    if asset["tradable_until"] is not None: anchor_limits.append(instant(asset["tradable_until"]))
    expiry = _clock(min([instant(policy["valid_until"]), *anchor_limits, *limits]))
    _check(report["source_day"] == row["source_day"] and expiry == row["valid_until"]
        and candidate["candidate_range_end"] == row["coverage_end"] and candidate["candidate_facts_hash"] == doc["candidate_facts_hash"]
        and content_hash({"authority_input": policy, "anchor_binding_hash": anchor_hash,
            "current_bindings": report["bindings"], "candidate": candidate}) == doc["checked_input_hash"])
    value = managed.managed_review_header(db, workspace, identifier, at)
    bindings = [{"slot": prefix + "_" + key, **binding} for prefix, source in (("anchor", anchor_report), ("publication", report))
        for key, binding in source["bindings"].items()]
    return value, latest, row, authority, sorted(bindings, key=lambda item: item["slot"])


def read_retained_action_evidence(db, workspace, actor, review_id, *, now=None, listing_review_id=None):
    """Read actual retained originals; never alter normal currentness or approval."""
    from .managed_actions import PREFIX
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor)
        _check(type(review_id) is str and 0 < len(review_id) <= 300)
        listing = resolve_review(db, workspace, listing_review_id, "listing", now=at) if listing_review_id is not None else None
        if review_id.startswith(PREFIX):
            if listing is not None: _check(listing["facts"]["market"] == "US")
            original, latest, publication, authority, bindings = _managed(db, workspace, review_id, at)
        else:
            original, latest = _manual(db, workspace, review_id, at, market=listing["facts"]["market"] if listing is not None else "US")
            publication, authority, bindings = None, None, []
        if listing is not None: _check(listing["facts"]["listing_id"] == original["facts"]["listing_id"])
        review, source = original["review"], original["source"]
        proof = {"schema_version": "investor-retained-action-evidence-v1", "workspace_id": workspace, "actor_id": actor,
            "review_id": review["id"], "review_hash": review["content_hash"], "source_id": source["id"], "source_hash": source["content_hash"],
            "facts_hash": content_hash(original["facts"]), "latest_manual_review_id": latest["review"]["id"],
            "latest_manual_review_hash": latest["review"]["content_hash"],
            "publication_id": publication["id"] if publication is not None else None,
            "publication_hash": publication["content_hash"] if publication is not None else None,
            "authority_id": authority["id"] if authority is not None else None,
            "authority_hash": authority["content_hash"] if authority is not None else None,
            "capture_bindings": bindings, "checked_at": at, "valid_until": min(review["valid_until"], latest["review"]["valid_until"]),
            "purpose": "retained_historical_comparison_only", "evidence_basis": "standing_rule_original_capture_replay" if bindings else "owner_review_record_only",
            "original_raw_reports_replayed": bool(bindings), "current_source_eligibility_restored": False, "economic_correction_approved": False,
            "checkpoint_created": False, "monitoring_resumed": False, "historical_observations_rewritten": False,
            "trading_permission": False, "provider_calls": 0, "database_writes": 0, "distribution": "private_owner_only_not_ai"}
        if listing is not None: proof["valid_until"] = min(proof["valid_until"], listing["review"]["valid_until"])
        validate_contract(proof, SCHEMA)
        return {"original_review": review, "original_source": source, "original_facts": original["facts"], "proof": proof}
