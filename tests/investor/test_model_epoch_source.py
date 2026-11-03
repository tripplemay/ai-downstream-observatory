"""Qualified fictional current sources, not unregistered current-state publication."""

from contextlib import closing
from copy import deepcopy
import unittest
from unittest.mock import patch

from tests.investor import test_current_correction_fixture as fixture, epoch_source_fixture as source_fixture
from worker.investor import model_epoch_source as source, eodhd_sources
from worker.investor.monitor_data import validate_monitor_data_document
from worker.orchestration.db import WorkbenchError, content_hash, open_database


class ModelEpochSourceTests(unittest.TestCase):
    setUp = fixture.CurrentCorrectionFixtureTests.setUp

    def seed(self):
        self.value = source_fixture.create(self.db, self.path); return self.value

    def prepare(self, db=None, now=source_fixture.NOW):
        return source.prepare_model_epoch_source(db or self.db, "w", "owner", **self.value, now=now)

    def test_real_reviewed_calendar_and_retained_sdk_new_close_replay_readonly_without_registering_epoch_input_or_checkpoint(self):
        self.seed(); before = list(self.db.iterdump())
        with closing(open_database(self.path, read_only=True)) as db:
            value = self.prepare(db); replay = source.replay_model_epoch_source(db, "w", "owner", value["epoch_definition"], value["input"], now=source_fixture.NOW)
            self.assertEqual(value, replay); self.assertEqual(db.total_changes, 0)
        self.assertEqual(value["input"]["schema_version"], "investor-monitor-data-input-v6")
        self.assertEqual(value["projection"]["schema_version"], "investor-monitor-data-projection-v4")
        self.assertEqual(value["candidate"]["checkpoint"]["projection_hash"], content_hash(value["projection"]))
        self.assertEqual(value["candidate"]["checkpoint"]["input_hash"], content_hash(value["input"]))
        self.assertTrue(value["proof"]["source_evidence_verified"])
        for key in ("epoch_registered", "current_source_eligibility_restored", "checkpoint_created", "monitoring_resumed", "trading_permission"):
            self.assertFalse(value["proof"][key])
        self.assertFalse(value["candidate"]["registered_bindings_verified"])
        self.assertGreater(value["candidate"]["checkpoint"]["market_cutoffs"]["US"], value["kernel_input"]["history"]["head"]["market_cutoffs"]["US"])
        with self.assertRaises(ValueError): validate_monitor_data_document(value["input"])
        self.assertEqual(before, list(self.db.iterdump()))

    def test_resealed_carry_definition_and_forged_current_parameters_or_scope_do_not_replace_source_replay(self):
        self.seed(); value = self.prepare(); before = list(self.db.iterdump())
        for field, replacement in (("carry_count", 0), ("carry_hash", "0" * 64), ("projection_hash", "0" * 64)):
            document = {**value["input"], field: replacement}
            with self.assertRaises(WorkbenchError): source.replay_model_epoch_source(self.db, "w", "owner", value["epoch_definition"], document, now=source_fixture.NOW)
        epoch = deepcopy(value["epoch_definition"]); epoch["original_head_id"] = "fake"
        document = deepcopy(value["input"]); document["epoch"]["content_hash"] = content_hash(epoch)
        with self.assertRaises(WorkbenchError): source.replay_model_epoch_source(self.db, "w", "owner", epoch, document, now=source_fixture.NOW)
        document = deepcopy(value["input"]); document["settings"]["policy"]["weight_band"] = "0.9"
        with self.assertRaises((ValueError, WorkbenchError)): source.replay_model_epoch_source(self.db, "w", "owner", value["epoch_definition"], document, now=source_fixture.NOW)
        definition = value["kernel_input"]["history"]["definition"]
        forged = source.build_monitor_data(self.db, "w", definition, self.value["windows"], document["settings"], now=source_fixture.NOW, audited_action_knowledge=True)
        document["audited_projection_hash"] = forged["document"]["projection_hash"]
        projection = deepcopy(value["projection"]); projection["economic_projection"]["policy"] = forged["projection"]["policy"]
        document["projection_hash"] = content_hash(projection)
        with self.assertRaisesRegex(WorkbenchError, "SETTINGS_CHANGED"): source.replay_model_epoch_source(self.db, "w", "owner", value["epoch_definition"], document, now=source_fixture.NOW)
        for actor, workspace in (("foreign", "w"), ("owner", "foreign")):
            with self.assertRaises(WorkbenchError): source.replay_model_epoch_source(self.db, workspace, actor, value["epoch_definition"], value["input"], now=source_fixture.NOW)
        with self.assertRaises((ValueError, WorkbenchError)): source.replay_model_epoch_source(self.db, "w", "owner", value["epoch_definition"], value["input"], now="2026-10-22T10:00:03.000Z")
        self.assertEqual(before, list(self.db.iterdump()))
        with patch.object(source, "_basis", side_effect=AssertionError("NO_STOPPED_SOURCE_REPLAY")) as heavy:
            with self.assertRaises(WorkbenchError): source.prepare_model_epoch_source(self.db, "w", "owner", **self.value, now=source_fixture.NOW, stop_requested=lambda: True)
        heavy.assert_not_called()
        self.db.execute("SAVEPOINT fictional_bad_epoch_tail")
        try:
            self.db.execute("DROP TRIGGER investor_evidence_checkpoint_insert")
            self.db.execute("""INSERT INTO investor_evidence_model_checkpoints SELECT 'fictional-bad-epoch-tail',workspace_id,model_id,input_id,sequence+1,
                content_hash,content_hash,projection_hash,created_at,valid_until FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1""")
            with self.assertRaisesRegex(WorkbenchError, "LATEST_HEAD_CHANGED"): self.prepare()
        finally: self.db.execute("ROLLBACK TO fictional_bad_epoch_tail"); self.db.execute("RELEASE fictional_bad_epoch_tail")
        self.db.execute("SAVEPOINT fictional_unrelated_actions")
        try:
            from worker.investor import data_evidence
            selected = data_evidence.resolve_review(self.db, "w", self.value["windows"][0]["action_review_ids"][0], "actions", now=source_fixture.NOW)
            stored = data_evidence.store_source(self.db, "w", "owner", "actions", {"title": "FICTIONAL unrelated same-looking facts", "reference": "synthetic://unrelated-epoch-source", "excerpt": "Not the approved source lineage"}, now=source_fixture.NOW)
            other = data_evidence.review_source(self.db, "w", "owner", stored["id"], "approved", selected["facts"], "Fictional only", selected["review"]["valid_until"], now=source_fixture.NOW)
            inputs = deepcopy(self.value); inputs["windows"][0]["action_review_ids"][0] = other["id"]
            with self.assertRaisesRegex(WorkbenchError, "ACTION_LINEAGE_CHANGED"): source.prepare_model_epoch_source(self.db, "w", "owner", **inputs, now=source_fixture.NOW)
        finally: self.db.execute("ROLLBACK TO fictional_unrelated_actions"); self.db.execute("RELEASE fictional_unrelated_actions")
        self.assertEqual(before, list(self.db.iterdump()))
        grant = self.db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
        eodhd_sources.set_authority_enabled(self.db, "w", "owner", grant, False, now=source_fixture.NOW)
        with self.assertRaises(WorkbenchError): self.prepare()
        with self.assertRaises(WorkbenchError): source.replay_model_epoch_source(self.db, "w", "owner", value["epoch_definition"], value["input"], now=source_fixture.NOW)


if __name__ == "__main__": unittest.main()
