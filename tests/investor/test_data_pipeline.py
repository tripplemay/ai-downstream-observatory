"""Temporary private files and fictional evidence only; no provider calls."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from tests.investor import test_runtime as queue
from tests.investor import test_data_evidence as evidence
from tests.investor import evidence_fixture
from worker.investor import data_pipeline
from worker.investor import history_collection
from worker.investor.data_evidence import review_source
from worker.market.providers import longport


NOW, EXPIRY, START, END = evidence.NOW, evidence.EXPIRY, evidence.START, evidence.END


class DataPipelineCliTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    review = evidence.InvestorDataTests.review
    prepare = evidence.InvestorDataTests.prepare
    collect = evidence.InvestorDataTests.collect
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance

    def file(self, body):
        path = self.path.parent / "private-input.json"
        path.write_text(body); path.chmod(0o600)
        return str(path)

    def invoke(self, *args):
        self.path.chmod(0o600)
        out, error = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(error):
            status = data_pipeline.main(["--db", str(self.path), "--workspace", "w", "--actor", "synthetic-investor", *args])
        return status, out.getvalue(), error.getvalue()

    def test_source_and_review_metadata_never_echo_excerpt_facts_or_private_reason(self):
        status, out, error = self.invoke("store-source", "--kind", "rights", "--file", self.file(json.dumps({
            "title": "Fictional", "reference": "synthetic://private", "excerpt": "PRIVATE-FIXTURE-NOT-A-REAL-LICENSE"})))
        self.assertEqual((status, error), (0, "")); source = json.loads(out)["source_id"]
        self.assertNotIn("PRIVATE-FIXTURE", out)
        status, out, error = self.invoke("review-source", "--source", source, "--file", self.file(json.dumps({
            "decision": "rejected", "facts": None, "reason": "PRIVATE-FIXTURE-NOT-A-REAL-LICENSE", "valid_until": "2100-01-01T00:00:00Z"})))
        self.assertEqual((status, error), (0, "")); self.assertEqual(json.loads(out)["decision"], "rejected")
        self.assertNotIn("PRIVATE-FIXTURE", out); self.assert_no_finance()

    def test_insecure_symlink_and_hardlinked_inputs_are_not_followed(self):
        path = Path(self.file('{"title":"x","reference":"x","excerpt":"x"}'))
        path.chmod(0o644)
        status, out, error = self.invoke("store-source", "--kind", "rights", "--file", str(path))
        self.assertEqual((status, out), (1, "")); self.assertIn("PRIVATE_FILE_REQUIRED", error)
        path.chmod(0o600); alias = path.with_name("alias.json"); alias.symlink_to(path)
        status, _, error = self.invoke("store-source", "--kind", "rights", "--file", str(alias))
        self.assertEqual(status, 1); self.assertIn("PRIVATE_FILE_REQUIRED", error)
        import os
        link = path.with_name("hardlink.json"); os.link(path, link)
        status, _, error = self.invoke("store-source", "--kind", "rights", "--file", str(path))
        self.assertEqual(status, 1); self.assertIn("PRIVATE_FILE_REQUIRED", error)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_data_sources").fetchone()[0], 0)

    def test_duplicate_nonfinite_and_oversized_json_are_rejected_without_echo(self):
        for body in ('{"title":"PRIVATE-FIXTURE","title":"x"}', '{"title":NaN}', " " * 131073):
            status, out, error = self.invoke("store-source", "--kind", "rights", "--file", self.file(body))
            self.assertEqual((status, out), (1, "")); self.assertNotIn("PRIVATE-FIXTURE", error)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_data_sources").fetchone()[0], 0)

    def test_missing_rights_stop_collection_before_credential_read_or_sdk(self):
        refs = self.prepare(); facts = json.loads(refs[0]["document_json"])["facts"]; facts["uses"].remove("private_backup")
        changed = review_source(self.db, "w", "synthetic-investor", refs[0]["source_id"], "approved", facts, "Fictional missing use", EXPIRY, now=NOW)
        with patch.object(longport, "read_private_credentials_file") as read, patch.object(longport, "_collect_isolated") as transport:
            status, out, error = self.invoke("collect-prices", "--rights-review", changed["id"], "--listing-review", refs[1]["id"],
                "--calendar-review", refs[2]["id"], "--start", START, "--end", END, "--credentials-file", "/private/unused.env")
        self.assertEqual((status, out), (1, "")); self.assertIn("USE_NOT_GRANTED", error)
        read.assert_not_called(); transport.assert_not_called(); self.assert_no_finance()

    def test_history_plan_is_readonly_metadata_and_wrong_seal_never_reads_credentials(self):
        refs = self.prepare()
        arguments = ["--rights-review", refs[0]["id"], "--listing-review", refs[1]["id"],
            "--calendar-review", refs[2]["id"], "--start", START, "--end", END]
        before = self.db.total_changes
        with patch.object(longport, "read_private_credentials_file") as read, patch.object(longport, "_collect_isolated") as transport:
            status, out, error = self.invoke("plan-history", *arguments)
            self.assertEqual((status, error), (0, ""))
            planned = json.loads(out)
            self.assertEqual(planned["missing_tile_count"], 1)
            self.assertFalse(planned["market_values_output"])
            self.assertFalse(planned["price_coverage_complete"])
            self.assertNotIn("candlesticks", out); self.assertNotIn("PRIVATE-FIXTURE", out)
            status, out, error = self.invoke("collect-history", *arguments, "--plan-hash", "0" * 64,
                "--credentials-file", "/private/unused.env", "--max-calls", "1")
            self.assertEqual((status, out), (1, "")); self.assertIn("HISTORY_PLAN_CHANGED", error)
        read.assert_not_called(); transport.assert_not_called()
        self.assertEqual(self.db.total_changes, before); self.assert_no_finance()

    def test_history_cli_reuses_replayed_stub_receipt_without_provider_call_or_synthetic_override(self):
        refs = self.prepare(); capture = evidence.InvestorDataTests.stub_official_capture(self, refs)
        arguments = ["--rights-review", refs[0]["id"], "--listing-review", refs[1]["id"],
            "--calendar-review", refs[2]["id"], "--start", START, "--end", END]
        # Deliberately stubbed official projection, not live market qualification.
        before = self.db.total_changes
        with patch.object(history_collection, "_milliseconds", return_value=NOW), \
                patch.object(longport, "read_private_credentials_file") as read, patch.object(longport, "_collect_isolated") as transport:
            status, out, error = self.invoke("plan-history", *arguments)
            self.assertEqual((status, error), (0, "")); planned = json.loads(out)
            status, out, error = self.invoke("collect-history", *arguments, "--plan-hash", planned["plan_hash"], "--credentials-file", "/private/unused.env")
            self.assertEqual((status, error), (0, "")); result = json.loads(out)
            self.assertEqual(result["provider_calls"], 0)
            self.assertEqual(result["tiles"][0]["capture_id"], capture["id"])
            self.assertTrue(result["price_coverage_complete"])
            self.assertFalse(result["total_return_verified"]); self.assertFalse(result["live_advice_eligible"])
        read.assert_not_called(); transport.assert_not_called()
        self.assertEqual(self.db.total_changes, before); self.assert_no_finance()
        with self.assertRaises(SystemExit):
            self.invoke("collect-history", *arguments, "--plan-hash", planned["plan_hash"], "--credentials-file", "/private/unused.env", "--allow-synthetic")

    def test_cli_does_not_offer_test_client_endpoint_override_or_synthetic_admission(self):
        help_text = data_pipeline._parser().format_help()
        self.assertNotIn("--allow-synthetic", help_text)
        with self.assertRaises(SystemExit):
            self.invoke("check-snapshot", "--capture", "fake", "--actions-review", "fake", "--start", START, "--end", END, "--allow-synthetic")
        refs = self.prepare(); capture = self.collect(refs)
        before = self.db.total_changes
        with patch("worker.investor.data_snapshot._milliseconds", side_effect=lambda value=None: NOW if value is None else value), \
                patch("worker.investor.data_evidence._milliseconds", side_effect=lambda value=None: NOW if value is None else value):
            status, out, error = self.invoke("check-snapshot", "--capture", capture["id"], "--actions-review", refs[3]["id"], "--start", START, "--end", END)
        self.assertEqual((status, out), (1, "")); self.assertIn("SYNTHETIC_CAPTURE_FORBIDDEN", error)
        self.assertEqual(self.db.total_changes, before); self.assert_no_finance()

    def test_admission_cli_emits_only_metadata_and_never_accepts_caller_prices(self):
        values = evidence_fixture.create(self.db, "w", "synthetic-investor", admit=False)
        arguments = ["admit-research", "--start", evidence_fixture.START, "--end", evidence_fixture.END,
            "--design-file", self.file(json.dumps({"plan": values["plan"], "policy": values["policy"]}))]
        for identity in values["captures"]: arguments.extend(("--capture", identity))
        for identity in values["actions"]: arguments.extend(("--actions-review", identity))
        with patch("worker.investor.source_inputs._milliseconds", side_effect=lambda value=None: NOW if value is None else value):
            status, out, error = self.invoke(*arguments)
        self.assertEqual((status, error), (0, "")); result = json.loads(out)
        self.assertEqual(result["source_qualification"], "owner_reviewed_reconstructed")
        self.assertFalse(result["market_values_output"]); self.assertFalse(result["live_advice_eligible"])
        self.assertIsNone(result["request_id"])
        for key in ("observations", "weights", "dataset", "plan", "policy"):
            self.assertNotIn(key, result)
        self.file(json.dumps({"plan": values["plan"], "policy": values["policy"], "dataset": {"close": "PRIVATE-FAKE-QUOTE"}}))
        status, out, error = self.invoke(*arguments)
        self.assertEqual((status, out), (1, "")); self.assertNotIn("PRIVATE-FAKE-QUOTE", error)
        self.assert_no_finance()

    def test_monitor_check_requires_owned_current_model_and_never_reads_credentials(self):
        before = self.db.total_changes
        with patch.object(longport, "read_private_credentials_file") as read, patch.object(longport, "_collect_isolated") as transport:
            status, out, error = self.invoke("check-monitor-snapshot", "--model", "not-a-model", "--file", "/private/not-read.json")
        self.assertEqual((status, out), (1, ""))
        self.assertIn("OUT_OF_SCOPE", error)
        read.assert_not_called(); transport.assert_not_called()
        self.assertEqual(self.db.total_changes, before)
        self.assert_no_finance()

    def monitor_fixture(self, fixed_policy=False, confirmed_latest=False, external_ai=False, extra_closed_day=False):
        from tests.investor.test_monitor_data import InvestorMonitorDataTests, NOW as monitor_now
        from tests.investor.fixtures import profile
        from worker.orchestration.db import canonical_json, content_hash, transaction
        from worker.orchestration.runtime import run_pending_once
        queue.InvestorRuntimeTests.save(self, profile("0.30"))
        evidence_fixture.create(self.db, "w", "synthetic-investor", fixed_policy_v2=fixed_policy)
        self.assertEqual(run_pending_once(self.db, "fictional", clock=lambda: NOW)["status"], "succeeded")
        row = self.db.execute("SELECT * FROM investor_reference_plans").fetchone()
        plan = json.loads(row["document_json"])
        preferences = self.db.execute("SELECT * FROM investor_profiles").fetchone()
        definition = {"schema_version": "investor-model-definition-v2" if fixed_policy else "investor-model-definition-v1", "model_id": "fictional-monitor", "profile_id": preferences["id"],
            "profile_version": preferences["version"], "profile_hash": preferences["content_hash"], "plan_id": row["id"], "plan_hash": row["content_hash"],
            "targets": [{key: target[key] for key in ("listing_id", "market", "currency", "weight")} for target in plan["targets"]],
            "created_at": monitor_now, "valid_until": plan["valid_until"], "data_mode": "reconstructed", "scope": "research_model", "live_advice_eligible": False}
        from worker.investor.model_contracts import definition_basis
        if fixed_policy: definition["fixed_policy"] = plan["fixed_policy"]
        definition["target_definition_hash"] = content_hash(definition_basis(definition))
        with transaction(self.db):
            self.db.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('monitor-select-audit','synthetic-investor','investor_save_plan','investor_workspace','w','{}',?)", (monitor_now,))
            self.db.execute("INSERT INTO investor_plan_selections(id,workspace_id,plan_id,actor_id,created_at,audit_id) VALUES('monitor-selection','w',?,'synthetic-investor',?,'monitor-select-audit')", (row["id"], monitor_now))
            self.db.execute("INSERT INTO investor_models(id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(?,'w',?,?,'monitor-selection',?,?,?)",
                (definition["model_id"], preferences["id"], row["id"], canonical_json(definition), content_hash(definition), monitor_now))
            self.db.execute("INSERT INTO investor_model_controls(id,workspace_id,model_id,version,enabled,actor_id,audit_id,created_at) VALUES('monitor-control','w',?,1,1,'synthetic-investor','monitor-select-audit',?)", (definition["model_id"], monitor_now))
        fixture = InvestorMonitorDataTests(methodName="test_three_market_different_closes_actual_receipt_time_and_newer_fx")
        fixture.db = self.db
        _, windows, settings, refs = fixture.fixture(("CN", "CN"), identities=[target["listing_id"] for target in definition["targets"]],
            roles=definition["fixed_policy"]["parameters"]["roles"] if fixed_policy else None, confirmed_latest=confirmed_latest, external_ai=external_ai, extra_closed_day=extra_closed_day)
        return definition, windows, settings, refs

    def test_current_reference_model_monitor_check_is_metadata_only_and_zero_write(self):
        from tests.investor.test_monitor_data import NOW as monitor_now
        definition, windows, settings, _ = self.monitor_fixture()
        arguments = ("check-monitor-snapshot", "--model", definition["model_id"], "--file", self.file(json.dumps({"windows": windows, "settings": settings})))
        before = self.db.total_changes
        with patch("worker.investor.runtime._milliseconds", side_effect=lambda value=None: monitor_now if value is None else value), \
                patch.object(longport, "read_private_credentials_file") as read, patch.object(longport, "_collect_isolated") as transport:
            status, out, error = self.invoke(*arguments)
        self.assertEqual((status, error), (0, ""))
        result = json.loads(out)
        self.assertEqual(result["quote_count"], 2)
        self.assertEqual(result["quality_gaps"], [])
        self.assertFalse(result["monitor_queue_updated"])
        self.assertFalse(result["model_enablement_changed"])
        self.assertFalse(result["market_values_output"])
        self.assertFalse(result["live_advice_eligible"])
        self.assertNotIn("quotes", result); self.assertNotIn("funding_intent", result); self.assertNotIn("policy", result)
        read.assert_not_called(); transport.assert_not_called()
        self.assertEqual(self.db.total_changes, before)
        self.assert_no_finance()
