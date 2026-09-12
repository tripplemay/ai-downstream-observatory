import unittest
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, getcontext, localcontext
from random import Random

from worker.accounting import (
    AccountingError, CurrencyBalance, DataTimes, DatedCashflow, NavPoint,
    Position, PriceRequirement, ReturnResult, TimedFlow, ValuedFlow, ValuedPosition,
    amount_attribution, annualized_unit_return, available_cash, buy, canonical, cashflow_profit,
    chain_returns, decimal, drawdown, eligible_at, exact_twr, fact_decimal,
    fx_return_decomposition, modified_dietz, nav_cny, pay_dividend, quantize_cash,
    sell, settle_buy, settle_sell, split, unrealized, valuation_quality, xirr, xnpv,
)


D = Decimal
START = datetime(2025, 1, 1, tzinfo=timezone.utc)


def cny_nav(balance, quantity="0", price="10"):
    return nav_cny({"CNY": balance}, [ValuedPosition("CN:TEST", "CNY", quantity, price)], {})


class DecimalBoundaryTests(unittest.TestCase):
    def test_canonical_exact_facts(self):
        value = "12345678901234567890.123456789012345678"
        self.assertEqual(canonical(fact_decimal(value)), value)
        self.assertEqual(canonical(fact_decimal("0.000000000000000001")), "0.000000000000000001")
        self.assertEqual(canonical("-0.000"), "0")
        self.assertEqual(canonical("10.1000"), "10.1")

    def test_reject_float_and_unparsed_formats(self):
        for value in (0.1, True, "1e3", "NaN", "Infinity", "1,000", "(1)", " 1", "+1", "01"):
            with self.subTest(value=value), self.assertRaises(AccountingError):
                fact_decimal(value)
        for value in ("1" * 39, "0.0000000000000000001", Decimal("Infinity")):
            with self.subTest(value=value), self.assertRaises(AccountingError):
                fact_decimal(value)

    def test_half_even_arbitrary_cash_quantum(self):
        self.assertEqual(quantize_cash("1.005"), D("1.00"))
        self.assertEqual(quantize_cash("1.015"), D("1.02"))
        self.assertEqual(quantize_cash("1.125", "0.05"), D("1.10"))
        self.assertEqual(quantize_cash("-1.125", "0.05"), D("-1.10"))

    def test_financial_context_is_local_and_at_least_fifty_digits(self):
        with localcontext() as context:
            context.prec = 8
            result = Position("3", "1").unit_cost
            self.assertGreaterEqual(len(str(result)), 60)
            self.assertEqual(getcontext().prec, 8)


