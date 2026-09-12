"""Real TS ledger + Python NAV/performance; all prices and evidence are synthetic."""

from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import json
import unittest

from tests.market.support import NOW, document, rules
from tests.market.test_security_transfers import (
    START, correct_security_fact, ledger_commands, publish_security_prices, security_database, value_evidence,
)
from tests.performance.test_flow_fx import flow_rules
from worker.market import ingest_document, value_portfolio
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp
from worker.performance import prepare_performance, persist_performance


def publish_security_fx(db, currency="USD", split_fx=False):
    at = START - timedelta(minutes=30)
    source = document("security:fx:1", price="7", observed=at)
    source["batch"].update(batch_type="fx", scope="fx:flows")
    row = source["pages"][0]["observations"][0]
    row.pop("listing_id")
    row.update(series_key="FX:" + currency, metric="fx_cny_per_unit", unit="CNY_per_unit_currency", price_basis="not_applicable")
    result = ingest_document(db, source, publish=True, now=at)
    if result["status"] != "published":
        raise AssertionError(result)
    if split_fx:
        later = START + timedelta(hours=3)
        source = deepcopy(source)
        source["batch"].update(id="security:fx:2", expected_rows=2, expected_publication_revision=1)
        old = source["pages"][0]["observations"][0]
        old.update(id="security:fx:2:old", batch_id="security:fx:2")
        new = {**old, "id": "security:fx:2:new", "value": "7.7", "observed_at": stamp(later),
               "published_at": stamp(later), "revision_id": "later-session"}
        source["pages"][0]["observations"].append(new)
        result = ingest_document(db, source, publish=True, now=later)
        if result["status"] != "published":
            raise AssertionError(result)


def performance_for(db, hours=(0, 6.5), mode="restated", currency="CNY", now=NOW, fx_rules=True):
    config = rules()
    if currency != "CNY":
        config["fx_scope"] = "fx:flows"
    snapshots = [value_portfolio(db, "p", stamp(START + timedelta(hours=hour)), config, mode=mode, now=now) for hour in hours]
    payload = {"valuation_ids": [row["id"] for row in snapshots], "evaluation_timezone": "UTC"}
    if currency != "CNY" and fx_rules:
        payload["flow_fx_rules"] = flow_rules()
    return prepare_performance(db, "p", payload, now=now), snapshots


