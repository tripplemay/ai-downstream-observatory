"""Retained first-state economics, actual journals and current source permissions."""

from contextlib import closing
import unittest
from unittest.mock import patch

from tests.investor import test_current_correction_fixture as setup, epoch_registration_fixture as fixture
from tests.investor.epoch_source_fixture import NOW
from tests.investor.registered_epoch_fixture import reseal_wrong_first_state
from worker.investor import model_epoch_source as source, model_epoch_registration as registration, registered_model_epoch as registered, eodhd_sources
from worker.investor.evidence_monitor_runtime import resolve_checkpoint, purge_monitor_payload
from worker.orchestration.db import WorkbenchError, open_database


class RegisteredModelEpochTests(unittest.TestCase):
    setUp = setup.CurrentCorrectionFixtureTests.setUp

    def seed(self):
        self.value = fixture.create(self.db, self.path); self.epoch_id = self.value["registration"]["epoch"]["id"]

    def read(self, db=None, now=NOW): return registered.read_registered_model_epoch(db or self.db, "w", "owner", self.epoch_id, now=now)

    def test_real_journal_authorizes_readonly_replay_after_publication_and_quote_freshness_without_admission_or_resuming(self):
        self.seed(); before = list(self.db.iterdump())
        with closing(open_database(self.path, read_only=True)) as db:
            value = self.read(db)
            later = self.read(db, "2026-10-20T21:00:03.000Z")
            self.assertEqual(value["source"], later["source"]); self.assertEqual(value["observation"], later["observation"])
            self.assertEqual(value["source"]["candidate"]["checkpoint"], self.value["checkpoint"])
            self.assertEqual(value["proof"]["read_valid_until"], "2026-10-24T16:00:00.000Z")
            self.assertTrue(value["proof"]["registered_bindings_verified"]); self.assertTrue(value["proof"]["source_evidence_verified"])
            self.assertFalse(value["proof"]["current_source_eligibility_restored"]); self.assertFalse(value["proof"]["monitoring_resumed"])
            self.assertEqual(value["observation"]["monitoring"], "paused"); self.assertIsNone(value["observation"]["next_review_at"])
            definition = value["source"]["kernel_input"]["history"]["definition"]
            checkpoint, reason = resolve_checkpoint(db, "w", definition, self.value["registration"]["checkpoint"]["id"], NOW)
            self.assertIsNone(reason); self.assertEqual(checkpoint, self.value["checkpoint"]); self.assertEqual(db.total_changes, 0)
        with self.assertRaisesRegex(WorkbenchError, "LATEST_HEAD_CHANGED"):
            source.replay_model_epoch_source(self.db, "w", "owner", self.value["preview"]["epoch_definition"], self.value["preview"]["input"], now=NOW)
        with patch("worker.investor.monitor.implementation_hash", return_value="f" * 64):
            self.assertEqual(self.read()["source"], value["source"])
        for kind, identifier in (("checkpoint", self.value["registration"]["checkpoint"]["id"]), ("run", self.value["registration"]["monitor_run_id"])):
            with self.assertRaisesRegex(WorkbenchError, "PURGE_NOT_DUE"):
                purge_monitor_payload(self.db, "w", "owner", kind, identifier, now="2026-10-20T21:00:03.000Z")
        self.assertEqual(before, list(self.db.iterdump()))

    def test_resealed_journal_and_first_state_do_not_replace_raw_source_and_arithmetic_verification(self):
        self.seed(); before = list(self.db.iterdump())
        self.db.execute("SAVEPOINT fictional_resealed_epoch_state")
        try:
            reseal_wrong_first_state(self.db, self.epoch_id)
            # Header hashes/audits are coherent. Raw replay must still detect the
            # wrong quantity rather than trusting those resealed receipts.
            registration._header(self.db, "w", "owner", self.epoch_id, "registration")
            with self.assertRaisesRegex(WorkbenchError, "CHECKPOINT_CHANGED"): self.read()
        finally: self.db.execute("ROLLBACK TO fictional_resealed_epoch_state"); self.db.execute("RELEASE fictional_resealed_epoch_state")
        for table, column, identifier in (("investor_evidence_checkpoint_payloads", "checkpoint_id", self.value["registration"]["checkpoint"]["id"]),
            ("investor_evidence_run_payloads", "run_id", self.value["registration"]["monitor_run_id"])):
            self.db.execute("SAVEPOINT fictional_missing_epoch_payload")
            try:
                trigger = "investor_evidence_checkpoint_payload_delete" if column == "checkpoint_id" else "investor_evidence_run_payload_delete"
                self.db.execute("DROP TRIGGER " + trigger); self.db.execute("DELETE FROM " + table + " WHERE " + column + "=?", (identifier,))
                with self.assertRaises(WorkbenchError): self.read()
            finally: self.db.execute("ROLLBACK TO fictional_missing_epoch_payload"); self.db.execute("RELEASE fictional_missing_epoch_payload")
        self.assertEqual(before, list(self.db.iterdump()))

    def test_owner_journal_clock_stops_and_current_provider_revocation_are_not_bypassed_by_recorded_calculation_time(self):
        self.seed(); before = list(self.db.iterdump())
        for workspace, actor, identifier in (("foreign", "owner", self.epoch_id), ("w", "foreign", self.epoch_id), ("w", "owner", "fictional-unregistered-epoch")):
            with self.assertRaises(WorkbenchError): registered.read_registered_model_epoch(self.db, workspace, actor, identifier, now=NOW)
        for at in ("2026-10-20T10:00:02.999Z", "2026-10-24T16:00:00.000Z"):
            with self.assertRaises(WorkbenchError): self.read(now=at)
        with patch.object(source, "_correction_basis", side_effect=AssertionError("NO_STOPPED_REPLAY")) as heavy:
            with self.assertRaisesRegex(WorkbenchError, "WORKER_STOP_REQUESTED"):
                registered.read_registered_model_epoch(self.db, "w", "owner", self.epoch_id, now=NOW, stop_requested=lambda: True)
        heavy.assert_not_called(); self.assertEqual(before, list(self.db.iterdump()))
        grant = self.db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
        eodhd_sources.set_authority_enabled(self.db, "w", "owner", grant, False, now=NOW)
        with self.assertRaises(WorkbenchError): self.read()
        checkpoint_id, run_id = self.value["registration"]["checkpoint"]["id"], self.value["registration"]["monitor_run_id"]
        for kind, identifier in (("checkpoint", checkpoint_id), ("run", run_id)):
            purged = purge_monitor_payload(self.db, "w", "owner", kind, identifier, now=NOW)
            self.assertEqual(purged["reason"], "source_unavailable")
        registration._header(self.db, "w", "owner", self.epoch_id, "registration")
        with self.assertRaisesRegex(WorkbenchError, "PAYLOAD_PURGED"): self.read()


if __name__ == "__main__": unittest.main()