class LedgerGoldenTests(unittest.TestCase):
    def test_F02_funding_is_not_profit(self):
        self.assertEqual(cny_nav(CurrencyBalance("80000")).nav_cny, D("80000"))
        self.assertEqual(cashflow_profit("80000", "64000", ["16000"]), D("0"))

    def test_F03_buy_trade_date_and_settlement(self):
        trade = buy(Position(), "1000", "10000", "10")
        balance = CurrencyBalance("100000", trade_payables=trade.payable)
        self.assertEqual(trade.position, Position("1000", "10000"))
        self.assertEqual(trade.payable, D("10010"))
        self.assertEqual(cny_nav(balance, trade.position.quantity).nav_cny, D("99990"))
        settled = settle_buy(balance, trade.payable)
        self.assertEqual(settled.settled_cash, D("89990"))
        self.assertEqual(settled.trade_payables, D("0"))
        self.assertEqual(cny_nav(settled, trade.position.quantity).nav_cny, D("99990"))

    def test_F04_partial_sell_gross_cost_and_fees(self):
        trade = sell(Position("1000", "10000"), "400", "4800", "4")
        balance = CurrencyBalance("89990", trade_receivables=trade.receivable)
        self.assertEqual(cny_nav(balance, "600", "12").nav_cny, D("101986"))
        settled = settle_sell(balance, trade.receivable)
        self.assertEqual(settled.settled_cash, D("94786"))
        self.assertEqual(trade.position, Position("600", "6000"))
        self.assertEqual(trade.gross_realized, D("800"))
        self.assertEqual(unrealized(trade.position, "12"), D("1200"))
        self.assertEqual(trade.gross_realized + unrealized(trade.position, "12") - D("14"), D("1986"))
        self.assertEqual(cny_nav(settled, "600", "12").nav_cny, D("101986"))

    def test_F05_dividend_receivable_and_payment_no_double_income(self):
        balance = CurrencyBalance(dividend_receivables="180")
        self.assertEqual(cny_nav(balance, "1000", "9.8").nav_cny, D("9980"))
        paid = pay_dividend(balance, "180")
        self.assertEqual(paid.dividend_receivables, D("0"))
        self.assertEqual(paid.settled_cash, D("180"))
        self.assertEqual(cny_nav(paid, "1000", "9.8").nav_cny, D("9980"))

    def test_F06_internal_transfer_not_an_external_flow(self):
        transit = CurrencyBalance("69990", owned_transfers_in_transit="30000")
        received = CurrencyBalance("99990")
        self.assertEqual(cny_nav(transit).nav_cny, D("99990"))
        self.assertEqual(cny_nav(received).nav_cny, D("99990"))
        self.assertEqual(cashflow_profit("99990", "100000", []), D("-10"))
        self.assertEqual(available_cash(transit), D("69990"))

    def test_F07_fx_original_facts_reference_valuation(self):
        value = nav_cny({"CNY": CurrencyBalance("0"), "USD": CurrencyBalance("1000")}, [], {"USD": "7"})
        self.assertEqual(value.nav_cny, D("7000"))
        self.assertEqual(cashflow_profit(value.nav_cny, "7007", []), D("-7"))

    def test_F13_split_preserves_cost_and_value(self):
        position = split(Position("100", "2000"), "2")
        self.assertEqual(position.quantity, D("200"))
        self.assertEqual(position.unit_cost, D("10"))
        self.assertEqual(position.total_cost, D("2000"))
        self.assertEqual(cny_nav(CurrencyBalance(), position.quantity).nav_cny, D("2000"))

    def test_F14_fx_cross_term(self):
        result = fx_return_decomposition("0.1", "0.02")
        self.assertEqual(result["cny_return"], D("0.122"))
        self.assertEqual(result["cross_return"], D("0.002"))

    def test_amount_attribution_reconciles_without_fabricated_adjustment(self):
        result = amount_attribution("101986", "100000", [],
                                    {"local_asset_price": "2000", "explicit_fees_taxes": "-14"})
        self.assertEqual(result["unexplained_cny"], D("0"))
        self.assertTrue(result["fully_explained"])
        result = amount_attribution("101986", "100000", [], {"local_asset_price": "2000"})
        self.assertEqual(result["unexplained_cny"], D("-14"))
        self.assertFalse(result["fully_explained"])

    def test_unknown_opening_cost_never_inferred(self):
        position = Position("100", None)
        self.assertIsNone(buy(position, "10", "120").position.total_cost)
        self.assertIsNone(sell(position, "10", "120").gross_realized)
        self.assertIsNone(unrealized(position, "12"))
        self.assertEqual(sell(position, "100", "1200").position.total_cost, D("0"))

    def test_moving_average_fees_expensed_not_capitalized(self):
        position = buy(Position("100", "1000"), "50", "1000", "10").position
        self.assertEqual(position.total_cost, D("2000"))
        self.assertEqual(sell(position, "75", "1100").position.total_cost, D("1000"))

    def test_reservations_do_not_reduce_nav(self):
        balance = CurrencyBalance("100000", trade_receivables="10000", trade_payables="10010")
        self.assertEqual(available_cash(balance, "100", "2000"), D("87890"))
        self.assertEqual(cny_nav(balance).nav_cny, D("99990"))

    def test_fact_recording_does_not_hide_negative_cash(self):
        balance = CurrencyBalance("5", trade_payables="10")
        self.assertEqual(settle_buy(balance, "10").settled_cash, D("-5"))
        self.assertEqual(available_cash(balance), D("-5"))

    def test_invalid_settlements_positions_and_prices_rejected(self):
        invalid_calls = [lambda: sell(Position("1", "1"), "2", "2"),
                         lambda: sell(Position("1", "1"), "1", "1", "2"),
                         lambda: split(Position("1", "1"), "0"),
                         lambda: settle_buy(CurrencyBalance(), "1"),
                         lambda: settle_sell(CurrencyBalance(), "1"),
                         lambda: pay_dividend(CurrencyBalance(), "1"),
                         lambda: Position("0", "1"),
                         lambda: ValuedPosition("id", "CNY", "1", "1", "qfq")]
        for call in invalid_calls:
            with self.assertRaises(AccountingError):
                call()

    def test_F16_missing_values_are_not_zero(self):
        missing_price = nav_cny({"CNY": CurrencyBalance("100")},
                                [ValuedPosition("test", "CNY", "10", None)], {})
        self.assertIsNone(missing_price.nav_cny)
        self.assertEqual(missing_price.quality, "blocked")
        self.assertEqual(missing_price.known_partial_cny, D("100"))
        missing_fx = nav_cny({"USD": CurrencyBalance("100")}, [], {})
        self.assertIsNone(missing_fx.nav_cny)
        self.assertIn("missing_fx:USD", missing_fx.issues)

    def test_provisional_input_not_a_complete_nav(self):
        result = nav_cny({"CNY": CurrencyBalance("100")}, [], {}, quality="provisional")
        self.assertIsNone(result.nav_cny)
        self.assertEqual(result.known_partial_cny, D("100"))
        with self.assertRaises(AccountingError):
            nav_cny({"CNY": CurrencyBalance("100")}, [], {"CNY": "7"})

    def test_duplicate_valuation_positions_rejected(self):
        position = ValuedPosition("id", "CNY", "1", "1")
        with self.assertRaises(AccountingError):
            nav_cny({}, [position, position], {})

    def test_fixed_seed_roundtrip_property(self):
        rng = Random(41013)
        for _ in range(100):
            quantity, price = D(rng.randint(1, 10000)), D(rng.randint(1, 10000)) / 100
            principal = quantity * price
            bought = buy(Position(), quantity, principal)
            balance = settle_buy(CurrencyBalance("1000000", trade_payables=bought.payable), bought.payable)
            self.assertEqual(cny_nav(balance, quantity, price).nav_cny, D("1000000"))
            sold = sell(bought.position, quantity, principal)
            balance = settle_sell(replace(balance, trade_receivables=sold.receivable), sold.receivable)
            self.assertEqual(balance.settled_cash, D("1000000"))
            self.assertEqual(sold.gross_realized, D("0"))


