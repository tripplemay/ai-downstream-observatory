"""Fictional automatic first-input admission, no network or personal plans."""

from copy import deepcopy
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as queue, test_data_pipeline as pipeline, test_monitor_data as fixtures
from worker.investor import monitor_bootstrap, monitor_admission
from tests.investor import evidence_fixture
from worker.investor.data_evidence import review_source, store_source
from worker.investor.monitor_data import resolve_monitor_data
from worker.market.providers import longport, longport_confirmed
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, open_database
from worker.orchestration.runtime import run_pending_once


NOW = fixtures.NOW
CONFIRMED_NOW = "2026-01-02T12:05:03.000Z"


class MonitorBootstrapTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    monitor_fixture = pipeline.DataPipelineCliTests.monitor_fixture
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def model(self, fixed=False, confirmed=False, positive_tolerance=False):
        self.now = CONFIRMED_NOW if confirmed else NOW
        research, policy = evidence_fixture.research_input, evidence_fixture.fixed_policy_input
        def explicit_tolerance(factory):
            data, plan, policy = factory()
            for candidate in [*plan["parameter_candidates"], plan["benchmark"], *policy["candidates"]]:
                candidate["tolerance"] = {"absolute_cny": "0.01", "weight": "0.005"}
            return data, plan, policy
        with patch.object(fixtures, "NOW", self.now), \
                patch.object(evidence_fixture, "research_input", side_effect=lambda: explicit_tolerance(research) if positive_tolerance else research()), \
                patch.object(evidence_fixture, "fixed_policy_input", side_effect=lambda: explicit_tolerance(policy) if positive_tolerance else policy()):
            self.definition, self.windows, self.manual_settings, self.refs = self.monitor_fixture(fixed_policy=fixed, confirmed_latest=confirmed)
        return self.definition

    def source(self):
        return self.db.execute("SELECT * FROM investor_monitor_evidence_inputs ORDER BY rowid DESC LIMIT 1").fetchone()

    def gap(self):
        return json.loads(self.db.execute("SELECT payload_json FROM outbox WHERE topic='investor.monitor_bootstrap_gap'").fetchone()[0])

    def test_default_core_creates_first_input_without_json_or_sdk_for_both_model_versions(self):
        for fixed in (False, True):
            if fixed: self.setUp()
            self.model(fixed, positive_tolerance=True)
            with patch.object(longport, "read_private_credentials_file") as credentials, patch.object(longport, "_collect_isolated") as history, \
                    patch.object(longport_confirmed, "collect_confirmed_days") as callback:
                completed = run_pending_once(self.db, "fictional-core", clock=lambda: self.now)
            self.assertEqual(completed["status"], "succeeded", completed)
            credentials.assert_not_called(); history.assert_not_called(); callback.assert_not_called()
            source = self.source(); self.assertIsNotNone(source)
            document = json.loads(source["document_json"])
            self.assertEqual(document["schema_version"], "investor-monitor-data-input-v1")
            self.assertEqual(document["settings"]["policy"]["version"], monitor_bootstrap.VERSION)
            self.assertIsNone(document["settings"]["policy"]["costs"])
            self.assertIsNone(document["settings"]["funding_intent"])
            replay = resolve_monitor_data(self.db, "w", self.definition, document, now=self.now)
            self.assertIsNone(replay["unavailable_reason"])
            self.assertEqual(replay["projection"]["quality_gaps"], [])
            self.assertEqual(len(replay["projection"]["quotes"]), 2)
            self.assertTrue(all(quote["observed_at"].startswith("2026-01-02") for quote in replay["projection"]["quotes"]))
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
            self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_bootstrap_monitor_source'").fetchone()[0], 1)
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_models").fetchone()[0], 1)
            self.assert_no_finance()

    def test_confirmed_complete_receipts_seed_monitor_only_input_not_research(self):
        self.model(confirmed=True)
        sources = monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now)
        self.assertEqual(len(sources), 1)
        document = json.loads(self.source()["document_json"])
        self.assertEqual(document["schema_version"], "investor-monitor-data-input-v2")
        snapshot = document["segments"][0]["snapshot"]
        self.assertEqual((snapshot["range_start"], snapshot["range_end"]), ("2026-01-02", "2026-01-02"))
        self.assertTrue(all(ref["kind"] == "confirmed_sdk" for ref in snapshot["capture_refs"]))
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_inputs").fetchone()[0], 1)
        self.assert_no_finance()

    def test_plan_is_zero_write_and_reuses_frozen_tolerances_without_fabricating_fees_or_funding(self):
        self.model(fixed=True)
        before = self.db.total_changes
        _, _, reference, windows, settings = monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], self.now)
        frozen = reference["fixed_policy"]["parameters"]["tolerance"]
        self.assertEqual(settings["policy"]["weight_band"], frozen["weight"])
        self.assertEqual(settings["policy"]["absolute_band_cny"], frozen["absolute_cny"])
        self.assertEqual(settings["max_quote_age_seconds"], 604800)
        self.assertIsNone(settings["policy"]["costs"]); self.assertIsNone(settings["funding_intent"])
        self.assertEqual((windows[0]["start_date"], windows[0]["end_date"]), ("2026-01-02", "2026-01-02"))
        self.assertEqual(self.db.total_changes, before)
        self.assert_no_finance()

    def test_second_connection_is_idempotent_and_manual_input_is_never_overwritten(self):
        self.model()
        result = monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now)
        self.assertEqual(len(result), 1)
        before = list(self.db.iterdump())
        second = open_database(self.path); self.addCleanup(second.close)
        self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(second, now=self.now), [])
        self.assertEqual(list(self.db.iterdump()), before)
        self.setUp(); self.model()
        manual = monitor_admission.admit_monitor_data(self.db, "w", "synthetic-investor", self.definition["model_id"], self.windows, self.manual_settings, now=self.now)
        before = list(self.db.iterdump())
        self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now), [])
        self.assertEqual(self.source()["id"], manual["id"])
        self.assertEqual(list(self.db.iterdump()), before)
        self.assert_no_finance()

    def test_withdrawn_prices_and_missing_actions_are_gaps_not_defaults(self):
        self.model()
        review_source(self.db, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
            "Fictional withdrawal", fixtures.EXPIRY, now=self.now)
        self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now), [])
        self.assertIsNone(self.source()); self.assertEqual(self.gap()["code"], "MONITOR_BOOTSTRAP_EVIDENCE_GAP")
        self.setUp(); self.model()
        review_source(self.db, "w", "synthetic-investor", self.refs[0]["actions"]["source_id"], "withdrawn", None,
            "Fictional action gap", fixtures.EXPIRY, now=self.now)
        self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now), [])
        self.assertIsNone(self.source()); self.assert_no_finance()

    def test_ambiguous_action_sources_are_not_resolved_by_picking_the_latest(self):
        self.model()
        original = self.refs[0]["actions"]
        duplicate = store_source(self.db, "w", "synthetic-investor", "actions", {"title": "FICTIONAL duplicate action authority",
            "reference": "synthetic://bootstrap/ambiguous", "excerpt": "Fictional ambiguity, not a real source"}, now=self.now)
        review_source(self.db, "w", "synthetic-investor", duplicate["id"], "approved", json.loads(original["document_json"])["facts"],
            "Fictional duplicate", fixtures.EXPIRY, now=self.now)
        with self.assertRaisesRegex(WorkbenchError, "ACTIONS_NOT_UNIQUE"):
            monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], self.now)
        self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now), [])
        self.assertIsNone(self.source()); self.assert_no_finance()

    def test_disabled_future_and_foreign_models_never_get_inputs(self):
        self.model()
        self.db.execute("INSERT INTO investor_model_controls VALUES('paused','w','fictional-monitor',2,0,'synthetic-investor','monitor-select-audit',?)", (self.now,))
        self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now), [])
        with self.assertRaises(WorkbenchError): monitor_bootstrap.plan_bootstrap(self.db, "foreign", self.definition["model_id"], self.now)
        with self.assertRaises(WorkbenchError): monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], queue.NOW)
        self.assertIsNone(self.source()); self.assert_no_finance()

    def test_read_only_and_restore_lock_block_before_any_source_write(self):
        self.model()
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
            monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"; marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
            monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now)
        marker.unlink()
        self.assertIsNone(self.source()); self.assert_no_finance()

    def test_late_audit_failure_rolls_back_input_revision_and_all_admission_audits(self):
        self.model()
        revision = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
        self.db.execute("CREATE TRIGGER fictional_bootstrap_audit_abort BEFORE INSERT ON audit_events WHEN NEW.action='investor_bootstrap_monitor_source' BEGIN SELECT RAISE(ABORT,'fictional late audit failure'); END")
        with self.assertRaises(sqlite3.IntegrityError): monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now)
        self.assertIsNone(self.source())
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], revision)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action IN ('investor_bootstrap_monitor_source','investor_admit_monitor_source')").fetchone()[0], 0)
        self.assert_no_finance()

    def test_zero_tolerance_and_unknown_costs_stay_blocked_not_zero_fee_advice(self):
        self.model()
        self.assertEqual(run_pending_once(self.db, "fictional-core", clock=lambda: self.now)["status"], "succeeded")
        self.assertIsNotNone(self.source())
        run = self.db.execute("SELECT * FROM investor_evidence_monitor_runs").fetchone()
        self.assertEqual(run["status"], "blocked")
        self.assertEqual(json.loads(run["document_json"])["reason_codes"], ["CANNOT_COMPARE_CHANGE_COST"])
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 0)
        self.assert_no_finance()

    def test_current_source_withdrawal_between_plan_and_admission_is_rechecked(self):
        self.model()
        original = monitor_bootstrap.plan_bootstrap
        second = open_database(self.path); self.addCleanup(second.close)
        def withdraw(*args, **kwargs):
            result = original(*args, **kwargs)
            review_source(second, "w", "synthetic-investor", self.refs[0]["rights"]["source_id"], "withdrawn", None,
                "Fictional concurrent withdrawal", fixtures.EXPIRY, now=self.now)
            return result
        with patch.object(monitor_bootstrap, "plan_bootstrap", side_effect=withdraw):
            self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now), [])
        self.assertIsNone(self.source())
        self.assertEqual(second.execute("SELECT decision FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (self.refs[0]["rights"]["source_id"],)).fetchone()[0], "withdrawn")
        self.assert_no_finance()

    def test_pause_between_plan_and_admission_does_not_bootstrap_old_control(self):
        self.model()
        original = monitor_bootstrap.plan_bootstrap
        def pause(*args, **kwargs):
            result = original(*args, **kwargs)
            self.db.execute("INSERT INTO investor_model_controls VALUES('paused','w','fictional-monitor',2,0,'synthetic-investor','monitor-select-audit',?)", (self.now,))
            return result
        with patch.object(monitor_bootstrap, "plan_bootstrap", side_effect=pause):
            self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now), [])
        self.assertIsNone(self.source()); self.assert_no_finance()

    def test_resealed_old_research_run_cannot_supply_unverified_default_settings(self):
        self.model()
        run = self.db.execute("SELECT * FROM investor_research_runs").fetchone()
        doc = json.loads(run["document_json"]); doc["result"]["reason_codes"] = ["FICTIONAL_UNTRUSTED_RESULT"]
        body = {key: value for key, value in doc["result"].items() if key != "result_hash"}
        doc["result"]["result_hash"] = content_hash(body)
        self.db.execute("DROP TRIGGER investor_research_run_no_update")
        self.db.execute("UPDATE investor_research_runs SET document_json=?,content_hash=? WHERE id=?", (canonical_json(doc), content_hash(doc), run["id"]))
        with self.assertRaisesRegex(WorkbenchError, "^INVESTOR_BOOTSTRAP_PLAN_INVALID$"):
            monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], self.now)
        self.assertEqual(monitor_bootstrap.bootstrap_monitor_inputs(self.db, now=self.now), [])
        self.assertIsNone(self.source()); self.assert_no_finance()

    def test_automatic_seed_then_default_listener_and_core_extend_same_model(self):
        from datetime import timedelta
        from tests.investor.test_confirmed_feed import ConfirmedFeedTests, EARLY, END
        from worker.orchestration.db import instant, stamp
        original = fixtures.InvestorMonitorDataTests.reviewed
        def future_calendar(fixture, kind, facts, label):
            facts = deepcopy(facts)
            if kind in ("actions", "calendar"): facts["range_end"] = "2026-01-04"
            if kind == "calendar":
                close = instant("2026-01-04T07:00:00.000Z")
                facts["days"].append({"date": "2026-01-04", "kind": "full", "close_at": stamp(close),
                    "available_at": stamp(close + timedelta(minutes=1)), "settled_at": stamp(close + timedelta(days=1)),
                    "settlement_rule_known_at": "2025-12-01T00:00:00Z"})
            return original(fixture, kind, facts, label)
        with patch.object(fixtures.InvestorMonitorDataTests, "reviewed", future_calendar):
            self.model(fixed=True, confirmed=True, positive_tolerance=True)
        self.assertEqual(run_pending_once(self.db, "fictional-core", clock=lambda: self.now)["status"], "succeeded")
        seed = self.source()["id"]
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
        self.assertIsNone(run_pending_once(self.db, "fictional-listener", role="longport", clock=lambda: EARLY))
        fixture = ConfirmedFeedTests(); fixture.db = self.db; fixture.path = self.path
        self.assertEqual(fixture.watch()[0]["status"], "succeeded")
        self.assertEqual(run_pending_once(self.db, "fictional-core", clock=lambda: END)["status"], "succeeded")
        self.assertNotEqual(self.source()["id"], seed)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_bootstrap_monitor_source'").fetchone()[0], 1)
        self.assertIsNone(run_pending_once(self.db, "fictional-core", clock=lambda: END))
        self.assert_no_finance()


if __name__ == "__main__": unittest.main()
