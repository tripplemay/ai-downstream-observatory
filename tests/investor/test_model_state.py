from copy import deepcopy
from datetime import timedelta
import unittest

from tests.investor.fixtures import monitor_input, MONITOR_NOW
from worker.accounting.decimal_math import decimal
from worker.investor.model_state import advance_model
from worker.orchestration.db import WorkbenchError, content_hash, instant


def model_fixture():
    monitor = monitor_input()
    targets = [{"listing_id": row["listing_id"], "market": row["market"], "currency": row["currency"],
                "weight": monitor["after_weights"][row["listing_id"]]} for row in monitor["quotes"]]
    definition = {"schema_version": "investor-model-definition-v1", "model_id": monitor["model_id"],
                  "profile_id": monitor["profile_id"], "profile_version": monitor["profile_version"], "profile_hash": monitor["profile_hash"],
                  "plan_id": "synthetic-plan", "plan_hash": "e" * 64, "targets": targets,
                  "created_at": "2025-07-08T22:00:00.000Z", "valid_until": "2025-07-20T23:00:00.000Z",
                  "data_mode": "synthetic", "scope": "research_model", "live_advice_eligible": False}
    definition["target_definition_hash"] = content_hash({key: definition[key] for key in ("profile_hash", "plan_hash", "targets")})
    snapshot = {"schema_version": "investor-model-snapshot-v1", "model_id": definition["model_id"],
                "source_qualification": "synthetic_test_only", "quotes": monitor["quotes"], "fx": monitor["fx"],
                "funding_intent": monitor["funding_intent"], "policy": monitor["policy"], "quality_gaps": [],
                "corporate_actions": [], "corporate_action_coverage": {row["market"]: {
                    "from": row["observed_at"], "to": row["observed_at"], "complete": True} for row in monitor["quotes"]}}
    return definition, snapshot


