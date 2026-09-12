"""Synthetic sources exercise the real TS ledger, not invented postings."""

from datetime import timedelta
import json
import unittest

from tests.market.support import NOW, database, document, rules, seed_account
from tests.market.test_security_transfers import (START, ledger_commands, correct_security_fact,
                                                 security_database, publish_security_prices)
from worker.market import ingest_document, value_portfolio
from worker.market.valuation import prepare_valuation
from worker.orchestration.db import content_hash, stamp


def corporate_database(test, commands=(), opening=True):
    db, path = database(test)
    seed_account(db)
    db.execute("INSERT INTO accounts(id,portfolio_id,name,broker,base_currency,created_at) VALUES('b','p','Other','synthetic','CNY',?)",
               (stamp(START),))
    rows = ([{"key": "opening", "at": stamp(START - timedelta(hours=1)),
              "fact": {"type": "opening_cash", "amount": "100"}}] if opening else [])
    rows.extend({"key": key, "at": stamp(START + timedelta(hours=hours)), "fact": fact}
                for key, hours, fact in commands)
    ids = ledger_commands(path, rows) if rows else {}
    return db, path, ids


def assessment(key, hours, tax, status="confirmed"):
    return key, hours, {"type": "dividend_tax_assessment", "related_event_id": "@gross", "tax": tax,
                        "tax_status": status, "evidence_reference": "Synthetic broker cumulative tax evidence"}


