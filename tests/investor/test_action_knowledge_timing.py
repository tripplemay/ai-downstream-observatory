"""Kernel timing properties for the pending versioned review handover, fictional only."""

from copy import deepcopy
from datetime import timedelta
import unittest

from tests.investor.fixtures import MONITOR_NOW
from tests.investor.test_model_state import model_fixture, next_snapshot
from worker.investor.model_state import advance_model
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp


class ActionKnowledgeTimingTests(unittest.TestCase):
    def test_late_receipt_can_advance_from_an_earlier_cutoff_when_known_by_assessment(self):
        definition, snapshot = model_fixture()
        first = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]; original = deepcopy(first)
        later, now = next_snapshot(snapshot); quote = later["quotes"][0]; quote["close"] = "50"
        self.assertLess(instant(quote["observed_at"]), instant(now))
        action = {"id": "fictional-late-known-split", "listing_id": quote["listing_id"], "kind": "split", "ratio": "2",
            "effective_at": quote["observed_at"], "known_at": now}
        later["corporate_actions"] = [action]
        result = advance_model(definition, later, first, now)
        self.assertEqual(result["assessment"]["model_nav_cny"], "10000")
        self.assertEqual(result["checkpoint"]["previous_hash"], content_hash(first)); self.assertEqual(first, original)
        self.assertEqual(result["checkpoint"]["processed_actions"][action["id"]], content_hash(action))

    def test_not_yet_known_receipt_still_blocks_without_changing_checkpoint(self):
        definition, snapshot = model_fixture(); first = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]
        original = deepcopy(first); later, now = next_snapshot(snapshot); quote = later["quotes"][0]
        later["corporate_actions"] = [{"id": "fictional-future-knowledge", "listing_id": quote["listing_id"], "kind": "split", "ratio": "2",
            "effective_at": quote["observed_at"], "known_at": stamp(instant(now) + timedelta(microseconds=1))}]
        value = advance_model(definition, later, first, now)
        self.assertIsNone(value["checkpoint"]); self.assertEqual(value["assessment"]["outcome"], "insufficient_evidence")
        self.assertIn("CORPORATE_ACTION_NOT_KNOWN", value["assessment"]["gaps"]); self.assertEqual(first, original)

    def test_old_event_availability_must_not_be_changed_by_a_new_coverage_review(self):
        definition, snapshot = model_fixture(); quote = snapshot["quotes"][0]
        action = {"id": "fictional-pre-inception-split", "listing_id": quote["listing_id"], "kind": "split", "ratio": "2",
            "effective_at": quote["observed_at"], "known_at": MONITOR_NOW}
        snapshot["corporate_actions"] = [action]
        first = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]; original = deepcopy(first)
        later, now = next_snapshot(snapshot); later["corporate_actions"] = [deepcopy(action)]
        unchanged = advance_model(definition, later, first, now)
        self.assertEqual(unchanged["checkpoint"]["quantities"], first["quantities"])
        later["corporate_actions"][0]["known_at"] = now
        with self.assertRaisesRegex(WorkbenchError, "ACTION_RESTATEMENT_REQUIRED"):
            advance_model(definition, later, first, now)
        self.assertEqual(first, original)

    def test_newly_reported_event_inside_completed_history_needs_restatement_not_replay(self):
        definition, snapshot = model_fixture(); first = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]
        later, now = next_snapshot(snapshot); second = advance_model(definition, later, first, now)["checkpoint"]
        final, final_now = next_snapshot(later); quote = later["quotes"][0]
        final["corporate_actions"] = [{"id": "fictional-missing-past-event", "listing_id": quote["listing_id"], "kind": "split", "ratio": "2",
            "effective_at": quote["observed_at"], "known_at": final_now}]
        original = deepcopy(second)
        with self.assertRaisesRegex(WorkbenchError, "ACTION_RESTATEMENT_REQUIRED"):
            advance_model(definition, final, second, final_now)
        self.assertEqual(second, original)

    def test_first_ever_bootstrap_does_not_pay_pre_entry_dividends_or_reset_existing_state(self):
        definition, snapshot = model_fixture(); plain = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]
        quote = snapshot["quotes"][0]; event = {"id": "fictional-pre-entry-ex", "listing_id": quote["listing_id"], "kind": "dividend_ex",
            "currency": quote["currency"], "net_per_unit": "4.32109", "entitlement_id": "fictional-old-entitlement", "tax_assumption_hash": "d" * 64,
            "effective_at": quote["observed_at"], "known_at": MONITOR_NOW}
        snapshot["corporate_actions"] = [event]
        first = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]
        self.assertEqual(first["quantities"], plain["quantities"]); self.assertEqual(first["cash_by_currency"], plain["cash_by_currency"])
        self.assertEqual(first["entitlements"], {}); self.assertEqual(first["receivables"], [])
        self.assertEqual(first["processed_actions"][event["id"]], content_hash(event)); self.assertEqual(first["sequence"], 1)


if __name__ == "__main__":
    unittest.main()
