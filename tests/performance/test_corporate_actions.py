from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import json
import unittest

from tests.market.support import NOW, rules
from tests.market.test_corporate_actions import corporate_database, assessment
from tests.market.test_security_transfers import START, correct_security_fact
from worker.market import value_portfolio
from worker.market.valuation import prepare_valuation, persist_valuation
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, stamp
from worker.performance import prepare_performance, persist_performance
from worker.accounting.fact_quality import evaluate_fact_quality


class CorporateActionPerformanceTests(unittest.TestCase):
    def prepare(self, db, start=0, end=7.5, mode="restated"):
        snapshots = [value_portfolio(db, "p", stamp(START + timedelta(hours=hours)), rules(), mode, now=NOW)
                     for hours in (start, end)]
        return prepare_performance(db, "p", {"valuation_ids": [row["id"] for row in snapshots],
            "evaluation_timezone": "Asia/Shanghai"}, now=NOW)

    def test_final_net_income_keeps_return_and_never_becomes_external_capital(self):
        db, path, ids = corporate_database(self, [("net", 1, {"type": "dividend_net", "amount": "180", "net_status": "final"})])
        for mode in ("as_known", "restated"):
            prepared = self.prepare(db, mode=mode)
            self.assertEqual(prepared.quality, "complete", prepared.result)
            self.assertEqual(prepared.result["net_profit_cny"], "180")
            self.assertEqual(prepared.result["external_flow_cny"], "0")
            self.assertEqual(prepared.result["external_flow_evidence"], [])
            self.assertEqual(prepared.result["attribution_quality"], "provisional")
            saved = persist_performance(db, prepared, now=NOW)
            self.assertEqual(saved["method_version"], "snapshot-performance-cny-v5")

    def test_breakdown_is_not_new_profit_or_external_flow(self):
        db, path, ids = corporate_database(self, [("net", 1, {"type": "dividend_net", "amount": "180", "net_status": "final"}),
            ("breakdown", 2, {"type": "dividend_breakdown", "related_event_id": "@net", "gross_amount": "200", "tax": "20", "evidence_reference": "Synthetic classification evidence"})])
        prepared = self.prepare(db, start=1.5)
        self.assertEqual(prepared.quality, "complete", prepared.result)
        self.assertEqual(prepared.result["net_profit_cny"], "0")
        self.assertEqual(prepared.result["external_flow_cny"], "0")

    def test_final_endpoints_do_not_hide_unresolved_tax_inside_period(self):
        db, path, ids = corporate_database(self, [("gross", 1, {"type": "dividend_accrual", "amount": "200", "tax_status": "unknown"}),
                                                assessment("confirmed", 3, "20")])
        prepared = self.prepare(db)
        self.assertEqual([proof["performance_quality"] for proof in prepared.result["ledger_fact_quality"]], ["complete", "complete"])
        self.assertEqual(prepared.result["period_fact_quality"]["performance_quality"], "provisional")
        self.assertEqual(prepared.quality, "blocked")
        self.assertIsNone(prepared.result["return"])

    def test_notice_resolved_by_end_still_blocks_graph_through_unknown_interval(self):
        db, path, ids = corporate_database(self, [("notice", 1, {"type": "corporate_action_notice", "action_kind": "liquidation", "evidence_reference": "Synthetic unresolved liquidation"}),
            ("resolved", 3, {"type": "corporate_action_resolution", "related_event_id": "@notice", "resolution": "not_applicable", "supporting_event_ids": [], "evidence_reference": "Synthetic resolution"})])
        prepared = self.prepare(db)
        self.assertEqual(prepared.quality, "blocked")
        self.assertEqual(prepared.result["period_fact_quality"]["corporate_actions"][0]["status"], "resolved")
        self.assertEqual(prepared.result["period_fact_quality"]["nav_quality"], "blocked")

    def test_historical_tax_correction_is_restatement_not_new_current_loss(self):
        db, path, ids = corporate_database(self, [("gross", 1, {"type": "dividend_accrual", "amount": "200", "tax_status": "unknown"}),
            ("paid", 2, {"type": "dividend_payment", "related_event_id": "@gross", "amount": "180"})])
        correct_security_fact(path, ids["gross"], {"tax": "20", "tax_status": "confirmed"}, now=START + timedelta(hours=5))
        known = self.prepare(db, mode="as_known")
        self.assertEqual(known.quality, "blocked")
        restated = self.prepare(db, mode="restated")
        self.assertEqual(restated.quality, "complete", restated.result)
        self.assertEqual(restated.result["net_profit_cny"], "180")

    def test_self_rehashed_omission_and_wrong_snapshot_quality_cannot_persist(self):
        db, path, ids = corporate_database(self, [("net", 1, {"type": "dividend_net", "amount": "180", "net_status": "final"})])
        prepared = self.prepare(db)
        manifest, result = json.loads(prepared.manifest), deepcopy(prepared.result)
        proof = manifest["period_fact_quality"]
        proof.update(dividends=[], event_hashes={}, issues=[], attribution_quality="complete")
        proof["binding_id"] = content_hash({key: value for key, value in proof.items() if key != "binding_id"})
        result["period_fact_quality"] = proof
        with self.assertRaisesRegex(WorkbenchError, "PERFORMANCE_FACT_QUALITY_INVALID"):
            persist_performance(db, replace(prepared, manifest=canonical_json(manifest), result=result), now=NOW)
        nav = prepare_valuation(db, "p", stamp(START + timedelta(hours=2)), rules(), "restated", NOW)
        manifest = json.loads(nav.market_manifest)
        manifest["ledger_fact_quality"] = proof
        with self.assertRaisesRegex(WorkbenchError, "VALUATION_FACT_QUALITY_INVALID"):
            persist_valuation(db, replace(nav, market_manifest=canonical_json(manifest)), now=NOW)

    def test_valid_but_shortened_period_proof_cannot_hide_unknown_interval(self):
        db, path, ids = corporate_database(self, [("notice", 1, {"type": "corporate_action_notice", "action_kind": "other", "evidence_reference": "Synthetic pending"}),
            ("resolved", 3, {"type": "corporate_action_resolution", "related_event_id": "@notice", "resolution": "not_applicable", "supporting_event_ids": [], "evidence_reference": "Synthetic resolved"})])
        prepared = self.prepare(db)
        events = [dict(row) for row in db.execute("SELECT * FROM ledger_events")]
        proof = evaluate_fact_quality(events, "p", prepared.ledger_revision, prepared.period_end, NOW,
                                      "restated", prepared.period_end)
        self.assertEqual(proof["performance_quality"], "complete")
        manifest, result = json.loads(prepared.manifest), deepcopy(prepared.result)
        manifest["period_fact_quality"] = result["period_fact_quality"] = proof
        result.update(attribution_quality="complete", issues=[], **{"return": {"value": "0"}})
        with self.assertRaisesRegex(WorkbenchError, "PERFORMANCE_FACT_QUALITY_INVALID"):
            persist_performance(db, replace(prepared, quality="complete", manifest=canonical_json(manifest), result=result), now=NOW)


if __name__ == "__main__":
    unittest.main()
