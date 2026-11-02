"""Retained explicit action knowledge, never a current-source or consent grant."""

from worker.orchestration.db import content_hash, instant, transaction
from . import managed_actions as managed
from .data_evidence import _assert, _fact_validation_scope, _owner, resolve_review
from .retained_action_evidence import _manual, _managed
from .no_new_actions import check_no_new_action_extension
from .monitor_action_knowledge import index_availability


def _check(value):
    _assert(value, "INVESTOR_RETAINED_ACTION_LINEAGE_INVALID")


def _anchor(db, workspace, actor, identifier, at):
    _owner(db, workspace, actor)
    authority, policy, control = managed._authority(db, workspace, identifier, at)
    base, latest = _manual(db, workspace, policy["base_review_id"], at)
    listing = resolve_review(db, workspace, policy["listing_review_id"], "listing", now=at)
    asset = listing["facts"]
    _check(authority["actor_id"] == actor and base["review"]["content_hash"] == policy["base_review_hash"]
        and listing["review"]["content_hash"] == policy["listing_review_hash"]
        and base["facts"]["listing_id"] == asset["listing_id"] == policy["listing_id"]
        and asset["provider_symbol"] == policy["provider_symbol"] and asset["market"] == "US" and asset["currency"] == "USD"
        and instant(asset["tradable_from"]) <= instant(at) and (asset["tradable_until"] is None or instant(at) < instant(asset["tradable_until"]))
        and base["review"]["created_at"] <= authority["created_at"] and listing["review"]["created_at"] <= authority["created_at"])
    values, report, limits = managed._captures(db, workspace, actor, policy["listing_review_id"], policy["anchor_captures"], at)
    _check(all(value["capture"]["created_at"] <= authority["created_at"] for value in values.values()))
    snapshots = {key: value["draft"] for key, value in values.items()}
    candidate = check_no_new_action_extension(base["facts"], snapshots, snapshots, symbol=policy["provider_symbol"], listing_id=policy["listing_id"])
    binding = content_hash({"base_review_hash": base["review"]["content_hash"], "listing_review_hash": listing["review"]["content_hash"], "bindings": report["bindings"]})
    _check(binding == policy["anchor_binding_hash"])
    limits += [instant(base["review"]["valid_until"]), instant(listing["review"]["valid_until"])]
    if asset["tradable_until"] is not None: limits.append(instant(asset["tradable_until"]))
    _check(instant(policy["valid_until"]) <= min(limits))
    return {"authority": authority, "policy": policy, "control": control, "base": base, "latest": latest, "listing": listing,
        "values": values, "report": report, "binding_hash": binding, "snapshots": snapshots, "candidate": candidate, "limits": limits,
        "read_valid_until": min(policy["valid_until"], latest["review"]["valid_until"])}


def _confirmation(db, workspace, actor, identifier, at):
    from .action_review_workflow import _confirmation_header, _compare_confirmation_facts
    _, doc = _confirmation_header(db, workspace, actor, identifier)
    _check(doc["created_at"] <= at)
    before = _anchor(db, workspace, actor, doc["previous_authority_id"], at)
    after = _anchor(db, workspace, actor, doc["new_authority_id"], at)
    old, policy, current_old = before["authority"], before["policy"], before["control"]
    new, next_policy = after["authority"], after["policy"]
    _check(old["content_hash"] == doc["previous_authority_hash"] and new["content_hash"] == doc["new_authority_hash"]
        and current_old["enabled"] == 0 and next_policy["base_review_id"] == doc["new_review_id"]
        and all(policy[key] == next_policy[key] for key in ("listing_id", "provider_symbol", "listing_review_id", "listing_review_hash")))
    previous_control = db.execute("SELECT * FROM investor_action_controls WHERE id=? AND workspace_id=?", (doc["previous_control_id"], workspace)).fetchone()
    retired = db.execute("SELECT * FROM investor_action_controls WHERE id=? AND workspace_id=?", (doc["retired_control_id"], workspace)).fetchone()
    initial = db.execute("SELECT * FROM investor_action_controls WHERE authority_id=? AND version=1", (new["id"],)).fetchone()
    selected = db.execute("SELECT * FROM investor_action_controls WHERE id=? AND workspace_id=?", (doc["new_control_id"], workspace)).fetchone()
    _check(all(value is not None for value in (previous_control, retired, initial, selected)))
    for authority, control in ((old, previous_control), (old, retired), (new, initial), (new, selected)):
        managed._control(db, authority, control, at)
    _check(previous_control["content_hash"] == doc["previous_control_hash"] and retired["content_hash"] == doc["retired_control_hash"]
        and retired["enabled"] == 0 and retired["version"] == previous_control["version"] + int(bool(previous_control["enabled"]))
        and previous_control["created_at"] <= retired["created_at"] <= doc["created_at"]
        and initial["enabled"] == 0 and initial["created_at"] == selected["created_at"] == new["created_at"] == doc["created_at"]
        and selected["content_hash"] == doc["new_control_hash"] and selected["enabled"] == int(doc["request"]["enable_rule"])
        and selected["version"] == (2 if doc["request"]["enable_rule"] else 1))
    _check(after["base"]["review"]["content_hash"] == doc["new_review_hash"]
        and after["base"]["review"]["created_at"] == after["base"]["source"]["created_at"] == doc["created_at"]
        and after["base"]["source"]["id"] != before["base"]["source"]["id"]
        and all(before["report"]["bindings"][kind][key] == after["report"]["bindings"][kind][key]
            for kind in before["report"]["bindings"] for key in ("authority_id", "authority_hash", "control_id", "control_hash")))
    head = db.execute("SELECT id FROM investor_action_publications WHERE authority_id=? AND workspace_id=? AND status='published' AND created_at<=? ORDER BY sequence DESC LIMIT 1",
        (old["id"], workspace, doc["created_at"])).fetchone()
    publication_id = head[0] if head else None
    _check(publication_id == doc["previous_publication_id"])
    prior, previous, limits = before["base"], before["snapshots"], before["limits"]
    if publication_id is not None:
        prior, *_ = _managed(db, workspace, publication_id, at)
        row, published = managed._publication_header(db, workspace, publication_id, at)
        values, _, limits = managed._captures(db, workspace, actor, policy["listing_review_id"], published["capture_refs"], at)
        _check(row["authority_id"] == old["id"] and row["created_at"] <= doc["created_at"])
        previous = {key: value["draft"] for key, value in values.items()}
    from . import unchanged_action_recovery as recovery
    result = _compare_confirmation_facts(workspace, actor, doc, old, policy, next_policy, previous_control,
        before, after, prior, previous, publication_id, limits,
        recovery_failure=recovery.failure_witness(db, workspace, old["id"], at) if recovery.is_recovery(doc) else None)
    return (*result, min(before["read_valid_until"], after["read_valid_until"], prior["review"]["valid_until"]))


