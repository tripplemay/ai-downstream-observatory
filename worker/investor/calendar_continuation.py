"""Explicit calendar-prefix continuity; no licence, expiry or collection renewal."""

from worker.market.contracts import validate_contract
from worker.orchestration.db import canonical_json, content_hash, new_id, transaction
from .data_evidence import _assert, _audit, _audit_binding, _object, _owner, resolve_review
from .runtime import _milliseconds


MAX_CONTINUATIONS = 16
SCHEMA = "investor-calendar-continuation.schema.json"


def _canonical_dates(value):
    for field in ("created_at", "valid_until"):
        _assert(_milliseconds(value["review"][field]) == value["review"][field])
    _assert(_milliseconds(value["source"]["created_at"]) == value["source"]["created_at"])


def check_extension(previous, facts):
    old = previous["facts"]
    _assert(facts["market"] == old["market"] and facts["range_start"] == old["range_start"]
        and facts["range_end"] > old["range_end"] and len(facts["days"]) > len(old["days"])
        and facts["days"][:len(old["days"])] == old["days"], "INVESTOR_CALENDAR_PREFIX_CHANGED")
    return content_hash(old)


def check_registration_depth(db, workspace, review_id):
    for unused in range(MAX_CONTINUATIONS):
        row = db.execute("SELECT previous_review_id FROM investor_calendar_continuations WHERE workspace_id=? AND new_review_id=?", (workspace, review_id)).fetchone()
        if row is None:
            return
        review_id = row[0]
    _assert(False, "INVESTOR_CALENDAR_CONTINUATION_LIMIT")


def register_continuation(db, workspace, actor, previous_id, new_id_value, at):
    _assert(db.in_transaction)
    with transaction(db):
        return _register_continuation(db, workspace, actor, previous_id, new_id_value, at)


def _register_continuation(db, workspace, actor, previous_id, new_id_value, at):
    _assert(db.in_transaction)
    _owner(db, workspace, actor)
    previous = resolve_review(db, workspace, previous_id, "calendar", now=at, require_current=False)
    current = resolve_review(db, workspace, new_id_value, "calendar", now=at, require_current=False)
    _canonical_dates(previous); _canonical_dates(current)
    _assert(previous["source"] == current["source"] and current["review"]["version"] == previous["review"]["version"] + 1
        and current["review"]["created_at"] == at)
    _assert(db.execute("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (current["source"]["id"],)).fetchone()[0] == new_id_value)
    document = {"schema_version": "investor-calendar-continuation-v1", "workspace_id": workspace,
        "source_id": current["source"]["id"], "source_hash": current["source"]["content_hash"],
        "previous_review_id": previous_id, "previous_review_hash": previous["review"]["content_hash"],
        "new_review_id": new_id_value, "new_review_hash": current["review"]["content_hash"], "market": current["facts"]["market"],
        "previous_facts_hash": check_extension(previous, current["facts"]), "previous_range_end": previous["facts"]["range_end"],
        "extended_range_end": current["facts"]["range_end"], "created_at": at,
        "approval_basis": "owner_reviewed_unchanged_calendar_prefix", "scope": "historical_prefix_only_not_source_renewal",
        "collection_permission": False, "trading_permission": False}
    validate_contract(document, SCHEMA)
    identity, digest = new_id("investor-calendar-continuation"), content_hash(document)
    audit = _audit(db, actor, "investor_continue_calendar_review", "investor_calendar_continuation", identity, {"content_hash": digest}, at)
    db.execute("INSERT INTO investor_calendar_continuations(id,workspace_id,source_id,previous_review_id,new_review_id,document_json,content_hash,actor_id,created_at,audit_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (identity, workspace, current["source"]["id"], previous_id, new_id_value, canonical_json(document), digest, actor, at, audit))
    return identity


def current_calendar_review(db, workspace, review_id, at):
    value = resolve_review(db, workspace, review_id, "calendar", now=at, require_current=False)
    _canonical_dates(value)
    latest = db.execute("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (value["source"]["id"],)).fetchone()[0]
    for unused in range(MAX_CONTINUATIONS + 1):
        if value["review"]["id"] == latest:
            return value
        _assert(unused < MAX_CONTINUATIONS, "INVESTOR_CALENDAR_CONTINUATION_LIMIT")
        row = db.execute("SELECT * FROM investor_calendar_continuations WHERE workspace_id=? AND previous_review_id=?",
            (workspace, value["review"]["id"])).fetchone()
        _assert(row is not None, "INVESTOR_DATA_REVIEW_SUPERSEDED")
        _owner(db, workspace, row["actor_id"])
        _audit_binding(db, row, "investor_continue_calendar_review", "investor_calendar_continuation", row["id"])
        document = _object(row["document_json"])
        validate_contract(document, SCHEMA)
        _assert(content_hash(document) == row["content_hash"] and document["workspace_id"] == workspace
            and document["source_id"] == row["source_id"] == value["source"]["id"]
            and document["source_hash"] == value["source"]["content_hash"]
            and document["previous_review_id"] == row["previous_review_id"] == value["review"]["id"]
            and document["previous_review_hash"] == value["review"]["content_hash"]
            and document["new_review_id"] == row["new_review_id"] and document["created_at"] == row["created_at"] <= at)
        # Intermediate reviews are historical equality witnesses, not current
        # data grants. Origin and final head must still be valid at use time.
        read_at = at if row["new_review_id"] == latest else row["created_at"]
        following = resolve_review(db, workspace, row["new_review_id"], "calendar", now=read_at, require_current=False)
        _canonical_dates(following)
        _assert(following["source"] == value["source"] and following["review"]["version"] == value["review"]["version"] + 1
            and following["review"]["created_at"] == row["created_at"] >= value["review"]["created_at"]
            and row["created_at"] < value["review"]["valid_until"]
            and document["new_review_hash"] == following["review"]["content_hash"]
            and document["market"] == following["facts"]["market"]
            and document["previous_facts_hash"] == check_extension(value, following["facts"])
            and document["previous_range_end"] == value["facts"]["range_end"]
            and document["extended_range_end"] == following["facts"]["range_end"])
        value = following
    raise AssertionError("UNREACHABLE_CALENDAR_CONTINUATION")


def is_continued_calendar(db, workspace, review_id, at):
    from worker.orchestration.db import WorkbenchError
    try:
        current_calendar_review(db, workspace, review_id, at)
        return True
    except WorkbenchError:
        return False


def assert_collection_calendar(db, value):
    latest = db.execute("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (value["source"]["id"],)).fetchone()
    _assert(latest is not None and latest[0] == value["review"]["id"], "INVESTOR_CALENDAR_COLLECTION_REVIEW_SUPERSEDED")
