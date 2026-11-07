"""Current selection after explicit fictional review, no providers or trading."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_action_review_workflow as fixture
from worker.investor import action_review_workflow as workflow, confirmed_feed, data_evidence, eodhd_sources, managed_actions as managed
from worker.investor.action_review_selection import retired_action_review
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash

AT, CONFIRM = fixture.AT, fixture.CONFIRM

class ActionReviewSelectionTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture.ActionReviewWorkflowTests(); self.case.setUp(); self.addCleanup(self.case.doCleanups)
        self.db = self.case.db

    def ready(self, *, enabled=False, quarantined=False):
        self.case.retained_reports()
        if quarantined: self.assertEqual(managed.publish_current_actions(self.db, now=AT)[0]["status"], "blocked")
        self.case.witness()
        return self.case.confirm(self.case.answers(enable_rule=enabled))

    def current(self, at=CONFIRM, header=False):
        return managed.current_action_reviews(self.db, "w", ["synthetic-3141"], at, header_only=header)

    def test_explicit_review_shadows_only_its_predecessor_even_with_default_off_child_and_no_child_publication(self):
        confirmed = self.ready(quarantined=True); before = list(self.db.iterdump())
        for header in (False, True):
            self.assertEqual([row["review"]["id"] for row in self.current(header=header)], [confirmed["new_review_id"]])
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_publications WHERE authority_id=?", (confirmed["new_authority_id"],)).fetchone()[0], 0)
        with self.assertRaises(WorkbenchError): data_evidence.resolve_review(self.db, "w", confirmed["previous_publication_id"], "actions", now=CONFIRM)
        self.case.assert_no_finance()

    def test_explicitly_enabled_child_may_use_its_approved_baseline_without_manufacturing_a_positive_publication(self):
        confirmed = self.ready(enabled=True); before = list(self.db.iterdump())
        self.assertEqual([row["review"]["id"] for row in self.current()], [confirmed["new_review_id"]])
        self.assertEqual(list(self.db.iterdump()), before)
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (confirmed["new_authority_id"],)).fetchone()[0], 1)

    def test_unrelated_equal_manual_facts_remain_ambiguous_and_are_never_shadowed(self):
        confirmed = self.ready()
        facts = data_evidence.resolve_review(self.db, "w", confirmed["new_review_id"], "actions", now=CONFIRM)["facts"]
        source = data_evidence.store_source(self.db, "w", "synthetic-investor", "actions", {"title": "Fictional unrelated review", "reference": "synthetic://unrelated", "excerpt": "Not an immutable successor"}, now=CONFIRM)
        other = data_evidence.review_source(self.db, "w", "synthetic-investor", source["id"], "approved", deepcopy(facts), "Fictional independent assertion", "2026-11-10T00:00:00.000Z", now=CONFIRM)
        self.assertEqual({row["review"]["id"] for row in self.current()}, {confirmed["new_review_id"], other["id"]})

    def test_two_explicit_generations_select_only_the_terminal_review_without_latest_wins(self):
        self.case.test_two_manual_successions_inherit_each_original_knowledge_time()
        confirmed = json.loads(self.db.execute("SELECT document_json FROM investor_action_review_confirmations ORDER BY created_at DESC LIMIT 1").fetchone()[0])
        self.assertEqual([row["review"]["id"] for row in self.current(at=confirmed["created_at"])], [confirmed["new_review_id"]])

    def test_current_source_withdrawal_does_not_restore_retired_manual_baselines(self):
        confirmed = self.ready()
        eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor", self.case.member["eodhd_authority_id"], False, now=CONFIRM)
        with self.assertRaises(WorkbenchError): self.current()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_action_review_confirmations").fetchone()[0], 1)
        self.assertEqual(self.db.execute("SELECT enabled FROM investor_action_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (confirmed["previous_authority_id"],)).fetchone()[0], 0)

    def test_a_later_child_quarantine_remains_a_stop_even_if_maintenance_is_paused(self):
        confirmed = self.ready(enabled=True); later = "2026-11-04T06:00:03.000Z"
        with patch.object(managed, "_current_refs", return_value=(None, "SOURCE_CAPTURE_TERMINAL_FAILURE")):
            self.assertEqual(managed.publish_current_actions(self.db, now=later)[0]["status"], "blocked")
        with self.assertRaises(WorkbenchError): self.current(at=later)
        managed.set_authority_enabled(self.db, "w", "synthetic-investor", confirmed["new_authority_id"], False, now=later)
        with self.assertRaises(WorkbenchError): self.current(at=later)

    def test_only_linked_predecessor_windows_can_extend_and_old_raw_proofs_still_must_replay(self):
        confirmed = self.ready(); old = confirmed["previous_publication_id"]
        definition = {"targets": [{"listing_id": "synthetic-3141", "market": "US"}]}
        windows = [("US", {"start_date": "2026-10-30", "end_date": "2026-11-02", "action_review_ids": [old]})]
        before = list(self.db.iterdump()); confirmed_feed._refresh_action_windows(self.db, "w", definition, windows, CONFIRM)
        self.assertEqual(windows[0][1]["action_review_ids"], [confirmed["new_review_id"]]); self.assertEqual(list(self.db.iterdump()), before)
        self.assertTrue(retired_action_review(self.db, "w", self.case.base["id"], CONFIRM))
        self.assertTrue(retired_action_review(self.db, "w", old, CONFIRM))
        self.assertFalse(retired_action_review(self.db, "w", confirmed["new_review_id"], CONFIRM))
        self.db.execute("DROP TRIGGER investor_issuer_payload_update")
        row = self.db.execute("SELECT rowid,payload FROM investor_issuer_payloads LIMIT 1").fetchone()
        raw = bytes(row["payload"]); self.db.execute("UPDATE investor_issuer_payloads SET payload=? WHERE rowid=?", (bytes([raw[0] ^ 1]) + raw[1:], row["rowid"]))
        windows[0][1]["action_review_ids"] = [old]
        with self.assertRaises(WorkbenchError): confirmed_feed._refresh_action_windows(self.db, "w", definition, windows, CONFIRM)
        self.assertEqual(windows[0][1]["action_review_ids"], [old]); self.case.assert_no_finance()

    def test_self_resealed_false_succession_proof_can_only_deny_old_sources_not_admit_new_ones(self):
        confirmed = self.ready(); self.db.execute("DROP TRIGGER investor_action_review_confirmation_update"); self.db.execute("DROP TRIGGER audit_events_no_update")
        row = self.db.execute("SELECT * FROM investor_action_review_confirmations WHERE id=?", (confirmed["confirmation_id"],)).fetchone()
        doc = json.loads(row["document_json"]); doc["append_proof"]["previous_snapshot_hash"] = "0" * 64; digest = content_hash(doc)
        self.db.execute("UPDATE investor_action_review_confirmations SET document_json=?,content_hash=? WHERE id=?", (canonical_json(doc), digest, row["id"]))
        self.db.execute("UPDATE audit_events SET payload_json=? WHERE id=?", (canonical_json({"content_hash": digest}), row["audit_id"]))
        self.assertTrue(retired_action_review(self.db, "w", self.case.base["id"], CONFIRM))
        with self.assertRaises(WorkbenchError): self.current()

    def test_expired_successor_cannot_fall_back_to_the_longer_lived_original_manual_review(self):
        self.ready()
        with self.assertRaises(WorkbenchError): self.current(at="2026-11-11T06:00:03.000Z")


if __name__ == "__main__": unittest.main()
