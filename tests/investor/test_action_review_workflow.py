"""Witnessed explicit approvals on fictional sources, no provider or finance calls."""

from copy import deepcopy
from hashlib import sha256
import json
import sys
import unittest
from unittest.mock import patch

from tests.investor import test_action_review_draft as fixture
from tests.investor import action_reconciliation_fixture as source_fixture
from tests.market.test_eodhd_actions import archive as div_archive, dividend
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import action_review_workflow as workflow, eodhd_sources, managed_actions
from worker.investor.data_evidence import resolve_review
from worker.investor.monitor_action_knowledge import _availability_refs
from worker.market.providers.eodhd_actions import parse_eodhd_actions
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, open_database


AT = fixture.AT
CONFIRM = fixture.LATER
EXPIRED = "2026-11-03T06:01:04.000Z"


class ActionReviewWorkflowTests(unittest.TestCase):
    setUp = fixture.ActionReviewDraftTests.setUp
    prepare = fixture.ActionReviewDraftTests.prepare
    policy = fixture.ActionReviewDraftTests.policy
    grant = fixture.ActionReviewDraftTests.grant
    next_source_day = fixture.ActionReviewDraftTests.next_source_day
    retained_reports = fixture.ActionReviewDraftTests.retained_reports
    assert_no_finance = fixture.ActionReviewDraftTests.assert_no_finance

    def revision(self):
        return self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0]

    def witness(self, **changes):
        request = {"authority_id": self.authority["id"], "expected_revision": self.revision(), "idempotency_key": "fictional-preview", **changes}
        self.preview_request = request
        self.preview = workflow.register_action_review_preview(self.db, "w", "synthetic-investor", request, now=AT)
        return self.preview

    def answers(self, **changes):
        return {"schema_version": "investor-action-review-submit-v1", "preview_id": self.preview["preview_id"],
            "expected_revision": self.preview["workspace_revision"], "idempotency_key": "fictional-confirmation",
            "new_events": [{"type": "dividend", "date": "2026-11-02", "at": "2026-11-02T14:30:00Z", "pay_at": "2026-11-09T21:00:00Z", "tax_per_unit": "0.432109"}],
            "acknowledgements": {key: True for key in ("issuer_amount_unit_and_currency", "reported_differences_seen", "explicit_research_instants",
                "explicit_tax_amounts", "unchanged_tax_assumption_applies", "reported_coverage_not_objective_absence", "no_historical_restatement", "register_new_default_off_rule")},
            "enable_rule": False, **changes}

    def confirm(self, request=None, *, now=CONFIRM):
        return workflow.confirm_action_review(self.db, "w", "synthetic-investor", request or self.answers(), now=now)

    def test_preview_is_an_unapproved_time_witness_not_a_source_approval(self):
        self.retained_reports(); counts = {name: self.db.execute("SELECT count(*) FROM " + name).fetchone()[0]
            for name in ("investor_data_sources", "investor_data_reviews", "investor_action_authorities", "investor_action_controls")}
        before_revision = self.revision(); value = self.witness()
        self.assertFalse(value["approval_performed"]); self.assertEqual(value["workspace_revision"], before_revision + 1)
        self.assertEqual(counts, {name: self.db.execute("SELECT count(*) FROM " + name).fetchone()[0] for name in counts})
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_review_confirmations").fetchone()[0], 0)
        readonly = open_database(self.path, read_only=True)
        try:
            visible = workflow.resolve_action_review_preview(readonly, "w", "synthetic-investor", value["preview_id"], now=CONFIRM)
            self.assertEqual(visible["preview"], value); self.assertEqual(readonly.total_changes, 0)
            self.assertEqual(visible["unchanged_tax_assumption"], self.base_facts["tax_assumption"])
            self.assertEqual(visible["visibility"], "private_owner_only_not_ai")
        finally: readonly.close()
        self.assert_no_finance()

    def test_explicit_answers_atomically_create_separate_review_default_off_rule_and_lineage(self):
        self.retained_reports(); self.witness()
        old_sources = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_data_sources ORDER BY rowid")]
        old_reviews = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_data_reviews ORDER BY rowid")]
        before = self.revision(); value = self.confirm()
        self.assertEqual(value["workspace_revision"], before + 1); self.assertTrue(value["monitor_data_readmission_required"])
        for key in ("quarantine_cleared", "research_admitted", "trading_permission", "raw_ai_sharing"): self.assertIs(value[key], False)
        new = resolve_review(self.db, "w", value["new_review_id"], "actions", now=CONFIRM)
        self.assertNotEqual(new["source"]["id"], self.base_source["id"])
        self.assertEqual(new["facts"]["events"][:-1], self.base_facts["events"])
        self.assertEqual(new["facts"]["events"][-1]["gross_per_unit"], "4.32109")
        self.assertEqual(new["facts"]["events"][-1]["tax_per_unit"], "0.432109")
        self.assertEqual(old_sources, [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_data_sources ORDER BY rowid")][:len(old_sources)])
        self.assertEqual(old_reviews, [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_data_reviews ORDER BY rowid")][:len(old_reviews)])
        for authority, expected in ((value["previous_authority_id"], 0), (value["new_authority_id"], 0)):
            self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (authority,)).fetchone()[0], expected)
        self.assert_no_finance()

    def test_only_an_explicit_enable_choice_starts_the_new_rule(self):
        self.retained_reports(); self.witness(); value = self.confirm(self.answers(enable_rule=True))
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE id=?", (value["new_control_id"],)).fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT version FROM investor_action_controls WHERE id=?", (value["new_control_id"],)).fetchone()[0], 2)
        self.assert_no_finance()

    def test_receipt_loss_reuses_original_preview_and_confirmation_even_after_ttl(self):
        self.retained_reports(); self.witness(); before = list(self.db.iterdump())
        again = workflow.register_action_review_preview(self.db, "w", "synthetic-investor", self.preview_request, now=CONFIRM)
        self.assertEqual(again, self.preview); self.assertEqual(before, list(self.db.iterdump()))
        request = self.answers(); value = self.confirm(request); committed = list(self.db.iterdump())
        with patch.object(workflow, "_prepare_action_review_draft", side_effect=AssertionError("NO_NEW_APPROVAL_OR_SOURCE_REPLAY")):
            self.assertEqual(self.confirm(request, now=EXPIRED), value)
        self.assertEqual(committed, list(self.db.iterdump())); self.assert_no_finance()

    def test_changed_retry_body_is_not_an_idempotent_second_approval(self):
        self.retained_reports(); self.witness(); self.confirm(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_CONFLICT"): self.confirm(self.answers(enable_rule=True))
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_unknown_or_false_acknowledgements_cannot_default_to_consent(self):
        self.retained_reports(); self.witness(); original = self.answers(); before = list(self.db.iterdump())
        for mode in ("missing", "false", "extra"):
            request = deepcopy(original)
            if mode == "missing": del request["acknowledgements"]["explicit_tax_amounts"]
            elif mode == "false": request["acknowledgements"]["register_new_default_off_rule"] = False
            else: request["acknowledgements"]["trading_permission"] = True
            with self.subTest(mode=mode), self.assertRaises(ValueError): self.confirm(request)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_client_cannot_supply_gross_or_extend_server_witness_expiry(self):
        self.retained_reports(); self.witness(); before = list(self.db.iterdump())
        for mode in ("gross", "expiry", "zero-default"):
            request = self.answers()
            if mode == "gross": request["new_events"][0]["gross_per_unit"] = "9999"
            elif mode == "expiry": request["valid_until"] = "2027-01-01T00:00:00Z"
            else: del request["new_events"][0]["tax_per_unit"]
            with self.assertRaises(ValueError): self.confirm(request)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_expired_preview_does_not_recompute_a_fresh_implicit_ack(self):
        self.retained_reports(); self.witness(); before = list(self.db.iterdump())
        with patch.object(workflow, "_prepare_action_review_draft") as prepare:
            with self.assertRaisesRegex(WorkbenchError, "PREVIEW_EXPIRED"): self.confirm(now=EXPIRED)
            prepare.assert_not_called()
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_late_atomic_failure_rolls_back_sources_reviews_controls_lineage_and_revision(self):
        self.retained_reports(); self.witness()
        self.db.execute("CREATE TRIGGER fictional_confirmation_abort BEFORE INSERT ON investor_action_review_confirmations BEGIN SELECT RAISE(ABORT,'fictional late confirmation'); END")
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(Exception, "fictional late confirmation"): self.confirm(self.answers(enable_rule=True))
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_retired_rule_cannot_be_resumed_or_forked_by_refresh(self):
        self.retained_reports(); self.witness(); value = self.confirm(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_RETIRED"):
            managed_actions.set_authority_enabled(self.db, "w", "synthetic-investor", self.authority["id"], True, now=CONFIRM)
        with self.assertRaisesRegex(WorkbenchError, "RULE_RETIRED"):
            workflow.register_action_review_preview(self.db, "w", "synthetic-investor", {"authority_id": self.authority["id"], "expected_revision": self.revision(), "idempotency_key": "fictional-fork"}, now=CONFIRM)
        self.assertFalse(value["quarantine_cleared"]); self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_another_owner_is_checked_before_private_source_replay(self):
        self.retained_reports(); self.witness()
        with patch.object(workflow, "_prepare_action_review_draft") as prepare:
            with self.assertRaises(WorkbenchError): workflow.confirm_action_review(self.db, "w", "fictional-other", self.answers(), now=CONFIRM)
            prepare.assert_not_called()

    def test_source_withdrawal_after_witness_never_creates_approval(self):
        self.retained_reports(); self.witness()
        eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor", self.member["eodhd_authority_id"], False, now=CONFIRM)
        before = list(self.db.iterdump())
        with self.assertRaises(ValueError): self.confirm()
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_full_record_replay_and_v4_origins_preserve_old_event_availability(self):
        self.retained_reports(); self.witness(); value = self.confirm(); before = list(self.db.iterdump())
        replay = workflow.resolve_action_review_confirmation(self.db, "w", "synthetic-investor", value["confirmation_id"], now=CONFIRM)
        self.assertEqual(replay, value)
        new = resolve_review(self.db, "w", value["new_review_id"], "actions", now=CONFIRM)
        refs = _availability_refs(self.db, "w", [new], CONFIRM, CONFIRM)
        original = next(row for row in refs if row["event_id"] == self.base_facts["events"][0]["id"])
        self.assertEqual(original["known_at"], self.base["created_at"]); self.assertEqual(original["original_review_id"], self.base["id"])
        added = next(row for row in refs if row["event_id"] != original["event_id"])
        self.assertEqual(added["known_at"], CONFIRM); self.assertEqual(added["original_review_id"], value["new_review_id"])
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_resealed_false_append_proof_is_not_a_source_or_consent_witness(self):
        self.retained_reports(); self.witness(); value = self.confirm()
        self.db.execute("DROP TRIGGER investor_action_review_confirmation_update"); self.db.execute("DROP TRIGGER audit_events_no_update")
        row = self.db.execute("SELECT * FROM investor_action_review_confirmations").fetchone()
        document = json.loads(row["document_json"]); document["append_proof"]["current_snapshot_hash"] = "0" * 64; digest = content_hash(document)
        self.db.execute("UPDATE investor_action_review_confirmations SET document_json=?,content_hash=?", (canonical_json(document), digest))
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), row["audit_id"]))
        with self.assertRaisesRegex(WorkbenchError, "CONFIRMATION_PROOF_CHANGED"):
            workflow.resolve_action_review_confirmation(self.db, "w", "synthetic-investor", value["confirmation_id"], now=CONFIRM)
        self.assert_no_finance()

    def test_two_manual_successions_inherit_each_original_knowledge_time(self):
        self.retained_reports(); self.witness(); first = self.confirm()
        next_at = "2026-11-05T06:00:03.000Z"; witness_at = "2026-11-05T06:00:03.001Z"; confirm_at = "2026-11-05T06:00:04.001Z"
        original_collector = source_fixture.ActionCollector
        class LaterCollector(original_collector):
            def __call__(collector, **options):
                result = super().__call__(**options)
                if options["symbol"] == "VT.US" and options["kind"] == "div":
                    raw = div_archive(dividend("987.123", date="2026-09-25", declarationDate="2026-09-20", recordDate="2026-09-25", paymentDate="2026-09-30"),
                        dividend("4.321", date="2026-11-02", recordDate="2026-11-02", paymentDate="2026-11-09"),
                        dividend("4", date="2026-11-04", recordDate="2026-11-04", paymentDate="2026-11-11"))
                    result["raw"] = raw; result["receipt"].update(raw_sha256=sha256(raw).hexdigest(), raw_bytes=len(raw))
                    result["draft"] = parse_eodhd_actions(raw, **{key: options[key] for key in ("kind", "symbol", "start_date", "end_date")}, retrieved_at=next_at)
                return result
        raw = archive(row("987.1234", exDividendDate="2026-09-25", recordDate="2026-09-25", payableDate="2026-09-30"),
            row("4.32109", exDividendDate="2026-11-02", recordDate="2026-11-02", payableDate="2026-11-09"),
            row("4.00009", exDividendDate="2026-11-04", recordDate="2026-11-04", payableDate="2026-11-11"))
        with patch.object(fixture.fixture, "LATER", next_at), patch.object(source_fixture, "ActionCollector", LaterCollector):
            self.next_source_day(issuer_raw=raw)
        self.preview = workflow.register_action_review_preview(self.db, "w", "synthetic-investor", {
            "authority_id": first["new_authority_id"], "expected_revision": self.revision(), "idempotency_key": "fictional-preview-2"}, now=witness_at)
        request = self.answers(idempotency_key="fictional-confirmation-2", new_events=[{"type": "dividend", "date": "2026-11-04",
            "at": "2026-11-04T14:30:00Z", "pay_at": "2026-11-11T21:00:00Z", "tax_per_unit": "0.4"}])
        second = self.confirm(request, now=confirm_at); unchanged = list(self.db.iterdump())
        current = resolve_review(self.db, "w", second["new_review_id"], "actions", now=confirm_at)
        refs = _availability_refs(self.db, "w", [current], confirm_at, confirm_at)
        by_id = {ref["event_id"]: ref for ref in refs}
        self.assertEqual(by_id[self.base_facts["events"][0]["id"]]["known_at"], self.base["created_at"])
        first_facts = resolve_review(self.db, "w", first["new_review_id"], "actions", now=confirm_at)["facts"]
        self.assertEqual(by_id[first_facts["events"][-1]["id"]]["known_at"], CONFIRM)
        self.assertEqual(by_id[current["facts"]["events"][-1]["id"]]["known_at"], confirm_at)
        self.assertEqual(len(refs), 3); self.assertEqual(unchanged, list(self.db.iterdump())); self.assert_no_finance()

    def test_invalid_time_tax_or_incomplete_event_answers_never_mutate(self):
        self.retained_reports(); self.witness(); before = list(self.db.iterdump())
        for mode in ("wrong-local-day", "wrong-pay-day", "negative-tax", "excess-tax", "trailing-tax", "submicro-pay", "missing-event", "duplicate-event"):
            request = self.answers(); event = request["new_events"][0]
            if mode == "wrong-local-day": event["at"] = "2026-11-02T00:30:00Z"
            elif mode == "wrong-pay-day": event["pay_at"] = "2026-11-10T21:00:00Z"
            elif mode == "negative-tax": event["tax_per_unit"] = "-0.1"
            elif mode == "excess-tax": event["tax_per_unit"] = "5"
            elif mode == "trailing-tax": event["tax_per_unit"] = "0.432109\n"
            elif mode == "submicro-pay": event["pay_at"] = "2026-11-09T21:00:00.0000001Z"
            elif mode == "missing-event": request["new_events"] = []
            else: request["new_events"].append(deepcopy(event))
            with self.subTest(mode=mode), self.assertRaises(ValueError): self.confirm(request)
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_witness_cannot_survive_revision_change_or_a_new_readonly_mode(self):
        self.retained_reports(); self.witness()
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
            self.confirm()
        self.db.execute("UPDATE investor_workspaces SET revision=revision+1 WHERE id='w'"); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "VERSION_CONFLICT"): self.confirm()
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_historical_correction_can_be_previewed_but_not_relabelled_as_append(self):
        self.retained_reports(correction=True); self.witness(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "SEPARATE_HISTORICAL_REVIEW_REQUIRED"): self.confirm()
        self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_same_request_winning_on_another_connection_returns_one_original_receipt(self):
        self.retained_reports(); self.witness(); request = self.answers(); original = workflow._prepare_action_review_draft
        active = [False]; winner = []; committed = []
        def race(*args, **options):
            value = original(*args, **options)
            if not active[0]:
                active[0] = True; other = open_database(self.path)
                try:
                    winner.append(workflow.confirm_action_review(other, "w", "synthetic-investor", request, now=CONFIRM))
                    committed.extend(list(other.iterdump()))
                finally: other.close()
            return value
        with patch.object(workflow, "_prepare_action_review_draft", side_effect=race): value = self.confirm(request)
        self.assertEqual(value, winner[0]); self.assertEqual(list(self.db.iterdump()), committed)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_review_confirmations").fetchone()[0], 1); self.assert_no_finance()

    def test_expiry_after_all_staged_writes_rolls_back_the_whole_confirmation(self):
        self.retained_reports(); self.witness(); before = list(self.db.iterdump()); original = workflow._clock; calls = [0]
        def clock(value):
            calls[0] += 1
            return EXPIRED if calls[0] == 3 else original(value)
        with patch.object(workflow, "_clock", side_effect=clock), self.assertRaisesRegex(WorkbenchError, "PREVIEW_EXPIRED"): self.confirm()
        self.assertEqual(calls[0], 3); self.assertEqual(before, list(self.db.iterdump())); self.assert_no_finance()

    def test_real_second_connection_withdrawal_after_prepare_is_caught_before_any_approval(self):
        self.retained_reports(); self.witness(); original = workflow._prepare_action_review_draft; expected = []
        def withdrawn(*args, **options):
            value = original(*args, **options); other = open_database(self.path)
            try:
                eodhd_sources.set_authority_enabled(other, "w", "synthetic-investor", self.member["eodhd_authority_id"], False, now=CONFIRM)
                expected.extend(list(other.iterdump()))
            finally: other.close()
            return value
        with patch.object(workflow, "_prepare_action_review_draft", side_effect=withdrawn), self.assertRaises(ValueError): self.confirm()
        self.assertEqual(list(self.db.iterdump()), expected); self.assert_no_finance()

    def test_caller_mutation_during_preparation_cannot_change_original_consent_or_enable(self):
        self.retained_reports(); self.witness(); request = self.answers(); original = workflow._prepare_action_review_draft
        def changed(*args, **options):
            value = original(*args, **options)
            request["enable_rule"] = True; request["new_events"][0]["tax_per_unit"] = "0"
            return value
        with patch.object(workflow, "_prepare_action_review_draft", side_effect=changed): value = self.confirm(request)
        self.assertFalse(value["request"]["enable_rule"]); self.assertEqual(value["request"]["new_events"][0]["tax_per_unit"], "0.432109")
        self.assertEqual(value["request_hash"], content_hash(value["request"]))
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE id=?", (value["new_control_id"],)).fetchone()[0], 0)
        self.assert_no_finance()

    def test_preview_and_confirmation_are_immutable_and_late_restore_lock_rolls_back(self):
        self.retained_reports(); self.witness(); original = workflow.store_source
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        def locked(*args, **options):
            value = original(*args, **options); marker.touch(); return value
        before = list(self.db.iterdump())
        try:
            with patch.object(workflow, "store_source", side_effect=locked), self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                self.confirm()
        finally:
            if marker.exists(): marker.unlink()
        self.assertEqual(before, list(self.db.iterdump()))
        self.confirm()
        for table in ("investor_action_review_previews", "investor_action_review_confirmations"):
            for statement in (f"UPDATE {table} SET content_hash='x'", f"DELETE FROM {table}"):
                with self.assertRaisesRegex(Exception, "immutable"): self.db.execute(statement)
        self.assert_no_finance()


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        case = ActionReviewWorkflowTests()
        try:
            case.setUp(); case.retained_reports(); case.witness(); confirmed = case.confirm(); case.assert_no_finance()
            print(json.dumps({"preview": case.preview, "confirmation": confirmed}))
        finally: case.doCleanups()
    else: unittest.main()
