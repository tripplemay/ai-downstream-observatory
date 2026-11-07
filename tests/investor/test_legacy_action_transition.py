"""Retained fictional legacy accounting must survive an explicit protocol review."""

import json
import sys
from copy import deepcopy
from datetime import timedelta
import unittest
from unittest.mock import patch

from tests.investor import test_action_review_readmission as fixture
from worker.investor import legacy_action_transition as transition, monitor_data
from worker.orchestration.db import WorkbenchError, canonical_json, instant, open_database

CONFIRM = fixture.CONFIRM


class LegacyActionTransitionTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.ActionReviewReadmissionTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.db = self.case.db

    def prepare(self, *, audited=False):
        self.case.model(audited=audited, known_costs=True); self.case.confirm()

    def preview(self, db=None, **kwargs):
        return transition.preview_legacy_action_transition(db or self.db, "w", "synthetic-investor",
            self.case.definition["model_id"], now=CONFIRM, **kwargs)

    def test_retained_original_receipts_and_checkpoint_replay_prove_conservative_knowledge_carry_without_admission(self):
        self.prepare(); before = list(self.db.iterdump())
        queries = []; self.db.set_trace_callback(queries.append)
        try:
            with patch("socket.create_connection", side_effect=AssertionError("NO_NETWORK")), \
                    patch("socket.getaddrinfo", side_effect=AssertionError("NO_DNS")), \
                    patch("worker.market.providers.longport.read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIAL_READ")):
                result = self.preview()
        finally: self.db.set_trace_callback(None)
        for table in ("investor_price_payloads", "investor_issuer_payloads", "investor_eodhd_payloads", "investor_evidence_checkpoint_payloads"):
            self.assertTrue(any("from " + table in query.lower() for query in queries), table)
        self.assertFalse(any(query.lstrip().split(" ", 1)[0].upper() in {"INSERT", "UPDATE", "DELETE", "REPLACE"} for query in queries))
        self.assertEqual(result["schema_version"], "investor-legacy-action-transition-preview-v1")
        self.assertEqual(result["status"], "awaiting_explicit_protocol_confirmation")
        self.assertFalse(result["admission_performed"]); self.assertFalse(result["live_advice_eligible"])
        self.assertEqual(result["checkpoint"]["sequence"], 1)
        expiry = self.db.execute("SELECT valid_until FROM investor_evidence_model_checkpoints").fetchone()[0]
        self.assertLessEqual(result["source_valid_until"], expiry)
        self.assertGreater(len(result["carry_forward"]), 0)
        self.assertTrue(any(row["recorded_known_at"] != row["audited_known_at"] for row in result["carry_forward"]))
        self.assertTrue(all(row["audited_known_at"] <= row["recorded_known_at"] for row in result["carry_forward"]))
        self.assertNotIn("quotes", result); self.assertNotIn("model_nav_cny", result)
        self.assertTrue(result["projection_quality_gaps"])
        self.assertEqual(before, list(self.db.iterdump()))
        original = json.loads(self.case.seed["document_json"])
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.case.definition, original,
            now=CONFIRM)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        from worker.investor.model_state import advance_evidence_model
        replay = transition._compare_original_input(self.db, "w", self.case.definition, self.case.seed, original, CONFIRM)
        changed = deepcopy(replay["projection"]); changed["schema_version"] = "investor-monitor-data-projection-v2"
        knowledge = {row["id"]: row["audited_known_at"] for row in result["carry_forward"]}
        for action in changed["corporate_actions"]: action["known_at"] = knowledge[action["id"]]
        stored = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads").fetchone()[0])
        at = transition._clock(instant(stored["created_at"]) + timedelta(milliseconds=1))
        # Pure arithmetic counterexample only, not an admitted source or replay.
        with self.assertRaisesRegex(WorkbenchError, "ACTION_RESTATEMENT_REQUIRED"):
            advance_evidence_model(self.case.definition, changed, stored, at, input_hash="a" * 64)
        self.assertEqual(before, list(self.db.iterdump()))
        self.case.case.assert_no_finance()

    def test_actual_read_only_connection_derives_the_same_preview(self):
        self.prepare(); before = list(self.db.iterdump()); expected = self.preview()
        other = open_database(self.case.case.path, read_only=True)
        try:
            self.assertEqual(self.preview(other), expected)
            self.assertEqual(other.total_changes, 0)
        finally: other.close()
        self.assertEqual(before, list(self.db.iterdump()))

    def test_wrong_owner_and_existing_v4_are_not_migrated(self):
        self.prepare(audited=True); before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError):
            transition.preview_legacy_action_transition(self.db, "w", "other-owner", self.case.definition["model_id"], now=CONFIRM)
        with self.assertRaisesRegex(WorkbenchError, "LEGACY_INPUT_REQUIRED"):
            self.preview()
        self.assertEqual(before, list(self.db.iterdump()))

    def test_source_withdrawal_and_stop_do_not_reuse_an_earlier_successful_preview(self):
        from worker.investor import eodhd_sources
        self.prepare(); self.preview(); before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
            self.preview(stop_requested=lambda: True)
        self.assertEqual(before, list(self.db.iterdump()))
        eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor",
            self.case.case.member["eodhd_authority_id"], False, now=CONFIRM)
        before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): self.preview()
        self.assertEqual(before, list(self.db.iterdump()))

    def test_changed_checkpoint_cannot_be_accepted_from_a_self_reported_state(self):
        self.prepare(); original = transition._payload
        def changed(*args, **kwargs):
            value = original(*args, **kwargs); value["initial_notional_cny"] = "10001"; return value
        before = list(self.db.iterdump())
        with patch.object(transition, "_payload", side_effect=changed), self.assertRaises(WorkbenchError): self.preview()
        self.assertEqual(before, list(self.db.iterdump()))

    def test_legacy_comparison_scope_is_cleared_on_a_failed_original_byte_replay(self):
        from worker.investor.action_checkpoint_replay import checkpoint_action_review
        self.prepare(); before = list(self.db.iterdump()); original = transition.resolve_monitor_data
        def failed(*args, **kwargs):
            if checkpoint_action_review(self.db, "w", self.case.old, "actions", CONFIRM) is not None:
                raise WorkbenchError("FICTIONAL_LEGACY_REPLAY_FAILURE")
            return original(*args, **kwargs)
        with patch.object(transition, "resolve_monitor_data", side_effect=failed), self.assertRaisesRegex(WorkbenchError, "FICTIONAL_LEGACY_REPLAY_FAILURE"):
            self.preview()
        self.assertIsNone(checkpoint_action_review(self.db, "w", self.case.old, "actions", CONFIRM))
        self.assertEqual(before, list(self.db.iterdump()))

    def test_every_original_checkpoint_is_replayed_not_just_the_last_header(self):
        from worker.investor.confirmed_feed import _windows
        from worker.investor.monitor_admission import admit_monitor_data
        from worker.orchestration.runtime import run_pending_once
        self.case.model(audited=False, known_costs=True)
        header = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone()
        at = transition._clock(instant(header["created_at"]) + timedelta(milliseconds=1))
        document = json.loads(self.case.seed["document_json"]); settings = deepcopy(document["settings"])
        settings["funding_intent"] = {"id": "fictional-legacy-funding", "amount_cny": "1000", "expected_at": at}
        admit_monitor_data(self.db, "w", "synthetic-investor", self.case.definition["model_id"],
            [window for _, window in _windows(self.db, "w", document)], settings, now=at)
        self.assertEqual(run_pending_once(self.db, "fictional-legacy-second", clock=lambda: at)["status"], "succeeded")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 2)
        self.case.confirm(); before = list(self.db.iterdump())
        self.assertEqual(self.preview()["checkpoint"]["sequence"], 2)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_knowledge_carry_rejects_changed_economics_missing_actions_and_later_knowledge(self):
        original = {"id": "split:fictional", "listing_id": "fictional", "kind": "split", "effective_at": "2026-01-02T01:00:00Z",
            "known_at": "2026-01-03T01:00:00Z", "ratio": "2"}
        ledger = {original["id"]: {"action": original, "input_id": "fictional", "input_hash": "a" * 64}}
        audited = {**original, "known_at": "2026-01-02T01:00:00Z"}
        for values in ([], [{**audited, "ratio": "3"}], [{**audited, "known_at": "2026-01-04T01:00:00Z"}]):
            with self.assertRaisesRegex(WorkbenchError, "TRANSITION_ACTION"):
                transition._carry_actions(ledger, values)
        carry = transition._carry_actions(ledger, [audited])
        self.assertEqual(carry[0]["recorded_known_at"], original["known_at"])
        self.assertEqual(original["known_at"], "2026-01-03T01:00:00Z")

    def test_newly_reported_historical_events_require_restatement_but_future_and_pre_entry_events_do_not(self):
        definition = {"targets": [{"listing_id": "fictional", "market": "US"}]}
        previous = {"initialized_at": {"US": "2026-01-01T01:00:00Z"}, "market_cutoffs": {"US": "2026-01-03T01:00:00Z"}}
        event = {"id": "new", "listing_id": "fictional", "effective_at": "2026-01-02T01:00:00Z"}
        with self.assertRaisesRegex(WorkbenchError, "RESTATEMENT_REQUIRED"):
            transition._check_unprocessed_history(definition, previous, {}, [event])
        for at in ("2026-01-01T01:00:00Z", "2026-01-04T01:00:00Z"):
            transition._check_unprocessed_history(definition, previous, {}, [{**event, "effective_at": at}])


if __name__ == "__main__":
    if sys.argv[1:] == ["--contract"]:
        case = LegacyActionTransitionTests(); case.setUp()
        try:
            with patch("socket.create_connection", side_effect=AssertionError("NO_NETWORK")), \
                    patch("socket.getaddrinfo", side_effect=AssertionError("NO_DNS")):
                case.prepare(); print(canonical_json(case.preview()))
        finally: case.doCleanups()
    else: unittest.main()
