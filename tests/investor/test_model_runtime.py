import json
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as runtime_fixtures
from tests.investor.test_model_state import model_fixture
from tests.investor.model_fixture import snapshot_for_model
from worker.investor.model_runtime import discover_monitor_requests, prepare_monitor_job, register_synthetic_snapshot
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, transaction
from worker.orchestration.jobs import claim_job, complete_job, run_one
from worker.orchestration.runtime import run_pending_once


NOW = runtime_fixtures.NOW


class InvestorModelRuntimeTests(unittest.TestCase):
    setUp = runtime_fixtures.InvestorRuntimeTests.setUp
    save = runtime_fixtures.InvestorRuntimeTests.save
    assert_no_finance = runtime_fixtures.InvestorRuntimeTests.assert_no_finance

    def seed_model(self):
        profile_id = self.save()
        definition, _ = model_fixture()
        profile = self.db.execute("SELECT * FROM investor_profiles WHERE id=?", (profile_id,)).fetchone()
        plan = {"schema_version": "investor-reference-plan-v1", "profile_id": profile_id, "strategy_version": "synthetic-only",
                "strategy_evidence": "Software fixture only", "input_version": "a" * 64, "data_cutoff": "2026-01-01T12:00:00.000Z", "created_at": NOW,
                "valid_until": "2026-01-05T12:00:00.000Z", "data_mode": "synthetic", "targets": [
                    {**target, "symbol": "SYNTHETIC", "name": "Synthetic", "role": "Test", "overlap_summary": "Test"} for target in definition["targets"]],
                "estimated_cost": "Test", "risk_scenarios": ["Test"], "benchmark_summary": "Test", "counterarguments": ["Test"], "uncertainties": ["Test"], "live_advice_eligible": False}
        definition.update(profile_id=profile_id, profile_version=profile["version"], profile_hash=profile["content_hash"], plan_id="plan",
                          plan_hash=content_hash(plan), created_at=NOW, valid_until=plan["valid_until"])
        definition["target_definition_hash"] = content_hash({key: definition[key] for key in ("profile_hash", "plan_hash", "targets")})
        with transaction(self.db):
            self.db.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('select-audit','synthetic-investor','investor_save_plan','investor_workspace','w','{}',?)", (NOW,))
            self.db.execute("INSERT INTO investor_reference_plans(id,workspace_id,profile_id,document_json,content_hash,created_at) VALUES('plan','w',?,?,?,?)", (profile_id, canonical_json(plan), content_hash(plan), NOW))
            self.db.execute("INSERT INTO investor_plan_selections(id,workspace_id,plan_id,actor_id,created_at,audit_id) VALUES('selection','w','plan','synthetic-investor',?,'select-audit')", (NOW,))
            self.db.execute("INSERT INTO investor_models(id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(?,'w',?,'plan','selection',?,?,?)", (definition["model_id"], profile_id, canonical_json(definition), content_hash(definition), NOW))
            self.db.execute("INSERT INTO investor_model_controls(id,workspace_id,model_id,version,enabled,actor_id,audit_id,created_at) VALUES('control','w',?,1,1,'synthetic-investor','select-audit',?)", (definition["model_id"], NOW))
        return definition

    def run_model(self, now=NOW, allow=True):
        discover_monitor_requests(self.db, now=now)
        return run_one(self.db, "model-test", lambda job, lease: prepare_monitor_job(self.db, job, lease, clock=lambda: now, allow_synthetic=allow), job_type="investor_monitor", clock=lambda: now)

    def source(self, definition, now=NOW, scenario="normal"):
        row = self.db.execute("SELECT document_json FROM investor_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()
        snapshot = snapshot_for_model(definition, now, json.loads(row[0]) if row else None, scenario)
        return register_synthetic_snapshot(self.db, "w", definition["model_id"], snapshot, now=now)

    def pause(self):
        self.db.execute("INSERT INTO investor_model_controls(id,workspace_id,model_id,version,enabled,actor_id,audit_id,created_at) SELECT 'pause','w',id,2,0,'synthetic-investor','select-audit',? FROM investor_models", (NOW,))

    def test_core_missing_input_check_is_not_a_no_action_signal_and_does_not_spin(self):
        self.seed_model()
        self.assertEqual(run_pending_once(self.db, "core", clock=lambda: NOW)["status"], "succeeded")
        self.assertIsNone(run_pending_once(self.db, "core", clock=lambda: "2026-01-02T12:30:00.000Z"))
        run = json.loads(self.db.execute("SELECT document_json FROM investor_monitor_runs").fetchone()[0])
        self.assertEqual(run["reason_codes"], ["MONITOR_DATASET_NOT_READY"])
        self.assertEqual(self.db.execute("SELECT outcome FROM investor_observations").fetchone()[0], "insufficient_evidence")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_model_checkpoints").fetchone()[0], 0)
        self.assert_no_finance()

    def test_production_handler_cannot_publish_synthetic_checkpoint(self):
        definition = self.seed_model(); self.source(definition)
        self.assertEqual(run_pending_once(self.db, "core", clock=lambda: NOW)["status"], "succeeded")
        document = json.loads(self.db.execute("SELECT document_json FROM investor_monitor_runs").fetchone()[0])
        self.assertEqual(document["reason_codes"], ["SYNTHETIC_MONITOR_DISABLED"])
        self.assertIsNone(document["result"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_model_checkpoints").fetchone()[0], 0)
        self.assert_no_finance()

    def test_dispatcher_datetime_wall_clock_does_not_break_unrelated_jobs(self):
        self.seed_model()
        wall_clock = instant("2026-01-02T12:00:03.123456Z")
        self.assertEqual(run_pending_once(self.db, "core", clock=lambda: wall_clock)["status"], "succeeded")
        document = json.loads(self.db.execute("SELECT document_json FROM investor_monitor_runs").fetchone()[0])
        self.assertEqual(document["created_at"], "2026-01-02T12:00:03.123Z")
        with self.assertRaisesRegex(WorkbenchError, "CLOCK_PRECISION"):
            discover_monitor_requests(self.db, now="2026-01-02T12:00:03.123456Z")

    def test_model_continues_with_hash_chained_units_and_never_applies_planned_funding(self):
        definition = self.seed_model(); self.source(definition); self.run_model()
        first = json.loads(self.db.execute("SELECT document_json FROM investor_model_checkpoints").fetchone()[0])
        self.assertIsNone(self.run_model())
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_requests").fetchone()[0], 1)
        later = "2026-01-03T12:00:03.000Z"
        self.source(definition, later, "due"); self.run_model(later)
        second = json.loads(self.db.execute("SELECT document_json FROM investor_model_checkpoints ORDER BY sequence DESC LIMIT 1").fetchone()[0])
        self.assertEqual(second["sequence"], 2)
        self.assertEqual(second["previous_hash"], content_hash(first))
        self.assertEqual(second["quantities"], first["quantities"])
        self.assertEqual(second["cash_by_currency"], first["cash_by_currency"])
        run = json.loads(self.db.execute("SELECT document_json FROM investor_monitor_runs ORDER BY created_at DESC LIMIT 1").fetchone()[0])
        self.assertEqual(run["result"]["assessment"]["outcome"], "decision_required")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_observations WHERE outcome!='insufficient_evidence'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_stale_source_publishes_gap_but_no_checkpoint(self):
        definition = self.seed_model(); self.source(definition, scenario="stale"); self.run_model()
        run = json.loads(self.db.execute("SELECT document_json FROM investor_monitor_runs").fetchone()[0])
        self.assertEqual(run["result"]["assessment"]["outcome"], "insufficient_evidence")
        self.assertIsNone(run["result"]["checkpoint"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_model_checkpoints").fetchone()[0], 0)

    def test_pause_profile_and_source_changes_fence_in_flight_results(self):
        for change in ("pause", "profile", "input"):
            with self.subTest(change=change):
                # Each mutation targets an independent fresh model database.
                if change != "pause": self.db.close(); self.doCleanups(); self.setUp()
                definition = self.seed_model(); self.source(definition); discover_monitor_requests(self.db, now=NOW)
                lease = claim_job(self.db, "test", 60, "investor_monitor", now=NOW)
                job = dict(self.db.execute("SELECT * FROM job_runs").fetchone())
                prepared = prepare_monitor_job(self.db, job, lease, clock=lambda: NOW, allow_synthetic=True)
                if change == "pause": self.pause()
                if change == "profile": self.save()
                if change == "input": self.source(definition, scenario="due")
                complete_job(self.db, lease, {}, effect=prepared["effect"], now=NOW)
                self.assertEqual(self.db.execute("SELECT status FROM job_runs WHERE id=?", (job["id"],)).fetchone()[0], "skipped")
                self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_runs").fetchone()[0], 0)
                self.assertEqual(self.db.execute("SELECT count(*) FROM investor_model_checkpoints").fetchone()[0], 0)

    def test_lease_takeover_and_restore_lock_cannot_partially_publish(self):
        definition = self.seed_model(); self.source(definition); discover_monitor_requests(self.db, now=NOW)
        old = claim_job(self.db, "old", 1, "investor_monitor", now=NOW)
        job = dict(self.db.execute("SELECT * FROM job_runs").fetchone())
        prepared = prepare_monitor_job(self.db, job, old, clock=lambda: NOW, allow_synthetic=True)
        later = "2026-01-02T12:00:05.000Z"
        winner = claim_job(self.db, "new", 60, "investor_monitor", now=later)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, old, {}, effect=prepared["effect"], now=later)
        job = dict(self.db.execute("SELECT * FROM job_runs").fetchone())
        ready = prepare_monitor_job(self.db, job, winner, clock=lambda: later, allow_synthetic=True)
        def locked(db):
            result = ready["effect"](db)
            (self.path.parent / "RESTORE_PENDING_REVIEW").write_text("Synthetic recovery lock")
            return result
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"): complete_job(self.db, winner, {}, effect=locked, now=later)
        for table in ("investor_monitor_runs", "investor_model_checkpoints", "investor_observations"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)

    def test_all_state_is_immutable_and_cannot_be_replaced(self):
        definition = self.seed_model(); self.source(definition); self.run_model()
        for table in ("investor_models", "investor_model_controls", "investor_model_inputs", "investor_model_checkpoints", "investor_monitor_requests", "investor_monitor_runs"):
            with self.subTest(table=table):
                with self.assertRaisesRegex(Exception, "immutable"): self.db.execute("UPDATE " + table + " SET created_at=?", (NOW,))
                with self.assertRaisesRegex(Exception, "immutable"): self.db.execute("DELETE FROM " + table)
                row = dict(self.db.execute("SELECT * FROM " + table).fetchone())
                with self.assertRaises(Exception): self.db.execute("INSERT OR REPLACE INTO " + table + "(" + ",".join(row) + ") VALUES(" + ",".join("?" for _ in row) + ")", tuple(row.values()))

    def test_clock_expiry_stop_and_private_failures_are_not_action_signals(self):
        definition = self.seed_model(); self.source(definition)
        for limit in (0, True, 1001):
            with self.assertRaisesRegex(WorkbenchError, "DISCOVERY_LIMIT"): discover_monitor_requests(self.db, limit=limit, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "CLOCK_REGRESSION"): discover_monitor_requests(self.db, now="2026-01-02T12:00:00.000Z")
        discover_monitor_requests(self.db, now=NOW)
        self.assertIsNone(run_pending_once(self.db, "verifier", role="verifier", clock=lambda: NOW))
        with patch("worker.investor.model_runtime.advance_model", side_effect=ValueError("Private fixture must not leak")):
            with self.assertRaisesRegex(WorkbenchError, "^INVESTOR_MONITOR_PREPARATION_FAILED$"): self.run_model()
        error = self.db.execute("SELECT error_json FROM job_attempts").fetchone()[0]
        self.assertNotIn("Private", error)
        self.assert_no_finance()

    def test_discovery_schema_failure_never_echoes_private_model_fields(self):
        definition = self.seed_model()
        definition["targets"][0]["listing_id"] = "Private fixture value must not leak"
        self.db.execute("DROP TRIGGER investor_model_no_update")
        self.db.execute("UPDATE investor_models SET document_json=?,content_hash=?", (canonical_json(definition), content_hash(definition)))
        with self.assertRaisesRegex(WorkbenchError, "^INVESTOR_MODEL_EVIDENCE_INVALID$"):
            discover_monitor_requests(self.db, now=NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_requests").fetchone()[0], 0)