class CorporateActionValuationTests(unittest.TestCase):
    def valuation(self, db, hours, mode="restated"):
        return value_portfolio(db, "p", stamp(START + timedelta(hours=hours)), rules(), mode, now=NOW)

    def test_unknown_tax_receipt_confirm_payment_and_refund_conserve_nav(self):
        db, path, ids = corporate_database(self, [
            ("gross", 1, {"type": "dividend_accrual", "amount": "200", "tax_status": "unknown"}),
            ("paid", 2, {"type": "dividend_payment", "related_event_id": "@gross", "amount": "180"}),
            assessment("tax20", 3, "20"), assessment("tax25", 4, "25"),
            ("deduct", 5, {"type": "dividend_tax_payment", "related_event_id": "@gross", "amount": "5", "evidence_reference": "Synthetic actual withholding"}),
            assessment("taxback20", 6, "20"),
            ("refund", 7, {"type": "dividend_payment", "related_event_id": "@gross", "amount": "5"})])
        for mode in ("restated", "as_known"):
            for hour, nav, partial in [(1.5, None, "300"), (2.5, None, "300"), (3.5, "280", "280"),
                                       (4.5, "275", "275"), (5.5, "275", "275"), (6.5, "280", "280"), (7.5, "280", "280")]:
                with self.subTest(mode=mode, hour=hour):
                    run = self.valuation(db, hour, mode)
                    self.assertEqual(run["nav_cny"], nav, run)
                    self.assertEqual(json.loads(run["issues_json"])["known_partial_cny"], partial)
            pending = self.valuation(db, 4.5, mode)
            item = db.execute("SELECT amount,value_cny FROM valuation_items WHERE run_id=? AND item_type='dividend_tax_payable'", (pending["id"],)).fetchone()
            self.assertEqual(tuple(item), ("-5", "-5"))
        self.assertEqual(db.execute("SELECT count(*) FROM postings WHERE ledger_account='external_capital'").fetchone()[0], 0)

    def test_final_net_keeps_full_nav_with_only_attribution_pending(self):
        db, path, ids = corporate_database(self, [("net", 1, {"type": "dividend_net", "amount": "180", "net_status": "final"}),
            ("breakdown", 2, {"type": "dividend_breakdown", "related_event_id": "@net", "gross_amount": "200", "tax": "20", "evidence_reference": "Synthetic gross/tax document"})])
        for hour, attribution in [(1.5, "provisional"), (2.5, "complete")]:
            run = self.valuation(db, hour)
            self.assertEqual((run["quality"], run["nav_cny"]), ("complete", "280"))
            proof = json.loads(run["market_manifest"])["ledger_fact_quality"]
            self.assertEqual(proof["attribution_quality"], attribution)
            self.assertEqual(proof["binding_id"], content_hash({key: value for key, value in proof.items() if key != "binding_id"}))

    def test_notice_only_is_not_initialization_and_rules_cannot_clear_it(self):
        db, path, ids = corporate_database(self, [("notice", 1, {"type": "corporate_action_notice", "action_kind": "merger",
                "listing_id": "CN:TEST", "evidence_reference": "Synthetic unresolved merger"})], opening=False)
        result = prepare_valuation(db, "p", stamp(START + timedelta(hours=2)), rules(), "restated", NOW)
        self.assertEqual(result.quality, "blocked")
        self.assertIn("PORTFOLIO_NOT_INITIALIZED_AT_CUTOFF", result.issues)
        self.assertIn("CORPORATE_ACTION_UNRESOLVED:" + ids["notice"], result.issues)

    def test_notice_applies_without_position_and_resolves_only_after_evidence(self):
        db, path, ids = corporate_database(self, [("notice", 1, {"type": "corporate_action_notice", "action_kind": "return_of_capital",
                "evidence_reference": "Synthetic uncertain nature"}),
            ("resolve", 3, {"type": "corporate_action_resolution", "related_event_id": "@notice", "resolution": "not_applicable",
                "supporting_event_ids": [], "evidence_reference": "Synthetic verified non-applicability"})])
        self.assertEqual(self.valuation(db, 2)["quality"], "blocked")
        self.assertEqual(self.valuation(db, 4)["nav_cny"], "100")

    def test_append_correction_does_not_rewrite_as_known_tax_state(self):
        db, path, ids = corporate_database(self, [("gross", 1, {"type": "dividend_accrual", "amount": "200", "tax_status": "unknown"}),
            ("paid", 2, {"type": "dividend_payment", "related_event_id": "@gross", "amount": "180"})])
        before = self.valuation(db, 3, "as_known")
        self.assertEqual(before["quality"], "provisional")
        correct_security_fact(path, ids["gross"], {"tax": "20", "tax_status": "confirmed"}, now=NOW)
        self.assertEqual(self.valuation(db, 3, "as_known")["quality"], "provisional")
        self.assertEqual(self.valuation(db, 3, "restated")["nav_cny"], "280")

    def test_foreign_tax_liability_uses_fx_once_and_missing_fx_never_uses_zero(self):
        db, path, ids = corporate_database(self, [
            ("gross", 1, {"type": "dividend", "currency": "USD", "amount": "200", "tax": "20"}),
            ("assess", 2, {"type": "dividend_tax_assessment", "currency": "USD", "related_event_id": "@gross",
                           "tax": "25", "tax_status": "confirmed", "evidence_reference": "Synthetic USD cumulative tax"})])
        self.assertEqual(self.valuation(db, 3)["quality"], "blocked")
        data = document("dividend:fx", price="7", observed=NOW)
        data["batch"].update(batch_type="fx", scope="fx:CNY")
        row = data["pages"][0]["observations"][0]
        del row["listing_id"]
        row.update(series_key="FX:USD", metric="fx_cny_per_unit", unit="CNY_per_unit_currency", price_basis="not_applicable")
        ingest_document(db, data, publish=True, now=NOW)
        config = rules()
        config["fx_scope"] = "fx:CNY"
        run = value_portfolio(db, "p", stamp(NOW), config, "restated", now=NOW)
        self.assertEqual(run["nav_cny"], "1325")
        item = db.execute("SELECT amount,fx_rate,value_cny FROM valuation_items WHERE run_id=? AND item_type='dividend_tax_payable'", (run["id"],)).fetchone()
        self.assertEqual(tuple(item), ("-5", "7", "-35"))

    def test_notice_cannot_be_ignored_when_all_securities_are_in_transit(self):
        db, path, ids = security_database(self, internal=False)
        ledger_commands(path, [
            {"key": "all-in-transit", "at": stamp(START + timedelta(hours=2)), "fact": {
                "type": "security_transfer_out", "listing_id": "CN:TEST", "quantity": "10", "target_account_id": "b"}},
            {"key": "notice", "at": stamp(START + timedelta(hours=3)), "fact": {
                "type": "corporate_action_notice", "listing_id": "CN:TEST", "action_kind": "merger",
                "evidence_reference": "Synthetic in-transit merger review"}}])
        publish_security_prices(db, split=False)
        run = self.valuation(db, 4)
        self.assertEqual(run["quality"], "blocked")
        self.assertEqual(db.execute("SELECT quantity FROM position_projections WHERE account_id='a'").fetchone()[0], "0")
        self.assertEqual(db.execute("SELECT amount FROM valuation_items WHERE run_id=? AND item_type='security_in_transit_market_value'", (run["id"],)).fetchone()[0], "100")

    def test_future_recorded_fact_cannot_enter_money_before_prepare_knowledge(self):
        db, path, ids = corporate_database(self)
        future = ledger_commands(path, [{"key": "future-knowledge", "at": stamp(START + timedelta(hours=1)),
            "recorded": stamp(NOW + timedelta(hours=1)), "fact": {"type": "dividend_net", "amount": "180", "net_status": "final"}}])
        cutoff = stamp(START + timedelta(hours=2))
        known = prepare_valuation(db, "p", cutoff, rules(), "as_known", NOW)
        self.assertEqual(known.nav_cny, "100")
        early = prepare_valuation(db, "p", cutoff, rules(), "restated", NOW)
        self.assertEqual((early.quality, early.nav_cny, early.known_partial_cny), ("blocked", None, "100"))
        self.assertIn("FUTURE_RECORDED_FACT_AT_VALUATION:" + future["future-knowledge"], early.issues)
        self.assertEqual(json.loads(early.market_manifest)["ledger_fact_quality"]["dividends"], [])
        later = prepare_valuation(db, "p", cutoff, rules(), "restated", NOW + timedelta(hours=2))
        self.assertEqual(later.nav_cny, "280")


if __name__ == "__main__":
    unittest.main()
