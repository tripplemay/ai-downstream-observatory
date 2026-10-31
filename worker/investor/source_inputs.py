"""Admit only dereferenced official captures; never persist a caller dataset."""

from worker.market.contracts import validate_contract
from worker.orchestration.db import canonical_json, content_hash, new_id, transaction
from .data_evidence import _assert, _audit, _audit_binding, _fact_validation_scope, _object, _owner, resolve_capture, resolve_review
from .data_snapshot import build_dataset
from .runtime import _milliseconds
from .strategy import research_engine, validate_reference_inputs


QUALIFICATION = "owner_reviewed_reconstructed"
PROFILE = {"schema_version": "investor-profile-v1", "horizon_years": 12, "loss_tolerance": None,
    "liquidity_need": "none_in_horizon", "markets": ["CN", "HK", "US"], "product_scope": "unleveraged_long_only_etfs",
    "research_direction": "system_design", "exclusions": [], "illustrative_budget_cny": None, "planned_annual_contribution_cny": None}


def latest_input(db, workspace_id):
    return db.execute("""SELECT * FROM investor_research_source_heads WHERE workspace_id=?
        ORDER BY created_at DESC,(source_kind='evidence') DESC,source_order DESC LIMIT 1""", (workspace_id,)).fetchone()


def _review_kind(db, workspace_id, review_id):
    row = db.execute("SELECT s.kind FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE r.id=? AND r.workspace_id=? AND s.workspace_id=?",
        (review_id, workspace_id, workspace_id)).fetchone()
    _assert(row is not None, "INVESTOR_DATA_OUT_OF_SCOPE")
    return row[0]


def _snapshot_ids(db, workspace_id, snapshot, kind):
    return [row["review_id"] for row in snapshot["review_refs"] if _review_kind(db, workspace_id, row["review_id"]) == kind]


def enqueue_evidence_request(db, workspace_id, source, now):
    profile = db.execute("SELECT * FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1", (workspace_id,)).fetchone()
    if profile is None:
        return None
    _assert(profile["created_at"] <= now)
    source_value = _object(source["document_json"])
    document = {"schema_version": "investor-research-request-v1", "engine_version": research_engine(source_value["plan"]),
        "profile_hash": profile["content_hash"], "input_hash": source["content_hash"]}
    digest = content_hash(document)
    previous = db.execute("SELECT id,evidence_input_id FROM investor_research_requests WHERE workspace_id=? AND profile_id=? AND input_version=?",
        (workspace_id, profile["id"], digest)).fetchone()
    if previous:
        _assert(previous["evidence_input_id"] == source["id"])
        return previous["id"]
    identifier = new_id("investor-evidence-request")
    db.execute("INSERT INTO investor_research_requests(id,workspace_id,profile_id,input_id,evidence_input_id,input_version,document_json,created_at) VALUES(?,?,?,NULL,?,?,?,?)",
        (identifier, workspace_id, profile["id"], source["id"], digest, canonical_json(document), now))
    return identifier


