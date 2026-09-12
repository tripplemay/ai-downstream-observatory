from copy import deepcopy
from datetime import timedelta
from decimal import Decimal
import unittest

from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from worker.research.backtest import compare_backtest
from worker.research.rotation import run_rotation_portfolio
from tests.research.rotation_fixtures import dataset, fixed, parameters, plan


def rows(result, kind):
    return [row for row in result["events"] if row["type"] == kind]


def flat(data, price="10"):
    for row in data["observations"]:
        if row["metric"] == "close":
            row["value"] = price


def switching(data):
    for row in data["observations"]:
        date = row["observed_at"][:10]
        if row["listing_id"] == "CN:ALPHA":
            row["value"] = "9" if date < "2025-01-05" else "10" if date < "2025-02-01" else "9"
        else:
            row["value"] = "10" if date < "2025-02-01" else "11"


class RotationTests(unittest.TestCase):
    def setUp(self):
        self.data, self.plan = dataset(), plan()

    def run_case(self, candidate=None):
        return run_rotation_portfolio(self.data, self.plan, candidate or parameters(), "train")

    def short(self):
        self.plan["windows"]["train"]["end"] = "2025-01-10T23:00:00Z"

    def test_rotation_and_fixed_benchmark_share_engine_and_reproducible_hash(self):
        first = compare_backtest(self.data, self.plan, parameters(), "train")
        second = compare_backtest(deepcopy(self.data), deepcopy(self.plan), parameters(), "train")
        self.assertEqual(first["result_hash"], second["result_hash"])
        self.assertEqual(first["strategy"]["engine_version"], first["benchmark"]["engine_version"])
        self.assertEqual(first["strategy"]["initial_equity_cny"], first["benchmark"]["initial_equity_cny"])
        self.assertFalse(first["live_advice_eligible"])
        self.assertFalse(any(gate["status"] == "PASS" for gate in first["strategy_gates"].values()))

    def test_E18_first_unchanged_month_is_not_reopened_by_next_day_ranking(self):
        self.short()
        flat(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-06":
                row["value"] = "20"
        result = self.run_case()
        evaluations = rows(result, "evaluation")
        self.assertEqual(len(evaluations), 1)
        self.assertEqual(evaluations[0]["outcome"], "unchanged")
        self.assertEqual(evaluations[0]["targets"], {"CN:ALPHA": "0", "CN:BETA": "0"})
        self.assertEqual(len(rows(result, "monthly_monitor")), 5)
        self.assertFalse(rows(result, "research_order"))
        self.assertEqual(result["profit_cny"], "0")

    def test_E28_new_buy_never_earns_selection_day_jump(self):
        self.short()
        flat(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-05":
                row["value"] = "20"
        result = self.run_case()
        buy = rows(result, "simulated_buy")[0]
        self.assertGreater(instant(buy["at"]), instant(buy["decision_at"]))
        self.assertEqual(buy["quantity"], "60")
        self.assertEqual(result["twr"], "0")
        self.assertEqual(result["ending_nav_cny"], "1200")

    def test_true_rotation_sells_then_waits_for_cash_settlement_before_next_close(self):
        switching(self.data)
        result = self.run_case()
        self.assertEqual([row["listing_id"] for row in rows(result, "simulated_buy")], ["CN:ALPHA", "CN:BETA"])
        sell = rows(result, "simulated_sell")[0]
        buy = rows(result, "simulated_buy")[1]
        self.assertEqual(sell["quantity"], "120")
        self.assertGreater(instant(buy["at"]), instant(sell["settled_at"]))
        self.assertEqual(buy["at"][:10], "2025-02-04")
        between = next(row for row in result["curve"] if row["at"].startswith("2025-02-02T07:00:"))
        self.assertEqual(between["cash_cny"], "0")
        self.assertEqual(between["nav_cny"], "1080")
        self.assertEqual(result["positions"], {"CN:ALPHA": "0", "CN:BETA": "98"})
        self.assertEqual(result["profit_cny"], "-120")
        self.assertEqual(result["twr"], "-0.1")
        self.assertGreater(Decimal(result["sell_turnover_on_mean_observed_nav"]), 0)

    def test_held_asset_earns_old_position_move_until_sell_but_no_longer_after_sell(self):
        switching(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-02-03":
                row["value"] = "90"
        result = self.run_case()
        self.assertEqual(result["ending_nav_cny"], "1080")
        self.assertEqual(result["profit_cny"], "-120")

    def test_price_jump_skips_frozen_buy_instead_of_resizing_or_replanning(self):
        self.short()
        flat(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-06":
                row["value"] = "20"
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertEqual(rows(result, "research_order")[0]["quantity"], "120")
        self.assertFalse(rows(result, "simulated_buy"))
        self.assertEqual(rows(result, "execution_skipped")[0]["required_cny"], "2400")
        self.assertEqual(len(rows(result, "research_order")), 1)
        self.assertEqual(result["execution_failure_count"], 1)
        self.assertEqual(result["profit_cny"], "0")

    def test_sale_price_drop_cannot_fund_dependent_fixed_budget(self):
        switching(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-02-02":
                row["value"] = "8"
        result = self.run_case()
        self.assertEqual(len(rows(result, "simulated_buy")), 1)
        skipped = rows(result, "execution_skipped")
        self.assertEqual(skipped[0]["reason"], "SETTLED_CASH_BELOW_PRECOMMITTED_BUDGET")
        self.assertEqual(skipped[0]["at"][:10], "2025-02-03")
        self.assertEqual(result["ending_nav_cny"], "960")

    def test_buying_stock_before_settlement_blocks_next_month_and_is_still_nav(self):
        switching(self.data)
        self.data["settlements"][5]["settled_at"] = "2025-02-03T09:00:00Z"
        result = self.run_case()
        feb = rows(result, "evaluation")[1]
        self.assertEqual(feb["outcome"], "blocked")
        self.assertEqual(feb["reason_codes"], ["ACTIVE_ORDERS_OR_UNSETTLED_ASSETS"])
        self.assertFalse(rows(result, "simulated_sell"))
        self.assertEqual(result["positions"]["CN:ALPHA"], "120")
        self.assertEqual(result["ending_nav_cny"], "1080")
        self.assertEqual(len(rows(result, "evaluation")), 2)

    def test_unsettled_sale_is_receivable_nav_never_spendable_cash(self):
        switching(self.data)
        for row in self.data["settlements"]:
            if row["session_date"] == "2025-02-02":
                row["settled_at"] = "2025-03-03T09:00:00Z"
        result = self.run_case()
        self.assertEqual(result["ending_receivables"]["sale_cny"], "1080")
        self.assertEqual(result["ending_cash"]["CNY"], "0")
        self.assertEqual(result["ending_nav_cny"], "1080")
        self.assertEqual(rows(result, "order_expired")[0]["reason"], "MONTHLY_ORDER_EXPIRED")
        self.assertEqual(len(rows(result, "simulated_buy")), 1)

    def test_contribution_on_decision_is_external_before_targets_and_neutral_to_returns(self):
        flat(self.data)
        self.plan["contributions"] = [{"at": "2025-02-01T07:01:00Z", "amount_cny": "300"}]
        candidate = fixed({"CN:ALPHA": "1"})
        self.plan["parameter_candidates"], self.plan["benchmark"] = [candidate], candidate
        report = compare_backtest(self.data, self.plan, candidate, "train")
        result = report["strategy"]
        feb = rows(result, "evaluation")[1]
        self.assertEqual(feb["nav_cny"], "1500")
        self.assertEqual(feb["deltas"][0]["difference_cny"], "300")
        self.assertEqual(result["contributions_cny"], "300")
        self.assertEqual(result["profit_cny"], "0")
        self.assertEqual(result["twr"], "0")
        self.assertEqual(report["excess_twr"], "0")
        self.assertEqual(content_hash(result), content_hash(report["benchmark"]))

    def test_intra_month_contribution_waits_cash_and_does_not_reopen_month_slot(self):
        self.short()
        flat(self.data)
        self.plan["contributions"] = [{"at": "2025-01-08T00:00:00Z", "amount_cny": "300"}]
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertEqual(len(rows(result, "research_order")), 1)
        self.assertEqual(result["ending_cash"]["CNY"], "300")
        self.assertEqual(result["ending_nav_cny"], "1500")
        self.assertEqual(result["profit_cny"], "0")

    def test_zero_orders_from_rounding_is_blocked_not_unchanged(self):
        self.short()
        flat(self.data)
        self.plan["initial_capital_cny"] = "5"
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        evaluation = rows(result, "evaluation")[0]
        self.assertEqual(evaluation["outcome"], "blocked")
        self.assertEqual(evaluation["reason_codes"], ["BUY_BELOW_QUANTITY_STEP_OR_FEES:CN:ALPHA"])

    def test_no_next_trade_close_is_blocked_not_unchanged(self):
        self.short()
        flat(self.data)
        for session in self.data["sessions"]:
            if session["close_at"] >= "2025-01-06":
                session["trade_allowed"] = False
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertEqual(rows(result, "evaluation")[0]["outcome"], "blocked")
        self.assertEqual(rows(result, "evaluation")[0]["reason_codes"], ["NO_EXECUTABLE_CLOSE:CN:ALPHA"])
        self.assertEqual(result["profit_cny"], "0")

    def test_missing_candidate_signal_records_blocked_month_not_repaired_by_next_day(self):
        self.short()
        self.data["observations"] = [row for row in self.data["observations"] if row["id"] != "CN:BETA:2025-01-05"]
        result = self.run_case()
        self.assertEqual(rows(result, "evaluation")[0]["outcome"], "blocked")
        self.assertFalse(rows(result, "research_order"))
        self.assertEqual(len(rows(result, "evaluation")), 1)
        self.assertEqual(result["ending_nav_cny"], "1200")

    def test_missing_held_price_aborts_instead_of_fabricating_nav(self):
        flat(self.data)
        self.data["observations"] = [row for row in self.data["observations"] if row["id"] != "CN:ALPHA:2025-01-08"]
        with self.assertRaisesRegex(WorkbenchError, "MISSING_REQUIRED_RESEARCH_SESSION"):
            self.run_case(fixed({"CN:ALPHA": "1"}))

    def test_month_expiry_is_processed_even_without_a_decision_and_equal_close_does_not_fill(self):
        flat(self.data)
        self.plan["decision_times"] = ["2025-01-31T07:01:00Z"]
        self.plan["windows"]["train"]["start"] = "2025-01-31T00:00:00Z"
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertEqual(rows(result, "evaluation")[0]["outcome"], "blocked")
        self.assertFalse(rows(result, "simulated_buy"))
        self.assertTrue(any(row["at"].startswith("2025-02-01T00:00:") for row in result["curve"]))

    def test_expiry_beats_same_instant_sale_settlement_and_leaves_no_new_order(self):
        switching(self.data)
        self.plan["windows"]["train"]["end"] = "2025-02-03T09:00:00Z"
        result = self.run_case()
        expired = rows(result, "order_expired")
        self.assertEqual(len(expired), 1)
        self.assertEqual(expired[0]["at"], rows(result, "sale_cash_settlement")[0]["at"])
        self.assertEqual(len(rows(result, "simulated_buy")), 1)
        self.assertEqual(result["ending_cash"]["CNY"], "1080")

    def test_local_month_not_utc_month_determines_slot_and_expiry(self):
        flat(self.data)
        self.plan["evaluation_timezone"] = "Asia/Shanghai"
        self.plan["decision_times"] = ["2025-01-31T15:00:00Z", "2025-01-31T16:00:00Z", "2025-02-01T07:01:00Z"]
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        evaluations = rows(result, "evaluation")
        self.assertEqual([row["period"] for row in evaluations], ["2025-01", "2025-02"])
        self.assertEqual(evaluations[0]["expires_at"], "2025-01-31T16:00:00.000000Z")
        self.assertEqual(len(rows(result, "monthly_monitor")), 1)

    def test_split_adjusts_owned_and_unsettled_shares_before_dividend(self):
        self.short()
        flat(self.data)
        for settlement in self.data["settlements"]:
            if settlement["session_date"] == "2025-01-06":
                settlement["settled_at"] = "2025-01-10T09:00:00Z"
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-07":
                row["value"] = "4.9"
        common = {"listing_id": "CN:ALPHA", "at": "2025-01-07T07:00:00Z", "published_at": "2025-01-04T00:00:00Z",
                  "ingested_at": "2025-01-04T00:00:00Z", "source_evidence": "Synthetic actions"}
        self.data["actions"] = [{**common, "id": "a-dividend", "type": "dividend", "gross_per_unit": "0.1", "tax_per_unit": "0.01",
                                 "pay_at": "2025-01-09T08:00:00Z"},
                                {**common, "id": "z-split", "type": "split", "ratio": "2"}]
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertEqual(result["positions"]["CN:ALPHA"], "240")
        self.assertEqual(rows(result, "stock_settlement")[0]["quantity"], "240")
        self.assertEqual(rows(result, "dividend_entitlement")[0]["gross"], "24")
        self.assertEqual(result["ending_nav_cny"], "1197.6")
        self.assertEqual(result["profit_cny"], "-2.4")
        same_time = [row["type"] for row in result["events"] if row.get("at") == "2025-01-07T07:00:00.000000Z"]
        self.assertEqual(same_time[:2], ["split", "dividend_entitlement"])

    def test_split_transforms_fixed_pending_quantity_without_repricing_budget(self):
        self.short()
        flat(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-06":
                row["value"] = "5"
        self.data["actions"] = [{"id": "split-pending", "type": "split", "listing_id": "CN:ALPHA", "ratio": "2",
                                 "at": "2025-01-06T07:00:00Z", "published_at": "2025-01-04T00:00:00Z",
                                 "ingested_at": "2025-01-04T00:00:00Z", "source_evidence": "Synthetic split"}]
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertEqual(rows(result, "research_order")[0]["quantity"], "120")
        self.assertEqual(rows(result, "research_order")[0]["budget_cny"], "1200")
        self.assertEqual(rows(result, "simulated_buy")[0]["quantity"], "240")
        self.assertEqual(result["profit_cny"], "0")

    def test_explicit_fees_fx_and_retained_foreign_dividend_reconcile_to_nav(self):
        self.short()
        flat(self.data)
        self.data["assets"][0]["currency"] = "USD"
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA":
                row["unit"] = "USD"
        template = deepcopy(self.data["observations"][0])
        template.pop("listing_id")
        for suffix, at, rate in (("a", "2025-01-01T00:00:00Z", "2"), ("b", "2025-01-09T00:00:00Z", "3")):
            self.data["observations"].append({**template, "id": "fx:" + suffix, "series_key": "FX:USD", "metric": "fx_cny_per_unit",
                                             "price_basis": "not_applicable", "unit": "CNY_per_unit_currency", "value": rate,
                                             "observed_at": at, "published_at": at, "ingested_at": at})
        self.plan["execution"].update(minimum_fee_cny="2", fx_bps="100", slippage_bps="100")
        self.data["actions"] = [{"id": "foreign-div", "type": "dividend", "listing_id": "CN:ALPHA", "gross_per_unit": "1", "tax_per_unit": "0.2",
                                 "at": "2025-01-08T07:00:00Z", "pay_at": "2025-01-10T08:00:00Z", "published_at": "2025-01-04T00:00:00Z",
                                 "ingested_at": "2025-01-04T00:00:00Z", "source_evidence": "Synthetic foreign dividend"}]
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        buy = rows(result, "simulated_buy")[0]
        quantity = Decimal(buy["quantity"])
        self.assertEqual(result["fees_cny"], "2")
        self.assertEqual(Decimal(result["fx_fees_cny"]), quantity * Decimal("10.1") * 2 / 100)
        self.assertEqual(Decimal(result["ending_cash"]["USD"]), quantity * Decimal("0.8"))
        expected = Decimal(result["ending_cash"]["CNY"]) + quantity * Decimal("10.8") * 3
        self.assertEqual(Decimal(result["ending_nav_cny"]), expected)

    def test_fixed_benchmark_has_bidirectional_rebalance_not_buy_only(self):
        flat(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-30":
                row["value"] = "20"
        result = self.run_case(fixed())
        feb = rows(result, "evaluation")[1]
        self.assertEqual([row["difference_cny"] for row in feb["deltas"]], ["-300", "300"])
        self.assertEqual(rows(result, "simulated_sell")[0]["quantity"], "15")
        self.assertEqual(result["positions"], {"CN:ALPHA": "45", "CN:BETA": "90"})
        self.assertEqual(result["ending_nav_cny"], "1800")

    def test_missing_fx_does_not_turn_foreign_equity_into_zero(self):
        flat(self.data)
        self.data["assets"][0]["currency"] = "USD"
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA":
                row["unit"] = "USD"
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertEqual(rows(result, "evaluation")[0]["outcome"], "blocked")
        self.assertIn("RESEARCH_FX_UNAVAILABLE:USD", rows(result, "evaluation")[0]["reason_codes"])
        self.assertFalse(rows(result, "simulated_buy"))

    def test_preclose_split_and_dividend_carry_do_not_create_fake_peak_or_drawdown(self):
        self.short()
        flat(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-07":
                row["value"] = "4.9"
        common = {"listing_id": "CN:ALPHA", "at": "2025-01-07T01:00:00Z", "published_at": "2025-01-04T00:00:00Z",
                  "ingested_at": "2025-01-04T00:00:00Z", "source_evidence": "Synthetic pre-close action"}
        self.data["actions"] = [{**common, "id": "a-div", "type": "dividend", "gross_per_unit": "0.1", "tax_per_unit": "0.01",
                                 "pay_at": "2025-01-09T08:00:00Z"},
                                {**common, "id": "z-split", "type": "split", "ratio": "2"}]
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        carry = next(row for row in result["curve"] if row["at"] == "2025-01-07T01:00:00.000000Z")
        self.assertEqual(carry["nav_cny"], "1197.6")
        self.assertEqual(carry["derived_carry_marks"], [{"listing_id": "CN:ALPHA", "price_observation_id": "CN:ALPHA:2025-01-06",
                         "quote_observed_at": "2025-01-06T07:00:00.000000Z", "mark_kind": "theoretical_ex_action_carry",
                         "raw_price": "10", "mark_price": "4.9", "action_ids": ["z-split", "a-div"]}])
        after_close = next(row for row in result["curve"] if row["at"] == "2025-01-07T07:00:00.000000Z")
        self.assertEqual(after_close["derived_carry_marks"], [])
        self.assertEqual(after_close["nav_cny"], carry["nav_cny"])
        self.assertEqual(result["max_drawdown"], "-0.002")
        self.assertEqual(result["profit_cny"], "-2.4")

    def test_preclose_decision_uses_carry_price_for_quantity_but_fill_uses_real_quote(self):
        self.short()
        flat(self.data)
        self.plan["decision_times"] = ["2025-01-05T01:00:00Z"]
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-05":
                row["value"] = "4.9"
        common = {"listing_id": "CN:ALPHA", "at": "2025-01-05T00:30:00Z", "published_at": "2025-01-04T00:00:00Z",
                  "ingested_at": "2025-01-04T00:00:00Z", "source_evidence": "Synthetic carry price"}
        self.data["actions"] = [{**common, "id": "div", "type": "dividend", "gross_per_unit": "0.1", "tax_per_unit": "0",
                                 "pay_at": "2025-01-07T08:00:00Z"}, {**common, "id": "split", "type": "split", "ratio": "2"}]
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        order = rows(result, "research_order")[0]
        self.assertEqual(order["decision_price_mark"]["mark_price"], "4.9")
        self.assertEqual(order["decision_price_mark"]["raw_price"], "10")
        self.assertEqual(order["quantity"], "244")
        self.assertEqual(rows(result, "simulated_buy")[0]["quantity"], "244")
        self.assertEqual(rows(result, "simulated_buy")[0]["execution_price"], "4.9")
        self.assertEqual(rows(result, "dividend_entitlement")[0]["gross"], "0")
        self.assertEqual(result["profit_cny"], "0")

    def test_nonpositive_ex_action_carry_blocks_rather_than_zero_or_negative_mark(self):
        self.short()
        flat(self.data)
        self.data["actions"] = [{"id": "invalid-carry", "type": "dividend", "listing_id": "CN:ALPHA", "gross_per_unit": "10",
                                 "tax_per_unit": "0", "at": "2025-01-07T01:00:00Z", "pay_at": "2025-01-07T08:00:00Z",
                                 "published_at": "2025-01-04T00:00:00Z", "ingested_at": "2025-01-04T00:00:00Z",
                                 "source_evidence": "Synthetic invalid carry example"}]
        with self.assertRaisesRegex(WorkbenchError, "NONPOSITIVE_EX_ACTION_CARRY_MARK"):
            self.run_case(fixed({"CN:ALPHA": "1"}))

    def test_sale_fx_frozen_at_fill_not_revalued_while_cny_receivable_waits(self):
        switching(self.data)
        self.data["assets"][0]["currency"] = "USD"
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA":
                row["unit"] = "USD"
        template = deepcopy(self.data["observations"][0])
        template.pop("listing_id")
        for suffix, at, rate in (("a", "2025-01-04T00:00:00Z", "2"), ("b", "2025-02-02T12:00:00Z", "3")):
            self.data["observations"].append({**template, "id": "fx:" + suffix, "series_key": "FX:USD", "metric": "fx_cny_per_unit",
                                             "price_basis": "not_applicable", "unit": "CNY_per_unit_currency", "value": rate,
                                             "observed_at": at, "published_at": at, "ingested_at": at})
        result = self.run_case()
        sell = rows(result, "simulated_sell")[0]
        self.assertEqual(sell["quantity"], "60")
        self.assertEqual(sell["fx_cny_per_unit"], "2")
        self.assertEqual(rows(result, "sale_cash_settlement")[0]["amount_cny"], "1080")
        self.assertEqual(result["ending_nav_cny"], "1080")
        self.assertEqual(result["profit_cny"], "-120")

    def test_direct_trade_guard_delisting_does_not_create_fictitious_exit(self):
        switching(self.data)
        self.data["assets"][0]["tradable_until"] = "2025-02-02T00:00:00Z"
        result = self.run_case()
        feb = rows(result, "evaluation")[1]
        self.assertEqual(feb["outcome"], "blocked")
        self.assertTrue(any("ASSET_NOT_HISTORICALLY_TRADABLE" in code for code in feb["reason_codes"]))
        self.assertFalse(rows(result, "simulated_sell"))
        self.assertEqual(result["positions"]["CN:ALPHA"], "120")

    def test_public_compare_valid_delisting_data_blocks_nav_without_verifiable_exit(self):
        switching(self.data)
        self.data["assets"][0]["tradable_until"] = "2025-02-02T00:00:00Z"
        self.data["observations"] = [row for row in self.data["observations"]
                                     if row["listing_id"] != "CN:ALPHA" or row["observed_at"] < "2025-02-02"]
        with self.assertRaisesRegex(WorkbenchError, "MISSING_REQUIRED_RESEARCH_SESSION"):
            compare_backtest(self.data, self.plan, parameters(), "train")

    def test_public_compare_new_ipo_insufficient_history_is_explicitly_ineligible(self):
        self.short()
        flat(self.data)
        self.data["assets"][1]["tradable_from"] = "2025-01-05T07:00:00Z"
        self.data["observations"] = [row for row in self.data["observations"]
                                     if row["listing_id"] != "CN:BETA" or row["observed_at"] >= "2025-01-05"]
        result = compare_backtest(self.data, self.plan, parameters(), "train")["strategy"]
        signal = next(row for row in rows(result, "evaluation")[0]["signals"] if row["listing_id"] == "CN:BETA")
        self.assertEqual(signal["status"], "ineligible")
        self.assertEqual(signal["available_points"], 1)
        self.assertEqual(signal["target_weight"], "0")
        self.assertTrue(any("HISTORY" in code for code in signal["reason_codes"]))
        self.assertFalse(rows(result, "simulated_buy"))

    def test_all_cash_target_liquidates_old_holding_without_counting_sale_as_external_flow(self):
        switching(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:BETA":
                row["value"] = "10"
        result = self.run_case()
        self.assertEqual(rows(result, "evaluation")[1]["targets"], {"CN:ALPHA": "0", "CN:BETA": "0"})
        self.assertEqual(len(rows(result, "simulated_sell")), 1)
        self.assertEqual(result["ending_cash"]["CNY"], "1080")
        self.assertEqual(result["contributions_cny"], "0")
        self.assertEqual(result["twr"], "-0.1")

    def test_reverse_split_cannot_turn_fixed_pending_buy_into_fractional_fill(self):
        self.short()
        flat(self.data)
        self.plan["initial_capital_cny"] = "1210"
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-06":
                row["value"] = "20"
        self.data["actions"] = [{"id": "reverse-split", "type": "split", "listing_id": "CN:ALPHA", "ratio": "0.5",
                                 "at": "2025-01-06T07:00:00Z", "published_at": "2025-01-04T00:00:00Z",
                                 "ingested_at": "2025-01-04T00:00:00Z", "source_evidence": "Synthetic reverse split"}]
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertEqual(rows(result, "research_order")[0]["quantity"], "121")
        self.assertFalse(rows(result, "simulated_buy"))
        self.assertEqual(rows(result, "execution_skipped")[0]["quantity"], "60.5")
        self.assertEqual(rows(result, "execution_skipped")[0]["reason"], "FIXED_QUANTITY_NOT_EXECUTABLE_AFTER_ACTION")
        self.assertEqual(result["ending_cash"]["CNY"], "1210")
        self.assertEqual(result["profit_cny"], "0")

    def test_owned_reverse_split_fraction_retains_nav_and_reports_unsellable_dust(self):
        switching(self.data)
        self.plan["initial_capital_cny"] = "1210"
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-07":
                row["value"] = "20"
            elif row["listing_id"] == "CN:BETA":
                row["value"] = "10"
        self.data["actions"] = [{"id": "reverse-held", "type": "split", "listing_id": "CN:ALPHA", "ratio": "0.5",
                                 "at": "2025-01-07T07:00:00Z", "published_at": "2025-01-04T00:00:00Z",
                                 "ingested_at": "2025-01-04T00:00:00Z", "source_evidence": "Synthetic reverse split"}]
        result = self.run_case()
        self.assertEqual(rows(result, "simulated_sell")[0]["quantity"], "60")
        self.assertEqual(result["positions"]["CN:ALPHA"], "0.5")
        self.assertEqual(result["ending_cash"]["CNY"], "1200")
        self.assertEqual(result["ending_nav_cny"], "1210")
        self.assertIn("SELL_QUANTITY_STEP_RESIDUAL:CN:ALPHA", rows(result, "evaluation")[1]["reason_codes"])
        self.assertTrue(rows(result, "evaluation")[1]["partial"])

    def test_actual_replay_requires_settlement_ingested_at_fill_without_fallback(self):
        self.short()
        flat(self.data)
        self.data["mode"] = "actual_replay"
        for row in self.data["observations"]:
            row["provenance"] = "live_observed"
        for row in self.data["settlements"]:
            row["ingested_at"] = "2025-01-01T00:00:00Z"
        self.data["settlements"][5]["ingested_at"] = "2025-01-07T00:00:00Z"
        result = self.run_case(fixed({"CN:ALPHA": "1"}))
        self.assertFalse(rows(result, "simulated_buy"))
        self.assertEqual(rows(result, "execution_skipped")[0]["reason"], "SETTLEMENT_EVIDENCE_UNAVAILABLE")
        self.assertEqual(result["profit_cny"], "0")

    def test_monthly_counts_exactly_match_recorded_slots_and_exclude_monitors(self):
        result = self.run_case()
        self.assertEqual(result["monthly_evaluation_counts"], {
            outcome: sum(row["outcome"] == outcome for row in rows(result, "evaluation"))
            for outcome in ("proposed", "unchanged", "blocked")})
        self.assertEqual(sum(result["monthly_evaluation_counts"].values()), 2)
        self.assertGreater(len(rows(result, "monthly_monitor")), 2)

    def test_cash_rounding_is_signed_cost_and_reconciles_execution_profit(self):
        self.short()
        flat(self.data, "10.003")
        candidate = fixed({"CN:ALPHA": "1"})
        self.plan["initial_capital_cny"] = "100"
        result = self.run_case(candidate)
        buy = rows(result, "simulated_buy")[0]
        self.assertEqual(buy["quantity"], "9")
        self.assertEqual(buy["total_cash_cny"], "90.03")
        self.assertEqual(buy["cash_rounding_cny"], "0.003")
        self.assertEqual(result["cash_rounding_cny"], "0.003")
        self.assertEqual(Decimal(result["profit_cny"]), -Decimal(result["cash_rounding_cny"]))
        flat(self.data, "10.002")
        result = self.run_case(candidate)
        self.assertEqual(result["cash_rounding_cny"], "0.002")
        flat(self.data, "10.001")
        result = self.run_case(candidate)
        self.assertEqual(result["cash_rounding_cny"], "0.001")
        flat(self.data, "10.0004")
        result = self.run_case(candidate)
        self.assertEqual(result["cash_rounding_cny"], "-0.0036")
        self.assertEqual(result["profit_cny"], "0.0036")

    def test_cross_market_buy_waits_own_next_close_after_other_market_sale_settles(self):
        switching(self.data)
        self.data["assets"][1]["market"] = "US"
        self.data["assets"][1]["currency"] = "USD"
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:BETA":
                at = instant(row["observed_at"]) + timedelta(hours=14)
                row.update(unit="USD", observed_at=stamp(at), published_at=stamp(at + timedelta(minutes=1)),
                           ingested_at=stamp(at + timedelta(minutes=1)))
                if at >= instant("2025-01-31T00:00:00Z"):
                    row["value"] = "11"
        for original in list(self.data["sessions"]):
            at = instant(original["close_at"]) + timedelta(hours=14)
            self.data["sessions"].append({**original, "market": "US", "close_at": stamp(at), "available_at": stamp(at + timedelta(minutes=1))})
        for original in list(self.data["settlements"]):
            self.data["settlements"].append({**original, "market": "US", "settled_at": stamp(instant(original["settled_at"]) + timedelta(hours=14))})
        template = deepcopy(self.data["observations"][0])
        template.pop("listing_id")
        for suffix, at in (("a", "2025-01-04T00:00:00Z"), ("b", "2025-02-01T00:00:00Z")):
            self.data["observations"].append({**template, "id": "fx:cross:" + suffix, "series_key": "FX:USD", "metric": "fx_cny_per_unit",
                                             "price_basis": "not_applicable", "unit": "CNY_per_unit_currency", "value": "1",
                                             "observed_at": at, "published_at": at, "ingested_at": at})
        self.plan["parameter_candidates"] = [parameters()]
        report = compare_backtest(self.data, self.plan, parameters(), "train")
        result = report["strategy"]
        sell = rows(result, "simulated_sell")[0]
        buy = rows(result, "simulated_buy")[1]
        self.assertEqual(sell["settled_at"], "2025-02-03T09:00:00.000000Z")
        self.assertEqual(buy["at"], "2025-02-03T21:00:00.000000Z")
        feb = rows(result, "evaluation")[1]
        signal = next(row for row in feb["signals"] if row["listing_id"] == "CN:BETA")
        self.assertNotIn("CN:BETA:2025-02-01", signal["window"]["observation_ids"])
        self.assertEqual(result["profit_cny"], "-120")

    def test_multiple_buy_budgets_do_not_reuse_reserved_cash_when_one_fill_skips(self):
        self.short()
        flat(self.data)
        for row in self.data["observations"]:
            if row["listing_id"] == "CN:ALPHA" and row["observed_at"] >= "2025-01-06":
                row["value"] = "20"
        result = self.run_case(fixed())
        self.assertEqual([row["budget_cny"] for row in rows(result, "research_order")], ["600", "600"])
        self.assertEqual(len(rows(result, "execution_skipped")), 1)
        self.assertEqual(rows(result, "simulated_buy")[0]["quantity"], "60")
        self.assertEqual(result["ending_cash"]["CNY"], "600")
        self.assertEqual(result["ending_nav_cny"], "1200")

    def test_sell_and_buy_fees_slippage_fx_rounding_are_all_actual_nav_costs(self):
        switching(self.data)
        self.plan["execution"].update(minimum_fee_cny="2", commission_bps="10", slippage_bps="10", fx_bps="20")
        result = self.run_case()
        trades = rows(result, "simulated_buy") + rows(result, "simulated_sell")
        self.assertEqual(len(trades), 3)
        self.assertEqual(Decimal(result["fees_cny"]), sum((Decimal(row["fee_cny"]) for row in trades), Decimal(0)))
        self.assertEqual(Decimal(result["cash_rounding_cny"]), sum((Decimal(row["cash_rounding_cny"]) for row in trades), Decimal(0)))
        first_quantity = Decimal(rows(result, "simulated_buy")[0]["quantity"])
        price_loss = -first_quantity
        explained = price_loss - Decimal(result["fees_cny"]) - Decimal(result["fx_fees_cny"]) - Decimal(result["slippage_cny"]) - Decimal(result["cash_rounding_cny"])
        self.assertEqual(Decimal(result["profit_cny"]), explained)


if __name__ == "__main__":
    unittest.main()
