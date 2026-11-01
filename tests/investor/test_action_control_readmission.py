"""Same-rule recovery on fictional receipts, preserving actual checkpoint state."""

import json
import unittest
from unittest.mock import patch

from tests.investor import test_action_refresh as refresh_fixture, test_managed_actions as managed_fixture
from tests.investor import test_action_review_readmission as callback_fixture
from tests.investor.fixtures import monitor_input
from worker.investor import confirmed_feed, data_evidence, managed_actions, monitor_admission, monitor_data
from worker.investor.evidence_monitor_runtime import resolve_checkpoint
from worker.market.providers import longport, longport_confirmed
from worker.orchestration.db import WorkbenchError
from worker.orchestration.runtime import run_pending_once


AT = "2026-11-03T06:00:03.000Z"
PAUSE = "2026-11-02T21:00:00.000Z"
RESUME = "2026-11-02T21:00:01.000Z"


class ActionControlReadmissionTests(unittest.TestCase):
    def setUp(self):
        self.case = refresh_fixture.ActionRefreshTests(); self.case.setUp()
        self.addCleanup(self.case.doCleanups); self.db = self.case.db

    def initial(self, *, audited=True):
        self.definition, self.seed, self.old = self.case.model_and_prices(audited=audited, calendar_end="2026-11-06",
            explicit_costs=monitor_input()["policy"]["costs"])
        self.assertEqual(run_pending_once(self.db, "fictional-control-initial", clock=lambda: managed_fixture.AT)["status"], "succeeded")
        self.initial_headers = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_model_checkpoints")]
        self.initial_payloads = [list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_checkpoint_payloads")]
        self.assertEqual(len(self.initial_headers), 1); self.assertEqual(len(self.initial_payloads), 1)
        callback_fixture.ActionReviewReadmissionTests.complete_prices(self)
        managed_actions.set_authority_enabled(self.db, "w", "synthetic-investor", self.case.authority["id"], False, now=PAUSE)
        managed_actions.set_authority_enabled(self.db, "w", "synthetic-investor", self.case.authority["id"], True, now=RESUME)

    def publish(self):
        with patch.object(managed_fixture, "LATER", AT): self.case.next_source_day()
        result = managed_actions.publish_current_actions(self.db, now=AT)
        self.assertEqual(result[0]["status"], "published"); self.current = result[0]["publication_id"]
        self.assertNotEqual(self.current, self.old)

    def test_default_core_advances_an_existing_v4_checkpoint_after_explicit_pause_resume_and_qualified_new_publication(self):
        self.initial(); self.publish()
        original = json.loads(self.seed["document_json"])
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, original, now=AT)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        with patch.object(longport, "_collect_isolated", side_effect=AssertionError("NO_HISTORY_REQUEST")), \
                patch.object(longport, "read_private_credentials_file", side_effect=AssertionError("NO_CREDENTIALS")), \
                patch.object(longport_confirmed, "collect_confirmed_days", side_effect=AssertionError("NO_NEW_WATCH")):
            result = run_pending_once(self.db, "fictional-control-readmission", clock=lambda: AT)
        self.assertEqual(result["status"], "succeeded")
        headers = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints ORDER BY sequence").fetchall()
        self.assertEqual(len(headers), 2)
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_model_checkpoints ORDER BY rowid")][:1], self.initial_headers)
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_checkpoint_payloads ORDER BY rowid")][:1], self.initial_payloads)
        previous = json.loads(self.initial_payloads[0][-1])
        latest = json.loads(self.db.execute("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?", (headers[1]["id"],)).fetchone()[0])
        self.assertEqual(latest["initialized_at"], previous["initialized_at"])
        self.assertEqual(latest["processed_actions"], previous["processed_actions"])
        self.assertEqual(headers[1]["previous_hash"], headers[0]["content_hash"])
        self.assertEqual(resolve_checkpoint(self.db, "w", self.definition, headers[1]["id"], AT), (latest, None))
        current = monitor_admission.latest_monitor_evidence(self.db, "w", self.definition["model_id"])
        self.assertNotEqual(current["id"], self.seed["id"])
        run = self.db.execute("SELECT checkpoint_id FROM investor_evidence_monitor_runs ORDER BY created_at DESC,rowid DESC LIMIT 1").fetchone()
        self.assertEqual(run[0], headers[1]["id"])
        self.assertEqual(monitor_data.resolve_monitor_data(self.db, "w", self.definition, original, now=AT)["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_confirmed_feed_admissions")], self.admissions)
        self.case.assert_no_finance()

    def test_resume_without_new_publication_does_not_requalify_an_old_checkpoint(self):
        self.initial(); header = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone()
        before = self.db.total_changes
        try: value, reason = resolve_checkpoint(self.db, "w", self.definition, header["id"], AT)
        except WorkbenchError: value, reason = None, "SOURCE_UNAVAILABLE"
        self.assertIsNone(value); self.assertIsNotNone(reason); self.assertEqual(self.db.total_changes, before)
        self.case.assert_no_finance()

    def test_an_unrelated_overlapping_manual_assertion_cannot_requalify_a_same_rule_checkpoint(self):
        self.initial(); self.publish()
        facts = data_evidence.resolve_review(self.db, "w", self.current, "actions", now=AT)["facts"]
        source = data_evidence.store_source(self.db, "w", "synthetic-investor", "actions",
            {"title":"Fictional unrelated assertion", "reference":"synthetic://control-unrelated", "excerpt":"Not a rule successor or actual market evidence"}, now=AT)
        data_evidence.review_source(self.db, "w", "synthetic-investor", source["id"], "approved", facts,
            "Fictional overlap remains ambiguous", "2026-11-10T00:00:00.000Z", now=AT)
        header = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone(); before = self.db.total_changes
        try: value, reason = resolve_checkpoint(self.db, "w", self.definition, header["id"], AT)
        except WorkbenchError: value, reason = None, "SOURCE_UNAVAILABLE"
        self.assertIsNone(value); self.assertIsNotNone(reason)
        self.assertEqual(self.db.total_changes, before); self.case.assert_no_finance()

    def test_upstream_withdrawal_is_not_maintenance_pause_and_cannot_replay_a_checkpoint(self):
        from worker.investor import eodhd_sources
        from worker.investor.action_checkpoint_replay import checkpoint_action_review
        self.initial(); self.publish()
        eodhd_sources.set_authority_enabled(self.db, "w", "synthetic-investor", self.case.member["eodhd_authority_id"], False, now=AT)
        header = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone(); before = self.db.total_changes
        try: value, reason = resolve_checkpoint(self.db, "w", self.definition, header["id"], AT)
        except WorkbenchError: value, reason = None, "SOURCE_UNAVAILABLE"
        self.assertIsNone(value); self.assertIsNotNone(reason); self.assertEqual(self.db.total_changes, before)
        self.assertIsNone(checkpoint_action_review(self.db, "w", self.old, "actions", AT)); self.case.assert_no_finance()

    def test_same_rule_raw_predecessor_verification_cannot_be_replaced_by_its_qualified_current_head(self):
        from worker.investor import reviewed_actions
        from worker.investor.action_checkpoint_replay import checkpoint_action_review
        self.initial(); self.publish()
        header = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone(); before = list(self.db.iterdump())
        with patch.object(reviewed_actions, "read_historical_action_review", side_effect=WorkbenchError("FICTIONAL_OLD_RAW_INVALID")), \
                self.assertRaisesRegex(WorkbenchError, "FICTIONAL_OLD_RAW_INVALID"):
            resolve_checkpoint(self.db, "w", self.definition, header["id"], AT)
        self.assertIsNone(checkpoint_action_review(self.db, "w", self.old, "actions", AT))
        self.assertEqual(list(self.db.iterdump()), before); self.case.assert_no_finance()

    def test_legacy_input_is_not_silently_migrated_by_same_rule_checkpoint_replay(self):
        self.initial(audited=False); self.publish()
        header = self.db.execute("SELECT * FROM investor_evidence_model_checkpoints").fetchone(); before = self.db.total_changes
        value, reason = resolve_checkpoint(self.db, "w", self.definition, header["id"], AT)
        self.assertIsNone(value); self.assertEqual(reason, "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertEqual(self.db.total_changes, before)
        self.assertEqual([list(row) for row in self.db.execute("SELECT rowid,* FROM investor_evidence_model_checkpoints")], self.initial_headers)
        self.case.assert_no_finance()


if __name__ == "__main__": unittest.main()
