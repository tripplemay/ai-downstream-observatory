"""Actual default-core publication from explicit fictional owner activation."""

from contextlib import closing
import json
import unittest
from unittest.mock import patch

from tests.investor import test_current_correction_fixture as setup
from tests.investor import fixture_dataset_shapes as shapes
from tests.investor.epoch_continuation_source_fixture import create, next_sources, NOW
from tests.investor.epoch_source_fixture import NOW as FIRST
from tests.investor.registered_epoch_fixture import reseal_wrong_continuation_state
from worker.investor import epoch_continuation as runtime, model_epoch_continuation_source as source, eodhd_sources
from worker.investor.evidence_monitor_runtime import resolve_checkpoint
from worker.orchestration.db import WorkbenchError, open_database, instant
from worker.orchestration.runtime import run_pending_once, command_handler
from worker.orchestration.jobs import run_one, claim_job, complete_job
from worker.market import contracts
from worker.research import snapshot


class EpochContinuationTests(unittest.TestCase):
    setUp = setup.CurrentCorrectionFixtureTests.setUp

    def seed(self):
        self.saved = create(self.db, self.path); self.epoch_id = self.saved["registration"]["epoch"]["id"]

    def body(self, enabled=True, key="fictional-explicit-epoch-activation"):
        head = self.db.execute("SELECT id,content_hash FROM investor_evidence_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()
        root = self.db.execute("SELECT content_hash FROM investor_model_epochs WHERE id=?", (self.epoch_id,)).fetchone()
        return {"schema_version": "investor-epoch-control-submit-v1", "epoch_id": self.epoch_id, "expected_registration_hash": root[0], "expected_checkpoint": dict(head),
            "expected_revision": self.db.execute("SELECT revision FROM investor_workspaces WHERE id='w'").fetchone()[0], "idempotency_key": key, "enabled": enabled, "acknowledgements": {key: True for key in runtime.ACKS}}

    def activate(self, now=FIRST):
        return runtime.set_epoch_continuation_control(self.db, "w", "owner", self.body(), owner_interaction=True, now=now)

    def run_core(self, now):
        value = run_pending_once(self.db, "fictional-epoch-continuation-core", clock=lambda: now)
        self.assertIsNotNone(value); self.assertEqual(value["status"], "succeeded", value)
        value["result"] = json.loads(value["result_json"])
        return value

    def test_explicit_activation_default_core_next_close_and_query_only_full_chain_without_trading_or_reset(self):
        self.seed(); before = list(self.db.iterdump())
        self.assertEqual(runtime.discover_epoch_continuations(self.db, now=FIRST), [])
        self.assertEqual(before, list(self.db.iterdump()))
        body = self.body()
        with self.assertRaisesRegex(WorkbenchError, "OWNER_INTERACTION_REQUIRED"):
            runtime.set_epoch_continuation_control(self.db, "w", "owner", body, now=FIRST)
        control = self.activate()
        self.assertEqual(runtime.set_epoch_continuation_control(self.db, "w", "owner", body, owner_interaction=True, now=FIRST), control)
        first = self.run_core(FIRST)
        self.assertEqual(first["result"]["status"], "epoch_continuation_published")
        one = runtime.read_epoch_continuation_chain(self.db, "w", "owner", self.epoch_id, now=FIRST)
        self.assertEqual(one["source"]["candidate"]["checkpoint"], self.saved["checkpoint"])
        self.assertEqual(one["publication_count"], 1)
        next_sources(self.db, self.saved)
        prepared = source.prepare_model_epoch_continuation(self.db, "w", "owner", self.epoch_id, now=NOW)
        self.assertEqual(prepared["candidate"]["checkpoint"]["sequence"], self.saved["checkpoint"]["sequence"] + 1)
        second = self.run_core(NOW)
        self.assertNotEqual(first["result"]["publication_id"], second["result"]["publication_id"])
        before = list(self.db.iterdump())
        with closing(open_database(self.path, read_only=True)) as db:
            chain = runtime.read_epoch_continuation_chain(db, "w", "owner", self.epoch_id, now=NOW)
            metrics = shapes._ACTIVE.get()["metrics"]; hits = metrics["hits"]
            self.assertGreater(hits, 0)
            # Compare the same retained originals and arithmetic with the fixture
            # memo explicitly bypassed, using the actual production validator.
            with patch.object(snapshot, "validate_contract", wraps=contracts.validate_contract) as uncached:
                self.assertEqual(runtime.read_epoch_continuation_chain(db, "w", "owner", self.epoch_id, now=NOW), chain)
                self.assertTrue(any(call.args[1] == shapes.SCHEMA for call in uncached.call_args_list))
            self.assertEqual(metrics["hits"], hits)
            historical = runtime.read_epoch_continuation_chain(db, "w", "owner", self.epoch_id, now="2026-10-21T21:00:00.000Z")
            self.assertEqual(chain["source"], historical["source"])
            replayed, reason = resolve_checkpoint(db, "w", chain["definition"], chain["head"]["checkpoint"]["id"], NOW)
            self.assertIsNone(reason); self.assertEqual(replayed, chain["source"]["candidate"]["checkpoint"])
            self.assertEqual(db.total_changes, 0)
        self.assertEqual(chain["publication_count"], 2)
        parent, checkpoint = self.saved["checkpoint"], chain["source"]["candidate"]["checkpoint"]
        self.assertEqual(checkpoint["sequence"], parent["sequence"] + 1)
        for field in ("initial_notional_cny", "initialized_at", "quantities", "cash_by_currency", "entitlements", "receivables", "processed_actions", "epoch_binding"):
            self.assertEqual(checkpoint[field], parent[field], field)
        self.assertEqual(before, list(self.db.iterdump()))
        actual_reader = runtime.read_registered_model_epoch
        cap = "2026-10-21T10:01:03.000Z"
        def stricter_read_cap(*args, **kwargs):
            verified = actual_reader(*args, **kwargs)
            verified["proof"]["read_valid_until"] = cap
            return verified
        # Extra restriction on a fully verified result, not a fabricated grant
        # or a real supplier permission-change acceptance claim.
        with patch.object(runtime, "read_registered_model_epoch", side_effect=stricter_read_cap):
            capped = runtime.read_epoch_continuation_chain(self.db, "w", "owner", self.epoch_id, now=NOW)
            self.assertEqual(capped["source"], chain["source"]); self.assertEqual(capped["read_valid_until"], cap)
            with self.assertRaisesRegex(WorkbenchError, "SOURCE_EXPIRED"):
                runtime.read_epoch_continuation_chain(self.db, "w", "owner", self.epoch_id, now=cap)
        self.assertEqual(before, list(self.db.iterdump()))
        self.db.execute("SAVEPOINT fictional_resealed_continuation")
        try:
            reseal_wrong_continuation_state(self.db, second["result"]["publication_id"])
            runtime.publication_header(self.db, "w", "owner", second["result"]["publication_id"])
            with self.assertRaisesRegex(WorkbenchError, "CHECKPOINT_CHANGED"):
                runtime.read_epoch_continuation_chain(self.db, "w", "owner", self.epoch_id, now=NOW)
        finally: self.db.execute("ROLLBACK TO fictional_resealed_continuation"); self.db.execute("RELEASE fictional_resealed_continuation")
        self.assertEqual(before, list(self.db.iterdump()))
        self.assertIsNone(run_pending_once(self.db, "fictional-epoch-continuation-dedup", clock=lambda: NOW))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM investor_epoch_continuations").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM investor_evidence_model_checkpoints").fetchone()[0], parent["sequence"] + 1)
        for table in ("portfolios", "accounts", "ledger_events", "postings"):
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM " + table).fetchone()[0], 0)

    def pending(self):
        self.seed(); self.activate(); requests = runtime.discover_epoch_continuations(self.db, now=FIRST)
        self.assertEqual(len(requests), 1)
        lease = claim_job(self.db, "fictional-long-finalization-test-lease", lease_seconds=1200, job_type=runtime.JOB_TYPE, now=FIRST)
        self.assertIsNotNone(lease)
        job = dict(self.db.execute("SELECT * FROM job_runs WHERE id=?", (lease.job_id,)).fetchone())
        self.assertTrue(job["period"].startswith(runtime.PREFIX))
        return lease, job

    def test_late_failure_and_final_runner_clock_expiry_roll_back_every_domain_row_without_heavy_writer_replay(self):
        lease, job = self.pending()
        prepared = runtime.prepare_epoch_continuation_job(self.db, job, lease, clock=lambda: FIRST)
        before = list(self.db.iterdump())
        with patch.object(runtime, "enqueue_notification", side_effect=WorkbenchError("FICTIONAL_LATE_PUBLICATION_FAILURE")), \
                patch.object(source, "replay_model_epoch_continuation", side_effect=AssertionError("NO_HEAVY_REPLAY_IN_WRITER")) as replay:
            with self.assertRaisesRegex(WorkbenchError, "FICTIONAL_LATE_PUBLICATION_FAILURE"):
                complete_job(self.db, lease, {}, effect=prepared["effect"], now=FIRST, clock=lambda: FIRST)
        replay.assert_not_called(); self.assertEqual(before, list(self.db.iterdump()))
        deadline = json.loads(self.db.execute("SELECT document_json FROM investor_epoch_continuation_requests WHERE id=?", (job["period"],)).fetchone()[0])["valid_until"]
        self.assertLess(instant(deadline), instant(lease.lease_until))
        times = iter([FIRST, FIRST, FIRST, deadline])
        clock = lambda: next(times)
        prepared = runtime.prepare_epoch_continuation_job(self.db, job, lease, clock=clock)
        with self.assertRaisesRegex(WorkbenchError, "PUBLICATION_EXPIRED"):
            complete_job(self.db, lease, {}, effect=prepared["effect"], now=FIRST, clock=clock)
        self.assertEqual(before, list(self.db.iterdump()))

    def test_revoked_sources_and_explicit_pause_invalidate_prepared_work_but_pause_needs_no_source_eligibility(self):
        lease, job = self.pending()
        prepared = runtime.prepare_epoch_continuation_job(self.db, job, lease, clock=lambda: FIRST)
        grant = self.db.execute("SELECT id FROM investor_eodhd_authorities WHERE workspace_id='w'").fetchone()[0]
        eodhd_sources.set_authority_enabled(self.db, "w", "owner", grant, False, now=FIRST)
        body = self.body(False, "fictional-stop-despite-revoked-source")
        paused = runtime.set_epoch_continuation_control(self.db, "w", "owner", body, owner_interaction=True, now=FIRST)
        self.assertFalse(paused["body"]["enabled"])
        before = list(self.db.iterdump())
        with self.assertRaises(WorkbenchError): complete_job(self.db, lease, {}, effect=prepared["effect"], now=FIRST, clock=lambda: FIRST)
        self.assertEqual(before, list(self.db.iterdump()))
        self.assertEqual(runtime.discover_epoch_continuations(self.db, now=FIRST), [])
        with self.assertRaises(WorkbenchError): runtime.read_epoch_continuation_chain(self.db, "w", "owner", self.epoch_id, now=FIRST)

    def test_obsolete_request_is_skipped_and_new_explicit_control_can_publish_without_waiting_for_new_quotes(self):
        self.seed(); self.activate(); runtime.discover_epoch_continuations(self.db, now=FIRST)
        later = "2026-10-20T10:00:03.001Z"
        runtime.set_epoch_continuation_control(self.db, "w", "owner", self.body(True, "fictional-reconfirmed-epoch-control"), owner_interaction=True, now=later)
        original_observations = self.db.execute("SELECT COUNT(*) FROM investor_observations").fetchone()[0]
        skipped = run_pending_once(self.db, "fictional-obsolete-epoch-control", clock=lambda: later)
        self.assertEqual(skipped["status"], "skipped", skipped)
        self.assertEqual(json.loads(skipped["result_json"])["status"], "epoch_continuation_obsolete")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM investor_epoch_continuations").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM investor_observations").fetchone()[0], original_observations)
        completed = self.run_core(later)
        self.assertEqual(completed["result"]["status"], "epoch_continuation_published")
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM investor_epoch_continuation_requests").fetchone()[0], 2)
        self.assertIsNone(run_pending_once(self.db, "fictional-no-epoch-spin", clock=lambda: later))

    def test_context_key_tracks_the_frozen_policy_local_day_but_not_poll_timestamp_or_parent_reference(self):
        value = {"input": {"epoch": {"id": "fictional-epoch", "content_hash": "a" * 64}, "segments": [], "settings": {}},
            "projection": {"economic_projection": {"quotes": [{"market": "US"}], "fx": [], "corporate_actions": []}},
            "kernel_input": {"definition": {"fixed_policy": {"evaluation_timezone": "Asia/Shanghai"}}}}
        activation = {"id": "fictional-control", "content_hash": "b" * 64}
        first = runtime._key(value, activation, "2026-10-20T15:59:58.000Z")
        self.assertEqual(first, runtime._key(value, activation, "2026-10-20T15:59:59.000Z"))
        self.assertNotEqual(first, runtime._key(value, activation, "2026-10-20T16:00:00.000Z"))


if __name__ == "__main__": unittest.main()
