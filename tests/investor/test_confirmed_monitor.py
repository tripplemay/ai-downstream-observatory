"""Fictional same-day capture admission/core, no provider or financial writes."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as queue, test_monitor_data as fixtures, test_data_pipeline as pipeline
from tests.investor.confirmed_monitor_fixture import NOW, create
from tests.investor.confirmed_capture_fixture import FictionalReceiver
from worker.investor import confirmed_capture, monitor_admission
from worker.investor.data_snapshot import build_dataset, build_monitor_dataset
from worker.investor.data_evidence import review_source, collect_prices
from worker.investor.monitor_data import build_monitor_data, resolve_monitor_data
from worker.orchestration.db import WorkbenchError, instant
from worker.orchestration.runtime import run_pending_once
from worker.market.providers import longport, longport_confirmed


class ConfirmedMonitorTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    monitor_fixture = pipeline.DataPipelineCliTests.monitor_fixture

    def model(self, fixed=False):
        with patch.object(fixtures, "NOW", NOW):
            return self.monitor_fixture(fixed_policy=fixed, confirmed_latest=True)

    def grouped(self, refs, bars=None):
        spec = [{**{kind + "_review_id": row[kind]["id"] for kind in ("rights", "listing", "calendar")}, "session_date": "2026-01-02"} for row in refs]
        mock = FictionalReceiver(now=NOW, bars=bars)
        millis, parse_time = confirmed_capture._milliseconds, confirmed_capture.instant
        with patch.object(longport_confirmed, "collect_confirmed_days", side_effect=lambda request, **kwargs: mock(request, kwargs["stop_requested"])), \
                patch.object(confirmed_capture, "_milliseconds", side_effect=lambda value=None: millis(NOW if value is None else value)), \
                patch.object(confirmed_capture, "instant", side_effect=lambda value=None: parse_time(NOW if value is None else value)):
            return confirmed_capture.collect_confirmed_prices(self.db, "w", "synthetic-investor", spec, watch_seconds=1)

    def test_one_multi_target_receipt_has_distinct_observation_ids_and_partial_batches_cannot_fill_gaps(self):
        definition, windows, settings, refs = self.model()
        shared = self.grouped(refs); windows[0]["confirmed_capture_ids"] = [shared["id"]]
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        self.assertEqual(result["projection"]["quality_gaps"], [])
        snapshot = build_monitor_dataset(self.db, "w", windows[0]["capture_ids"], [shared["id"]], windows[0]["action_review_ids"], [], "2026-01-01", "2026-01-02", now=NOW)
        prices = [row for row in snapshot["dataset"]["observations"] if row["batch_id"] == shared["id"]]
        self.assertEqual(len(prices), 2); self.assertEqual(len({row["id"] for row in prices}), 2)
        self.assertTrue(all(row["parser_version"] == "investor-confirmed-monitor-v1" and row["provenance"] == "reconstructed" for row in prices))
        for bars in (1, 0):
            partial = self.grouped(refs, bars=bars); windows[0]["confirmed_capture_ids"] = [partial["id"]]
            with self.assertRaisesRegex(WorkbenchError, "PRICE_COVERAGE_INCOMPLETE"):
                build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        self.assert_no_finance()

    def test_same_local_day_cn_hk_and_us_prior_holiday_close_are_independently_projected(self):
        definition, windows, settings, refs = create(self.db)
        before = self.db.total_changes
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        self.assertEqual(result["document"]["schema_version"], "investor-monitor-data-input-v2")
        self.assertEqual(result["projection"]["quality_gaps"], [])
        self.assertEqual({row["market"]: row["observed_at"] for row in result["projection"]["quotes"]},
            {"CN": "2026-01-02T07:00:00.000Z", "HK": "2026-01-02T08:00:00.000Z", "US": "2026-01-01T20:00:00.000Z"})
        self.assertEqual(len(result["projection"]["corporate_actions"]), 3)
        replay = resolve_monitor_data(self.db, "w", definition, result["document"], now=NOW)
        self.assertEqual(replay["projection"], result["projection"])
        self.assertEqual(self.db.total_changes, before)
        for ref in refs[:2]:
            self.assertEqual(json.loads(ref["capture"]["receipt_json"])["request"]["end_date"], "2026-01-01")
            self.assertEqual(json.loads(ref["confirmed_capture"]["receipt_json"])["request"]["targets"][0]["session_date"], "2026-01-02")
        self.assert_no_finance()

    def test_same_day_is_not_admissible_as_a_legacy_history_receipt_or_research_snapshot(self):
        definition, windows, settings, refs = create(self.db)
        first = windows[0]
        with self.assertRaises(WorkbenchError):
            build_dataset(self.db, "w", first["confirmed_capture_ids"], first["action_review_ids"], first["fx_review_ids"], first["start_date"], first["end_date"], now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "WINDOW_NOT_COMPLETE"):
            collect_prices(self.db, "w", "synthetic-investor", *(refs[0][kind]["id"] for kind in ("rights", "listing", "calendar")),
                "2026-01-02", "2026-01-02", now=NOW, client=object(), sdk_version="4.3.7")
        broken = deepcopy(windows); broken[0].pop("confirmed_capture_ids")
        with self.assertRaisesRegex(WorkbenchError, "PRICE_COVERAGE_INCOMPLETE"):
            build_monitor_data(self.db, "w", definition, broken, settings, now=NOW)
        self.assert_no_finance()

    def test_metadata_admission_is_idempotent_and_default_core_publishes_both_model_versions(self):
        for fixed in (False, True):
            if fixed: self.setUp()
            definition, windows, settings, _ = self.model(fixed)
            revision = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
            row = monitor_admission.admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=NOW)
            changes = self.db.total_changes
            self.assertEqual(monitor_admission.admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=NOW), row)
            self.assertEqual(self.db.total_changes, changes)
            self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], revision + 1)
            completed = run_pending_once(self.db, "fictional-confirmed-core", clock=lambda: NOW)
            self.assertEqual(completed["status"], "succeeded", completed)
            run = self.db.execute("SELECT * FROM investor_evidence_monitor_runs").fetchone()
            self.assertEqual(run["status"], "decision_required" if fixed else "observe")
            self.assertEqual(self.db.execute("SELECT count(*) FROM investor_evidence_model_checkpoints").fetchone()[0], 1)
            self.assertIsNone(run_pending_once(self.db, "fictional-confirmed-core", clock=lambda: NOW))
            self.assert_no_finance()

    def test_withdrawal_between_projection_and_admission_is_atomic(self):
        definition, windows, settings, refs = self.model()
        original = monitor_admission.build_monitor_data
        def withdraw(*args, **kwargs):
            result = original(*args, **kwargs)
            review_source(self.db, "w", "synthetic-investor", refs[0]["rights"]["source_id"], "withdrawn", None, "Fictional withdrawal", fixtures.EXPIRY, now=NOW)
            return result
        revision = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
        with patch.object(monitor_admission, "build_monitor_data", side_effect=withdraw), self.assertRaises(WorkbenchError):
            monitor_admission.admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=NOW)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], revision)
        self.assert_no_finance()

    def test_core_cleans_confirmed_source_and_all_dependent_payloads_after_rights_withdrawal(self):
        definition, windows, settings, refs = self.model()
        monitor_admission.admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=NOW)
        self.assertEqual(run_pending_once(self.db, "fictional-confirmed-core", clock=lambda: NOW)["status"], "succeeded")
        previous = self.db.execute("SELECT id FROM investor_evidence_monitor_runs").fetchone()[0]
        review_source(self.db, "w", "synthetic-investor", refs[0]["rights"]["source_id"], "withdrawn", None, "Fictional withdrawal", fixtures.EXPIRY, now=NOW)
        result = run_pending_once(self.db, "fictional-confirmed-core", clock=lambda: NOW)
        self.assertEqual(result["status"], "succeeded")
        for table in ("investor_confirmed_payloads", "investor_evidence_checkpoint_payloads"):
            self.assertEqual(self.db.execute("SELECT count(*) FROM " + table).fetchone()[0], 0)
        self.assertIsNone(self.db.execute("SELECT 1 FROM investor_evidence_run_payloads WHERE run_id=?", (previous,)).fetchone())
        latest = self.db.execute("SELECT * FROM investor_evidence_monitor_runs ORDER BY rowid DESC LIMIT 1").fetchone()
        self.assertEqual(latest["status"], "blocked")
        payload = json.loads(self.db.execute("SELECT payload FROM investor_evidence_run_payloads WHERE run_id=?", (latest["id"],)).fetchone()[0])
        self.assertIsNone(payload["assessment"]); self.assert_no_finance()

    def test_malformed_or_partial_source_never_becomes_complete_monitor_coverage(self):
        definition, windows, settings, refs = create(self.db)
        confirmed = refs[0]["confirmed_capture"]
        self.db.execute("DROP TRIGGER investor_confirmed_payload_no_update")
        self.db.execute("UPDATE investor_confirmed_payloads SET projection=? WHERE capture_id=?", (b"{}", confirmed["id"]))
        with self.assertRaises(WorkbenchError): build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        self.assert_no_finance()

    def test_aliases_wrong_kinds_futures_and_caller_prices_are_rejected(self):
        definition, windows, settings, _ = create(self.db)
        result = build_monitor_data(self.db, "w", definition, windows, settings, now=NOW)
        for mutate in (lambda v: v[0].update(confirmed_capture_ids=[]), lambda v: v[0].update(quotes=[]),
                lambda v: v[0]["capture_ids"].extend(v[0]["confirmed_capture_ids"])):
            bad = deepcopy(windows); mutate(bad)
            with self.assertRaises(WorkbenchError): build_monitor_data(self.db, "w", definition, bad, settings, now=NOW)
        with self.assertRaises(WorkbenchError): resolve_monitor_data(self.db, "w", definition, result["document"], now="2026-01-02T12:05:02.000Z")
        wrong = deepcopy(result["document"]); wrong["schema_version"] = "investor-monitor-data-input-v1"
        with self.assertRaises(WorkbenchError): resolve_monitor_data(self.db, "w", definition, wrong, now=NOW)
        self.assert_no_finance()
