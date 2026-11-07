"""Actual fictional legacy history -> receipt -> distinct source, never a reset."""

from copy import deepcopy
from datetime import timedelta
import json
import sys
import unittest
from unittest.mock import patch

from tests.investor import test_action_review_readmission as fixture
from worker.investor import legacy_transition_source as bridge, legacy_transition_workflow as workflow
from worker.investor import monitor_admission, monitor_data
from worker.orchestration.db import WorkbenchError, content_hash, instant, open_database


class LegacyTransitionSourceTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch("socket.create_connection", side_effect=AssertionError("NO_NETWORK")))
        self.enterContext(patch("socket.getaddrinfo", side_effect=AssertionError("NO_DNS")))
        self.enterContext(patch("worker.market.providers.longport.read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIAL_READ")))
        self.case = fixture.ActionReviewReadmissionTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups); self.db = self.case.db
        self.at = workflow._clock(instant(fixture.CONFIRM) + timedelta(milliseconds=1))

    def revision(self):
        return self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]

    def prepare(self, *, completed=False, quote_ttl=None, closed_dates=(), bnd_coverage_end='2026-11-02'):
        self.case.model(audited=False, known_costs=True, quote_ttl=quote_ttl, closed_dates=closed_dates, bnd_coverage_end=bnd_coverage_end)
        if completed: self.case.complete_prices()
        self.case.confirm(); self.model_id = self.case.definition["model_id"]
        preview = workflow.register_legacy_transition_preview(self.db, "w", "synthetic-investor", {"model_id": self.model_id,
            "expected_revision": self.revision(), "idempotency_key": "fictional-bridge-preview"}, now=self.at)
        self.receipt = workflow.confirm_legacy_transition(self.db, "w", "synthetic-investor", {
            "schema_version": "investor-legacy-transition-submit-v1", "preview_id": preview["preview_id"], "expected_preview_hash": content_hash(preview),
            "expected_revision": preview["workspace_revision"], "idempotency_key": "fictional-bridge-confirm", "acknowledgements": {key: True for key in
                ("preserve_original_accounting_and_knowledge", "revalidate_current_sources_on_every_use", "new_actions_keep_audited_knowledge",
                 "quality_gaps_are_not_current_advice", "research_only_no_trading")}}, now=self.at)

    def request(self):
        return {"transition_id": self.receipt["confirmation_id"], "transition_hash": content_hash(self.receipt),
            "expected_revision": self.revision(), "idempotency_key": "fictional-bridge-register"}

    def admit(self, request=None, **kwargs):
        return bridge.admit_legacy_transition_source(self.db, "w", "synthetic-investor", request or self.request(), now=self.at, **kwargs)

    def test_distinct_v5_registration_preserves_all_history_and_does_not_forge_current_data(self):
        self.prepare(); tables = ("investor_models", "investor_model_controls", "investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads", "job_runs")
        before = {table: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in tables}
        original = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_monitor_evidence_inputs")]
        result = self.admit(); self.assertTrue(result["monitor_source_registered"]); self.assertFalse(result["monitoring_activated"])
        self.assertFalse(result["trading_permission"]); self.assertEqual(result["provider_calls"], 0)
        row, document = monitor_admission.monitor_evidence_document(self.db, "w", self.model_id, result["input_id"], self.at)
        self.assertEqual(document["schema_version"], "investor-monitor-data-input-v5")
        self.assertEqual(document["transition"], {"id": self.receipt["confirmation_id"], "content_hash": content_hash(self.receipt)})
        self.assertLessEqual(document["valid_until"], self.receipt["valid_until"])
        comparison = bridge.compare_transition_monitor_data(self.db, "w", self.case.definition, document, now=self.at)
        self.assertEqual(comparison["comparison_projection"]["schema_version"], "investor-monitor-data-projection-v3")
        self.assertTrue(comparison["comparison_projection"]["quality_gaps"])
        self.assertNotIn("projection", comparison)
        normal = monitor_data.resolve_monitor_data(self.db, "w", self.case.definition, document, now=self.at)
        self.assertTrue(normal["projection"] is None or normal["projection"]["quality_gaps"])
        self.assertEqual(original, [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_monitor_evidence_inputs")][:len(original)])
        self.assertEqual(before, {table: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in tables})
        readonly = open_database(self.case.case.path, read_only=True)
        try:
            self.assertEqual(bridge.compare_transition_monitor_data(readonly, "w", self.case.definition, document, now=self.at), comparison)
            self.assertEqual(readonly.total_changes, 0)
        finally: readonly.close()
        self.case.case.assert_no_finance()

    def test_original_legacy_checkpoint_replays_only_after_an_actual_admitted_transition_not_a_receipt_alone(self):
        from worker.investor.evidence_monitor_runtime import resolve_checkpoint
        self.prepare(); head = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone()
        self.assertIsNone(resolve_checkpoint(self.db, "w", self.case.definition, head["id"], self.at)[0])
        self.admit(); before = list(self.db.iterdump())
        state, reason = resolve_checkpoint(self.db, "w", self.case.definition, head["id"], self.at)
        self.assertIsNone(reason)
        original = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (head["id"],)).fetchone()[0])
        self.assertEqual(state, original); self.assertEqual(before, list(self.db.iterdump()))
        legacy = json.loads(self.case.seed["document_json"])
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.case.definition, legacy, now=self.at)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")

    def test_lost_response_is_historical_only_and_changed_body_cannot_register_a_second_input(self):
        from worker.investor import eodhd_sources
        self.prepare(); request = self.request(); value = self.admit(request)
        eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor", self.case.case.member["eodhd_authority_id"], False, now=self.at)
        before = list(self.db.iterdump())
        self.assertEqual(self.admit(request), value)
        bad = deepcopy(request); bad["transition_hash"] = "0" * 64
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"): self.admit(bad)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_late_atomic_failure_and_source_withdrawal_cannot_leave_an_unbound_v5_source(self):
        from worker.investor import eodhd_sources
        self.prepare(); request = self.request()
        self.db.execute("CREATE TRIGGER fictional_bridge_abort BEFORE INSERT ON investor_legacy_transition_admissions BEGIN SELECT RAISE(ABORT,'fictional bridge late failure'); END")
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(Exception, "fictional bridge late failure"): self.admit(request)
        self.assertEqual(before, list(self.db.iterdump()))
        self.db.execute("DROP TRIGGER fictional_bridge_abort")
        prepared = bridge.prepare_legacy_transition_source(self.db, "w", "synthetic-investor", request, now=self.at)
        other = open_database(self.case.case.path)
        try: eodhd_sources.set_authority_enabled(other, "w", "synthetic-investor", self.case.case.member["eodhd_authority_id"], False, now=self.at)
        finally: other.close()
        before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): prepared(self.db)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_default_core_rebinds_the_already_completed_capture_and_continues_the_original_model_without_a_new_request(self):
        from worker.orchestration.runtime import run_pending_once
        from worker.investor import confirmed_feed
        self.prepare(completed=True)
        original = {table: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in
            ("investor_confirmed_feed_requests", "investor_confirmed_feed_runs", "investor_confirmed_feed_admissions", "investor_confirmed_captures")}
        old_head = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads").fetchone()[0])
        root = self.admit(); self.assertEqual(len(self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchall()), 1)
        self.assertEqual(run_pending_once(self.db, "fictional-v5-default-core", clock=lambda: self.at)["status"], "succeeded")
        latest = monitor_admission.latest_monitor_evidence(self.db, "w", self.model_id)
        self.assertNotEqual(latest["id"], root["input_id"])
        document = json.loads(latest["document_json"]); self.assertEqual(document["schema_version"], "investor-monitor-data-input-v5")
        resolved = monitor_data.resolve_monitor_data(self.db, "w", self.case.definition, document, now=self.at)
        self.assertIsNone(resolved["unavailable_reason"]); self.assertEqual(resolved["projection"]["quality_gaps"], [])
        states = [json.loads(row[0]) for row in self.db.execute("SELECT p.payload FROM investor_evidence_model_checkpoints c JOIN investor_evidence_checkpoint_payloads p ON p.checkpoint_id=c.id ORDER BY c.sequence")]
        self.assertEqual(len(states), 2); self.assertEqual(states[1]["previous_hash"], content_hash(old_head))
        self.assertEqual(states[1]["initialized_at"], old_head["initialized_at"])
        self.assertEqual({key: states[1]["processed_actions"][key] for key in old_head["processed_actions"]}, old_head["processed_actions"])
        self.assertGreater(len(states[1]["processed_actions"]), len(old_head["processed_actions"])); self.assertEqual(len(states[1]["receivables"]), 1)
        self.assertEqual(original, {table: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in original})
        before = list(self.db.iterdump()); self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=self.at), [])
        self.assertEqual(before, list(self.db.iterdump())); self.case.case.assert_no_finance()

    def test_already_stale_at_construction_v5_can_seed_only_verified_listener_metadata_never_current_nav(self):
        from worker.investor import confirmed_feed
        self.prepare(); later = "2026-11-08T06:00:04.002Z"
        admission = bridge.admit_legacy_transition_source(self.db, "w", "synthetic-investor", self.request(), now=later)
        _, document = monitor_admission.monitor_evidence_document(self.db, "w", self.model_id, admission["input_id"], later)
        normal = monitor_data.resolve_monitor_data(self.db, "w", self.case.definition, document, now=later)
        self.assertEqual(normal["unavailable_reason"], "MONITOR_DATA_PROJECTION_EXPIRED"); self.assertIsNone(normal["projection"])
        before = list(self.db.iterdump())
        context = confirmed_feed._seed(self.db, "w", self.model_id, admission["input_id"], later)
        self.assertTrue(context[6]["source_only"]); self.assertIsNone(context[6]["projection"])
        self.assertEqual(set(context[6]["catalog"]), {row["listing_id"] for row in self.case.definition["targets"]})
        self.assertEqual(before, list(self.db.iterdump())); self.case.case.assert_no_finance()

    def test_database_does_not_allow_a_later_admission_to_discard_the_bridge_or_bind_a_false_receipt(self):
        from worker.investor.data_evidence import _audit
        from worker.orchestration.db import canonical_json, transaction
        self.prepare(); registered = self.admit()
        _, root = monitor_admission.monitor_evidence_document(self.db, "w", self.model_id, registered["input_id"], self.at)
        before = list(self.db.iterdump())
        for mode in ("downgrade", "wrong-consent"):
            doc = bridge.audited_document(root) if mode == "downgrade" else deepcopy(root)
            if mode == "wrong-consent": doc["transition"]["content_hash"] = "f" * 64
            digest = content_hash(doc); identifier = "fictional-invalid-" + mode
            with self.subTest(mode=mode), self.assertRaisesRegex(Exception, "legacy transition"):
                with transaction(self.db):
                    audit = _audit(self.db, "synthetic-investor", "investor_admit_monitor_source", "investor_monitor_evidence_input", identifier, {"content_hash": digest}, self.at)
                    self.db.execute("INSERT INTO investor_monitor_evidence_inputs(id,workspace_id,model_id,source_qualification,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES(?,?,?,'owner_reviewed_reconstructed',?,?,?,?,?,?)",
                        (identifier, "w", self.model_id, canonical_json(doc), digest, "synthetic-investor", self.at, doc["valid_until"], audit))
            self.assertEqual(before, list(self.db.iterdump()))


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        case = LegacyTransitionSourceTests(); case.setUp()
        try:
            case.prepare(); admission = case.admit()
            _, document = monitor_admission.monitor_evidence_document(case.db, "w", case.model_id, admission["input_id"], case.at)
            projection = bridge.compare_transition_monitor_data(case.db, "w", case.case.definition, document, now=case.at)["comparison_projection"]
            from worker.orchestration.db import canonical_json
            print(canonical_json({"input": document, "projection": projection, "admission": admission}))
        finally: case.doCleanups()
    else: unittest.main()