def admit_evidence_input(db, workspace_id, actor_id, capture_ids, action_review_ids, fx_review_ids, start_date, end_date, plan, policy, *, now=None):
    _owner(db, workspace_id, actor_id)
    created = _milliseconds(now)
    snapshot = build_dataset(db, workspace_id, capture_ids, action_review_ids, fx_review_ids, start_date, end_date, now=created)
    _assert(snapshot["dataset"]["mode"] == "reconstructed", "INVESTOR_DATA_OFFICIAL_CAPTURES_REQUIRED")
    payload = {"dataset": snapshot["dataset"], "plan": plan, "policy": policy}
    validate_reference_inputs(**payload, profile=PROFILE)
    _assert(policy["roles"] == {key: row["role"] for key, row in snapshot["catalog"].items()}, "INVESTOR_DATA_ROLE_BINDING_INVALID")
    document = {"schema_version": "investor-evidence-input-v1", "workspace_id": workspace_id, "source_qualification": QUALIFICATION,
        "snapshot": snapshot["manifest"], "dataset_hash": snapshot["dataset_hash"], "catalog_hash": content_hash(snapshot["catalog"]),
        "plan": plan, "policy": policy, "created_at": created, "valid_until": snapshot["valid_until"], "live_advice_eligible": False}
    validate_contract(document, "investor-evidence-input.schema.json")
    encoded, digest = canonical_json(document), content_hash(document)
    _assert(len(encoded.encode()) <= 1048576, "INVESTOR_DATA_ADMISSION_LIMIT")
    with transaction(db):
        _owner(db, workspace_id, actor_id)
        # Recheck immutable inputs and current reviews after validation, before
        # admitting any request. No duplicate copy of quotes is retained here.
        checked = _milliseconds(now)
        check_source_refs(db, workspace_id, document, checked)
        head = latest_input(db, workspace_id)
        if head and head["source_kind"] == "evidence":
            existing_row, existing_document = source_document(db, workspace_id, head["id"], checked)
            prior_manifest = {key: value for key, value in existing_document["snapshot"].items() if key != "created_at"}
            new_manifest = {key: value for key, value in document["snapshot"].items() if key != "created_at"}
            if (prior_manifest == new_manifest and existing_document["plan"] == plan and existing_document["policy"] == policy
                    and existing_document["valid_until"] == document["valid_until"]):
                resolve_evidence_input(db, workspace_id, head["id"], now=checked)
                return {**existing_row, "request_id": enqueue_evidence_request(db, workspace_id, existing_row, checked)}
        previous = db.execute("SELECT * FROM investor_evidence_inputs WHERE workspace_id=? AND content_hash=?", (workspace_id, digest)).fetchone()
        if previous:
            return {**dict(previous), "request_id": enqueue_evidence_request(db, workspace_id, previous, checked)}
        identifier = new_id("investor-evidence-input")
        audit = _audit(db, actor_id, "investor_admit_research_source", "investor_evidence_input", identifier, {"content_hash": digest}, created)
        db.execute("INSERT INTO investor_evidence_inputs(id,workspace_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES(?,?,?,?,?,?,?,?,?)",
            (identifier, workspace_id, QUALIFICATION, encoded, digest, actor_id, created, document["valid_until"], audit))
        row = db.execute("SELECT * FROM investor_evidence_inputs WHERE id=?", (identifier,)).fetchone()
        request = enqueue_evidence_request(db, workspace_id, row, checked)
        db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id=?", (workspace_id,))
        return {**dict(row), "request_id": request}


def source_document(db, workspace_id, input_id, now):
    row = db.execute("SELECT * FROM investor_evidence_inputs WHERE id=? AND workspace_id=?", (input_id, workspace_id)).fetchone()
    _assert(row is not None, "INVESTOR_DATA_OUT_OF_SCOPE")
    document = _object(row["document_json"])
    validate_contract(document, "investor-evidence-input.schema.json")
    _assert(content_hash(document) == row["content_hash"] and document["workspace_id"] == workspace_id
        and document["created_at"] == row["created_at"] <= now and document["valid_until"] == row["valid_until"]
        and document["source_qualification"] == row["source_qualification"] == QUALIFICATION
        and document["snapshot"]["created_at"] == row["created_at"] and document["snapshot"]["mode"] == "reconstructed"
        and document["snapshot"]["workspace_id"] == workspace_id)
    _owner(db, workspace_id, row["actor_id"])
    _audit_binding(db, row, "investor_admit_research_source", "investor_evidence_input", input_id)
    return dict(row), document


def check_source_refs(db, workspace_id, document, now):
    with _fact_validation_scope():
        _check_source_refs(db, workspace_id, document, now)


def _check_source_refs(db, workspace_id, document, now):
    _assert(now < document["valid_until"], "INVESTOR_DATA_SOURCE_EXPIRED")
    for ref in document["snapshot"]["review_refs"]:
        value = resolve_review(db, workspace_id, ref["review_id"], _review_kind(db, workspace_id, ref["review_id"]), now=now)
        _assert(value["review"]["content_hash"] == ref["review_hash"] and value["source"]["id"] == ref["source_id"]
            and value["source"]["content_hash"] == ref["source_hash"])
    for ref in document["snapshot"]["capture_refs"]:
        value = resolve_capture(db, workspace_id, ref["capture_id"], now=now)
        _assert(value["capture"]["receipt_hash"] == ref["receipt_hash"] and value["capture"]["projection_sha256"] == ref["projection_sha256"])


