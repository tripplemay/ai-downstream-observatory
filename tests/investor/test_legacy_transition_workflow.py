"""Explicit compatibility consent on fictional retained evidence, never admission."""

from copy import deepcopy
from datetime import timedelta
import sys
import unittest
from unittest.mock import patch

from tests.investor import test_legacy_action_transition as fixture
from worker.investor import legacy_transition_workflow as workflow
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, open_database


class LegacyTransitionWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch("socket.create_connection", side_effect=AssertionError("NO_NETWORK")))
        self.enterContext(patch("socket.getaddrinfo", side_effect=AssertionError("NO_DNS")))
        self.enterContext(patch("worker.market.providers.longport.read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIAL_READ")))
        self.case = fixture.LegacyActionTransitionTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.db = self.case.db; self.case.prepare()
        self.model_id = self.case.case.definition["model_id"]
        self.at = workflow._clock(instant(fixture.CONFIRM) + timedelta(milliseconds=1))

    def revision(self):
        return self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]

    def witness(self):
        self.preview_request = {"model_id": self.model_id, "expected_revision": self.revision(), "idempotency_key": "fictional-legacy-preview"}
        self.preview = workflow.register_legacy_transition_preview(self.db, "w", "synthetic-investor", self.preview_request, now=self.at)
        return self.preview

    def answers(self):
        return {"schema_version": "investor-legacy-transition-submit-v1", "preview_id": self.preview["preview_id"],
            "expected_preview_hash": content_hash(self.preview), "expected_revision": self.preview["workspace_revision"],
            "idempotency_key": "fictional-legacy-confirmation", "acknowledgements": {key: True for key in
                ("preserve_original_accounting_and_knowledge", "revalidate_current_sources_on_every_use",
                 "new_actions_keep_audited_knowledge", "quality_gaps_are_not_current_advice", "research_only_no_trading")}}

    def confirm(self, request=None, **kwargs):
        return workflow.confirm_legacy_transition(self.db, "w", "synthetic-investor", request or self.answers(), now=self.at, **kwargs)

    def test_explicit_receipt_keeps_all_original_rows_and_does_not_admit_or_activate_anything(self):
        tables = ("investor_models", "investor_model_controls", "investor_monitor_evidence_inputs", "investor_evidence_model_checkpoints",
            "investor_evidence_checkpoint_payloads", "investor_confirmed_feed_admissions", "job_runs")
        before = {table: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in tables}
        self.witness(); value = self.confirm()
        self.assertEqual(value["protocol"], "preserve_original_processed_action_knowledge_v1")
        self.assertEqual(value["workspace_revision"], self.preview["workspace_revision"] + 1)
        for key in ("research_admitted", "monitoring_activated", "trading_permission", "raw_ai_sharing"):
            self.assertIs(value[key], False)
        self.assertTrue(value["monitor_data_readmission_required"]); self.assertEqual(value["provider_calls"], 0)
        self.assertEqual(before, {table: [list(row) for row in self.db.execute("SELECT rowid,* FROM " + table)] for table in tables})
        readonly = open_database(self.case.case.case.path, read_only=True)
        try:
            self.assertEqual(workflow.resolve_legacy_transition_confirmation(readonly, "w", "synthetic-investor", value["confirmation_id"], now=self.at), value)
            self.assertEqual(readonly.total_changes, 0)
        finally: readonly.close()
        self.case.case.case.assert_no_finance()

    def test_lost_response_returns_the_original_receipt_without_reapproving_withdrawn_sources(self):
        self.witness(); request = self.answers(); value = self.confirm(request); before = list(self.db.iterdump())
        later = workflow._clock(instant(self.at) + timedelta(days=1))
        with patch.object(workflow, "_prepare_legacy_action_transition", side_effect=AssertionError("NO_REAPPROVAL")):
            self.assertEqual(workflow.confirm_legacy_transition(self.db, "w", "synthetic-investor", request, now=later), value)
        self.assertEqual(before, list(self.db.iterdump()))
        changed = deepcopy(request); changed["expected_preview_hash"] = "0" * 64
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"): self.confirm(changed)

    def test_false_missing_extra_acknowledgements_and_client_data_never_imply_consent(self):
        self.witness(); before = list(self.db.iterdump())
        for mode in ("false", "missing", "extra", "prices", "clock"):
            request = self.answers()
            if mode == "false": request["acknowledgements"]["research_only_no_trading"] = False
            elif mode == "missing": del request["acknowledgements"]["new_actions_keep_audited_knowledge"]
            elif mode == "extra": request["acknowledgements"]["trading"] = True
            elif mode == "prices": request["quotes"] = []
            else: request["now"] = self.at
            with self.subTest(mode=mode), self.assertRaises(ValueError): self.confirm(request)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_expiry_revision_preview_hash_and_stop_are_checked_before_any_receipt_is_written(self):
        self.witness(); before = list(self.db.iterdump())
        bad = self.answers(); bad["expected_preview_hash"] = "0" * 64
        with self.assertRaisesRegex(WorkbenchError, "PREVIEW_CHANGED"): self.confirm(bad)
        bad = self.answers(); bad["expected_revision"] -= 1
        with self.assertRaisesRegex(WorkbenchError, "VERSION_CONFLICT"): self.confirm(bad)
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"): self.confirm(stop_requested=lambda: True)
        with self.assertRaisesRegex(WorkbenchError, "PREVIEW_EXPIRED"):
            workflow.confirm_legacy_transition(self.db, "w", "synthetic-investor", self.answers(), now=self.preview["valid_until"])
        self.assertEqual(before, list(self.db.iterdump()))

    def test_late_failure_and_recovery_read_only_fences_roll_back_the_whole_confirmation(self):
        self.witness(); self.db.execute("CREATE TRIGGER fictional_legacy_abort BEFORE INSERT ON investor_legacy_transition_confirmations BEGIN SELECT RAISE(ABORT,'fictional late legacy failure'); END")
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(Exception, "fictional late legacy failure"): self.confirm()
        self.assertEqual(before, list(self.db.iterdump()))
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "READ_ONLY"): self.confirm()
        self.assertEqual(before, list(self.db.iterdump()))

    def test_confirmation_rebuilds_the_full_basis_instead_of_trusting_an_earlier_summary(self):
        self.witness(); original = workflow._prepare_legacy_action_transition
        def changed(*args, **kwargs):
            value = original(*args, **kwargs); value["preview"]["settings_hash"] = "f" * 64; return value
        before = list(self.db.iterdump())
        with patch.object(workflow, "_prepare_legacy_action_transition", side_effect=changed), self.assertRaisesRegex(WorkbenchError, "BASIS_CHANGED"):
            self.confirm()
        self.assertEqual(before, list(self.db.iterdump()))

    def test_prepared_confirmation_is_fenced_after_a_real_second_connection_withdraws_the_source(self):
        from worker.investor import eodhd_sources
        self.witness(); prepared = workflow.prepare_legacy_transition_confirmation(self.db, "w", "synthetic-investor", self.answers(), now=self.at)
        other = open_database(self.case.case.case.path)
        try:
            eodhd_sources.set_authority_enabled(other, "w", "synthetic-investor", self.case.case.case.member["eodhd_authority_id"], False, now=self.at)
        finally: other.close()
        before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): prepared(self.db)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_idempotent_witness_lookup_cannot_renew_its_original_five_minute_deadline(self):
        self.witness(); before = list(self.db.iterdump())
        later = workflow._clock(instant(self.at) + timedelta(days=1))
        self.assertEqual(workflow.register_legacy_transition_preview(self.db, "w", "synthetic-investor", self.preview_request, now=later), self.preview)
        with self.assertRaisesRegex(WorkbenchError, "PREVIEW_EXPIRED"):
            workflow.resolve_legacy_transition_preview(self.db, "w", "synthetic-investor", self.preview["preview_id"], now=later)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_later_server_time_rebuilds_clock_derived_hashes_but_never_changes_the_confirmed_basis(self):
        self.witness(); later = workflow._clock(instant(self.at) + timedelta(seconds=2))
        self.assertEqual(workflow.resolve_legacy_transition_preview(self.db, "w", "synthetic-investor", self.preview["preview_id"], now=later), self.preview)
        value = workflow.confirm_legacy_transition(self.db, "w", "synthetic-investor", self.answers(), now=later)
        self.assertEqual(value["created_at"], later)
        self.assertEqual(workflow.resolve_legacy_transition_confirmation(self.db, "w", "synthetic-investor", value["confirmation_id"], now=later), value)
        self.assertEqual(value["carry_hash"], self.preview["proof"]["carry_hash"])

    def test_supplier_withdrawal_fences_fresh_confirmation_and_current_receipt_use_but_not_historical_lookup(self):
        from worker.investor import eodhd_sources
        self.witness(); request = self.answers(); value = self.confirm(request)
        eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor", self.case.case.case.member["eodhd_authority_id"], False, now=self.at)
        before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError):
            workflow.resolve_legacy_transition_confirmation(self.db, "w", "synthetic-investor", value["confirmation_id"], now=self.at)
        self.assertEqual(self.confirm(request), value)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_prepare_is_not_commit_and_late_clock_expiry_or_restore_marker_never_writes_consent(self):
        self.witness(); before = list(self.db.iterdump())
        ticks = iter([self.at, self.at, self.preview["valid_until"]])
        prepared = workflow.prepare_legacy_transition_confirmation(self.db, "w", "synthetic-investor", self.answers(), clock=lambda: next(ticks))
        self.assertFalse(self.db.in_transaction); self.assertEqual(before, list(self.db.iterdump()))
        with self.assertRaisesRegex(WorkbenchError, "PREVIEW_EXPIRED"): prepared(self.db)
        self.assertEqual(before, list(self.db.iterdump()))
        marker = self.case.case.case.path.parent / "RESTORE_PENDING_REVIEW"; calls = [0]
        def restore_clock():
            calls[0] += 1
            if calls[0] == 3: marker.touch()
            return self.at
        try:
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                workflow.confirm_legacy_transition(self.db, "w", "synthetic-investor", self.answers(), clock=restore_clock)
        finally: marker.unlink(missing_ok=True)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_immutable_records_and_owner_binding_do_not_depend_on_the_caller_replaying_a_summary(self):
        self.witness(); value = self.confirm(); before = list(self.db.iterdump())
        for table in ("investor_legacy_transition_previews", "investor_legacy_transition_confirmations"):
            for statement in ("UPDATE " + table + " SET actor_id='other'", "DELETE FROM " + table):
                with self.assertRaisesRegex(Exception, "immutable"): self.db.execute(statement)
        with patch.object(workflow, "_original_chain", side_effect=AssertionError("OWNER_BEFORE_PRIVATE_REPLAY")):
            with self.assertRaises(WorkbenchError):
                workflow.resolve_legacy_transition_confirmation(self.db, "w", "other", value["confirmation_id"], now=self.at)
        self.assertEqual(before, list(self.db.iterdump()))


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        case = LegacyTransitionWorkflowTests(); case.setUp()
        try:
            witness = case.witness(); request = case.answers(); confirmation = case.confirm(request)
            print(canonical_json({"preview_request": case.preview_request, "preview": witness, "submit": request, "confirmation": confirmation}))
        finally: case.doCleanups()
    else: unittest.main()
