"""Audited deletion of derived comparison bytes; not backup/media erasure."""

from worker.orchestration.db import WorkbenchError, transaction
from .data_evidence import _assert, _audit, _owner
from .runtime import _milliseconds
from .model_runtime import _clock
from .source_inputs import resolve_evidence_input


def purge_funded_result(db, workspace, actor, run_id, parameters_hash, *, now=None):
    at = _milliseconds(now)
    with transaction(db):
        _owner(db, workspace, actor)
        row = db.execute("SELECT * FROM investor_funded_result_headers WHERE run_id=? AND parameters_hash=? AND workspace_id=?",
                         (run_id, parameters_hash, workspace)).fetchone()
        _assert(row is not None and row["created_at"] <= at, "INVESTOR_DATA_OUT_OF_SCOPE")
        previous = db.execute("SELECT * FROM investor_funded_result_purges WHERE run_id=? AND parameters_hash=?", (run_id, parameters_hash)).fetchone()
        if previous:
            _assert(previous["created_at"] <= at, "INVESTOR_DATA_INVALID_CLOCK")
            return dict(previous)
        reason = "retention_expired" if row["valid_until"] <= at else "source_unavailable"
        if reason == "source_unavailable":
            source_id = db.execute("SELECT r.evidence_input_id FROM investor_funded_study_runs u JOIN investor_funded_study_requests r ON r.id=u.request_id WHERE u.id=? AND u.workspace_id=?",
                                   (run_id, workspace)).fetchone()[0]
            source = resolve_evidence_input(db, workspace, source_id, now=at, header_only=True, allow_unavailable=True)
            _assert(source.get("unavailable_reason"), "INVESTOR_DATA_PURGE_NOT_DUE")
        audit = _audit(db, actor, "investor_purge_funded_result", "investor_funded_result", run_id,
                       {"parameters_hash": parameters_hash, "reason": reason}, at)
        db.execute("INSERT INTO investor_funded_result_purges VALUES(?,?,?,?,?,?,?)", (run_id, parameters_hash, workspace, reason, actor, at, audit))
        db.execute("DELETE FROM investor_funded_result_payloads WHERE run_id=? AND parameters_hash=?", (run_id, parameters_hash))
        return dict(db.execute("SELECT * FROM investor_funded_result_purges WHERE run_id=? AND parameters_hash=?", (run_id, parameters_hash)).fetchone())


def purge_due_funded_results(db, *, limit=100, now=None, stop_requested=None):
    """Core maintenance only. GET never creates purge records or deletes bytes."""
    _assert(type(limit) is int and 1 <= limit <= 1000, "INVESTOR_DATA_PURGE_LIMIT")
    at = _clock(now)
    rows = db.execute("""SELECT h.run_id,h.parameters_hash,h.workspace_id,w.owner_id
        FROM investor_funded_result_headers h JOIN investor_workspaces w ON w.id=h.workspace_id
        JOIN investor_funded_study_runs u ON u.id=h.run_id JOIN investor_funded_study_requests r ON r.id=u.request_id
        JOIN investor_evidence_inputs i ON i.id=r.evidence_input_id
        WHERE h.created_at<=? AND NOT EXISTS(SELECT 1 FROM investor_funded_result_purges p
            WHERE p.run_id=h.run_id AND p.parameters_hash=h.parameters_hash)
          AND EXISTS(SELECT 1 FROM investor_funded_result_payloads b WHERE b.run_id=h.run_id AND b.parameters_hash=h.parameters_hash)
          AND (h.valid_until<=? OR EXISTS(SELECT 1 FROM json_each(i.document_json,'$.snapshot.review_refs') ref
            JOIN investor_review_headers d ON d.id=json_extract(ref.value,'$.review_id') AND d.workspace_id=i.workspace_id
            WHERE d.valid_until<=? OR d.decision!='approved' OR EXISTS(SELECT 1 FROM investor_review_headers newer
              WHERE newer.source_id=d.source_id AND newer.version>d.version)
              OR EXISTS(SELECT 1 FROM investor_action_unavailable_headers a WHERE a.id=d.id AND a.workspace_id=d.workspace_id))
            OR EXISTS(SELECT 1 FROM json_each(i.document_json,'$.snapshot.capture_refs') ref
              JOIN investor_price_captures c ON c.id=json_extract(ref.value,'$.capture_id')
              WHERE c.retain_until<=? OR EXISTS(SELECT 1 FROM investor_price_purges p WHERE p.capture_id=c.id)))
        ORDER BY h.valid_until,h.run_id,h.parameters_hash LIMIT ?""", (at, at, at, at, limit)).fetchall()
    purged = []
    for row in rows:
        if stop_requested and stop_requested():
            raise WorkbenchError("WORKER_STOP_REQUESTED")
        purged.append(purge_funded_result(db, row["workspace_id"], row["owner_id"], row["run_id"], row["parameters_hash"], now=at))
    return purged