def source_unavailable_reason(db, workspace_id, document, now):
    if now >= document["valid_until"]:
        return "REFERENCE_SOURCE_EXPIRED"
    for ref in document["snapshot"]["review_refs"]:
        row = db.execute("SELECT * FROM investor_data_reviews WHERE id=? AND workspace_id=?", (ref["review_id"], workspace_id)).fetchone()
        _assert(row is not None and row["content_hash"] == ref["review_hash"] and row["source_id"] == ref["source_id"])
        latest = db.execute("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (row["source_id"],)).fetchone()
        if row["decision"] != "approved":
            return "REFERENCE_SOURCE_NO_LONGER_CURRENT"
        if latest[0] != row["id"]:
            from .calendar_continuation import is_continued_calendar
            if _review_kind(db, workspace_id, row["id"]) != "calendar" or not is_continued_calendar(db, workspace_id, row["id"], now):
                return "REFERENCE_SOURCE_NO_LONGER_CURRENT"
        if now >= row["valid_until"]:
            return "REFERENCE_SOURCE_EXPIRED"
        from .managed_fx import managed_review_unavailable
        managed = managed_review_unavailable(db, workspace_id, row["id"], now)
        if managed:
            return managed
    for ref in document["snapshot"]["capture_refs"]:
        versioned = document["snapshot"]["schema_version"] == "investor-monitor-price-snapshot-v1"
        _assert(ref.get("kind") in ("historical_sdk", "confirmed_sdk") if versioned else "kind" not in ref)
        confirmed = versioned and ref["kind"] == "confirmed_sdk"
        table, digest = ("investor_confirmed_captures", "payload_sha256") if confirmed else ("investor_price_captures", "projection_sha256")
        row = db.execute("SELECT * FROM " + table + " WHERE id=? AND workspace_id=?", (ref["capture_id"], workspace_id)).fetchone()
        _assert(row is not None and row["receipt_hash"] == ref["receipt_hash"] and row[digest] == ref[digest])
        if now >= row["retain_until"]:
            return "REFERENCE_SOURCE_EXPIRED"
        if db.execute("SELECT 1 FROM " + ("investor_confirmed_purges" if confirmed else "investor_price_purges") + " WHERE capture_id=?", (row["id"],)).fetchone():
            return "REFERENCE_SOURCE_PAYLOAD_PURGED"
    return None


def resolve_evidence_input(db, workspace_id, input_id, *, now=None, header_only=False, allow_unavailable=False):
    checked = _milliseconds(now)
    row, document = source_document(db, workspace_id, input_id, checked)
    unavailable = source_unavailable_reason(db, workspace_id, document, checked)
    if unavailable:
        _assert(allow_unavailable, unavailable)
        return {"row": row, "document": document, "payload": None, "unavailable_reason": unavailable}
    manifest = document["snapshot"]
    if header_only:
        check_source_refs(db, workspace_id, document, checked)
        return {"row": row, "document": document}
    snapshot = build_dataset(db, workspace_id, [ref["capture_id"] for ref in manifest["capture_refs"]],
        _snapshot_ids(db, workspace_id, manifest, "actions"), _snapshot_ids(db, workspace_id, manifest, "fx"), manifest["range_start"], manifest["range_end"],
        now=checked, snapshot_at=document["created_at"])
    _assert(snapshot["manifest"] == manifest and snapshot["dataset_hash"] == document["dataset_hash"]
        and content_hash(snapshot["catalog"]) == document["catalog_hash"] and snapshot["valid_until"] == document["valid_until"])
    return {"row": row, "document": document, "catalog": snapshot["catalog"], "payload": {"dataset": snapshot["dataset"], "plan": document["plan"], "policy": document["policy"]}, "unavailable_reason": None}
