"""Fictional reference and retained SDK stubs; no account, credentials or trades."""

from copy import deepcopy
import json
import sqlite3
import unittest
from unittest.mock import patch

from tests.investor import test_data_pipeline as pipeline
from tests.investor.test_monitor_data import NOW, EXPIRY
from tests.investor import test_runtime as queue
from tests.investor.fixtures import profile
from tests.investor import evidence_fixture
from worker.investor import monitor_admission
from worker.investor.data_evidence import purge_price_payload, review_source
from worker.investor.monitor_data import build_monitor_data, resolve_monitor_data
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError


class MonitorAdmissionTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    monitor_fixture = pipeline.DataPipelineCliTests.monitor_fixture
    file = pipeline.DataPipelineCliTests.file
    invoke = pipeline.DataPipelineCliTests.invoke
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def counts(self):
        return {table: self.db.execute("SELECT count(*) FROM " + table).fetchone()[0] for table in
            ("investor_monitor_evidence_inputs", "audit_events", "job_runs", "investor_monitor_requests", "investor_model_controls")}

    def admit(self, definition, windows, settings, now=NOW):
        return monitor_admission.admit_monitor_data(self.db, "w", "synthetic-investor", definition["model_id"], windows, settings, now=now)

    def live_fixture_at(self, now, expected_date, *, external_ai=False):
        from tests.investor.live_monitor_fixture import create
        definition, _, _, _ = self.monitor_fixture()
        with patch.object(longport, "read_private_credentials_file") as credentials:
            row = create(self.db, "w", "synthetic-investor", definition["model_id"], now, external_ai=external_ai)
        credentials.assert_not_called()
        document = json.loads(row["document_json"])
        replay = resolve_monitor_data(self.db, "w", definition, document, now=now)
        self.assertIsNone(replay["unavailable_reason"])
        self.assertEqual(replay["projection"]["quality_gaps"], [])
        self.assertTrue(all(quote["observed_at"].startswith(expected_date) for quote in replay["projection"]["quotes"]))
        rights = json.loads(self.db.execute("SELECT r.document_json FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id WHERE s.kind='rights' ORDER BY r.rowid DESC LIMIT 1").fetchone()[0])
        self.assertEqual("external_ai" in rights["facts"]["uses"], external_ai)
        self.assert_no_finance()

    def test_current_clock_fixture_before_cn_midnight_uses_previous_local_session(self):
        self.live_fixture_at("2026-01-03T15:59:59.000Z", "2026-01-02")

    def test_current_clock_fixture_after_cn_midnight_does_not_use_utc_calendar_horizon(self):
        self.live_fixture_at("2026-01-03T16:00:00.000Z", "2026-01-03")

    def test_current_clock_external_ai_fixture_requires_explicit_test_only_flag(self):
        self.live_fixture_at("2026-01-03T16:00:00.000Z", "2026-01-03", external_ai=True)

    def test_unbound_fixed_policy_cannot_admit_inputs_for_legacy_monitor(self):
        from worker.investor import reference_plan
        original = evidence_fixture.create
        render = reference_plan.render_reference_plan
        with patch.object(evidence_fixture, "create", side_effect=lambda *args, **kwargs: original(*args, **{**kwargs, "fixed_policy_v2": True})), \
                patch.object(reference_plan, "render_reference_plan", side_effect=lambda *args, **kwargs: render(*args, version="investor-reference-plan-v1")):
            definition, windows, settings, _ = self.monitor_fixture()
        stored = json.loads(self.db.execute("SELECT document_json FROM investor_reference_plans").fetchone()[0])
        self.assertEqual(stored["schema_version"], "investor-reference-plan-v1")
        self.assertTrue(stored["strategy_version"].endswith("+fixed-policy-v2"))
        before = self.counts()
        with patch.object(monitor_admission, "build_monitor_data") as build, self.assertRaisesRegex(WorkbenchError, "FIXED_POLICY_UNSUPPORTED"):
            self.admit(definition, windows, settings)
        build.assert_not_called(); self.assertEqual(self.counts(), before); self.assert_no_finance()

    def test_metadata_admission_is_idempotent_scoped_and_never_enqueues_enables_or_writes_finance(self):
        definition, windows, settings, _ = self.monitor_fixture()
        before = self.counts()
        revision = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
        with patch.object(longport, "read_private_credentials_file") as credentials, patch.object(longport, "_collect_isolated") as provider:
            row = self.admit(definition, windows, settings)
            again = self.admit(definition, windows, settings, "2026-01-03T12:00:04.000Z")
        self.assertEqual(row, again); credentials.assert_not_called(); provider.assert_not_called()
        _, document = monitor_admission.monitor_evidence_document(self.db, "w", definition["model_id"], row["id"], NOW)
        self.assertEqual(document["source_qualification"], "owner_reviewed_reconstructed")
        self.assertFalse(document["live_advice_eligible"])
        for key in ("quotes", "fx", "dataset", "corporate_actions"): self.assertNotIn(key, document)
        after = self.counts()
        self.assertEqual(after, {**before, "investor_monitor_evidence_inputs": 1, "audit_events": before["audit_events"] + 1})
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], revision + 1)
        for workspace, model in (("foreign", definition["model_id"]), ("w", "foreign")):
            with self.assertRaisesRegex(WorkbenchError, "OUT_OF_SCOPE"):
                monitor_admission.monitor_evidence_document(self.db, workspace, model, row["id"], NOW)
        for sql in ("UPDATE investor_monitor_evidence_inputs SET content_hash='x'", "DELETE FROM investor_monitor_evidence_inputs"):
            with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"): self.db.execute(sql)
        self.assert_no_finance()

    def test_stale_prices_and_caller_prices_never_admit_a_snapshot(self):
        definition, windows, settings, _ = self.monitor_fixture()
        before = self.counts()
        stale = deepcopy(settings); stale["max_quote_age_seconds"] = 1
        with self.assertRaisesRegex(WorkbenchError, "MONITOR_INPUTS_NOT_CURRENT"): self.admit(definition, windows, stale)
        injected = deepcopy(settings); injected["quotes"] = [{"close": "PRIVATE-FAKE-QUOTE"}]
        with self.assertRaises(WorkbenchError): self.admit(definition, windows, injected)
        self.assertEqual(self.counts(), before); self.assert_no_finance()

    def test_unknown_owner_read_only_and_restore_marker_cannot_admit_metadata(self):
        definition, windows, settings, _ = self.monitor_fixture()
        before = self.counts()
        with self.assertRaisesRegex(WorkbenchError, "OUT_OF_SCOPE"):
            monitor_admission.admit_monitor_data(self.db, "w", "foreign", definition["model_id"], windows, settings, now=NOW)
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}), self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
            self.admit(definition, windows, settings)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"): self.admit(definition, windows, settings)
        marker.unlink()
        self.assertEqual(self.counts(), before); self.assert_no_finance()

    def test_profile_change_rejects_old_model_before_private_file_or_provider_access(self):
        definition, _, _, _ = self.monitor_fixture()
        queue.InvestorRuntimeTests.save(self, {**profile("0.30"), "horizon_years": 13})
        before = self.counts()
        with patch("worker.investor.runtime._milliseconds", return_value=NOW), patch.object(longport, "read_private_credentials_file") as read:
            status, out, error = self.invoke("admit-monitor-snapshot", "--model", definition["model_id"], "--file", "/private/not-read.json")
        self.assertEqual((status, out), (1, "")); self.assertIn("MODEL_NOT_CURRENT", error); read.assert_not_called()
        self.assertEqual(self.counts(), before)

    def test_withdrawal_between_preparation_and_commit_does_not_append_admission_or_its_audit(self):
        definition, windows, settings, refs = self.monitor_fixture()
        def withdrawn(*args, **kwargs):
            value = build_monitor_data(*args, **kwargs)
            review_source(self.db, "w", "synthetic-investor", refs[0]["rights"]["source_id"], "withdrawn", None, "Fictional withdrawal", EXPIRY, now=NOW)
            return value
        with patch.object(monitor_admission, "build_monitor_data", side_effect=withdrawn), self.assertRaises(WorkbenchError):
            self.admit(definition, windows, settings)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_admit_monitor_source'").fetchone()[0], 0)
        self.assert_no_finance()

    def test_corrupted_payload_between_preparation_and_commit_is_replayed_not_trusted(self):
        definition, windows, settings, refs = self.monitor_fixture()
        def corrupted(*args, **kwargs):
            value = build_monitor_data(*args, **kwargs)
            self.db.execute("DROP TRIGGER investor_price_payload_no_update")
            self.db.execute("UPDATE investor_price_payloads SET projection=? WHERE capture_id=?", (b"{}", refs[0]["capture"]["id"]))
            return value
        with patch.object(monitor_admission, "build_monitor_data", side_effect=corrupted), self.assertRaises(WorkbenchError):
            self.admit(definition, windows, settings)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM audit_events WHERE action='investor_admit_monitor_source'").fetchone()[0], 0)

    def test_failed_insert_atomically_rolls_back_audit_and_revision(self):
        definition, windows, settings, _ = self.monitor_fixture()
        before = self.counts(); revision = self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0]
        self.db.execute("CREATE TRIGGER fictional_admission_failure BEFORE INSERT ON investor_monitor_evidence_inputs BEGIN SELECT RAISE(ABORT,'fictional failure'); END")
        with self.assertRaisesRegex(sqlite3.IntegrityError, "fictional failure"): self.admit(definition, windows, settings)
        self.assertEqual(self.counts(), before)
        self.assertEqual(self.db.execute("SELECT revision FROM investor_workspaces").fetchone()[0], revision)
        self.assert_no_finance()

    def test_projection_expiring_during_locked_replay_cannot_be_admitted(self):
        definition, windows, settings, _ = self.monitor_fixture()
        before = self.counts()
        with patch.object(monitor_admission, "_milliseconds", side_effect=[NOW, NOW, "2026-01-03T16:00:00.000Z"]), self.assertRaisesRegex(WorkbenchError, "MONITOR_INPUTS_NOT_CURRENT"):
            self.admit(definition, windows, settings, None)
        self.assertEqual(self.counts(), before)

    def test_expired_and_purged_admitted_projection_is_unavailable_without_copying_retained_prices(self):
        definition, windows, settings, refs = self.monitor_fixture()
        row = self.admit(definition, windows, settings)
        document = json.loads(row["document_json"])
        self.assertEqual(resolve_monitor_data(self.db, "w", definition, document, now="2026-01-03T16:00:00.000Z")["unavailable_reason"], "MONITOR_DATA_PROJECTION_EXPIRED")
        review_source(self.db, "w", "synthetic-investor", refs[0]["rights"]["source_id"], "withdrawn", None, "Fictional withdrawal permits purge", EXPIRY, now=NOW)
        purge_price_payload(self.db, "w", "synthetic-investor", refs[0]["capture"]["id"], now=NOW)
        result = resolve_monitor_data(self.db, "w", definition, document, now=NOW)
        self.assertIsNone(result["projection"]); self.assertEqual(result["unavailable_reason"], "REFERENCE_SOURCE_NO_LONGER_CURRENT")
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 1)
        self.assert_no_finance()

    def test_cli_admission_emits_metadata_only_and_rejects_private_caller_quote_arrays(self):
        definition, windows, settings, _ = self.monitor_fixture()
        arguments = ("admit-monitor-snapshot", "--model", definition["model_id"], "--file", self.file(json.dumps({"windows": windows, "settings": settings})))
        with patch("worker.investor.runtime._milliseconds", return_value=NOW), patch.object(monitor_admission, "_milliseconds", return_value=NOW):
            status, out, error = self.invoke(*arguments)
        self.assertEqual((status, error), (0, "")); result = json.loads(out)
        self.assertEqual(result["source_qualification"], "owner_reviewed_reconstructed")
        for key in ("monitor_queue_updated", "model_enablement_changed", "market_values_output", "live_advice_eligible"): self.assertFalse(result[key])
        for key in ("quotes", "fx", "policy", "funding_intent", "corporate_actions"): self.assertNotIn(key, result)
        before = self.counts()
        self.file(json.dumps({"windows": windows, "settings": settings, "quotes": [{"close": "PRIVATE-FAKE-QUOTE"}]}))
        with patch("worker.investor.runtime._milliseconds", return_value=NOW): status, out, error = self.invoke(*arguments)
        self.assertEqual((status, out), (1, "")); self.assertNotIn("PRIVATE-FAKE-QUOTE", error); self.assertNotIn(str(self.path), error)
        self.assertEqual(self.counts(), before); self.assert_no_finance()


if __name__ == "__main__": unittest.main()
