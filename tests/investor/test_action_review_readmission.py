"""Explicit review -> ordinary core -> new input on fictional retained receipts."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import action_reconciliation_fixture as source_fixture, test_action_refresh as refresh_fixture
from tests.investor import test_action_review_workflow as review_fixture, test_managed_actions as managed_fixture
from tests.investor.test_reviewed_action_successor import UpdatedCollector
from tests.investor.confirmed_capture_fixture import FictionalReceiver
from tests.investor.fixtures import monitor_input
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import confirmed_capture, confirmed_feed, data_evidence, monitor_admission, monitor_data
from worker.market.providers import longport, longport_confirmed
from worker.orchestration.db import WorkbenchError, instant
from worker.orchestration.runtime import run_pending_once


AT, CONFIRM = review_fixture.AT, review_fixture.CONFIRM


class ActionReviewReadmissionTests(unittest.TestCase):
    def setUp(self):
        self.case = review_fixture.ActionReviewWorkflowTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups); self.db = self.case.db

    def model(self, *, audited=True, known_costs=False):
        self.definition, self.seed, self.old = refresh_fixture.ActionRefreshTests.model_and_prices(self.case, audited=audited, calendar_end="2026-11-06",
            explicit_costs=monitor_input()["policy"]["costs"] if known_costs else None)
        self.assertEqual(run_pending_once(self.db, "fictional-initial-review-core", clock=lambda: managed_fixture.AT)["status"], "succeeded")
        self.checkpoints = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_model_checkpoints")]
        self.assertEqual(len(self.checkpoints), 1)

    def complete_prices(self):
        start, end = "2026-11-02T19:58:00.000Z", "2026-11-02T20:01:02.000Z"
        confirmed_feed.discover_confirmed_watches(self.db, now=start)
        times = [start]
        receiver = FictionalReceiver(now=start, received_at=end, during=lambda: times.__setitem__(0, end))
        millis, parse_time = confirmed_capture._milliseconds, confirmed_capture.instant
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kwargs: receiver(request, kwargs["stop_requested"])), \
                patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(times[0] if value is None else value)), \
                patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse_time(times[0] if value is None else value)), \
                patch.object(longport, "_collect_isolated", side_effect=AssertionError("NO_HISTORY_FALLBACK")), \
                patch.object(longport, "read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIAL_READ")):
            result = run_pending_once(self.db, "fictional-completed-before-review", role="longport", clock=lambda: times[0])
        self.assertEqual(result["status"], "succeeded"); self.assertEqual(receiver.calls, 1)
        confirmed_feed.admit_completed_feeds(self.db, now=end)
        self.admissions = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_confirmed_feed_admissions")]
        self.assertEqual(len(self.admissions), 1)

    def confirm(self):
        raw = archive(row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30"),
            row("4.32109", exDividendDate="2026-11-02", recordDate="2026-11-02", payableDate="2026-11-09"))
        with patch.object(managed_fixture, "LATER", "2026-11-03T06:00:03.000Z"), patch.object(source_fixture, "ActionCollector", UpdatedCollector), \
                patch.object(UpdatedCollector, "event_day", "2026-11-02"):
            self.case.next_source_day(issuer_raw=raw)
        self.case.witness(); self.confirmed = self.case.confirm(); return self.confirmed

    def test_default_core_rebuilds_v4_from_completed_prices_and_explicit_review_preserving_old_inputs_checkpoints_and_attempts(self):
        self.check_core_readmission()

    def test_a_checkpoint_using_an_earlier_linked_publication_replays_without_adopting_the_later_publication_time(self):
        self.check_core_readmission(intermediate_publication=True)

    def check_core_readmission(self, *, intermediate_publication=False):
        self.model(known_costs=True)
        if intermediate_publication:
            self.case.next_source_day()
            published = review_fixture.workflow.managed.publish_current_actions(self.db, now=managed_fixture.LATER)
            self.assertEqual(published[0]["status"], "published"); self.assertNotEqual(published[0]["publication_id"], self.old)
        self.complete_prices(); confirmed = self.confirm()
        frozen_inputs = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_monitor_evidence_inputs")]
        original = json.loads(self.seed["document_json"])
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, original, now=CONFIRM)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        with self.assertRaises(WorkbenchError): confirmed_feed._seed(self.db, "w", self.definition["model_id"], self.seed["id"], CONFIRM)
        context = confirmed_feed._source_refresh_context(self.db, "w", self.definition["model_id"], self.seed["id"], CONFIRM)
        windows = confirmed_feed._windows(self.db, "w", context[5])
        confirmed_feed._merge_completed(self.db, "w", self.definition["model_id"], windows, CONFIRM)
        confirmed_feed._refresh_fx_windows(self.db, "w", self.definition, windows, context[5]["settings"], CONFIRM)
        confirmed_feed._refresh_action_windows(self.db, "w", self.definition, windows, CONFIRM)
        self.assertEqual(windows[0][1]["end_date"], "2026-11-02")
        from worker.investor.evidence_monitor_runtime import resolve_checkpoint
        checkpoint = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()
        replayed, reason = resolve_checkpoint(self.db, "w", self.definition, checkpoint["id"], CONFIRM)
        self.assertIsNone(reason); self.assertIsNotNone(replayed)
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=AssertionError("NO_NEW_WATCH")), \
                patch.object(longport, "_collect_isolated", side_effect=AssertionError("NO_SOURCE_RETRY")), \
                patch.object(longport, "read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIAL_READ")):
            result = run_pending_once(self.db, "fictional-reviewed-readmission-core", clock=lambda: CONFIRM)
        self.assertIsNotNone(result); self.assertEqual(result["status"], "succeeded")
        latest = monitor_admission.latest_monitor_evidence(self.db, "w", self.definition["model_id"])
        self.assertNotEqual(latest["id"], self.seed["id"])
        document = json.loads(latest["document_json"]); self.assertEqual(document["schema_version"], "investor-monitor-data-input-v4")
        self.assertEqual(document["settings"], original["settings"])
        actual = monitor_data.resolve_monitor_data(self.db, "w", self.definition, document, now=CONFIRM)
        self.assertIsNone(actual["unavailable_reason"]); self.assertEqual({row["observed_at"] for row in actual["projection"]["quotes"]}, {"2026-11-02T20:00:00.000Z"})
        self.assertIn(confirmed["new_review_id"], [ref["review_id"] for segment in document["segments"] for ref in segment["snapshot"]["review_refs"]])
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_monitor_evidence_inputs ORDER BY rowid")][:len(frozen_inputs)], frozen_inputs)
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_model_checkpoints ORDER BY rowid")][:len(self.checkpoints)], self.checkpoints)
        checkpoints = self.db.execute("SELECT c.*,p.payload FROM investor_evidence_model_checkpoints c JOIN investor_evidence_checkpoint_payloads p ON p.checkpoint_id=c.id ORDER BY c.sequence").fetchall()
        self.assertEqual(len(checkpoints), 2)
        old_state, new_state = [json.loads(row["payload"]) for row in checkpoints]
        self.assertEqual(checkpoints[1]["previous_hash"], checkpoints[0]["content_hash"])
        self.assertEqual(new_state["initialized_at"], old_state["initialized_at"])
        self.assertEqual({key:new_state["processed_actions"][key] for key in old_state["processed_actions"]}, old_state["processed_actions"])
        self.assertGreater(len(new_state["processed_actions"]), len(old_state["processed_actions"])); self.assertEqual(len(new_state["receivables"]), 1)
        run = self.db.execute("SELECT r.checkpoint_id,q.input_id FROM investor_evidence_monitor_runs r JOIN investor_evidence_monitor_requests q ON q.id=r.request_id ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1").fetchone()
        self.assertEqual(run["input_id"], latest["id"]); self.assertEqual(run["checkpoint_id"], checkpoints[1]["id"])
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, original, now=CONFIRM)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_confirmed_feed_admissions")], self.admissions)
        attempt = self.db.execute("SELECT attempt_count,max_attempts FROM job_runs WHERE job_type=? AND status='succeeded'", (confirmed_feed.JOB_TYPE,)).fetchone()
        self.assertEqual(tuple(attempt), (1, 1)); self.case.assert_no_finance()

    def test_legacy_input_requires_its_own_checkpoint_protocol_instead_of_switching_hashes_or_resetting_the_model(self):
        self.model(audited=False); self.confirm(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "ACTION_PROTOCOL_REVIEW_REQUIRED"):
            confirmed_feed._source_refresh_context(self.db, "w", self.definition["model_id"], self.seed["id"], CONFIRM)
        self.assertEqual(confirmed_feed.refresh_monitor_sources(self.db, now=CONFIRM), [])
        self.assertEqual(before, list(self.db.iterdump())); self.case.assert_no_finance()

    def test_review_does_not_guess_missing_costs_or_turn_a_valid_new_input_into_a_usable_decision(self):
        self.model(); self.complete_prices(); self.confirm()
        run_pending_once(self.db, "fictional-unknown-cost-review-core", clock=lambda: CONFIRM)
        latest = monitor_admission.latest_monitor_evidence(self.db, "w", self.definition["model_id"])
        self.assertNotEqual(latest["id"], self.seed["id"])
        run = json.loads(self.db.execute("SELECT document_json FROM investor_evidence_monitor_runs ORDER BY created_at DESC,rowid DESC LIMIT 1").fetchone()[0])
        self.assertEqual(run["status"], "blocked"); self.assertEqual(run["reason_codes"], ["CANNOT_COMPARE_CHANGE_COST"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_checkpoint_payloads").fetchone()[0], 1)
        self.case.assert_no_finance()

    def test_checkpoint_replay_is_exactly_bound_and_scope_is_cleared_when_the_old_projection_rebuild_fails(self):
        from worker.investor.action_checkpoint_replay import checkpoint_action_review, replay_checkpoint_monitor_source
        self.model(known_costs=True); self.confirm()
        header = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone(); document = json.loads(self.seed["document_json"])
        with self.assertRaises(WorkbenchError): replay_checkpoint_monitor_source(self.db, "w", self.definition, {**dict(header),"projection_hash":"0"*64}, document, CONFIRM)
        before = list(self.db.iterdump())
        def failed(*args, **kwargs):
            self.assertIsNotNone(checkpoint_action_review(self.db, "w", self.old, "actions", CONFIRM))
            raise WorkbenchError("FICTIONAL_REPLAY_FAILURE")
        with patch.object(monitor_data, "build_monitor_data", side_effect=failed), self.assertRaisesRegex(WorkbenchError,"FICTIONAL_REPLAY_FAILURE"):
            replay_checkpoint_monitor_source(self.db, "w", self.definition, header, document, CONFIRM)
        self.assertIsNone(checkpoint_action_review(self.db, "w", self.old, "actions", CONFIRM))
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, document, now=CONFIRM)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertEqual(list(self.db.iterdump()), before); self.case.assert_no_finance()

    def test_source_retirement_alone_does_not_authorize_deletion_but_supplier_withdrawal_still_does(self):
        from worker.investor import eodhd_sources, source_retention
        self.model(); confirmed = self.confirm()
        payloads = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_checkpoint_payloads")]
        self.assertEqual(source_retention.purge_due_source_payloads(self.db, now=CONFIRM), [])
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_checkpoint_payloads")], payloads)
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, json.loads(self.seed["document_json"]), now=CONFIRM)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor", self.case.member["eodhd_authority_id"], False, now=CONFIRM)
        purged = source_retention.purge_due_source_payloads(self.db, now=CONFIRM)
        self.assertTrue(any(row.get("kind")=="checkpoint" for row in purged))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_checkpoint_payloads").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (confirmed["previous_authority_id"],)).fetchone()[0], 0)
        self.case.assert_no_finance()

    def test_source_withdrawal_after_monitor_preparation_cannot_commit_a_checkpoint_or_observation(self):
        from worker.investor import eodhd_sources, evidence_monitor_runtime
        from worker.orchestration.db import open_database
        self.model(known_costs=True); self.complete_prices(); self.confirm()
        inputs = confirmed_feed.refresh_monitor_sources(self.db, now=CONFIRM); self.assertEqual(len(inputs), 1)
        original = evidence_monitor_runtime.prepare_evidence_monitor_job; changed = []
        def withdraw(*args, **kwargs):
            prepared = original(*args, **kwargs); other = open_database(self.case.path)
            try: eodhd_sources.set_authority_enabled(other, "w", "synthetic-investor", self.case.member["eodhd_authority_id"], False, now=CONFIRM)
            finally: other.close()
            changed.append(True); return prepared
        before = {table:[list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in
            ("investor_evidence_model_checkpoints","investor_evidence_checkpoint_payloads","investor_evidence_monitor_runs","investor_observations")}
        with patch.object(evidence_monitor_runtime,"prepare_evidence_monitor_job",side_effect=withdraw):
            result = run_pending_once(self.db,"fictional-withdrawal-at-publication",clock=lambda:CONFIRM)
        self.assertTrue(changed); self.assertEqual(result["status"],"skipped")
        for table,rows in before.items(): self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)],rows)
        self.case.assert_no_finance()


if __name__ == "__main__": unittest.main()
