"""Explicit fictional consent persists a frozen baseline, never a current checkpoint."""

from copy import deepcopy
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as runtime
from tests.investor.test_correction_impact_jobs import settled_correction_case
from tests.investor.test_action_correction_impact import CHECKED, OWNER
from tests.investor.test_legacy_protocol_matrix import offline_protocol_fixture
from worker.investor import correction_consent as consent, correction_impact_jobs as impact, eodhd_sources
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, open_database
from worker.orchestration.jobs import claim_job, complete_job
from worker.orchestration.runtime import run_pending_once


AT = "2026-11-07T06:00:04.002Z"
COMMIT = "2026-11-07T06:00:04.003Z"


class CorrectionConsentTests(unittest.TestCase):
    setUp = runtime.InvestorRuntimeTests.setUp
    assert_no_finance = runtime.InvestorRuntimeTests.assert_no_finance

    def seed(self, *, retain=False, tamper=False, mode="replace"):
        self.enterContext(offline_protocol_fixture()); self.value = settled_correction_case(self.db, self.path, mode=mode)
        if retain: self.value["request"]["decisions"][0].update(choice="retain", events=[])
        self.original_request = impact.enqueue_correction_impact(self.db, "w", OWNER, self.value["request"], now=CHECKED)
        for _ in range(12):
            result = run_pending_once(self.db, "fictional-impact-before-consent", clock=lambda: CHECKED)
            row = self.db.execute("SELECT * FROM investor_correction_impact_results WHERE request_id=?", (self.original_request["request_id"],)).fetchone()
            if row: break
            self.assertIsNotNone(result)
        self.assertEqual(row["outcome"], "preview_ready"); self.impact_result = json.loads(row["document_json"])
        if tamper:
            self.db.execute("DROP TRIGGER investor_correction_impact_result_update")
            self.db.execute("DROP TRIGGER audit_events_no_update")
            self.impact_result["impact"]["comparison"]["difference_cny"] = "99999"
            digest = content_hash(self.impact_result)
            self.db.execute("UPDATE investor_correction_impact_results SET document_json=?,content_hash=? WHERE id=?", (canonical_json(self.impact_result), digest, row["id"]))
            self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), row["audit_id"]))
            row = self.db.execute("SELECT * FROM investor_correction_impact_results WHERE id=?", (row["id"],)).fetchone()
        self.body = {"schema_version": "investor-correction-consent-submit-v1", "impact_request_id": self.original_request["request_id"],
            "expected_result_hash": row["content_hash"], "expected_revision": self.value["request"]["expected_revision"],
            "idempotency_key": "fictional-consent", "acknowledgements": {key: True for key in consent.ACKS}}
        return self.body

    def rows(self, table): return [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table + " ORDER BY rowid")]

    def enqueue(self): return consent.enqueue_correction_consent(self.db, "w", OWNER, self.body, now=AT)

    def finish(self, request):
        for _ in range(12):
            job = run_pending_once(self.db, "fictional-explicit-correction-consent", clock=lambda: AT)
            row = self.db.execute("SELECT document_json FROM investor_correction_consent_results WHERE request_id=?", (request["request_id"],)).fetchone()
            if row: return json.loads(row[0])
            self.assertIsNotNone(job)
        self.fail("CONSENT_JOB_REQUIRED")

    def test_default_core_records_exact_owner_consent_and_economic_baseline_without_changing_any_old_observation(self):
        self.seed(); names = ("investor_models", "investor_model_controls", "investor_evidence_model_checkpoints", "investor_evidence_checkpoint_payloads",
            "investor_monitor_evidence_inputs", "investor_data_reviews", "investor_action_controls", "investor_action_publications")
        before = {name: self.rows(name) for name in names}; revision = self.body["expected_revision"]
        request = self.enqueue(); result = self.finish(request); self.assertEqual(result["outcome"], "confirmed", result)
        metadata = consent.read_correction_consent_receipt(self.db, "w", OWNER, result["confirmation_id"], now=AT)
        self.assertNotIn("baseline", metadata); self.assertFalse(metadata["source_values_included"])
        # Inspect storage separately; the public historical receipt has no economics.
        receipt = consent._registered_correction_document(self.db, "w", OWNER, result["confirmation_id"], AT)
        baseline = receipt["baseline"]; self.assertEqual(baseline["knowledge_at"], AT)
        self.assertEqual(baseline["economics"]["initialized_at"], self.value["head"]["initialized_at"])
        self.assertEqual(baseline["economics"]["initial_notional_cny"], "10000")
        self.assertEqual(baseline["valuation_summary"]["difference_cny"], self.impact_result["impact"]["comparison"]["difference_cny"])
        self.assertNotIn("comparison", baseline); self.assertNotIn("corrected_actions", baseline)
        self.assertTrue(receipt["economic_correction_approved"])
        for key in ("checkpoint_created", "state_published", "monitoring_resumed", "historical_observations_rewritten", "historical_strategy_results_recomputed", "trading_permission"):
            self.assertIs(receipt[key], False)
        corrected = next(event for event in baseline["approved_facts"]["events"] if event["at"].startswith("2026-11-05"))
        self.assertTrue(corrected["id"].startswith("reviewed-correction:")); self.assertEqual(corrected["published_at"], AT)
        self.assertEqual(corrected["gross_per_unit"], "5.32109"); self.assertEqual(corrected["tax_per_unit"], "0.432109")
        self.assertEqual(before, {name: self.rows(name) for name in names})
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0], revision + 1)
        self.assertGreater(receipt["valid_until"], request["valid_until"])
        self.assert_no_finance()

    def test_exact_nonce_recovers_receipt_after_intent_ttl_but_changed_answers_or_a_second_nonce_cannot_reapprove(self):
        self.seed(); request = self.enqueue(); result = self.finish(request); before = list(self.db.iterdump())
        later = "2026-11-07T07:00:04.001Z"
        self.assertEqual(consent.enqueue_correction_consent(self.db, "w", OWNER, self.body, now=later), request)
        self.assertEqual(consent.read_correction_consent_receipt(self.db, "w", OWNER, result["confirmation_id"], now=later)["confirmation_id"], result["confirmation_id"])
        changed = deepcopy(self.body); changed["expected_result_hash"] = "0" * 64
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"): consent.enqueue_correction_consent(self.db, "w", OWNER, changed, now=later)
        changed = deepcopy(self.body); changed["idempotency_key"] = "fictional-second"
        with self.assertRaises(WorkbenchError): consent.enqueue_correction_consent(self.db, "w", OWNER, changed, now=later)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_hypothetical_consent_new_event_answers_prices_or_implicit_acknowledgements_cannot_enter_the_closed_protocol(self):
        self.seed(); before = list(self.db.iterdump())
        for changes in ({"new_events": []}, {"enable_rule": True}, {"cash_cny": "10000"}, {"acknowledgements": {}},
            {"expected_revision": True}, {"acknowledgements": {**self.body["acknowledgements"], "hypothetical_only": True}}):
            with self.assertRaises(ValueError): consent.enqueue_correction_consent(self.db, "w", OWNER, {**self.body, **changes}, now=AT)
        with self.assertRaises(ValueError): consent.enqueue_correction_consent(self.db, "w", OWNER, self.value["request"], now=AT)
        with self.assertRaises(ValueError): consent.enqueue_correction_consent(self.db, "w", "foreign", self.body, now=AT)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_self_resealed_cached_economic_result_is_not_confirmation_evidence(self):
        self.seed(tamper=True); result = self.finish(self.enqueue())
        self.assertEqual(result["outcome"], "rejected"); self.assertEqual(result["code"], "CORRECTION_CONSENT_CHANGED")
        self.assertEqual(self.rows("investor_correction_consents"), []); self.assert_no_finance()

    def test_retain_is_still_a_hypothesis_not_a_resolution_of_known_source_difference(self):
        self.seed(retain=True); result = self.finish(self.enqueue())
        self.assertEqual(result["outcome"], "rejected"); self.assertEqual(result["code"], "CORRECTION_CONSENT_UNRESOLVED")
        self.assertEqual(self.rows("investor_correction_consents"), [])

    def test_late_source_withdrawal_rejects_at_short_commit_and_leaves_no_partial_baseline_or_revision(self):
        self.seed(); request = self.enqueue(); consent.discover_correction_consents(self.db, now=AT)
        lease = claim_job(self.db, "fictional-consent-lease", job_type=consent.JOB_TYPE, lease_seconds=300, now=AT)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        times = [AT]; original = consent._prepare_action_correction_impact; no_lock = []
        def prepare(*args, **kwargs):
            other = open_database(self.path)
            try: other.execute("BEGIN IMMEDIATE"); other.rollback(); no_lock.append(True)
            finally: other.close()
            return original(*args, **kwargs)
        with patch.object(consent, "_prepare_action_correction_impact", side_effect=prepare):
            descriptor = consent.prepare_correction_consent_job(self.db, job, lease, clock=lambda: times[0])
        self.assertTrue(no_lock); before = self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        other = open_database(self.path)
        try: eodhd_sources.set_authority_enabled(other, "w", OWNER, self.value["member"]["eodhd_authority_id"], False, now=AT)
        finally: other.close()
        times[0] = COMMIT; complete_job(self.db, lease, {}, effect=descriptor["effect"], now=COMMIT, clock=lambda: times[0])
        result = json.loads(self.db.execute("SELECT document_json FROM investor_correction_consent_results WHERE request_id=?", (request["request_id"],)).fetchone()[0])
        self.assertEqual(result["outcome"], "rejected"); self.assertEqual(self.rows("investor_correction_consents"), [])
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0], before)
        self.assert_no_finance()

    def test_prepare_and_commit_use_distinct_instants_without_backdating_knowledge_or_replaying_the_job(self):
        self.seed(); request = self.enqueue(); consent.discover_correction_consents(self.db, now=AT)
        lease = claim_job(self.db, "fictional-moving-clock", job_type=consent.JOB_TYPE, lease_seconds=300, now=AT)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone()); times = [AT]
        descriptor = consent.prepare_correction_consent_job(self.db, job, lease, clock=lambda: times[0]); times[0] = COMMIT
        complete_job(self.db, lease, {}, effect=descriptor["effect"], now=COMMIT, clock=lambda: times[0])
        row = self.db.execute("SELECT id FROM investor_correction_consents WHERE request_id=?", (request["request_id"],)).fetchone(); self.assertIsNotNone(row)
        reader = open_database(self.path, read_only=True)
        try:
            receipt = consent._registered_correction_document(reader, "w", OWNER, row[0], COMMIT)
            self.assertEqual(receipt["baseline"]["knowledge_at"], AT); self.assertEqual(receipt["created_at"], COMMIT); self.assertEqual(reader.total_changes, 0)
        finally: reader.close()
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("DELETE FROM investor_correction_consents WHERE id=?", (row[0],))

    def test_failure_after_baseline_insert_rolls_back_baseline_audit_revision_and_never_retries_the_job(self):
        self.seed(); request = self.enqueue(); before = self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]
        audits = self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_confirm_correction'").fetchone()[0]
        self.db.execute("CREATE TRIGGER fictional_consent_result_failure BEFORE INSERT ON investor_correction_consent_results BEGIN SELECT RAISE(ABORT,'fictional late failure'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fictional late failure"):
            run_pending_once(self.db, "fictional-consent-atomic-failure", clock=lambda: AT)
        job = self.db.execute("SELECT * FROM job_runs WHERE job_type=? AND scope='w' AND period=?", (consent.JOB_TYPE, request["request_id"])).fetchone()
        self.assertEqual((job["job_type"], job["status"], job["attempt_count"], job["max_attempts"]), (consent.JOB_TYPE, "failed", 1, 1))
        self.assertEqual(self.rows("investor_correction_consents"), []); self.assertEqual(self.rows("investor_correction_consent_results"), [])
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0], before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_confirm_correction'").fetchone()[0], audits)
        self.assertEqual(consent.discover_correction_consents(self.db, now=AT), [])
        self.assertEqual(consent.enqueue_correction_consent(self.db, "w", OWNER, self.body, now=AT), request)
        self.assert_no_finance()

    def test_expired_queued_consent_does_not_replay_sources_or_publish_a_baseline(self):
        self.seed(); request = self.enqueue(); later = "2026-11-07T06:05:04.003Z"
        with patch.object(consent, "_prepare_action_correction_impact", side_effect=AssertionError("NO_LATE_SOURCE_REPLAY")) as heavy:
            done = run_pending_once(self.db, "fictional-expired-consent", clock=lambda: later)
        self.assertEqual((done["job_type"], done["status"]), (consent.JOB_TYPE, "succeeded")); heavy.assert_not_called()
        row = self.db.execute("SELECT document_json FROM investor_correction_consent_results WHERE request_id=?", (request["request_id"],)).fetchone()
        result = json.loads(row[0]); self.assertEqual(result["code"], "CORRECTION_CONSENT_EXPIRED")
        self.assertEqual(self.rows("investor_correction_consents"), []); self.assert_no_finance()


if __name__ == "__main__": unittest.main()
