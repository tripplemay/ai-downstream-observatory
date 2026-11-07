"""Verified successor scope; never infer succession from dates or equal facts."""

from .reviewed_actions import _check


MAX_LINKS = 256


def checkpoint_review_needs_replay(db, workspace, identifier, at):
    from . import managed_actions as managed
    return retired_action_review(db, workspace, identifier, at) or identifier.startswith(managed.PREFIX) \
        and managed.managed_review_unavailable(db, workspace, identifier, at) == "REFERENCE_SOURCE_NO_LONGER_CURRENT"


def check_paused_checkpoint_extension(db, workspace, previous, current, at, *, start_date, end_date):
    from . import managed_actions as managed
    from .reviewed_actions import read_historical_action_review
    _check(previous["review"]["id"].startswith(managed.PREFIX), "AUTHORITY_REVIEW_REQUIRED")
    original = read_historical_action_review(db, workspace, previous["review"]["id"], at)
    _check(original == previous, "CONFIRMATION_INPUTS_CHANGED")
    expected = managed.paused_control_successor(db, workspace, previous["review"]["id"], at)
    selected = [value for value in managed.current_action_reviews(db, workspace, [previous["facts"]["listing_id"]], at)
        if value["facts"]["range_start"] <= start_date <= end_date <= value["facts"]["range_end"]]
    _check(len(selected) == 1 and selected[0] == expected == current, "SUCCESSION_AMBIGUOUS")


def manual_successor_unavailable(db, workspace, identifier, at):
    """Negative metadata gate; current facts still need original-byte replay."""
    from . import action_review_workflow as workflow, managed_actions as managed
    rows = db.execute("SELECT id,actor_id FROM investor_action_review_confirmations WHERE workspace_id=? AND new_review_id=? LIMIT 2", (workspace, identifier)).fetchall()
    _check(len(rows) <= 1, "SUCCESSION_AMBIGUOUS")
    if not rows: return None
    _, doc = workflow._confirmation_header(db, workspace, rows[0]["actor_id"], rows[0]["id"])
    authority, policy, _ = managed._authority(db, workspace, doc["new_authority_id"], at)
    _check(policy["base_review_id"] == identifier and policy["base_review_hash"] == doc["new_review_hash"]
        and authority["content_hash"] == doc["new_authority_hash"], "CONFIRMATION_INPUTS_CHANGED")
    if at >= policy["valid_until"]: return "REFERENCE_SOURCE_EXPIRED"
    if at < policy["valid_from"] or managed._quarantined(db, workspace, authority["id"], at): return "REFERENCE_SOURCE_NO_LONGER_CURRENT"
    for kind, ref in policy["anchor_captures"].items():
        module = managed.issuer_sources if kind == "issuer" else managed.eodhd_sources
        capture, _, request, *_ = module._capture_header(db, workspace, ref["capture_id"], at)
        _check(capture["content_hash"] == ref["capture_hash"] and capture["status"] == "captured" and capture["qualification"] == module.OFFICIAL, "CONFIRMATION_INPUTS_CHANGED")
        grant = module._grant(db, workspace, request["authority_id"], at)
        if at >= capture["retain_until"] or at >= grant[1]["valid_until"]: return "REFERENCE_SOURCE_EXPIRED"
        if module._purge_header(db, workspace, capture["id"], at): return "REFERENCE_SOURCE_PAYLOAD_PURGED"
        active = module._active(grant[1], grant[2], at) if kind == "issuer" else module._active(grant, at)
        if not active or grant[2]["id"] != request["control_id"]: return "REFERENCE_SOURCE_NO_LONGER_CURRENT"
    return None


def retired_action_review(db, workspace, identifier, at):
    """Metadata can deny an old monitor input; it cannot admit replacement facts."""
    from . import action_review_workflow as workflow, managed_actions as managed
    publication = None
    if identifier.startswith(managed.PREFIX):
        publication, _ = managed._publication_header(db, workspace, identifier, at)
        rows = db.execute("SELECT id,actor_id FROM investor_action_review_confirmations WHERE workspace_id=? AND previous_authority_id=? AND created_at<=? LIMIT 2",
            (workspace, publication["authority_id"], at)).fetchall()
    else:
        rows = db.execute("""SELECT c.id,c.actor_id FROM investor_action_review_confirmations c JOIN investor_action_authorities a
          ON a.id=c.previous_authority_id AND a.workspace_id=c.workspace_id WHERE c.workspace_id=? AND a.base_review_id=? AND c.created_at<=? LIMIT 2""",
            (workspace, identifier, at)).fetchall()
    _check(len(rows) <= 1, "SUCCESSION_AMBIGUOUS")
    if not rows: return False
    _, doc = workflow._confirmation_header(db, workspace, rows[0]["actor_id"], rows[0]["id"])
    authority, policy, control = managed._authority(db, workspace, doc["previous_authority_id"], at)
    _check(authority["content_hash"] == doc["previous_authority_hash"] and control["enabled"] == 0
        and (publication is None and policy["base_review_id"] == identifier or publication is not None
            and publication["authority_id"] == authority["id"] and publication["created_at"] <= doc["created_at"]), "CONFIRMATION_INPUTS_CHANGED")
    return True


