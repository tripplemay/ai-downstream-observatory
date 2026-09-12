from dataclasses import replace
from datetime import timedelta
import json
import unittest
from unittest.mock import patch

from tests.market.support import NOW, document, ledger_event, rules
from tests.performance import test_pipeline as base
from tests.market.test_valuation_units import unsafe_historical_publication
from worker.market import ingest_document, value_portfolio
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp
from worker.performance import prepare_performance, persist_performance
from worker.orchestration.jobs import claim_job, complete_job, enqueue_job


def flow_rules():
    return {"schema_version": "flow-fx-rules-v1", "approved": True,
            "approval_evidence": "Isolated synthetic fixture, not investment approval",
            "fx_scope": "fx:flows", "max_fx_age_seconds": 86400,
            "time_policy": "event_second_strict"}


class FlowFxTests(unittest.TestCase):
    setUp = base.PerformanceTests.setUp
    snapshot = base.PerformanceTests.snapshot
    date_flow = base.PerformanceTests.date_flow

    def fx_document(self, identity="fx:1", value="7", revision=0, observed=None, currency="USD"):
        source = document(identity, price=value, revision=revision,
                          observed=observed or self.start + timedelta(hours=23))
        source["batch"].update(batch_type="fx", scope="fx:flows")
        row = source["pages"][0]["observations"][0]
        row.pop("listing_id")
        row.update(series_key="FX:" + currency, metric="fx_cny_per_unit",
                   unit="CNY_per_unit_currency", price_basis="not_applicable", revision_id=identity)
        return source

    def add_flow(self, identity="usd", amount="100", currency="USD", at=None):
        from worker.accounting import canonical, decimal
        ledger_event(self.db, identity, [("cash_settled", amount), ("external_capital", canonical(-decimal(amount)))],
                     currency=currency, effective=at or self.start + timedelta(days=1))

    def prepare(self, mode="restated", config=True, ids=("start", "end"), now=NOW):
        payload = {"valuation_ids": list(ids), "evaluation_timezone": "Asia/Shanghai"}
        if config is not False:
            payload["flow_fx_rules"] = flow_rules() if config is True else config
        return prepare_performance(self.db, "p", payload, now=now)

    def snapshots(self, mode="restated", end="870"):
        self.snapshot("start", self.start, "100", mode=mode)
        self.snapshot("end", self.end, end, mode=mode)

    def publish(self, source=None, at=None):
        result = ingest_document(self.db, source or self.fx_document(), publish=True,
                                 now=at or self.start + timedelta(hours=23, minutes=1))
        self.assertEqual(result["status"], "published", result)

    def assert_blocked(self, result, code):
        self.assertEqual(result.quality, "blocked")
        self.assertTrue(any(item.startswith(code) for item in result.result["issues"]), result.result)
        for key in ("return", "net_profit_cny", "external_flow_cny", "drawdown"):
            self.assertIsNone(result.result[key])
        self.assertIsNone(result.result["xirr"]["rate"])

    def test_event_rate_not_terminal_rate_and_full_evidence_is_frozen(self):
        self.add_flow()
        archive = self.fx_document()
        final = self.fx_document("final", "7.7", observed=self.end - timedelta(hours=1))["pages"][0]["observations"][0]
        final.update(batch_id="fx:1", id="fx:1:final")
        archive["pages"][0]["observations"].append(final)
        archive["batch"]["expected_rows"] = 2
        self.publish(archive, at=self.end)
        self.snapshots()
        result = self.prepare()
        self.assertEqual(result.result["external_flow_cny"], "700")
        self.assertEqual(result.result["net_profit_cny"], "70")
        self.assertEqual(result.method, "modified_dietz_estimate")
        evidence = result.result["external_flow_evidence"][0]
        self.assertEqual(evidence["fx_rate"], "7")
        self.assertEqual(evidence["amount_native"], "100")
        self.assertEqual(evidence["posting_id"], "usd:p:1")
        self.assertEqual(evidence["binding_id"], content_hash({k: v for k, v in evidence.items() if k != "binding_id"}))
        manifest = json.loads(result.manifest)
        self.assertEqual(manifest["external_flow_evidence"], [evidence])
        validate_contract(manifest, "performance-input-v5.schema.json")
        validate_contract(evidence, "flow-fx-evidence-v2.schema.json")
        self.assertEqual(manifest["market_heads"]["fx:flows"]["revision"], 1)

    def test_actual_ledger_to_valuation_to_performance_flow_fx_path(self):
        self.add_flow()
        archive = self.fx_document()
        final = self.fx_document("end", "7.7", observed=self.end - timedelta(hours=1))["pages"][0]["observations"][0]
        final.update(batch_id="fx:1")
        archive["pages"][0]["observations"].append(final)
        archive["batch"]["expected_rows"] = 2
        self.publish(archive, at=self.end)
        config = rules()
        config["fx_scope"] = "fx:flows"
        snapshots = [value_portfolio(self.db, "p", stamp(at), config, mode="restated", now=self.end)
                     for at in (self.start, self.end)]
        self.assertEqual([row["nav_cny"] for row in snapshots], ["100", "870"])
        result = self.prepare(ids=tuple(row["id"] for row in snapshots))
        self.assertEqual(result.result["net_profit_cny"], "70")

    def test_missing_or_unapproved_rules_leave_amount_unknown_not_zero(self):
        self.add_flow()
        self.publish()
        self.snapshots()
        for config, code in ((False, "FLOW_FX_EVIDENCE_REQUIRED"),
                             ({**flow_rules(), "approved": False}, "FLOW_FX_RULES_UNAPPROVED"),
                             ({**flow_rules(), "approval_evidence": " "}, "FLOW_FX_RULES_UNAPPROVED")):
            result = self.prepare(config=config)
            self.assert_blocked(result, code)
            self.assertIsNone(result.result["external_flow_evidence"][0]["amount_cny"])

    def test_late_ingestion_not_as_known_but_explicit_restatement_can_use_it(self):
        self.add_flow()
        self.publish(at=self.end)
        self.snapshots(mode="as_known")
        self.assert_blocked(self.prepare(), "FLOW_FX_NO_PUBLICATION")
        self.snapshot("restated:start", self.start, "100")
        self.snapshot("restated:end", self.end, "800")
        result = self.prepare(ids=("restated:start", "restated:end"))
        self.assertEqual(result.result["external_flow_cny"], "700")
        self.assertEqual(result.result["net_profit_cny"], "0")

    def test_intermediate_correction_omitted_from_latest_batch_still_blocks(self):
        self.add_flow()
        self.publish()
        corrected_at = self.start + timedelta(hours=26)
        revised = self.fx_document("fx:2", "7.1", revision=1)
        revised["pages"][0]["observations"][0].update(published_at=stamp(corrected_at), revision_id="revised")
        self.publish(revised, corrected_at)
        self.publish(self.fx_document("fx:3", "7.7", revision=2, observed=self.end - timedelta(hours=1)), self.end)
        self.snapshots(mode="as_known")
        self.assert_blocked(self.prepare(), "FLOW_FX_KNOWLEDGE_CHANGED_RESTATE_REQUIRED")

    def test_foreign_date_only_overlapping_terminal_intraday_snapshot_blocks(self):
        self.date_flow("dated", "2025-01-03", "-100")
        # Isolated fixture: append a USD capital leg for the same date-only event.
        self.db.execute("INSERT INTO postings VALUES('dated:usd','dated','a','USD','external_capital','-100')")
        self.snapshots()
        result = self.prepare()
        self.assert_blocked(result, "FLOW_TIME_PRECISION_UNSUPPORTED")
        evidence = next(row for row in result.result["external_flow_evidence"] if row["currency"] == "USD")
        self.assertIsNone(evidence["flow_time"])
        self.assertIsNone(evidence["amount_cny"])

    def test_cash_only_nav_still_cas_checks_flow_fx_scope(self):
        self.add_flow()
        self.publish()
        self.snapshots()
        prepared = self.prepare()
        self.publish(self.fx_document("fx:2", "7.1", revision=1), self.end)
        with self.assertRaisesRegex(WorkbenchError, "STALE_PERFORMANCE_MARKET_INPUT"):
            persist_performance(self.db, prepared, now=self.end)

    def test_source_quality_stale_future_and_missing_series_block(self):
        for defect in ("synthetic", "reconstructed", "stale", "future", "wrong_currency"):
            with self.subTest(defect=defect):
                self.setUp()
                self.add_flow()
                source = self.fx_document()
                row = source["pages"][0]["observations"][0]
                if defect == "synthetic":
                    source["batch"]["source_mode"] = "synthetic"
                    row["provenance"] = "reconstructed"
                elif defect == "reconstructed":
                    row["provenance"] = "reconstructed"
                elif defect == "stale":
                    row["observed_at"] = stamp(self.start - timedelta(days=2))
                    row["published_at"] = row["observed_at"]
                elif defect == "future":
                    row["observed_at"] = stamp(self.end - timedelta(hours=1))
                    row["published_at"] = row["observed_at"]
                else:
                    row["series_key"] = "FX:HKD"
                self.publish(source, self.end)
                self.snapshots()
                self.assert_blocked(self.prepare(), "FLOW_FX_")

    def test_v5_rejects_prepared_v2_v3_and_v4_manifests(self):
        self.snapshots(end="100")
        prepared = self.prepare(config=False)
        for version in (2, 3, 4):
            old = json.loads(prepared.manifest)
            old["schema_version"] = "performance-input-v" + str(version)
            with self.assertRaisesRegex(WorkbenchError, "PERFORMANCE_INPUT_MANIFEST_INVALID"):
                persist_performance(self.db, replace(prepared, manifest=canonical_json(old)), now=self.end)
        saved = persist_performance(self.db, prepared, now=self.end)
        self.assertEqual(saved["method_version"], "snapshot-performance-cny-v5")
        self.assertEqual(persist_performance(self.db, prepared, now=self.end)["id"], saved["id"])

    def test_multiple_native_flows_withdrawal_and_fx_trade_are_not_conflated(self):
        self.add_flow("usd", "100")
        self.add_flow("hkd", "100", "HKD", self.start + timedelta(hours=30))
        self.add_flow("withdraw", "-10", "USD", self.start + timedelta(hours=36))
        ledger_event(self.db, "conversion", [("cash_settled", "-10"), ("fx_bridge", "10")], currency="USD")
        ledger_event(self.db, "internal", [("cash_settled", "-10"), ("transfer_in_transit", "10")], currency="HKD")
        source = self.fx_document()
        rows = source["pages"][0]["observations"]
        for identity, value, currency, hours in (("hkd-quote", "0.9", "HKD", 29), ("usd-later", "7.2", "USD", 35)):
            row = self.fx_document(identity, value, observed=self.start + timedelta(hours=hours), currency=currency)["pages"][0]["observations"][0]
            row["batch_id"] = "fx:1"
            rows.append(row)
        source["batch"]["expected_rows"] = 3
        self.publish(source, self.end)
        self.snapshots(end="818")
        result = self.prepare()
        self.assertEqual(result.result["external_flow_cny"], "718")
        self.assertEqual(result.result["net_profit_cny"], "0")
        evidence = {row["event_id"]: row for row in result.result["external_flow_evidence"]}
        self.assertEqual(set(evidence), {"usd", "hkd", "withdraw"})
        self.assertEqual(evidence["withdraw"]["amount_cny"], "-72")

    def test_binding_stable_across_as_known_periods_and_future_head_not_retroactive(self):
        self.add_flow()
        self.publish()
        self.snapshots(mode="as_known", end="800")
        first = self.prepare()
        later = self.end + timedelta(days=1)
        self.publish(self.fx_document("future", "8", revision=1, observed=later - timedelta(hours=1)), later)
        self.snapshot("future:end", later, "900", mode="as_known")
        second = self.prepare(ids=("start", "future:end"), now=later)
        replay = self.prepare(now=later)
        self.assertEqual(first.result["external_flow_evidence"], second.result["external_flow_evidence"])
        self.assertEqual(first.result["external_flow_evidence"], replay.result["external_flow_evidence"])
        self.assertEqual(replay.result["external_flow_cny"], "700")

    def test_restatement_rebinds_corrected_history_without_overwriting_prior_run(self):
        self.add_flow()
        self.publish()
        self.snapshots(mode="as_known", end="800")
        old = persist_performance(self.db, self.prepare(), now=self.end)
        revised = self.fx_document("revised", "7.1", revision=1)
        revised["pages"][0]["observations"][0]["published_at"] = stamp(self.end)
        self.publish(revised, self.end)
        self.assert_blocked(self.prepare(), "FLOW_FX_KNOWLEDGE_CHANGED_RESTATE_REQUIRED")
        self.snapshot("restated:start", self.start, "100")
        self.snapshot("restated:end", self.end, "800")
        result = self.prepare(ids=("restated:start", "restated:end"))
        self.assertEqual(result.result["external_flow_cny"], "710")
        self.assertEqual(result.result["net_profit_cny"], "-10")
        self.assertEqual(json.loads(self.db.execute("SELECT result_json FROM performance_runs WHERE id=?", (old["id"],)).fetchone()[0])["external_flow_cny"], "700")

    def test_reversal_and_replay_bind_only_new_posting(self):
        self.add_flow("wrong", "100")
        event = dict(self.db.execute("SELECT * FROM ledger_events WHERE id='wrong'").fetchone())
        event.update(id="reverse", event_type="reversal", reversal_of="wrong", idempotency_key="reverse", ledger_revision=3)
        self.db.execute("INSERT INTO ledger_events(" + ",".join(event) + ") VALUES(" + ",".join("?" for _ in event) + ")", tuple(event.values()))
        self.db.execute("INSERT INTO postings VALUES('reverse:p','reverse','a','USD','external_capital','100')")
        self.db.execute("UPDATE ledger_heads SET revision=3 WHERE portfolio_id='p'")
        self.add_flow("replay", "90")
        self.publish()
        self.snapshots(end="730")
        result = self.prepare()
        self.assertEqual(result.result["external_flow_cny"], "630")
        self.assertEqual([row["posting_id"] for row in result.result["external_flow_evidence"]], ["replay:p:1"])

    def test_stored_wrong_unit_basis_nonpositive_and_ambiguous_quote_never_convert(self):
        for defect in ("unit", "basis", "zero", "negative", "ambiguous", "publication_time"):
            with self.subTest(defect=defect):
                self.setUp()
                self.add_flow()
                source = self.fx_document()
                row = source["pages"][0]["observations"][0]
                if defect == "unit":
                    row["unit"] = "USD_per_CNY"
                elif defect == "basis":
                    row["price_basis"] = "total_return"
                elif defect in ("zero", "negative"):
                    row["value"] = "0" if defect == "zero" else "-7"
                elif defect == "publication_time":
                    row.pop("published_at")
                else:
                    other = {**row, "id": "ambiguous", "value": "7.1", "revision_id": "alternate"}
                    source["pages"][0]["observations"].append(other)
                    source["batch"]["expected_rows"] = 2
                unsafe_historical_publication(self.db, source)
                self.snapshots()
                self.assert_blocked(self.prepare(), "FLOW_FX_")

    def test_future_source_publication_and_date_quote_day_not_ended_are_unavailable(self):
        for defect in ("publication", "date_day_not_ended"):
            with self.subTest(defect=defect):
                self.setUp()
                self.add_flow()
                source = self.fx_document()
                row = source["pages"][0]["observations"][0]
                if defect == "publication":
                    row["published_at"] = stamp(self.end + timedelta(days=1))
                    unsafe_historical_publication(self.db, source)
                else:
                    row.update(observed_at="2025-01-02", time_precision="date", source_timezone="America/New_York")
                    self.publish(source, self.end)
                self.snapshots()
                self.assert_blocked(self.prepare(), "FLOW_FX_NO_POINT_IN_TIME_OBSERVATION")

    def test_latest_publication_missing_historical_member_does_not_borrow_old_batch(self):
        self.add_flow()
        self.publish()
        self.publish(self.fx_document("latest-only", "7.7", revision=1, observed=self.end - timedelta(hours=1)), self.end)
        self.snapshots()
        self.assert_blocked(self.prepare(), "FLOW_FX_NO_POINT_IN_TIME_OBSERVATION")

    def test_frozen_evidence_hash_tamper_rejected_before_persist(self):
        self.add_flow()
        self.publish()
        self.snapshots()
        result = self.prepare()
        manifest = json.loads(result.manifest)
        manifest["external_flow_evidence"][0]["amount_cny"] = "999"
        altered_result = {**result.result, "external_flow_evidence": manifest["external_flow_evidence"]}
        with self.assertRaisesRegex(WorkbenchError, "PERFORMANCE_INPUT_MANIFEST_INVALID"):
            persist_performance(self.db, replace(result, manifest=canonical_json(manifest), result=altered_result), now=self.end)

    def test_decimal_product_retains_more_than_minor_units_or_18_places(self):
        self.add_flow(amount="100.000000000000000001")
        self.publish(self.fx_document(value="7.000000000000000001"))
        self.snapshots()
        evidence = self.prepare().result["external_flow_evidence"][0]
        self.assertEqual(evidence["amount_cny"], "700.000000000000000107000000000000000001")
        validate_contract(evidence, "flow-fx-evidence-v2.schema.json")

    def test_rules_and_client_rate_injection_are_not_accepted(self):
        self.add_flow()
        self.snapshots()
        for config in ({**flow_rules(), "fx_rate": "7"},
                       {**flow_rules(), "live_advice_eligible": True},
                       {key: value for key, value in flow_rules().items() if key != "approval_evidence"}):
            with self.assertRaisesRegex(WorkbenchError, "CONTRACT_INVALID"):
                self.prepare(config=config)

    def test_fenced_persist_expired_worker_and_recovery_read_only_guards(self):
        self.add_flow()
        self.publish()
        self.snapshots()
        prepared = self.prepare()
        enqueue_job(self.db, "performance", "p", "fixture", "v3", now=self.end)
        lease = claim_job(self.db, "stale", lease_seconds=1, now=self.end)
        at = self.end + timedelta(seconds=2)
        replacement = claim_job(self.db, "fresh", lease_seconds=60, now=at)
        effect = lambda db: persist_performance(db, prepared, now=at)
        with self.assertRaisesRegex(WorkbenchError, "STALE_OR_EXPIRED_LEASE"):
            complete_job(self.db, lease, {}, effect=effect, now=at)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM performance_runs").fetchone()[0], 0)
        marker = self.path.parent / "RESTORE_PENDING_REVIEW"
        marker.touch()
        try:
            with self.assertRaisesRegex(WorkbenchError, "RESTORE_PENDING_REVIEW"):
                persist_performance(self.db, prepared, now=at)
        finally:
            marker.unlink()
        with patch.dict("os.environ", {"WORKBENCH_MODE": "read_only"}):
            with self.assertRaisesRegex(WorkbenchError, "READ_ONLY"):
                persist_performance(self.db, prepared, now=at)
        complete_job(self.db, replacement, {}, effect=effect, now=at)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM performance_runs").fetchone()[0], 1)


def contract_fixture():
    case = FlowFxTests()
    case.setUp()
    try:
        case.add_flow(amount="100.000000000000000001")
        case.publish(case.fx_document(value="7.000000000000000001"))
        case.snapshots()
        result = case.prepare()
        return {"manifest": json.loads(result.manifest), "result": result.result, "rules": flow_rules()}
    finally:
        case.doCleanups()


if __name__ == "__main__":
    unittest.main()