class PerformanceTests(unittest.TestCase):
    def test_F08_exact_twr_and_midpoint_dietz(self):
        end, middle = START + timedelta(days=10), START + timedelta(days=5)
        precise = exact_twr(START, end, "100", "176", [ValuedFlow(middle, "50", "110")])
        estimated = modified_dietz(START, end, "100", "176", [TimedFlow(middle, "50")])
        self.assertEqual(precise.value, D("0.21"))
        self.assertEqual(precise.method, "exact_twr")
        self.assertEqual(estimated.value, D("0.208"))
        self.assertEqual(estimated.method, "modified_dietz_estimate")
        self.assertEqual(cashflow_profit("176", "100", ["50"]), D("26"))

    def test_date_only_eod_label_and_weight(self):
        result = modified_dietz(START, START + timedelta(days=10), "100", "176",
                                [TimedFlow(date(2025, 1, 5), "50")], evaluation_timezone="UTC")
        self.assertEqual(result.value, D("0.208"))
        self.assertIn("date_only_eod_assumption", result.assumptions)
        with self.assertRaises(AccountingError):
            modified_dietz(START, START + timedelta(days=10), "100", "176",
                           [TimedFlow(date(2025, 1, 5), "50")])

    def test_bad_period_unsorted_naive_and_outside_flow(self):
        with self.assertRaises(AccountingError):
            exact_twr(START, START, "100", "100")
        with self.assertRaises(AccountingError):
            exact_twr(START.replace(tzinfo=None), START, "100", "100")
        with self.assertRaises(AccountingError):
            exact_twr(START, START + timedelta(days=2), "100", "100", [ValuedFlow(START, "1", "100")])
        with self.assertRaises(AccountingError):
            modified_dietz(START, START + timedelta(days=2), "100", "100",
                           [TimedFlow(START + timedelta(days=3), "1")])

    def test_zero_asset_reset_and_invalid_denominator(self):
        end = START + timedelta(days=2)
        result = exact_twr(START, end, "100", "0", [ValuedFlow(START + timedelta(days=1), "-100", "100")])
        self.assertIsNone(result.value)
        self.assertEqual(result.status, "requires_new_return_interval")
        result = modified_dietz(START, end, "100", "0", [TimedFlow(START, "-100")])
        self.assertIsNone(result.value)
        self.assertEqual(result.status, "nonpositive_denominator")

    def test_estimate_taints_linked_chain(self):
        result = chain_returns([ReturnResult(D("0.1"), "exact_twr"),
                                ReturnResult(D("0.1"), "modified_dietz_estimate")])
        self.assertEqual(result.value, D("0.21"))
        self.assertEqual(result.method, "linked_return_estimate")
        self.assertIsNone(chain_returns([ReturnResult(None, "exact_twr", "missing")]).value)

    def test_simultaneous_flows_require_aggregation_and_closing_consistency(self):
        middle, end = START + timedelta(days=1), START + timedelta(days=2)
        with self.assertRaises(AccountingError):
            exact_twr(START, end, "100", "130",
                      [ValuedFlow(middle, "10", "100"), ValuedFlow(middle, "20", "110")])
        with self.assertRaises(AccountingError):
            exact_twr(START, end, "100", "130", [ValuedFlow(end, "10", "100")])
        self.assertEqual(exact_twr(START, end, "100", "110", [ValuedFlow(end, "10", "100")]).value, D("0"))

    def test_unit_nav_zero_cannot_bridge_new_money_interval(self):
        result = chain_returns([ReturnResult(D("-1"), "exact_twr"), ReturnResult(D("0.1"), "exact_twr")])
        self.assertIsNone(result.value)
        self.assertEqual(result.status, "requires_new_return_interval")

    def test_quality_blocks_performance(self):
        for function in (exact_twr, modified_dietz):
            result = function(START, START + timedelta(days=1), "100", "110", quality="provisional")
            self.assertIsNone(result.value)
            self.assertEqual(result.status, "incomplete_valuation")

    def test_F11_drawdown_unrecovered(self):
        points = [NavPoint(START + timedelta(days=i), value) for i, value in enumerate(("1", "1.2", "0.9", "1.08"))]
        result = drawdown(points)
        self.assertEqual(result.max_drawdown, D("-0.25"))
        self.assertEqual(result.peak_at, points[1].at)
        self.assertEqual(result.trough_at, points[2].at)
        self.assertIsNone(result.recovered_at)
        self.assertEqual(result.underwater_until, points[-1].at)

    def test_drawdown_recovery_gap_and_estimate_labels(self):
        values = ("1", "1.2", "0.9", "1.08", "1.2")
        points = [NavPoint(START + timedelta(days=i), value) for i, value in enumerate(values)]
        self.assertEqual(drawdown(points).recovered_at, points[-1].at)
        self.assertIsNone(drawdown(points).underwater_until)
        points[3] = replace(points[3], unit_nav=None)
        result = drawdown(points, estimated=True)
        self.assertIsNone(result.max_drawdown)
        self.assertIsNone(result.recovered_at)
        self.assertEqual(result.quality, "blocked")
        self.assertEqual(result.method, "unit_nav_estimate")

    def test_annualized_unit_return_actual_days(self):
        self.assertEqual(annualized_unit_return("1", "1.1", 365).value, D("0.1"))
        result = annualized_unit_return("1", "1.1", 30)
        self.assertIn("shorter_than_one_year", result.assumptions)
        with self.assertRaises(AccountingError):
            annualized_unit_return("1", "1.1", 0)