def _origins(db, workspace, actor, review, at, seen, market):
    _check(len(seen) < 256 and review["review"]["id"] not in seen)
    seen = seen | {review["review"]["id"]}
    row = db.execute("SELECT id FROM investor_action_review_confirmations WHERE workspace_id=? AND new_review_id=?", (workspace, review["review"]["id"])).fetchone()
    if row is None:
        original, latest = _manual(db, workspace, review["review"]["id"], at, market=market); _check(original == review)
        return {event["id"]: {"original_review_id": review["review"]["id"], "original_review_hash": review["review"]["content_hash"],
            "known_at": review["review"]["created_at"]} for event in review["facts"]["events"]}, {review["review"]["id"]: review["review"]["content_hash"]}, min(review["review"]["valid_until"], latest["review"]["valid_until"])
    _check(market == "US")
    doc, predecessor, current, deadline = _confirmation(db, workspace, actor, row["id"], at)
    _check(current == review)
    origins, ancestors, previous_deadline = _origins(db, workspace, actor, predecessor, at, seen, market)
    for event in current["facts"]["events"]:
        if event["id"] not in origins:
            origins[event["id"]] = {"original_review_id": current["review"]["id"], "original_review_hash": current["review"]["content_hash"], "known_at": doc["created_at"]}
    _check(set(origins) == {event["id"] for event in current["facts"]["events"]})
    ancestors[current["review"]["id"]] = current["review"]["content_hash"]
    return origins, ancestors, min(deadline, previous_deadline)


def retained_action_knowledge(db, workspace, actor, reviews, at, frozen, listing_review_ids=None):
    """Derive original event times from retained sources and actual owner answers."""
    _owner(db, workspace, actor)
    with transaction(db, immediate=False), _fact_validation_scope():
        result, ancestry, deadlines = [], {}, []
        for review in reviews:
            listing_id = review["facts"]["listing_id"]
            listing = resolve_review(db, workspace, listing_review_ids[listing_id], "listing", now=at) if listing_review_ids is not None else None
            if listing is not None: _check(listing["facts"]["listing_id"] == listing_id)
            market = listing["facts"]["market"] if listing is not None else "US"
            origin = review
            if review["review"]["id"].startswith(managed.PREFIX):
                row, _ = managed._publication_header(db, workspace, review["review"]["id"], at)
                origin = _anchor(db, workspace, actor, row["authority_id"], at)["base"]
                _check(origin["facts"]["events"] == review["facts"]["events"]
                    and origin["facts"]["listing_id"] == review["facts"]["listing_id"] and origin["facts"]["tax_assumption"] == review["facts"]["tax_assumption"])
            origins, ancestors, deadline = _origins(db, workspace, actor, origin, at, set(), market); deadlines.append(deadline)
            if listing is not None: deadlines.append(listing["review"]["valid_until"])
            ancestry[review["review"]["id"]] = ancestors
            for event in review["facts"]["events"]:
                result.append({"review_id": review["review"]["id"], "review_hash": review["review"]["content_hash"],
                    "event_id": event["id"], "event_hash": content_hash(event), **origins[event["id"]]})
        _check(len(result) <= 10000)
        result.sort(key=lambda row: (row["review_id"], row["event_id"]))
        index_availability(reviews, result, frozen)
        return result, ancestry, min(deadlines) if deadlines else None
