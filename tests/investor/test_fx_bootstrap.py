"""Fictional retained FX sources through bootstrap planning and snapshot replay."""

from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from tests.investor import test_monitor_data as fixtures, test_runtime as queue
from tests.investor.test_fx_selection import SERIES
from worker.investor import monitor_bootstrap
from worker.investor.data_evidence import review_source
from worker.investor.monitor_data import build_monitor_data, resolve_monitor_data
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, transaction


NOW = fixtures.NOW


class FxBootstrapTests(unittest.TestCase):
    setUp = queue.InvestorRuntimeTests.setUp
    assert_no_finance = queue.InvestorRuntimeTests.assert_no_finance
    reviewed = fixtures.InvestorMonitorDataTests.reviewed
    fixture = fixtures.InvestorMonitorDataTests.fixture
    workspace_id = "w"

    def context(self, markets=("US",)):
        self.definition, _, self.settings, self.refs = self.fixture(markets)
        self.reference = {"targets": [
            {**target, "symbol": json.loads(ref["listing"]["document_json"])["facts"]["provider_symbol"]}
            for target, ref in zip(self.definition["targets"], self.refs)]}
        profile_id = queue.InvestorRuntimeTests.save(self)
        profile = self.db.execute("SELECT * FROM investor_profiles WHERE id=?", (profile_id,)).fetchone()
        self.definition.update(profile_id=profile_id, profile_version=profile["version"],
            profile_hash=profile["content_hash"], plan_hash=content_hash(self.reference))
        self.definition["target_definition_hash"] = content_hash({key: self.definition[key]
            for key in ("profile_hash", "plan_hash", "targets")})
        # Persist the scoped model header; only its expensive research qualification
        # is stubbed below. Planning must not create or change this fixture state.
        with transaction(self.db):
            self.db.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES('fx-select-audit','synthetic-investor','investor_save_plan','investor_workspace','w','{}',?)", (NOW,))
            self.db.execute("INSERT INTO investor_reference_plans(id,workspace_id,profile_id,document_json,content_hash,created_at) VALUES(?,'w',?,?,?,?)",
                (self.definition["plan_id"], profile_id, canonical_json(self.reference), content_hash(self.reference), NOW))
            self.db.execute("INSERT INTO investor_plan_selections(id,workspace_id,plan_id,actor_id,created_at,audit_id) VALUES('fx-selection','w',?,'synthetic-investor',?,'fx-select-audit')", (self.definition["plan_id"], NOW))
            self.db.execute("INSERT INTO investor_models(id,workspace_id,profile_id,plan_id,selection_id,document_json,content_hash,created_at) VALUES(?,'w',?,?,'fx-selection',?,?,?)",
                (self.definition["model_id"], profile_id, self.definition["plan_id"], canonical_json(self.definition), content_hash(self.definition), NOW))

    def plan(self):
        # Only the stored research/model context is stubbed. Source resolution,
        # actual price-receipt replay, FX selection and windows are exercised.
        with patch.object(monitor_bootstrap, "current_monitor_model", return_value=(
                {"id": self.definition["model_id"]}, self.definition, self.reference)), \
                patch.object(monitor_bootstrap, "_settings", return_value=deepcopy(self.settings)):
            return monitor_bootstrap.plan_bootstrap(self.db, "w", self.definition["model_id"], NOW)

    def extra_fx(self, label, dates, *, currency="USD", series=None, value="1.25"):
        facts = {"currency": currency, "unit": "CNY_per_unit_currency", "rows": [
            {"observed_at": day + "T10:00:00Z", "assumed_available_at": day + "T10:01:00Z", "value": value} for day in dates]}
        if series is not None: facts["monitor_series"] = deepcopy(series)
        return self.reviewed("fx", facts, label)

    def withdraw_default_fx(self):
        for source in self.db.execute("SELECT id FROM investor_data_sources WHERE kind='fx'").fetchall():
            review_source(self.db, "w", "synthetic-investor", source["id"], "withdrawn", None,
                "Explicit fictional fixture transition, not a production operation", fixtures.EXPIRY, now=NOW)

    def test_old_stale_reviews_do_not_ambiguate_current_fx_or_mutate_history(self):
        self.context()
        old = self.extra_fx("stale-history", ("2025-12-20",))
        before = list(self.db.iterdump()); total = self.db.total_changes
        _, _, _, windows, settings = self.plan()
        self.assertNotIn(old["id"], windows[0]["fx_review_ids"])
        snapshot = build_monitor_data(self.db, "w", self.definition, windows, settings, now=NOW)
        replay = resolve_monitor_data(self.db, "w", self.definition, snapshot["document"], now=NOW)
        self.assertIsNone(replay["unavailable_reason"])
        self.assertEqual(replay["projection"]["quality_gaps"], [])
        self.assertEqual(replay["projection"]["fx"][0]["value"], "1.25")
        self.assertEqual(self.db.total_changes, total); self.assertEqual(list(self.db.iterdump()), before)
        self.assert_no_finance()

    def test_same_approved_series_advances_tail_and_snapshot_binds_exact_new_review(self):
        self.context(); self.withdraw_default_fx()
        self.settings["policy"]["max_fx_age_seconds"] = 172800
        old = self.extra_fx("series-old", ("2026-01-01", "2026-01-02"), series=SERIES)
        current = self.extra_fx("series-current", ("2026-01-01", "2026-01-02", "2026-01-03"), series=SERIES)
        before = list(self.db.iterdump())
        _, _, _, windows, settings = self.plan()
        self.assertEqual(windows[0]["fx_review_ids"], [current["id"]])
        snapshot = build_monitor_data(self.db, "w", self.definition, windows, settings, now=NOW)
        refs = snapshot["document"]["segments"][0]["snapshot"]["review_refs"]
        self.assertIn(current["id"], [row["review_id"] for row in refs])
        self.assertNotIn(old["id"], [row["review_id"] for row in refs])
        self.assertIsNone(resolve_monitor_data(self.db, "w", self.definition, snapshot["document"], now=NOW)["unavailable_reason"])
        self.assertEqual(list(self.db.iterdump()), before); self.assert_no_finance()

    def test_two_currencies_are_selected_once_at_same_assessment_without_cross_scope(self):
        self.context(("HK", "US"))
        self.extra_fx("stale-usd", ("2025-12-20",), currency="USD")
        self.extra_fx("stale-hkd", ("2025-12-20",), currency="HKD")
        original = monitor_bootstrap.select_current_fx
        with patch.object(monitor_bootstrap, "select_current_fx", wraps=original) as selector:
            _, _, _, windows, settings = self.plan()
        self.assertEqual(selector.call_count, 1)
        self.assertEqual(selector.call_args.args[1], {"HKD", "USD"})
        result = build_monitor_data(self.db, "w", self.definition, windows, settings, now=NOW)
        self.assertEqual({row["currency"] for row in result["projection"]["fx"]}, {"HKD", "USD"})
        self.assertEqual(result["projection"]["quality_gaps"], []); self.assert_no_finance()

    def test_unrelated_fresh_authority_conflicting_history_and_stale_only_are_explicit_gaps(self):
        self.context()
        self.extra_fx("fresh-unbound-duplicate", ("2026-01-03",))
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_AMBIGUOUS"): self.plan()
        self.withdraw_default_fx()
        self.extra_fx("stale-only", ("2025-12-20",))
        with self.assertRaisesRegex(WorkbenchError, "NOT_CURRENT"): self.plan()
        self.withdraw_default_fx()
        self.extra_fx("series-old-conflict", ("2026-01-01",), series=SERIES)
        self.extra_fx("series-new-conflict", ("2026-01-01", "2026-01-03"), series=SERIES, value="1.3")
        with self.assertRaisesRegex(WorkbenchError, "RESTATEMENT_REQUIRED"): self.plan()
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_monitor_evidence_inputs").fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT count(*) FROM investor_models").fetchone()[0], 1)
        self.assert_no_finance()

    def test_frozen_age_ceiling_is_honored_without_selecting_older_review_by_creation_time(self):
        self.context(); self.withdraw_default_fx()
        self.settings["policy"]["max_fx_age_seconds"] = 1
        self.extra_fx("fresh-receipt-old-rate", ("2026-01-03",))
        with self.assertRaisesRegex(WorkbenchError, "NOT_CURRENT"): self.plan()
        self.assertEqual(self.settings["policy"]["max_fx_age_seconds"], 1)
        self.assert_no_finance()

    def test_commit_fence_rechecks_new_authority_and_same_series_tail_without_replanning_economics(self):
        self.context()
        _, _, _, windows, settings = self.plan()
        before = self.db.total_changes
        monitor_bootstrap._check_fx_selection(self.db, "w", self.definition, windows, settings, NOW)
        self.assertEqual(self.db.total_changes, before)
        self.extra_fx("concurrent-authority", ("2026-01-03",))
        with self.assertRaisesRegex(WorkbenchError, "AUTHORITY_AMBIGUOUS"):
            monitor_bootstrap._check_fx_selection(self.db, "w", self.definition, windows, settings, NOW)
        self.withdraw_default_fx()
        self.extra_fx("first-tail", ("2026-01-01", "2026-01-02"), series=SERIES)
        self.settings["policy"]["max_fx_age_seconds"] = 172800
        _, _, _, windows, settings = self.plan()
        self.extra_fx("concurrent-tail", ("2026-01-01", "2026-01-02", "2026-01-03"), series=SERIES)
        with self.assertRaisesRegex(WorkbenchError, "FX_SELECTION_CHANGED"):
            monitor_bootstrap._check_fx_selection(self.db, "w", self.definition, windows, settings, NOW)
        self.assert_no_finance()

    def test_commit_fence_honors_expiry_boundary_and_cny_scope_needs_no_fx_authority(self):
        self.context()
        _, _, _, windows, settings = self.plan()
        with self.assertRaisesRegex(WorkbenchError, "NOT_CURRENT"):
            monitor_bootstrap._check_fx_selection(self.db, "w", self.definition, windows, settings, "2026-01-04T10:00:00Z")
        with patch.object(monitor_bootstrap, "_reviews", side_effect=AssertionError("Unneeded FX review read")):
            result = monitor_bootstrap._current_fx(self.db, "w", [{"currency": "CNY"}], settings, NOW)
        self.assertEqual(result, {}); self.assert_no_finance()


if __name__ == "__main__":
    unittest.main()
