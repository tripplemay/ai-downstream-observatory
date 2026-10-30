"""Bounded, audited source/monitor BLOB cleanup, not backup or media erasure."""

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, assert_writable, content_hash
from .data_evidence import _assert, _audit_binding, _object, _owner
from .model_contracts import definition_schema, reference_schema, validate_definition
from .model_runtime import _clock, _sealed
from .monitor_admission import monitor_evidence_document
from .source_inputs import source_document, source_unavailable_reason


def _review_receipt(db, workspace, row, now):
    _assert(row is not None and row["workspace_id"] == workspace and row["created_at"] <= now)
    document = _object(row["document_json"])
    _assert(set(document) == {"schema_version", "source_id", "source_hash", "kind", "version", "decision", "facts", "reason", "valid_until", "review_basis"}
        and content_hash(document) == row["content_hash"] and document["source_id"] == row["source_id"]
        and document["version"] == row["version"] and document["decision"] == row["decision"]
        and document["valid_until"] == row["valid_until"] and document["schema_version"] == "investor-data-review-v1"
        and document["review_basis"] == "owner_reviewed_not_provider_certified")
    _owner(db, workspace, row["actor_id"])
    _audit_binding(db, row, "investor_review_data_source", "investor_data_review", row["id"])
    return document


def _snapshot_reason(db, workspace, snapshot, valid_until, now):
    # Candidate SQL is only a shortlist. Verify immutable owner receipts before
    # treating a superseding review or upstream purge as a deletion authority.
    for ref in snapshot["review_refs"]:
        row = db.execute("SELECT * FROM investor_data_reviews WHERE id=? AND workspace_id=?", (ref["review_id"], workspace)).fetchone()
        document = _review_receipt(db, workspace, row, now)
        source = db.execute("SELECT * FROM investor_data_sources WHERE id=? AND workspace_id=?", (row["source_id"], workspace)).fetchone()
        _assert(source is not None and source["created_at"] <= row["created_at"]
            and content_hash(_object(source["document_json"])) == source["content_hash"] == ref["source_hash"]
            and document["source_hash"] == source["content_hash"] and document["kind"] == source["kind"])
        _owner(db, workspace, source["actor_id"])
        _audit_binding(db, source, "investor_store_data_source", "investor_data_source", source["id"])
        latest = db.execute("SELECT * FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (source["id"],)).fetchone()
        latest_document = _review_receipt(db, workspace, latest, now)
        _assert(latest_document["source_hash"] == source["content_hash"] and latest_document["kind"] == source["kind"])
    for ref in snapshot["capture_refs"]:
        confirmed = snapshot["schema_version"] == "investor-monitor-price-snapshot-v1" and ref.get("kind") == "confirmed_sdk"
        prefix = "investor_confirmed" if confirmed else "investor_price"
        purge = db.execute("SELECT p.*,c.workspace_id FROM " + prefix + "_purges p JOIN " + prefix + "_captures c ON c.id=p.capture_id WHERE p.capture_id=?", (ref["capture_id"],)).fetchone()
        if purge:
            _assert(purge["workspace_id"] == workspace and purge["created_at"] <= now)
            _owner(db, workspace, purge["actor_id"])
            audit = db.execute("SELECT * FROM audit_events WHERE id=?", (purge["audit_id"],)).fetchone()
            _assert(audit is not None and audit["actor_id"] == purge["actor_id"] and audit["created_at"] == purge["created_at"]
                and audit["action"] == ("investor_purge_confirmed_payload" if confirmed else "investor_purge_price_payload")
                and audit["object_type"] == ("investor_confirmed_capture" if confirmed else "investor_price_capture")
                and audit["object_id"] == ref["capture_id"] and _object(audit["payload_json"]) == {"reason": purge["reason"]})
    return source_unavailable_reason(db, workspace, {"snapshot": snapshot, "valid_until": valid_until}, now)


def _monitor_reason(db, workspace, definition, input_id, evaluated_at, now):
    row, document = monitor_evidence_document(db, workspace, definition["model_id"], input_id, now)
    _assert(row["created_at"] <= evaluated_at and document["target_definition_hash"] == definition["target_definition_hash"])
    reason = None
    for segment in document["segments"]:
        found = _snapshot_reason(db, workspace, segment["snapshot"], document["valid_until"], now)
        reason = reason or found
    return row, document, reason


def _checkpoint_reason(db, workspace, definition, identifier, now):
    if identifier is None:
        return None
    head = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?", (identifier, workspace, definition["model_id"])).fetchone()
    _assert(head is not None and 1 <= head["sequence"] <= 1000)
    rows = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? AND sequence<=? ORDER BY sequence", (workspace, definition["model_id"], head["sequence"])).fetchall()
    _assert(len(rows) == head["sequence"])
    previous, expiry, reason = None, definition["valid_until"], None
    for index, row in enumerate(rows, 1):
        _assert(row["sequence"] == index and row["created_at"] <= now
            and row["previous_hash"] == (previous["content_hash"] if previous else None)
            and (previous is None or previous["created_at"] <= row["created_at"]))
        _, document, unavailable = _monitor_reason(db, workspace, definition, row["input_id"], row["created_at"], now)
        expiry = min(expiry, document["valid_until"])
        _assert(row["valid_until"] == expiry and row["projection_hash"] == document["projection_hash"])
        purge = db.execute("SELECT * FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=?", (row["id"],)).fetchone()
        if purge:
            _assert(purge["workspace_id"] == workspace and purge["model_id"] == definition["model_id"] and purge["created_at"] <= now)
            _owner(db, workspace, purge["actor_id"])
            audit = db.execute("SELECT * FROM audit_events WHERE id=?", (purge["audit_id"],)).fetchone()
            _assert(audit is not None and audit["actor_id"] == purge["actor_id"] and audit["created_at"] == purge["created_at"]
                and audit["action"] == "investor_purge_monitor_payload" and audit["object_type"] == "investor_monitor_payload"
                and audit["object_id"] == row["id"] and _object(audit["payload_json"]) == {"kind": "checkpoint", "reason": purge["reason"]})
            reason = reason or "MONITOR_CHECKPOINT_PAYLOAD_PURGED"
        reason = reason or unavailable or ("MONITOR_CHECKPOINT_SOURCE_EXPIRED" if expiry <= now else None)
        previous = row
    return reason


def monitor_payload_unavailable(db, row, kind, now):
    """Verify source and all checkpoint ancestors without replaying price BLOBs."""
    workspace = row["workspace_id"]
    model = db.execute("SELECT * FROM investor_models WHERE id=? AND workspace_id=?", (row["model_id"], workspace)).fetchone()
    _assert(model is not None and model["created_at"] <= row["created_at"] <= now)
    definition = _sealed(model, definition_schema(_object(model["document_json"]))); validate_definition(definition)
    _assert(definition["model_id"] == model["id"] and definition["plan_id"] == model["plan_id"]
        and definition["profile_id"] == model["profile_id"] and definition["created_at"] == model["created_at"]
        and definition["data_mode"] == "reconstructed")
    plan = db.execute("SELECT * FROM investor_reference_plans WHERE id=? AND workspace_id=?", (model["plan_id"], workspace)).fetchone()
    _assert(plan is not None and plan["created_at"] <= model["created_at"])
    reference = _sealed(plan, reference_schema(_object(plan["document_json"])))
    _assert(definition["plan_hash"] == plan["content_hash"] and definition["valid_until"] == reference["valid_until"])
    evidence = db.execute("SELECT * FROM investor_reference_evidence WHERE plan_id=? AND workspace_id=?", (plan["id"], workspace)).fetchone()
    ref = reference["reference_evidence"]
    _assert(evidence is not None and evidence["created_at"] == plan["created_at"]
        and all(evidence[key] == ref[reference_key] for key, reference_key in
            (("evidence_input_id", "source_input_id"), ("request_id", "request_id"), ("run_id", "run_id"), ("result_hash", "result_hash"))))
    source, document = source_document(db, workspace, evidence["evidence_input_id"], now)
    _assert(source["created_at"] <= plan["created_at"])
    reason = _snapshot_reason(db, workspace, document["snapshot"], document["valid_until"], now)
    if reason:
        return reason
    if kind == "checkpoint":
        return _checkpoint_reason(db, workspace, definition, row["id"], now)
    run = _sealed(row); validate_contract(run, "investor-evidence-monitor.schema.json", fragment="$defs/run")
    _assert(run["request_id"] == row["request_id"] and run["model_id"] == model["id"]
        and run["created_at"] == row["created_at"] and run["valid_until"] == row["valid_until"] and run["status"] == row["status"])
    request = db.execute("SELECT * FROM investor_evidence_monitor_requests WHERE id=? AND workspace_id=? AND model_id=?", (row["request_id"], workspace, model["id"])).fetchone()
    _assert(request is not None and request["created_at"] <= row["created_at"])
    from .evidence_monitor_runtime import _validate_request
    bound = _object(request["document_json"]); _validate_request(bound)
    input_row, _, reason = _monitor_reason(db, workspace, definition, request["input_id"], request["created_at"], now)
    _assert(content_hash(bound) == request["input_version"] == run["input_version"]
        and bound["model_hash"] == model["content_hash"] and bound["profile_hash"] == definition["profile_hash"]
        and bound["input_hash"] == input_row["content_hash"] and bound["control_id"] == request["control_id"])
    return reason or _checkpoint_reason(db, workspace, definition, row["checkpoint_id"], now)


_CANDIDATES = """
WITH source_snapshots AS (
  SELECT 'research' kind,i.id,i.workspace_id,i.created_at,i.valid_until,json_extract(i.document_json,'$.snapshot') snapshot
    FROM investor_evidence_inputs i
  UNION ALL
  SELECT 'monitor',i.id,i.workspace_id,i.created_at,i.valid_until,json_extract(s.value,'$.snapshot')
    FROM investor_monitor_evidence_inputs i JOIN json_each(i.document_json,'$.segments') s
), unavailable_sources AS (
  SELECT DISTINCT kind,id,workspace_id FROM source_snapshots s
    WHERE s.created_at<=:at AND (s.valid_until<=:at
      OR EXISTS(SELECT 1 FROM json_each(s.snapshot,'$.review_refs') ref
        JOIN investor_data_reviews d ON d.id=json_extract(ref.value,'$.review_id') AND d.workspace_id=s.workspace_id
        WHERE d.valid_until<=:at OR d.decision!='approved' OR EXISTS(
          SELECT 1 FROM investor_data_reviews newer WHERE newer.source_id=d.source_id AND newer.version>d.version))
      OR EXISTS(SELECT 1 FROM json_each(s.snapshot,'$.capture_refs') ref
        JOIN investor_price_captures c ON c.id=json_extract(ref.value,'$.capture_id') AND c.workspace_id=s.workspace_id
        WHERE c.retain_until<=:at OR EXISTS(SELECT 1 FROM investor_price_purges p WHERE p.capture_id=c.id))
      OR EXISTS(SELECT 1 FROM json_each(s.snapshot,'$.capture_refs') ref
        JOIN investor_confirmed_captures c ON c.id=json_extract(ref.value,'$.capture_id') AND c.workspace_id=s.workspace_id
        WHERE json_extract(ref.value,'$.kind')='confirmed_sdk' AND (c.retain_until<=:at
          OR EXISTS(SELECT 1 FROM investor_confirmed_purges p WHERE p.capture_id=c.id))))
), affected_models AS (
  SELECT m.id,m.workspace_id FROM investor_models m JOIN investor_reference_evidence e
    ON e.plan_id=m.plan_id AND e.workspace_id=m.workspace_id JOIN unavailable_sources s
    ON s.kind='research' AND s.id=e.evidence_input_id AND s.workspace_id=m.workspace_id
), affected_chains AS (
  SELECT c.model_id,c.workspace_id,MIN(c.sequence) first_sequence FROM investor_evidence_model_checkpoints c
    WHERE EXISTS(SELECT 1 FROM unavailable_sources s WHERE s.kind='monitor' AND s.id=c.input_id AND s.workspace_id=c.workspace_id)
      OR EXISTS(SELECT 1 FROM investor_monitor_payload_purges p WHERE p.kind='checkpoint' AND p.entity_id=c.id)
    GROUP BY c.model_id,c.workspace_id
), candidates AS (
  SELECT 'price' kind,c.id,c.workspace_id,c.retain_until due_at FROM investor_price_captures c
    JOIN investor_data_reviews d ON d.id=c.rights_review_id AND d.workspace_id=c.workspace_id
    WHERE c.created_at<=:at AND EXISTS(SELECT 1 FROM investor_price_payloads b WHERE b.capture_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM investor_price_purges p WHERE p.capture_id=c.id)
      AND (c.retain_until<=:at OR d.valid_until<=:at OR d.decision!='approved'
        OR EXISTS(SELECT 1 FROM investor_data_reviews newer WHERE newer.source_id=d.source_id AND newer.version>d.version))
  UNION ALL
  SELECT 'confirmed',c.id,c.workspace_id,c.retain_until FROM investor_confirmed_captures c
    WHERE c.created_at<=:at AND EXISTS(SELECT 1 FROM investor_confirmed_payloads b WHERE b.capture_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM investor_confirmed_purges p WHERE p.capture_id=c.id)
      AND (c.retain_until<=:at OR EXISTS(SELECT 1 FROM investor_confirmed_targets t
        JOIN investor_data_reviews d ON d.id=t.rights_review_id AND d.workspace_id=c.workspace_id
        WHERE t.capture_id=c.id AND (d.valid_until<=:at OR d.decision!='approved'
          OR EXISTS(SELECT 1 FROM investor_data_reviews newer WHERE newer.source_id=d.source_id AND newer.version>d.version))))
  UNION ALL
  SELECT 'issuer',c.id,c.workspace_id,c.retain_until FROM investor_issuer_captures c
    JOIN investor_issuer_requests r ON r.id=c.request_id AND r.workspace_id=c.workspace_id
    JOIN investor_issuer_authorities a ON a.id=r.authority_id AND a.workspace_id=c.workspace_id
    WHERE c.status='captured' AND c.created_at<=:at
      AND NOT EXISTS(SELECT 1 FROM investor_issuer_purges p WHERE p.capture_id=c.id)
      AND (c.retain_until<=:at OR json_extract(a.document_json,'$.valid_until')<=:at
        OR NOT EXISTS(SELECT 1 FROM investor_issuer_controls x WHERE x.id=r.control_id AND x.enabled=1
          AND x.version=(SELECT max(version) FROM investor_issuer_controls WHERE authority_id=r.authority_id)))
  UNION ALL
  SELECT 'checkpoint',c.id,c.workspace_id,c.valid_until FROM investor_evidence_model_checkpoints c
    WHERE c.created_at<=:at AND EXISTS(SELECT 1 FROM investor_evidence_checkpoint_payloads b WHERE b.checkpoint_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM investor_monitor_payload_purges p WHERE p.kind='checkpoint' AND p.entity_id=c.id)
      AND (c.valid_until<=:at OR EXISTS(SELECT 1 FROM affected_models m WHERE m.id=c.model_id AND m.workspace_id=c.workspace_id)
        OR EXISTS(SELECT 1 FROM affected_chains a WHERE a.model_id=c.model_id AND a.workspace_id=c.workspace_id AND c.sequence>=a.first_sequence))
  UNION ALL
  SELECT 'run',u.id,u.workspace_id,u.valid_until FROM investor_evidence_monitor_runs u
    JOIN investor_evidence_monitor_requests r ON r.id=u.request_id AND r.workspace_id=u.workspace_id AND r.model_id=u.model_id
    LEFT JOIN investor_evidence_model_checkpoints c ON c.id=u.checkpoint_id AND c.workspace_id=u.workspace_id AND c.model_id=u.model_id
    WHERE u.created_at<=:at AND EXISTS(SELECT 1 FROM investor_evidence_run_payloads b WHERE b.run_id=u.id)
      AND NOT EXISTS(SELECT 1 FROM investor_monitor_payload_purges p WHERE p.kind='run' AND p.entity_id=u.id)
      AND (u.valid_until<=:at OR EXISTS(SELECT 1 FROM affected_models m WHERE m.id=u.model_id AND m.workspace_id=u.workspace_id)
        OR EXISTS(SELECT 1 FROM unavailable_sources s WHERE s.kind='monitor' AND s.id=r.input_id AND s.workspace_id=u.workspace_id)
        OR EXISTS(SELECT 1 FROM affected_chains a WHERE a.model_id=u.model_id AND a.workspace_id=u.workspace_id AND c.sequence>=a.first_sequence))
)
SELECT c.kind,c.id,c.workspace_id,w.owner_id FROM candidates c JOIN investor_workspaces w ON w.id=c.workspace_id
  ORDER BY c.due_at,c.kind,c.id LIMIT :limit
"""


def purge_due_source_payloads(db, *, limit=100, now=None, stop_requested=None):
    """One shared deletion budget; each receipt/delete is its own transaction."""
    _assert(type(limit) is int and 1 <= limit <= 1000, "INVESTOR_DATA_PURGE_LIMIT")
    at = _clock(now)
    assert_writable(db)
    if stop_requested and stop_requested():
        raise WorkbenchError("WORKER_STOP_REQUESTED")
    rows = db.execute(_CANDIDATES, {"at": at, "limit": limit}).fetchall()
    from .data_evidence import purge_price_payload
    from .confirmed_capture import purge_confirmed_payload
    from .evidence_monitor_runtime import purge_monitor_payload
    from .issuer_sources import purge_issuer_capture
    purged = []
    for row in rows:
        if stop_requested and stop_requested():
            raise WorkbenchError("WORKER_STOP_REQUESTED")
        if row["kind"] == "price":
            result = purge_price_payload(db, row["workspace_id"], row["owner_id"], row["id"], now=at)
        elif row["kind"] == "confirmed":
            result = purge_confirmed_payload(db, row["workspace_id"], row["owner_id"], row["id"], now=at)
        elif row["kind"] == "issuer":
            result = purge_issuer_capture(db, row["workspace_id"], row["owner_id"], row["id"], now=at)
        else:
            result = purge_monitor_payload(db, row["workspace_id"], row["owner_id"], row["kind"], row["id"], now=at)
        purged.append(result)
    return purged