class XirrTests(unittest.TestCase):
    def test_F09_single_root_tolerance_and_actual365(self):
        flows = [DatedCashflow(date(2025, 1, 1), "-100000"), DatedCashflow(date(2026, 1, 1), "110000")]
        result = xirr(flows)
        self.assertEqual(result.status, "ok")
        self.assertLess(abs(result.rate - D("0.1")), D("1e-8"))
        self.assertLess(abs(result.residual), D("0.01"))
        self.assertEqual(result.duration_days, 365)

    def test_F10_multiple_roots_no_default_selection(self):
        flows = [DatedCashflow(date(2025, 1, 1), "-100"), DatedCashflow(date(2026, 1, 1), "230"),
                 DatedCashflow(date(2027, 1, 1), "-132")]
        result = xirr(flows)
        self.assertEqual(result.status, "ambiguous")
        self.assertEqual(result.reason, "multiple_roots")
        self.assertIsNone(result.rate)
        self.assertEqual(len(result.roots), 2)
        for actual, expected in zip(result.roots, (D("0.1"), D("0.2"))):
            self.assertLess(abs(actual - expected), D("1e-10"))
            self.assertLess(abs(xnpv(actual, flows)), D("0.000001"))

    def test_no_root_is_not_zero_return(self):
        flows = [DatedCashflow(date(2025, 1, 1), "-100"), DatedCashflow(date(2026, 1, 1), "100"),
                 DatedCashflow(date(2027, 1, 1), "-100")]
        result = xirr(flows)
        self.assertEqual(result.status, "no_root")
        self.assertIsNone(result.rate)

    def test_double_root_and_nearly_touching_pair_not_false_unique(self):
        flows = [DatedCashflow(date(2025, 1, 1), "-100"), DatedCashflow(date(2026, 1, 1), "220"),
                 DatedCashflow(date(2027, 1, 1), "-121")]
        result = xirr(flows)
        self.assertEqual(result.status, "ambiguous")
        self.assertIsNone(result.rate)
        self.assertTrue(result.roots)
        self.assertLess(abs(result.roots[0] - D("0.1")), D("1e-10"))

    def test_same_day_missing_signs_empty_all_zero_are_explicit(self):
        self.assertEqual(xirr([]).status, "no_data")
        same_day = xirr([DatedCashflow(date(2025, 1, 1), "-100"), DatedCashflow(date(2025, 1, 1), "100")])
        self.assertEqual(same_day.status, "same_day_flows")
        self.assertIsNone(same_day.rate)
        no_sign = xirr([DatedCashflow(date(2025, 1, 1), "100"), DatedCashflow(date(2026, 1, 1), "100")])
        self.assertEqual(no_sign.status, "missing_signs")
        all_zero = xirr([DatedCashflow(date(2025, 1, 1), "0"), DatedCashflow(date(2026, 1, 1), "0")])
        self.assertEqual(all_zero.status, "ambiguous")

    def test_sort_and_same_day_aggregate_no_input_mutation(self):
        flows = [DatedCashflow(date(2026, 1, 1), "110"), DatedCashflow(date(2025, 1, 1), "-60"),
                 DatedCashflow(date(2025, 1, 1), "-40")]
        result = xirr(flows)
        self.assertEqual(result.status, "ok")
        self.assertLess(abs(result.rate - D("0.1")), D("1e-10"))
        self.assertEqual(flows[0].amount, "110")

    def test_leap_year_uses_365_not366(self):
        result = xirr([DatedCashflow(date(2024, 1, 1), "-100"), DatedCashflow(date(2025, 1, 1), "110")])
        self.assertEqual(result.duration_days, 366)
        self.assertLess(result.rate, D("0.1"))

    def test_negative_root_and_legitimate_zero(self):
        for terminal, rate in (("90", "-0.1"), ("100", "0")):
            result = xirr([DatedCashflow(date(2025, 1, 1), "-100"), DatedCashflow(date(2026, 1, 1), terminal)])
            self.assertEqual(result.status, "ok")
            self.assertLess(abs(result.rate - D(rate)), D("1e-10"))

    def test_microsoft_irregular_dates_reference(self):
        flows = [DatedCashflow(date(2008, 1, 1), "-10000"), DatedCashflow(date(2008, 3, 1), "2750"),
                 DatedCashflow(date(2008, 10, 30), "4250"), DatedCashflow(date(2009, 2, 15), "3250"),
                 DatedCashflow(date(2009, 4, 1), "2750")]
        result = xirr(flows)
        self.assertEqual(result.status, "ok")
        self.assertLess(abs(result.rate - D("0.373362535")), D("1e-8"))

    def test_two_through_five_provable_roots_not_lost_between_samples(self):
        root_sets = (("1.1", "1.2"), ("0.5", "1.1", "2"),
                     ("0.8", "1.1", "1.4", "2"), ("0.2", "0.6", "1.1", "1.5", "2"))
        with localcontext() as context:
            context.prec = 60
            for roots in root_sets:
                coefficients = [D("1")]
                for root in roots:
                    expanded = [D("0")] * (len(coefficients) + 1)
                    for index, coefficient in enumerate(coefficients):
                        expanded[index] += coefficient
                        expanded[index + 1] -= D(root) * coefficient
                    coefficients = expanded
                flows = [DatedCashflow(date(2025, 1, 1) + timedelta(days=365 * index), coefficient)
                         for index, coefficient in enumerate(coefficients)]
                result = xirr(flows)
                self.assertEqual(result.status, "ambiguous")
                self.assertEqual(len(result.roots), len(roots))
                for actual, expected in zip(result.roots, roots):
                    self.assertLess(abs(actual - (D(expected) - 1)), D("1e-10"))

    def test_dates_need_explicit_evaluation_timezone_conversion(self):
        with self.assertRaises(AccountingError):
            xirr([DatedCashflow(START, "-100")])
        with self.assertRaises(AccountingError):
            xnpv("-1", [DatedCashflow(date(2025, 1, 1), "-100")])


