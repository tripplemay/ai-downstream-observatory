"""Fictional post-publication corruption, not a supported mutation or bypass."""

from copy import deepcopy
from worker.accounting.decimal_math import canonical, decimal
from worker.orchestration.db import canonical_json, content_hash
from worker.investor.data_evidence import _object


def reseal_wrong_first_state(db, epoch_id):
    """Used only inside disposable test savepoints; never alter underlying sources."""
    row = db.execute("SELECT * FROM investor_model_epochs WHERE id=?", (epoch_id,)).fetchone()
    original = _object(db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (row["checkpoint_id"],)).fetchone()[0])
    bad = deepcopy(original); listing = sorted(bad["quantities"])[0]
    bad["quantities"][listing] = canonical(decimal(bad["quantities"][listing]) + 1)
    record = _object(row["document_json"]); record["checkpoint"]["content_hash"] = content_hash(bad)
    run = db.execute("SELECT * FROM investor_evidence_monitor_runs WHERE id=?", (row["monitor_run_id"],)).fetchone()
    run_doc = _object(run["document_json"]); run_doc["checkpoint_hash"] = content_hash(bad)
    for trigger in ("investor_evidence_checkpoint_payload_update", "investor_evidence_checkpoint_no_update", "investor_epoch_update", "investor_evidence_run_no_update", "audit_events_no_update"):
        db.execute("DROP TRIGGER " + trigger)
    db.execute("UPDATE investor_evidence_checkpoint_payloads SET payload=? WHERE checkpoint_id=?", (canonical_json(bad).encode(), row["checkpoint_id"]))
    db.execute("UPDATE investor_evidence_model_checkpoints SET content_hash=? WHERE id=?", (content_hash(bad), row["checkpoint_id"]))
    db.execute("UPDATE investor_model_epochs SET document_json=?,content_hash=? WHERE id=?", (canonical_json(record), content_hash(record), epoch_id))
    db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": content_hash(record)}), row["audit_id"]))
    db.execute("UPDATE investor_evidence_monitor_runs SET document_json=?,content_hash=? WHERE id=?", (canonical_json(run_doc), content_hash(run_doc), run["id"]))
