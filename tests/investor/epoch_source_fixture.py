"""Frozen component fixture with normal reviewed calendar and retained SDK prices."""

from copy import deepcopy
from datetime import timedelta
import json
from unittest.mock import patch

from tests.investor import current_correction_fixture as current
from worker.investor import action_review_workflow as review, action_review_jobs, correction_impact_jobs as impact, correction_consent as consent, corrected_action_handover as handover
from worker.investor import data_evidence, managed_actions
from worker.orchestration.db import content_hash, instant
from worker.orchestration.runtime import run_pending_once


AT = "2026-10-19T10:00:03.000Z"
NOW = "2026-10-20T10:00:03.000Z"


def clock(milliseconds): return current.actions.stamp(instant(AT) + timedelta(milliseconds=milliseconds))


def finish(db, table, request, at):
    for _ in range(32):
        value = run_pending_once(db, "fictional-epoch-source-construction", clock=lambda: at)
        row = db.execute("SELECT document_json FROM " + table + " WHERE request_id=?", (request["request_id"],)).fetchone()
        if row: return json.loads(row[0])
        assert value is not None
    raise AssertionError("FICTIONAL_EPOCH_SOURCE_JOB_DID_NOT_SETTLE")


def create(db, filename):
    dates = current.timeline(AT); reviewed, core = current.reviewed, current.core
    def calendar_known_ahead(connection, kind, facts, at, expiry, label):
        if kind == "calendar":
            facts = deepcopy(facts)
            for row in facts["days"]:
                if row["date"] not in ("2026-10-19", "2026-10-20"): continue
                day = current.actions.datetime.fromisoformat(row["date"]).date()
                row.update(kind="full", close_at=current.actions.day_at(day, 16),
                    available_at=current.actions.stamp(instant(current.actions.day_at(day, 16)) + timedelta(minutes=1)),
                    settled_at=current.actions.day_at(day + timedelta(days=1), 17), settlement_rule_known_at=at)
        return reviewed(connection, kind, facts, at, expiry, label)
    with patch.object(current, "actual", return_value=AT), patch.object(current, "core", side_effect=lambda connection, at=None: core(connection, at or AT)), \
            patch.object(current, "reviewed", side_effect=calendar_known_ahead): original = current.prepare(db, filename)
    authority = db.execute("SELECT new_authority_id FROM investor_action_review_confirmations ORDER BY rowid DESC LIMIT 1").fetchone()[0]
    revision = lambda: db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
    preview = review.register_action_review_preview(db, "w", "owner", {"authority_id": authority, "expected_revision": revision(), "idempotency_key": "fictional-epoch-correction-preview"}, now=clock(1), owner_interaction=True)
    body = {"schema_version": "investor-action-correction-impact-request-v1", "model_id": original["model_id"], "preview_id": preview["preview_id"],
        "expected_revision": preview["workspace_revision"], "idempotency_key": "fictional-epoch-correction-impact",
        "acknowledgements": {key: True for key in ("hypothetical_only", "source_differences_seen", "explicit_time_and_tax", "original_reported_coverage_only", "unchanged_tax_assumption")},
        "decisions": [{"date": dates["event"].isoformat(), "choice": "replace", "reason": "FICTIONAL retained issuer correction, unchanged independent old difference",
            "events": [{"type": "dividend", "at": current.actions.day_at(dates["event"], 10), "pay_at": current.actions.day_at(dates["event"] + timedelta(days=7), 16), "tax_per_unit": "0.432109"}]}]}
    queued = impact.enqueue_correction_impact(db, "w", "owner", body, now=clock(2)); calculated = finish(db, "investor_correction_impact_results", queued, clock(2))
    assert calculated["outcome"] == "preview_ready", calculated
    row = db.execute("SELECT content_hash FROM investor_correction_impact_results WHERE request_id=?", (queued["request_id"],)).fetchone()
    queued = consent.enqueue_correction_consent(db, "w", "owner", {"schema_version": "investor-correction-consent-submit-v1", "impact_request_id": queued["request_id"],
        "expected_result_hash": row[0], "expected_revision": revision(), "idempotency_key": "fictional-epoch-economic-consent", "acknowledgements": {key: True for key in consent.ACKS}}, now=clock(3))
    confirmed = finish(db, "investor_correction_consent_results", queued, clock(3)); assert confirmed["outcome"] == "confirmed", confirmed
    correction = db.execute("SELECT * FROM investor_correction_consents WHERE id=?", (confirmed["confirmation_id"],)).fetchone()
    preview = review.register_action_review_preview(db, "w", "owner", {"authority_id": authority, "expected_revision": revision(), "idempotency_key": "fictional-epoch-fresh-source-preview"}, now=clock(4), owner_interaction=True)
    queued = action_review_jobs.enqueue_action_review_request(db, "w", "owner", "confirmation", {"schema_version": handover.SUBMIT, "preview_id": preview["preview_id"],
        "correction_id": correction["id"], "expected_correction_hash": correction["content_hash"], "expected_revision": revision(), "idempotency_key": "fictional-epoch-source-handover",
        "enable_rule": True, "acknowledgements": {key: True for key in handover.ACKS}}, now=clock(5))
    completed = finish(db, "investor_action_review_job_results", queued, clock(5)); assert completed["outcome"] == "confirmed", completed
    handed = review.resolve_action_review_confirmation(db, "w", "owner", completed["resource_id"], now=clock(5))
    issuer = db.execute("SELECT id FROM investor_issuer_authorities WHERE workspace_id='w'").fetchone()[0]
    current.actions.collect(db, dates, issuer, NOW, updated=True, gross="5.32109")
    published = managed_actions.publish_current_actions(db, now=NOW); assert len(published) == 1 and published[0]["status"] == "published", published
    head = db.execute("SELECT input_id FROM investor_evidence_model_checkpoints WHERE id=?", (original["original_head_id"],)).fetchone()
    source = json.loads(db.execute("SELECT document_json FROM investor_monitor_evidence_inputs WHERE id=?", (head[0],)).fetchone()[0])["segments"][0]["snapshot"]
    captures = [data_evidence.resolve_capture(db, "w", row["capture_id"], now=NOW) for row in source["capture_refs"]]
    listing_ids = sorted({row["binding"]["listing"]["review"]["id"] for row in captures})
    listings = [dict(db.execute("SELECT * FROM investor_data_reviews WHERE id=?", (identifier,)).fetchone()) for identifier in listing_ids]
    historical = {"rights": captures[0]["binding"]["rights"]["review"], "listings": listings}; calendar = captures[0]["binding"]["calendar"]["review"]
    day = instant(AT).astimezone(current.actions.ZONE).date()
    new_captures = current.prices(db, historical, calendar, day, NOW)
    previous_fx = [data_evidence.resolve_review(db, "w", row["review_id"], "fx", now=NOW) for row in source["review_refs"]
        if db.execute("SELECT kind FROM investor_data_sources WHERE id=?", (row["source_id"],)).fetchone()[0] == "fx"]
    rates = [row for value in previous_fx for row in value["facts"]["rows"]]
    observed = current.actions.day_at(day, 15)
    fx = reviewed(db, "fx", {"currency": "USD", "unit": "CNY_per_unit_currency", "rows": [*rates,
        {"observed_at": observed, "assumed_available_at": current.actions.stamp(instant(observed) + timedelta(minutes=1)), "value": "1.25"}]}, NOW, handed["source_valid_until"], "epoch-new-close-fx")
    bnd = next(row["review_id"] for row in source["review_refs"] if db.execute("SELECT kind FROM investor_data_sources WHERE id=?", (row["source_id"],)).fetchone()[0] == "actions"
        and data_evidence.resolve_review(db, "w", row["review_id"], "actions", now=NOW)["facts"]["listing_id"] == "synthetic-0928")
    return {"model_id": original["model_id"], "epoch_id": "fictional-qualified-epoch-source", "references": [{"correction_id": correction["id"], "confirmation_hash": correction["content_hash"],
        "handover_id": handed["confirmation_id"], "handover_hash": content_hash(handed)}],
        "windows": [{"capture_ids": [row["capture_id"] for row in source["capture_refs"]] + new_captures,
            "action_review_ids": [published[0]["publication_id"], bnd], "fx_review_ids": [fx["id"]], "start_date": source["range_start"], "end_date": day.isoformat()}]}