def verified_action_successions(db, workspace, listing_ids, at):
    from . import action_review_workflow as workflow, managed_actions as managed
    placeholders = ",".join("?" for _ in listing_ids)
    rows = db.execute("""SELECT c.id,c.actor_id FROM investor_action_review_confirmations c
      LEFT JOIN investor_action_authorities before ON before.id=c.previous_authority_id AND before.workspace_id=c.workspace_id
      LEFT JOIN investor_action_authorities after ON after.id=c.new_authority_id AND after.workspace_id=c.workspace_id
      WHERE c.workspace_id=? AND c.created_at<=? AND (before.listing_id IN (""" + placeholders + ") OR after.listing_id IN (" + placeholders + ")) ORDER BY c.created_at,c.id LIMIT ?",
        (workspace, at, *listing_ids, *listing_ids, MAX_LINKS + 1)).fetchall()
    _check(len(rows) <= MAX_LINKS, "SUCCESSION_LIMIT_OR_CYCLE")
    by_new, by_previous, shadowed = {}, {}, set()
    for row in rows:
        doc, before, after = workflow._verified_confirmation(db, workspace, row["actor_id"], row["id"], at)
        _check(doc["new_authority_id"] not in by_new and doc["previous_authority_id"] not in by_previous
            and before["facts"]["listing_id"] == after["facts"]["listing_id"] in listing_ids, "SUCCESSION_AMBIGUOUS")
        entry = {"document": doc, "before": before, "after": after}
        by_new[doc["new_authority_id"]] = entry; by_previous[doc["previous_authority_id"]] = entry
        shadowed.add(before["review"]["id"])
    terminals = {}
    for identifier, entry in by_new.items():
        seen, current = set(), identifier
        while current in by_new:
            _check(current not in seen and len(seen) < MAX_LINKS, "SUCCESSION_LIMIT_OR_CYCLE")
            seen.add(current); current = by_new[current]["document"]["previous_authority_id"]
        if identifier in by_previous: continue
        authority, policy, _ = managed._authority(db, workspace, identifier, at)
        _check(policy["valid_from"] <= at < policy["valid_until"]
            and not managed._quarantined(db, workspace, identifier, at), "SOURCE_UNAVAILABLE")
        _check(entry["after"]["review"]["id"] == policy["base_review_id"]
            and entry["after"]["review"]["content_hash"] == policy["base_review_hash"], "CONFIRMATION_INPUTS_CHANGED")
        terminals[authority["id"]] = entry["after"]
    return {"by_new": by_new, "by_previous": by_previous, "shadowed": shadowed, "terminals": terminals}


def check_action_review_extension(db, workspace, previous, current, at, *, start_date, end_date):
    from . import managed_actions as managed
    from .data_evidence import resolve_review
    from .reviewed_actions import read_historical_action_review
    identity = current["facts"]["listing_id"]
    _check(previous["facts"]["listing_id"] == identity, "IDENTITY_DIFFERS")
    links = verified_action_successions(db, workspace, [identity], at)
    selected = [value for value in managed.current_action_reviews(db, workspace, [identity], at)
        if value["facts"]["range_start"] <= start_date <= end_date <= value["facts"]["range_end"]]
    _check(len(selected) == 1 and selected[0] == current, "SUCCESSION_AMBIGUOUS")
    new_id, old_id = current["review"]["id"], previous["review"]["id"]
    if new_id.startswith(managed.PREFIX):
        current_row, _ = managed._publication_header(db, workspace, new_id, at)
        cursor = current_row["authority_id"]
    else:
        matches = [key for key, value in links["terminals"].items() if value["review"]["id"] == new_id]
        _check(len(matches) == 1, "AUTHORITY_REVIEW_REQUIRED"); cursor = matches[0]
    _check(cursor in links["terminals"], "AUTHORITY_REVIEW_REQUIRED")
    original = read_historical_action_review(db, workspace, old_id, at) if old_id.startswith(managed.PREFIX) else resolve_review(db, workspace, old_id, "actions", now=at)
    _check(original == previous, "CONFIRMATION_INPUTS_CHANGED")
    old_publication = managed._publication_header(db, workspace, old_id, at)[0] if old_id.startswith(managed.PREFIX) else None
    seen = set()
    while cursor in links["by_new"]:
        _check(cursor not in seen and len(seen) < MAX_LINKS, "SUCCESSION_LIMIT_OR_CYCLE"); seen.add(cursor)
        entry = links["by_new"][cursor]; doc = entry["document"]; before = entry["before"]
        if old_publication is None and before["review"]["id"] == old_id:
            _check(before == original, "CONFIRMATION_INPUTS_CHANGED"); return
        if old_publication is not None and old_publication["authority_id"] == doc["previous_authority_id"]:
            _check(doc["previous_publication_id"] is not None, "AUTHORITY_REVIEW_REQUIRED")
            bound, _ = managed._publication_header(db, workspace, doc["previous_publication_id"], at)
            _check(old_publication["created_at"] <= doc["created_at"] and old_publication["sequence"] <= bound["sequence"]
                and original["facts"]["range_end"] <= doc["append_proof"]["previous_coverage_end"]
                and {key: value for key, value in original["facts"].items() if key != "range_end"}
                    == {key: value for key, value in before["facts"].items() if key != "range_end"}, "HISTORICAL_RECORDS_CHANGED")
            return
        cursor = doc["previous_authority_id"]
    _check(False, "AUTHORITY_REVIEW_REQUIRED")
