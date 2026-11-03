"""Disposable, explicit fictional owner decisions for cross-language verification."""

import json

from . import epoch_source_fixture as source
from worker.investor import model_epoch_registration as registration
from worker.orchestration.db import content_hash
from worker.orchestration.jobs import run_one
from worker.orchestration.runtime import command_handler


def create(db, path):
    value = source.create(db, path)
    revision = db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
    preview = registration.register_model_epoch_preview(db, "w", "owner", value["model_id"], value["references"], value["windows"],
        expected_revision=revision, owner_interaction=True, now=source.NOW)
    request = registration.enqueue_model_epoch_registration(db, "w", "owner", {"schema_version": "investor-model-epoch-submit-v1", "preview_id": preview["preview_id"],
        "expected_preview_hash": content_hash(preview), "expected_revision": preview["workspace_revision"], "idempotency_key": "fictional-protocol-epoch-confirmation",
        "acknowledgements": {key: True for key in registration.ACKS}}, now=source.NOW)
    completed = run_one(db, "fictional-epoch-registration-protocol", command_handler(db, clock=lambda: source.NOW), job_type=registration.JOB_TYPE,
        lease_seconds=300, clock=lambda: source.NOW)
    assert completed["status"] == "succeeded", completed
    row = db.execute("SELECT * FROM investor_model_epochs WHERE request_id=?", (request["request_id"],)).fetchone()
    checkpoint = json.loads(db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (row["checkpoint_id"],)).fetchone()[0])
    return {"preview": preview, "request": request, "registration": json.loads(row["document_json"]), "checkpoint": checkpoint}