def next_snapshot(snapshot, days=1):
    value = deepcopy(snapshot)
    def later(time): return (instant(time) + timedelta(days=days)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    for quote in value["quotes"]:
        window = value["corporate_action_coverage"][quote["market"]]
        window["from"], window["to"] = window["to"], later(window["to"])
        for key in ("observed_at", "expected_close_at", "known_at", "valid_until"): quote[key] = later(quote[key])
    for fx in value["fx"]:
        for key in ("observed_at", "known_at", "valid_until"): fx[key] = later(fx[key])
    value["corporate_actions"] = []
    source_now = max(row["known_at"] for row in [*snapshot["quotes"], *snapshot["fx"]])
    return value, later(max(source_now, MONITOR_NOW))


class InvestorModelStateTests(unittest.TestCase):
    def test_normalized_initialization_and_static_units_not_personal_cash(self):
        definition, snapshot = model_fixture()
        result = advance_model(definition, snapshot, None, MONITOR_NOW)
        checkpoint = result["checkpoint"]
        self.assertEqual(result["assessment"]["outcome"], "observe")
        self.assertEqual(decimal(result["assessment"]["model_nav_cny"]), decimal("10000"))
        self.assertEqual(checkpoint["initial_notional_cny"], "10000")
        self.assertIsNone(checkpoint["previous_hash"])
        self.assertEqual(checkpoint["cash_by_currency"], {"CNY": "0", "HKD": "0", "USD": "0"})
        later, now = next_snapshot(snapshot)
        later["funding_intent"] = {"id": "planned-not-cash", "amount_cny": "2000", "expected_at": now}
        update = advance_model(definition, later, checkpoint, now)
        self.assertEqual(update["assessment"]["outcome"], "decision_required")
        self.assertEqual(update["checkpoint"]["quantities"], checkpoint["quantities"])
        self.assertEqual(update["checkpoint"]["cash_by_currency"], checkpoint["cash_by_currency"])
        self.assertEqual(update["checkpoint"]["previous_hash"], content_hash(checkpoint))

    def test_split_changes_units_not_value_or_returns(self):
        definition, snapshot = model_fixture()
        first = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]
        later, now = next_snapshot(snapshot)
        quote = later["quotes"][0]
        quote["close"] = "50"
        later["corporate_actions"] = [{"id": "split", "listing_id": quote["listing_id"], "kind": "split", "ratio": "2",
            "effective_at": quote["observed_at"], "known_at": now}]
        result = advance_model(definition, later, first, now)
        self.assertEqual(decimal(result["assessment"]["model_nav_cny"]), decimal("10000"))
        self.assertEqual(decimal(result["checkpoint"]["quantities"][quote["listing_id"]]), decimal(first["quantities"][quote["listing_id"]]) * 2)
        repeat = advance_model(definition, later, result["checkpoint"], now)
        self.assertEqual(repeat["checkpoint"]["quantities"], result["checkpoint"]["quantities"])

    def test_dividend_ex_then_payment_conserves_value_foreign_cash_not_spendable_cny(self):
        definition, snapshot = model_fixture()
        first = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]
        ex, ex_now = next_snapshot(snapshot)
        quote = next(row for row in ex["quotes"] if row["currency"] == "HKD")
        quote["close"] = "120"
        action = {"id": "dividend-ex", "listing_id": quote["listing_id"], "kind": "dividend_ex", "currency": "HKD",
                  "net_per_unit": "5", "entitlement_id": "dividend-1", "tax_assumption_hash": "d" * 64,
                  "effective_at": quote["observed_at"], "known_at": ex_now}
        ex["corporate_actions"] = [action]
        result = advance_model(definition, ex, first, ex_now)
        self.assertEqual(decimal(result["assessment"]["model_nav_cny"]), decimal("10000"))
        self.assertEqual(result["checkpoint"]["receivables"][0]["amount"], "150")
        self.assertEqual(result["checkpoint"]["cash_by_currency"]["HKD"], "0")
        paid, pay_now = next_snapshot(ex, 2)
        paid["corporate_actions"] = [{"id": "dividend-pay", "listing_id": quote["listing_id"], "kind": "dividend_payment",
            "currency": "HKD", "entitlement_id": "dividend-1", "ex_at": action["effective_at"],
            "effective_at": paid["quotes"][1]["observed_at"], "known_at": pay_now}]
        paid["funding_intent"] = {"id": "planned", "amount_cny": "100", "expected_at": pay_now}
        update = advance_model(definition, paid, result["checkpoint"], pay_now)
        self.assertEqual(decimal(update["assessment"]["model_nav_cny"]), decimal("10000"))
        self.assertEqual(update["checkpoint"]["receivables"], [])
        self.assertEqual(update["checkpoint"]["cash_by_currency"]["HKD"], "150")
        self.assertEqual(update["monitor_request"]["document"]["non_cash_assets_cny"], "120")
        self.assertLessEqual(sum((decimal(row["proposed_change_cny"]) for row in update["assessment"]["changes"]), decimal("0")), decimal("100"))
        repeat = advance_model(definition, paid, update["checkpoint"], pay_now)
        self.assertEqual(repeat["checkpoint"]["cash_by_currency"]["HKD"], "150")
        duplicate, duplicate_now = next_snapshot(paid)
        duplicate["corporate_actions"] = [{**action, "id": "duplicate-ex-after-paid", "effective_at": duplicate["quotes"][1]["observed_at"], "known_at": duplicate_now}]
        with self.assertRaisesRegex(WorkbenchError, "DUPLICATE_DIVIDEND_ENTITLEMENT"):
            advance_model(definition, duplicate, update["checkpoint"], duplicate_now)

    def test_stale_and_action_coverage_gaps_never_publish_checkpoint(self):
        for kind in ("stale", "coverage", "future-action"):
            definition, snapshot = model_fixture()
            if kind == "stale": snapshot["quotes"][1]["expected_close_at"] = "2025-07-08T09:00:00.000Z"
            if kind == "coverage": snapshot["corporate_action_coverage"]["HK"]["complete"] = False
            if kind == "future-action": snapshot["corporate_actions"] = [{"id": "future", "listing_id": snapshot["quotes"][0]["listing_id"],
                "kind": "split", "ratio": "2", "effective_at": snapshot["quotes"][0]["observed_at"], "known_at": "2025-07-10T00:00:00.000Z"}]
            result = advance_model(definition, snapshot, None, MONITOR_NOW)
            self.assertIsNone(result["checkpoint"], kind)
            self.assertEqual(result["assessment"]["outcome"], "insufficient_evidence")

    def test_historical_restatement_unknown_payment_and_clock_binding_fail_closed(self):
        definition, snapshot = model_fixture()
        first = advance_model(definition, snapshot, None, MONITOR_NOW)["checkpoint"]
        later, now = next_snapshot(snapshot)
        second = advance_model(definition, later, first, now)["checkpoint"]
        for kind in ("late-action", "unknown-payment", "clock", "target", "foreign-cash"):
            value, previous = deepcopy(later), deepcopy(second)
            bound, at = deepcopy(definition), now
            if kind == "late-action": value["corporate_actions"] = [{"id": "late", "listing_id": value["quotes"][0]["listing_id"], "kind": "split", "ratio": "2", "effective_at": value["quotes"][0]["observed_at"], "known_at": now}]
            if kind == "unknown-payment":
                value, at = next_snapshot(later, 2)
                value["corporate_actions"] = [{"id": "unknown", "listing_id": value["quotes"][0]["listing_id"], "kind": "dividend_payment", "currency": "CNY", "entitlement_id": "missing", "ex_at": later["quotes"][0]["observed_at"], "effective_at": value["quotes"][0]["observed_at"], "known_at": at}]
            if kind == "clock": at = now.replace(".000Z", ".0000001Z")
            if kind == "target": bound["target_definition_hash"] = "0" * 64
            if kind == "foreign-cash":
                bound["targets"] = [row for row in bound["targets"] if row["currency"] != "HKD"]
                bound["target_definition_hash"] = content_hash({key: bound[key] for key in ("profile_hash", "plan_hash", "targets")})
            with self.subTest(kind=kind), self.assertRaises(Exception): advance_model(bound, value, previous, at)