class SecurityFlowTests(unittest.TestCase):
    def setUp(self):
        self.db, self.path, self.events = security_database(self)
        publish_security_prices(self.db)

    def test_real_external_in_and_internal_transit_are_not_profit(self):
        result, snapshots = performance_for(self.db)
        self.assertEqual([row["nav_cny"] for row in snapshots], ["100", "200"])
        self.assertEqual(result.result["net_profit_cny"], "0", result.result)
        self.assertEqual(result.result["external_flow_cny"], "100")
        self.assertEqual(result.method, "modified_dietz_estimate")
        evidence = result.result["external_flow_evidence"]
        self.assertEqual(len(evidence), 1)
        self.assertEqual(evidence[0]["event_id"], self.events["incoming"])
        self.assertEqual(evidence[0]["flow_kind"], "security")
        self.assertEqual(evidence[0]["security"]["market_value"], "100")
        self.assertEqual(evidence[0]["fx_rate"], "1")
        self.assertIsNone(evidence[0]["knowledge_at"])
        fact = json.loads(self.db.execute("SELECT payload_json FROM ledger_events WHERE id=?", (self.events["incoming"],)).fetchone()[0])["fact"]
        self.assertEqual(evidence[0]["security"]["fact_hash"], content_hash(fact))
        self.assertEqual(json.loads(result.manifest)["external_flow_evidence"], evidence)
        saved = persist_performance(self.db, result, now=NOW)
        self.assertEqual(saved["method_version"], "snapshot-performance-cny-v5")

    def test_no_external_flow_during_dispatch_partial_return_split_or_final_receipt(self):
        for mode in ("as_known", "restated"):
            result, _ = performance_for(self.db, (1.5, 2.5, 3.5, 4.5, 5.5, 6.5), mode)
            self.assertEqual(result.quality, "complete", result.result)
            self.assertEqual(result.method, "exact_twr")
            self.assertEqual(result.result["external_flow_evidence"], [])
            self.assertEqual(result.result["external_flow_cny"], "0")
            self.assertEqual(result.result["return"]["value"], "0")
            self.assertEqual(result.result["net_profit_cny"], "0")

    def test_external_out_releases_market_value_not_cost_and_fees_are_separate(self):
        for cost in (None, "0", "40", "200"):
            db, path, events = security_database(self, cost=cost, internal=False)
            publish_security_prices(db, split=False)
            at = stamp(START + timedelta(hours=2))
            ledger_commands(path, [{"key": "outgoing", "at": at, "fact": {
                "type": "security_out", "listing_id": "CN:TEST", "quantity": "4", "market_value": "40", "value_evidence": value_evidence(at)}},
                {"key": "separate-fee", "at": stamp(START + timedelta(hours=2.5)), "fact": {"type": "fee", "amount": "5"}}])
            result, snapshots = performance_for(db, (0, 3))
            self.assertEqual([row["nav_cny"] for row in snapshots], ["100", "155"])
            self.assertEqual(result.result["external_flow_cny"], "60", result.result)
            self.assertEqual(result.result["net_profit_cny"], "-5")
            self.assertEqual([row["amount_native"] for row in result.result["external_flow_evidence"]], ["100", "-40"])

    def test_foreign_security_uses_event_fx_not_terminal_fx_and_needs_explicit_rules(self):
        db, path, events = security_database(self, currency="USD", internal=False)
        publish_security_prices(db, "USD", split=False)
        publish_security_fx(db, split_fx=True)
        for mode in ("as_known", "restated"):
            result, snapshots = performance_for(db, (0, 4), mode, "USD")
            self.assertEqual([row["nav_cny"] for row in snapshots], ["100", "870"])
            self.assertEqual(result.result["external_flow_cny"], "700", result.result)
            self.assertEqual(result.result["net_profit_cny"], "70")
            evidence = result.result["external_flow_evidence"][0]
            self.assertEqual(evidence["flow_kind"], "security")
            self.assertEqual(evidence["fx_rate"], "7")
            self.assertEqual(evidence["security"]["market_value"], "100")
        missing, _ = performance_for(db, (0, 4), currency="USD", fx_rules=False)
        self.assertEqual(missing.quality, "blocked")
        self.assertIsNone(missing.result["external_flow_cny"])
        self.assertIsNone(missing.result["external_flow_evidence"][0]["amount_cny"])

    def test_date_security_value_blocks_cny_and_foreign_even_if_nav_can_be_valued(self):
        for currency in ("CNY", "USD"):
            db, path, events = security_database(self, currency=currency, internal=False, date_only=True)
            publish_security_prices(db, currency, split=False)
            if currency != "CNY":
                publish_security_fx(db)
            result, _ = performance_for(db, (0, 4), currency=currency)
            self.assertEqual(result.quality, "blocked")
            evidence = result.result["external_flow_evidence"][0]
            self.assertIn("FLOW_TIME_PRECISION_UNSUPPORTED:" + events["incoming"], result.result["issues"])
            for field in ("amount_cny", "flow_time", "knowledge_at", "evaluation_date"):
                self.assertIsNone(evidence[field])
            self.assertNotIn("date_only_source_timezone_eod_assumption", result.result["assumptions"])

    def test_foreign_outflow_has_its_own_fx_binding_and_consumed_scope_cas(self):
        db, path, events = security_database(self, currency="USD", internal=False)
        publish_security_prices(db, "USD", split=False)
        publish_security_fx(db, split_fx=True)
        at = stamp(START + timedelta(hours=4))
        ledger_commands(path, [{"key": "foreign-out", "at": at, "fact": {
            "type": "security_out", "currency": "USD", "listing_id": "CN:TEST", "quantity": "4",
            "market_value": "40", "value_evidence": value_evidence(at)}}])
        result, snapshots = performance_for(db, (0, 5), currency="USD")
        self.assertEqual([row["nav_cny"] for row in snapshots], ["100", "562"])
        self.assertEqual(result.result["external_flow_cny"], "392", result.result)
        self.assertEqual(result.result["net_profit_cny"], "70")
        self.assertEqual([(row["amount_native"], row["fx_rate"], row["amount_cny"]) for row in result.result["external_flow_evidence"]],
                         [("100", "7", "700"), ("-40", "7.7", "-308")])
        source = document("security:fx:3", price="8", revision=2, observed=START + timedelta(hours=5))
        source["batch"].update(batch_type="fx", scope="fx:flows")
        row = source["pages"][0]["observations"][0]
        row.pop("listing_id")
        row.update(series_key="FX:USD", metric="fx_cny_per_unit", unit="CNY_per_unit_currency", price_basis="not_applicable")
        ingest_document(db, source, publish=True, now=NOW)
        with self.assertRaisesRegex(WorkbenchError, "STALE_PERFORMANCE_MARKET_INPUT"):
            persist_performance(db, result, now=NOW)

    def test_cost_restatement_reverses_and_replays_transit_without_economic_profit(self):
        before, snapshots = performance_for(self.db, (0, 5.5), "as_known")
        persisted = persist_performance(self.db, before, now=NOW)
        correction = correct_security_fact(self.path, self.events["incoming"], {"cost_amount": "80"}, now=START + timedelta(hours=7))
        after, restated = performance_for(self.db, (0, 5.5), "restated")
        self.assertEqual(after.result["net_profit_cny"], "0", after.result)
        self.assertEqual([row["nav_cny"] for row in restated], ["100", "200"])
        self.assertEqual(after.result["external_flow_evidence"][0]["security"]["market_value"], "100")
        new_dispatch = next(row["event_id"] for row in correction["replacements"] if row["original_event_id"] == self.events["dispatch"])
        pending = self.db.execute("SELECT evidence_json FROM valuation_items WHERE run_id=? AND item_type='security_in_transit_market_value'", (restated[-1]["id"],)).fetchone()
        self.assertEqual(json.loads(pending[0])["transfer_event_id"], new_dispatch)
        historical, old = performance_for(self.db, (0, 5.5), "as_known")
        self.assertEqual(historical.result["external_flow_evidence"][0]["event_id"], self.events["incoming"])
        self.assertEqual(historical.result["net_profit_cny"], "0")
        crossing, _ = performance_for(self.db, (5.5, 7.5), "as_known")
        self.assertEqual(crossing.quality, "blocked")
        self.assertIn("KNOWLEDGE_SET_CHANGED_RESTATE_REQUIRED", crossing.result["issues"])
        self.assertEqual(self.db.execute("SELECT result_json FROM performance_runs WHERE id=?", (persisted["id"],)).fetchone()[0], canonical_json(before.result))

    def test_value_correction_and_void_match_clean_restatement_not_today_profit(self):
        db, path, events = security_database(self, internal=False)
        publish_security_prices(db, split=False)
        correct_security_fact(path, events["incoming"], {"market_value": "120"}, now=START + timedelta(hours=3))
        restated, _ = performance_for(db, (0, 4))
        self.assertEqual(restated.result["external_flow_cny"], "120", restated.result)
        self.assertEqual(restated.result["net_profit_cny"], "-20")
        clean, clean_path, clean_events = security_database(self, internal=False, market_value="120")
        publish_security_prices(clean, split=False)
        baseline, _ = performance_for(clean, (0, 4))
        for field in ("return", "net_profit_cny", "external_flow_cny", "xirr"):
            self.assertEqual(restated.result[field], baseline.result[field])
        historical, _ = performance_for(db, (0, 2), "as_known")
        self.assertEqual(historical.result["external_flow_cny"], "100")
        self.assertEqual(historical.result["net_profit_cny"], "0")
        crossing, _ = performance_for(db, (2, 4), "as_known")
        self.assertEqual(crossing.quality, "blocked")
        current_id = restated.result["external_flow_evidence"][0]["event_id"]
        correct_security_fact(path, current_id, now=START + timedelta(hours=5))
        voided, snapshots = performance_for(db, (0, 6))
        self.assertEqual([row["nav_cny"] for row in snapshots], ["100", "100"])
        self.assertEqual(voided.result["external_flow_cny"], "0")
        self.assertEqual(voided.result["net_profit_cny"], "0")

    def test_security_coverage_missing_or_duplicate_posting_blocks(self):
        for defect in ("missing", "duplicate"):
            db, path, events = security_database(self, internal=False)
            publish_security_prices(db, split=False)
            if defect == "missing":
                # Deliberate corruption in an isolated DB, never a supported ledger mutation.
                db.execute("DROP TRIGGER postings_no_delete")
                db.execute("DELETE FROM postings WHERE event_id=? AND ledger_account='external_capital'", (events["incoming"],))
            else:
                db.execute("INSERT INTO postings SELECT 'forged:duplicate',event_id,account_id,currency,ledger_account,amount FROM postings WHERE event_id=? AND ledger_account='external_capital'", (events["incoming"],))
            result, _ = performance_for(db, (0, 4))
            self.assertEqual(result.quality, "blocked")
            self.assertIn("SECURITY_FLOW_POSTING_COVERAGE_INVALID:" + events["incoming"], result.result["issues"])
            self.assertIsNone(result.result["net_profit_cny"])

    def test_source_value_time_scope_and_real_security_movement_are_independently_checked(self):
        for defect in ("missing_evidence", "value", "time", "timezone", "reference", "movement_missing", "movement_quantity", "movement_scope"):
            with self.subTest(defect=defect):
                db, path, events = security_database(self, internal=False)
                publish_security_prices(db, split=False)
                if defect.startswith("movement_"):
                    db.execute("DROP TRIGGER position_movements_no_update")
                    db.execute("DROP TRIGGER position_movements_no_delete")
                    if defect == "movement_missing":
                        db.execute("DELETE FROM position_movements WHERE event_id=?", (events["incoming"],))
                    elif defect == "movement_quantity":
                        db.execute("UPDATE position_movements SET quantity='9' WHERE event_id=?", (events["incoming"],))
                    else:
                        db.execute("UPDATE position_movements SET account_id='b' WHERE event_id=?", (events["incoming"],))
                else:
                    db.execute("DROP TRIGGER ledger_events_no_update")
                    raw = json.loads(db.execute("SELECT payload_json FROM ledger_events WHERE id=?", (events["incoming"],)).fetchone()[0])
                    if defect == "missing_evidence":
                        raw["fact"].pop("value_evidence")
                    elif defect == "value":
                        raw["fact"]["market_value"] = "101"
                    elif defect == "time":
                        raw["fact"]["value_evidence"]["effective_at"] = stamp(START + timedelta(hours=2))
                    elif defect == "timezone":
                        raw["fact"]["value_evidence"]["source_timezone"] = "Asia/Shanghai"
                    else:
                        raw["fact"]["value_evidence"]["reference"] = " "
                    db.execute("UPDATE ledger_events SET payload_json=? WHERE id=?", (canonical_json(raw), events["incoming"]))
                result, _ = performance_for(db, (0, 4))
                self.assertEqual(result.quality, "blocked", result.result)
                evidence = result.result["external_flow_evidence"][0]
                self.assertIsNone(evidence["amount_cny"])
                self.assertTrue(any(code.startswith("SECURITY_FLOW_") for code in result.result["issues"]), result.result)

    def test_new_contracts_freeze_full_fact_and_old_methods_are_not_reused(self):
        result, _ = performance_for(self.db)
        manifest = json.loads(result.manifest)
        validate_contract(manifest, "performance-input-v5.schema.json")
        evidence = manifest["external_flow_evidence"][0]
        validate_contract(evidence, "flow-fx-evidence-v2.schema.json")
        self.assertEqual(evidence["binding_id"], content_hash({key: value for key, value in evidence.items() if key != "binding_id"}))
        for altered in ({**evidence, "flow_kind": "cash"}, {**evidence, "security": None}, {**evidence, "execute_trade": True}):
            with self.assertRaises(WorkbenchError):
                validate_contract(altered, "flow-fx-evidence-v2.schema.json")
        manifest["schema_version"] = "performance-input-v3"
        with self.assertRaisesRegex(WorkbenchError, "PERFORMANCE_INPUT_MANIFEST_INVALID"):
            persist_performance(self.db, replace(result, manifest=canonical_json(manifest)), now=NOW)


def security_contract_fixture():
    test = SecurityFlowTests()
    test.setUp()
    try:
        prepared, snapshots = performance_for(test.db, (0, 5.5))
        saved = persist_performance(test.db, prepared, now=NOW)
        return {"manifest": json.loads(prepared.manifest), "result": prepared.result, "saved": saved,
                "valuations": [{"manifest": json.loads(row["market_manifest"]), "method": row["method_version"]} for row in snapshots]}
    finally:
        test.doCleanups()


if __name__ == "__main__":
    unittest.main()
