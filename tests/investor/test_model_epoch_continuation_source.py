"""Actual registered parent plus further retained closes, never provider calls."""

from contextlib import closing
import unittest
from unittest.mock import patch

from tests.investor import test_current_correction_fixture as setup, current_correction_fixture as current
from tests.investor.epoch_continuation_source_fixture import create, next_sources, NOW
from tests.investor.epoch_source_fixture import NOW as FIRST
from worker.investor import model_epoch_continuation_source as source, eodhd_sources, data_evidence
from worker.investor.monitor_data import validate_monitor_data_document
from worker.orchestration.db import WorkbenchError, content_hash, open_database


class ModelEpochContinuationSourceTests(unittest.TestCase):
    setUp = setup.CurrentCorrectionFixtureTests.setUp

    def seed(self):
        self.saved = create(self.db, self.path); self.epoch_id = self.saved["registration"]["epoch"]["id"]
        next_sources(self.db, self.saved)

    def prepare(self, db=None, now=NOW):
        return source.prepare_model_epoch_continuation(db or self.db, "w", "owner", self.epoch_id, now=now)

    def test_automatic_real_receipt_selection_replays_registered_parent_and_next_close_without_reset_or_writes(self):
        self.seed(); before = list(self.db.iterdump())
        with closing(open_database(self.path, read_only=True)) as db:
            value = self.prepare(db)
            self.assertEqual(value, source.replay_model_epoch_continuation(db, "w", "owner", self.epoch_id, value["input"], now=NOW))
            self.assertEqual(db.total_changes, 0)
        parent, candidate = self.saved["checkpoint"], value["candidate"]["checkpoint"]
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["sequence"], parent["sequence"] + 1)
        self.assertEqual(candidate["previous_hash"], content_hash(parent))
        self.assertEqual(candidate["epoch_binding"], parent["epoch_binding"])
        for field in ("initial_notional_cny", "initialized_at", "quantities", "cash_by_currency", "entitlements", "receivables", "processed_actions"):
            self.assertEqual(candidate[field], parent[field], field)
        self.assertGreater(candidate["market_cutoffs"]["US"], parent["market_cutoffs"]["US"])
        self.assertEqual(candidate["input_hash"], content_hash(value["input"]))
        self.assertEqual(candidate["projection_hash"], content_hash(value["projection"]))
        self.assertEqual(len(value["input"]["segments"][0]["snapshot"]["capture_refs"]), 4)
        self.assertEqual(value["epoch_definition"], self.saved["preview"]["epoch_definition"])
        for key in ("continuation_admitted", "current_source_eligibility_restored", "checkpoint_created", "monitoring_resumed", "trading_permission"):
            self.assertFalse(value["proof"][key])
        with self.assertRaises(ValueError): validate_monitor_data_document(value["input"])
        self.assertEqual(before, list(self.db.iterdump()))

    def test_no_new_close_reuses_actual_parent_and_resealed_carry_or_stale_input_cannot_change_it(self):
        self.saved = create(self.db, self.path); self.epoch_id = self.saved["registration"]["epoch"]["id"]
        same = self.prepare(now=FIRST)
        self.assertEqual(same["candidate"]["checkpoint"], self.saved["checkpoint"])
        next_sources(self.db, self.saved); value = self.prepare(); before = list(self.db.iterdump())
        for field, replacement in (("carry_hash", "0" * 64), ("carry_count", 0), ("projection_hash", "0" * 64)):
            changed = {**value["input"], field: replacement}
            with self.assertRaises(WorkbenchError): source.replay_model_epoch_continuation(self.db, "w", "owner", self.epoch_id, changed, now=NOW)
        with self.assertRaises(WorkbenchError): source.replay_model_epoch_continuation(self.db, "w", "owner", self.epoch_id, same["input"], now=NOW)
        with self.assertRaises(WorkbenchError): self.prepare(now="2026-10-24T16:00:00.000Z")
        for workspace, actor, identifier in (("foreign", "owner", self.epoch_id), ("w", "foreign", self.epoch_id), ("w", "owner", "unregistered")):
            with self.assertRaises(WorkbenchError): source.prepare_model_epoch_continuation(self.db, workspace, actor, identifier, now=NOW)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_stops_unknown_tail_and_current_permissions_are_not_replaced_by_old_registration(self):
        self.seed(); before = list(self.db.iterdump())
        with patch.object(source, "_basis", side_effect=AssertionError("NO_STOPPED_REPLAY")) as heavy:
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                source.prepare_model_epoch_continuation(self.db, "w", "owner", self.epoch_id, now=NOW, stop_requested=lambda: True)
        heavy.assert_not_called()
        self.db.execute("SAVEPOINT fictional_unknown_continuation")
        try:
            self.db.execute("DROP TRIGGER investor_evidence_checkpoint_insert"); self.db.execute("DROP TRIGGER investor_epoch_checkpoint_insert")
            self.db.execute("""INSERT INTO investor_evidence_model_checkpoints SELECT 'fictional-unknown-continuation',workspace_id,model_id,input_id,sequence+1,
                content_hash,content_hash,projection_hash,created_at,valid_until FROM investor_evidence_model_checkpoints WHERE id=?""", (self.saved["registration"]["checkpoint"]["id"],))
            with self.assertRaisesRegex(WorkbenchError, "LATEST_HEAD_CHANGED"): self.prepare()
        finally: self.db.execute("ROLLBACK TO fictional_unknown_continuation"); self.db.execute("RELEASE fictional_unknown_continuation")
        self.assertEqual(before, list(self.db.iterdump()))
        grant = self.db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
        eodhd_sources.set_authority_enabled(self.db, "w", "owner", grant, False, now=NOW)
        with self.assertRaises(WorkbenchError): self.prepare()

    def test_unrelated_equal_fx_sources_still_stop_selection_and_replay_rather_than_latest_wins(self):
        self.seed(); value = self.prepare()
        snapshot = value["input"]["segments"][0]["snapshot"]
        ref = next(ref for ref in snapshot["review_refs"] if self.db.execute("SELECT kind FROM investor_data_sources WHERE id=?", (ref["source_id"],)).fetchone()[0] == "fx")
        facts = data_evidence.resolve_review(self.db, "w", ref["review_id"], "fx", now=NOW)["facts"]
        facts = {key: item for key, item in facts.items() if key != "monitor_series"}
        current.reviewed(self.db, "fx", facts, NOW, self.saved["preview"]["epoch_definition"]["valid_until"], "unrelated-equal-fx-must-not-win")
        before = list(self.db.iterdump())
        with self.assertRaisesRegex(WorkbenchError, "FX_AUTHORITY_AMBIGUOUS"): self.prepare()
        with self.assertRaisesRegex(WorkbenchError, "FX_AUTHORITY_AMBIGUOUS"):
            source.replay_model_epoch_continuation(self.db, "w", "owner", self.epoch_id, value["input"], now=NOW)
        self.assertEqual(before, list(self.db.iterdump()))


if __name__ == "__main__": unittest.main()