class QualityTests(unittest.TestCase):
    def test_actual_replay_rejects_future_ingestion_and_revision(self):
        data = DataTimes(START, START, START + timedelta(days=3), True)
        result = eligible_at(data, START + timedelta(days=1))
        self.assertFalse(result.eligible)
        self.assertIn("ingested_after_decision", result.reasons)
        self.assertTrue(eligible_at(data, START + timedelta(days=1), "historical_point_in_time").eligible)
        revision = replace(data, published_at=START + timedelta(days=2))
        self.assertFalse(eligible_at(revision, START + timedelta(days=1), "historical_point_in_time").eligible)

    def test_historical_archive_must_be_verified(self):
        data = DataTimes(START, None, START + timedelta(days=3))
        result = eligible_at(data, START + timedelta(days=1), "historical_point_in_time")
        self.assertFalse(result.eligible)
        reconstructed = eligible_at(data, START + timedelta(days=1), "reconstructed")
        self.assertTrue(reconstructed.eligible)
        self.assertEqual(reconstructed.mode, "reconstructed")

    def test_F16_market_holiday_is_not_missing_quote(self):
        china_close = START + timedelta(hours=7)
        cutoff = START + timedelta(days=1)
        requirement = PriceRequirement("CN:TEST", "CN", "2025-01-01", "2025-01-01",
                                       DataTimes(china_close, china_close, china_close))
        result = valuation_quality([requirement], cutoff)
        self.assertEqual(result.quality, "complete")
        self.assertTrue(result.decision_eligible)
        missing = replace(requirement, listing_id="HK:TEST", actual_session=None, times=None)
        result = valuation_quality([requirement, missing], cutoff)
        self.assertEqual(result.quality, "blocked")
        self.assertFalse(result.decision_eligible)

    def test_old_quote_provisional_unknown_calendar_and_fx_blocked(self):
        times = DataTimes(START, START, START)
        requirement = PriceRequirement("id", "US", "2025-01-02", "2025-01-01", times)
        self.assertEqual(valuation_quality([requirement], START + timedelta(days=2)).quality, "provisional")
        result = valuation_quality([replace(requirement, expected_session=None)], START + timedelta(days=2))
        self.assertEqual(result.quality, "blocked")
        self.assertEqual(valuation_quality([], START, missing_fx=("USD",)).quality, "blocked")

    def test_corporate_action_missing_basis_mismatch_and_reconstructed(self):
        requirement = PriceRequirement("id", "US", "2025-01-01", "2025-01-01", DataTimes(START, START, START))
        result = valuation_quality([replace(requirement, corporate_actions_complete=False)], START)
        self.assertEqual(result.quality, "provisional")
        self.assertFalse(result.decision_eligible)
        self.assertEqual(valuation_quality([replace(requirement, price_basis="total_return")], START).quality, "blocked")
        self.assertFalse(valuation_quality([requirement], START, mode="reconstructed").decision_eligible)


if __name__ == "__main__":
    unittest.main()
