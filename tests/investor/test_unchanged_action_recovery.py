"""Fictional failed capture -> new-day reports -> explicit immutable recovery."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_action_review_workflow as prior
from tests.investor import test_managed_actions as fixture
from tests.investor.test_reviewed_action_successor import UpdatedCollector
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import action_review_jobs as jobs, action_review_workflow as workflow, managed_actions, unchanged_action_recovery as recovery
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, open_database
from worker.orchestration.jobs import run_one


AT, CONFIRM = prior.AT, prior.CONFIRM


class UnchangedActionRecoveryTests(unittest.TestCase):
    setUp = prior.ActionReviewWorkflowTests.setUp
    prepare = prior.ActionReviewWorkflowTests.prepare
    policy = prior.ActionReviewWorkflowTests.policy
    grant = prior.ActionReviewWorkflowTests.grant
    next_source_day = prior.ActionReviewWorkflowTests.next_source_day
    revision = prior.ActionReviewWorkflowTests.revision
    assert_no_finance = prior.ActionReviewWorkflowTests.assert_no_finance

    def failed_source_day(self, *, publish=True):
        grant = self.db.execute("SELECT * FROM investor_issuer_authorities WHERE id=?", (self.member["issuer_authority_id"],)).fetchone()
        schedule = fixture.issuer_schedule.register_schedule(self.db, "w", "synthetic-investor",
            fixture.schedule_fixture.scheduled(grant, valid_from=fixture.AT, lookback_days=365), now=fixture.AT)
        fixture.issuer_schedule.set_schedule_enabled(self.db, "w", "synthetic-investor", schedule["id"], True, now=fixture.AT)
        fixture.issuer_schedule.discover_issuer_requests(self.db, now=fixture.LATER)
        with patch.object(fixture.issuer_sources.receiver, "collect_vanguard_distribution_draft", side_effect=WorkbenchError("FICTIONAL_TRANSPORT_FAILURE")) as collector:
            failed = run_one(self.db, "fictional-recovery-failed-source", lambda job, lease: fixture.issuer_schedule.prepare_issuer_capture(
                self.db, job, lease, clock=lambda: fixture.LATER), job_type=fixture.issuer_schedule.JOB_TYPE, lease_seconds=180, clock=lambda: fixture.LATER)
        collector.assert_called_once(); self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["attempt_count"], 1); self.assertEqual(failed["max_attempts"], 1)
        if publish:
            result = managed_actions.publish_current_actions(self.db, now=fixture.LATER)
            self.assertEqual(result[0]["failure_code"], "SOURCE_CAPTURE_TERMINAL_FAILURE")
        return failed

    def ready(self, *, fail=True, new_event=False, correction=False):
        self.prepare(); self.grant()
        self.assertEqual(managed_actions.publish_current_actions(self.db, now=fixture.AT)[0]["status"], "published")
        if fail: self.failed_source_day()
        records = [row("987.1235" if correction else "987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30")]
        if new_event: records.append(row("4.32109", exDividendDate="2026-11-02", recordDate="2026-11-02", payableDate="2026-11-09"))
        collector = UpdatedCollector if new_event else fixture.fixture.ActionCollector
        with patch.object(fixture, "LATER", "2026-11-03T06:00:03.000Z"), patch.object(fixture.fixture, "ActionCollector", collector), \
                patch.object(UpdatedCollector, "event_day", "2026-11-02"):
            self.next_source_day(issuer_raw=archive(*records))
        self.preview = workflow.register_action_review_preview(self.db, "w", "synthetic-investor", {
            "authority_id": self.authority["id"], "expected_revision": self.revision(), "idempotency_key": "fictional-recovery-preview"}, now=AT)
        return self.preview

    def answers(self, *, enable=False):
        failure = recovery.failure_witness(self.db, "w", self.authority["id"], AT)
        return {"schema_version": recovery.SUBMIT, "preview_id": self.preview["preview_id"], "expected_revision": self.revision(),
            "idempotency_key": "fictional-recovery-confirm", "enable_rule": enable,
            **{key: failure[key] for key in ("failed_publication_id", "failed_publication_hash")},
            "acknowledgements": {key: True for key in ("unchanged_economic_events_and_tax", "source_overlap_and_old_differences_unchanged",
                "reported_coverage_not_objective_absence", "original_failure_and_history_retained", "separate_current_data_readmission", "register_new_default_off_rule")}}

    def test_real_stored_failure_then_later_unchanged_reports_create_default_off_successor_without_erasing_failure(self):
        self.ready(); request = self.answers()
        original = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_action_publications ORDER BY rowid")]
        result = workflow.confirm_action_review(self.db, "w", "synthetic-investor", request, now=CONFIRM)
        self.assertEqual(result["schema_version"], recovery.CONFIRMATION)
        self.assertEqual(result["append_proof"]["added_event_count"], 0)
        self.assertEqual(original, [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_action_publications ORDER BY rowid")])
        for key in ("previous_authority_id", "new_authority_id"):
            self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (result[key],)).fetchone()[0], 0)
        self.assertTrue(managed_actions._quarantined(self.db, "w", self.authority["id"], CONFIRM))
        stored = workflow.resolve_action_review_confirmation(self.db, "w", "synthetic-investor", result["confirmation_id"], now=CONFIRM)
        self.assertEqual(stored, result)
        current = self.db.execute("SELECT document_json FROM investor_data_reviews WHERE id=?", (result["new_review_id"],)).fetchone()[0]
        self.assertEqual(json.loads(current)["facts"]["events"], self.base_facts["events"])
        self.assertEqual(json.loads(current)["facts"]["tax_assumption"], self.base_facts["tax_assumption"])
        self.assertFalse(result["research_admitted"]); self.assertFalse(result["quarantine_cleared"]); self.assert_no_finance()

    def test_original_nonempty_protocols_stay_closed_and_recovery_cannot_smuggle_event_or_tax_answers(self):
        self.ready(); request = self.answers(); before = list(self.db.iterdump())
        old = {"schema_version": "investor-action-review-submit-v1", "preview_id": self.preview["preview_id"],
            "expected_revision": self.revision(), "idempotency_key": "fictional-empty-append", "enable_rule": False,
            "new_events": [], "acknowledgements": prior.ActionReviewWorkflowTests.answers(self)["acknowledgements"]}
        with self.assertRaises(ValueError): validate_contract(old, workflow.SCHEMA, fragment="$defs/submit")
        for changes in ({"new_events": []}, {"tax_per_unit": "0"}, {"failed_publication_hash": "a" * 64},
                {"acknowledgements": {**request["acknowledgements"], "unchanged_economic_events_and_tax": False}}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                workflow.confirm_action_review(self.db, "w", "synthetic-investor", {**request, **changes}, now=CONFIRM)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_exact_retry_recovers_same_receipt_and_explicit_enable_is_separate(self):
        self.ready(); request = self.answers(enable=True)
        value = workflow.confirm_action_review(self.db, "w", "synthetic-investor", request, now=CONFIRM)
        before = list(self.db.iterdump())
        self.assertEqual(workflow.confirm_action_review(self.db, "w", "synthetic-investor", request, now="2026-11-03T06:02:00.000Z"), value)
        self.assertEqual(before, list(self.db.iterdump()))
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE id=?", (value["new_control_id"],)).fetchone()[0], 1)
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"):
            workflow.confirm_action_review(self.db, "w", "synthetic-investor", {**request, "enable_rule": False}, now=CONFIRM)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_unblocked_rule_cannot_be_forked_as_a_recovery(self):
        self.ready(fail=False); before = list(self.db.iterdump())
        request = {"schema_version": recovery.SUBMIT, "preview_id": self.preview["preview_id"], "expected_revision": self.revision(),
            "idempotency_key": "fictional-no-failure", "enable_rule": False, "failed_publication_id": "fictional-missing", "failed_publication_hash": "a" * 64,
            "acknowledgements": {key: True for key in ("unchanged_economic_events_and_tax", "source_overlap_and_old_differences_unchanged",
                "reported_coverage_not_objective_absence", "original_failure_and_history_retained", "separate_current_data_readmission", "register_new_default_off_rule")}}
        with self.assertRaisesRegex(WorkbenchError, "RECOVERY_REQUIRES_ORIGINAL_FAILURE"):
            workflow.confirm_action_review(self.db, "w", "synthetic-investor", request, now=CONFIRM)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_new_reported_action_cannot_use_the_unchanged_protocol(self):
        self.ready(new_event=True); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "SEPARATE_HISTORICAL_REVIEW_REQUIRED"):
            workflow.confirm_action_review(self.db, "w", "synthetic-investor", self.answers(), now=CONFIRM)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_historical_correction_cannot_use_the_unchanged_protocol(self):
        self.ready(correction=True); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "SEPARATE_HISTORICAL_REVIEW_REQUIRED"):
            workflow.confirm_action_review(self.db, "w", "synthetic-investor", self.answers(), now=CONFIRM)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_readonly_retained_lineage_and_old_event_knowledge_replay_independently_of_the_receipt(self):
        self.ready(); result = workflow.confirm_action_review(self.db, "w", "synthetic-investor", self.answers(), now=CONFIRM)
        reader = open_database(self.path, read_only=True)
        try:
            from worker.investor.retained_action_lineage import _confirmation
            self.assertEqual(_confirmation(reader, "w", "synthetic-investor", result["confirmation_id"], CONFIRM)[0], result)
            from worker.investor.data_evidence import resolve_review
            reviewed = resolve_review(reader, "w", result["new_review_id"], "actions", now=CONFIRM)
            origins = workflow._confirmed_event_origins(reader, "w", reviewed, CONFIRM)
            self.assertEqual(origins["fictional-dividend"]["original_review_id"], self.base["id"])
            self.assertEqual(reader.total_changes, 0)
        finally: reader.close()

    def test_newly_withdrawn_source_rolls_back_prepared_recovery_instead_of_trusting_cached_comparison(self):
        self.ready(); effect = workflow.prepare_action_review_confirmation(self.db, "w", "synthetic-investor", self.answers(), now=CONFIRM)
        fixture.eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor", self.member["eodhd_authority_id"], False, now=CONFIRM)
        before = list(self.db.iterdump())
        with self.assertRaises(ValueError): effect(self.db)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_observed_event_or_correction_failures_cannot_be_relabelled_as_transport_recovery(self):
        self.ready(); failure = recovery.failure_witness(self.db, "w", self.authority["id"], AT)
        draft, context = workflow._prepare_action_review_draft(self.db, "w", "synthetic-investor", self.authority["id"], now=AT)
        facts = recovery.recovery_facts(context["prior"]["facts"], context["previous"], context["current"],
            symbol=context["policy"]["provider_symbol"], listing_id=context["policy"]["listing_id"])[0]
        for reason in ("NEW_REPORTED_ACTION", "HISTORICAL_RECORDS_CHANGED", "BASE_FACTS_CHANGED"):
            with self.subTest(reason=reason), self.assertRaisesRegex(WorkbenchError, "RECOVERY_UNSUPPORTED_FAILURE"):
                recovery.check_unchanged_action_recovery(context["prior"]["facts"], facts, context["previous"], context["current"],
                    symbol=context["policy"]["provider_symbol"], listing_id=context["policy"]["listing_id"], knowledge_floor=draft["knowledge_not_before"],
                    reviewed_at=CONFIRM, failure={**failure, "failure_code": reason})
        self.assert_no_finance()


class UnchangedRecoveryReadmissionTests(unittest.TestCase):
    def setUp(self):
        self.case = UnchangedActionRecoveryTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups); self.db = self.case.db

    def test_default_core_requalifies_the_same_model_with_retained_prices_and_no_new_source_attempt(self):
        from tests.investor.test_action_review_readmission import ActionReviewReadmissionTests
        from worker.investor import confirmed_feed, monitor_admission, monitor_data
        from worker.market.providers import longport, longport_confirmed
        from worker.orchestration.runtime import run_pending_once
        ActionReviewReadmissionTests.model(self, known_costs=True)
        failed = self.case.failed_source_day(publish=False)
        ActionReviewReadmissionTests.complete_prices(self)
        blocked = managed_actions.publish_current_actions(self.db, now="2026-11-02T20:02:00.000Z")
        self.assertEqual(blocked[0]["failure_code"], "SOURCE_CAPTURE_TERMINAL_FAILURE")
        with patch.object(fixture, "LATER", "2026-11-03T06:00:03.000Z"):
            self.case.next_source_day()
        self.case.preview = workflow.register_action_review_preview(self.db, "w", "synthetic-investor", {
            "authority_id": self.case.authority["id"], "expected_revision": self.case.revision(), "idempotency_key": "fictional-readmission-recovery"}, now=AT)
        result = workflow.confirm_action_review(self.db, "w", "synthetic-investor", self.case.answers(enable=True), now=CONFIRM)
        frozen = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_monitor_evidence_inputs ORDER BY rowid")]
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=AssertionError("NO_NEW_WATCH")), \
                patch.object(longport, "_collect_isolated", side_effect=AssertionError("NO_HISTORY_RETRY")), \
                patch.object(longport, "read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIAL_READ")):
            completed = run_pending_once(self.db, "fictional-unchanged-recovery-readmission", clock=lambda: CONFIRM)
        self.assertEqual(completed["status"], "succeeded")
        current = monitor_admission.latest_monitor_evidence(self.db, "w", self.definition["model_id"])
        self.assertNotEqual(current["id"], self.seed["id"])
        document = json.loads(current["document_json"])
        self.assertEqual(document["schema_version"], "investor-monitor-data-input-v4")
        self.assertIsNone(monitor_data.resolve_monitor_data(self.db, "w", self.definition, document, now=CONFIRM)["unavailable_reason"])
        self.assertIn(result["new_review_id"], [ref["review_id"] for segment in document["segments"] for ref in segment["snapshot"]["review_refs"]])
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_monitor_evidence_inputs ORDER BY rowid")][:len(frozen)], frozen)
        states = [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads ORDER BY rowid")]
        self.assertEqual(len(states), 2)
        for key in ("quantities", "cash_by_currency", "receivables", "entitlements", "processed_actions", "initialized_at"):
            self.assertEqual(states[0][key], states[1][key], key)
        self.assertEqual(tuple(self.db.execute("SELECT status,attempt_count,max_attempts FROM job_runs WHERE id=?", (failed["id"],)).fetchone()), ("failed", 1, 1))
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_confirmed_feed_admissions")], self.admissions)
        self.case.assert_no_finance()


if __name__ == "__main__":
    unittest.main()
