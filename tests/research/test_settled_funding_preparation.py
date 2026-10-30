from copy import deepcopy
from decimal import Decimal, getcontext
from fractions import Fraction
import unittest

from tests.research.settled_funding_fixtures import preparation_input, preparation_vectors
from worker.orchestration.db import WorkbenchError, content_hash
from worker.research.settled_funding import prepare_settled_cash_buys


class SettledFundingPreparationTests(unittest.TestCase):
    def test_fresh_orders_are_sized_once_from_the_actual_settled_cash_not_a_sale_forecast(self):
        for cash, quantity, worst in [('297.4', '29', '295.8'), ('287', '28', '285.6')]:
            value = preparation_input(cash); before = deepcopy(value)
            result = prepare_settled_cash_buys(value)
            self.assertEqual(value, before)
            self.assertFalse(result['published']); self.assertFalse(result['live_advice_eligible'])
            self.assertEqual(result['input_hash'], content_hash(value))
            order = result['orders'][0]
            self.assertEqual((order['quantity'], order['budget_cny'], order['worst_total_cash_cny']), (quantity, cash, worst))
            self.assertEqual(order['order_id'], 'fictional-new-buy:1')
            self.assertEqual(result['latest_sale_settlement_at'], '2025-02-07T09:00:00.000000Z')

    def test_reserved_and_locked_cash_is_subtracted_without_adding_sale_receipts_twice(self):
        value = preparation_input(); value['cash'].update(reserved_cny='100', floor_cny='20')
        result = prepare_settled_cash_buys(value)
        self.assertEqual(result['available_cash_cny'], '177.4')
        self.assertEqual(result['orders'][0]['quantity'], '17')
        self.assertEqual(result['orders'][0]['worst_total_cash_cny'], '173.4')
        value['cash']['settled_cny'] = '0'
        with self.assertRaisesRegex(WorkbenchError, 'SETTLED_FUNDING_NO_AVAILABLE_CASH'):
            prepare_settled_cash_buys(value)

    def test_all_vectors_remain_pure_with_exact_cent_budgets_and_both_price_and_fx_caps(self):
        values = preparation_vectors()
        self.assertEqual(len(values), 36)
        for vector in values:
            value, expected = vector['input'], vector['result']; before = deepcopy(value)
            if 'blocked' in expected:
                with self.assertRaisesRegex(WorkbenchError, expected['blocked']):
                    prepare_settled_cash_buys(value)
            else:
                result = prepare_settled_cash_buys(value)
                self.assertEqual(result, expected['prepared'])
                self.assertLessEqual(Decimal(result['total_budget_cny']), Decimal(result['available_cash_cny']))
                for order in result['orders']:
                    self.assertLessEqual(Decimal(order['worst_total_cash_cny']), Decimal(order['budget_cny']))
                    self.assertEqual((Fraction(order['budget_cny']) * 100).denominator, 1)
            self.assertEqual(value, before)

    def test_independent_integer_rationals_prove_cost_ceilings_and_maximal_lot_sizing(self):
        checked = 0
        for currency, rate in [('CNY', '1'), ('HKD', '0.8'), ('USD', '5.12345')]:
            for price in ('0.00123', '10.12345678', '123.45', '0.000001'):
                for lot in ('0.001', '1', '100'):
                    for commission in ('0', '3', '100'):
                        value = preparation_input(); need = value['needs'][0]
                        need.update(currency=currency, close=price, quantity_step=lot, fx_cny_per_unit=rate)
                        if currency != 'CNY': need.update(fx_observed_at='2025-02-08T06:00:00Z', fx_available_at='2025-02-08T06:01:00Z')
                        value['execution'].update(commission_bps=commission, minimum_fee_cny='1.01', slippage_bps='5', fx_bps='7')
                        cap, fx = Fraction(price) * Fraction(102, 100), Fraction(rate) * (Fraction(102, 100) if currency != 'CNY' else 1)
                        def exact_cost(quantity):
                            principal = quantity * cap * fx * Fraction(10005, 10000)
                            full = principal + max(Fraction('1.01'), principal * Fraction(commission) / 10000)
                            if currency != 'CNY': full += principal * Fraction(7, 10000)
                            cents = full * 100
                            return Fraction(-(-cents.numerator // cents.denominator), 100)
                        if exact_cost(Fraction(lot)) > Fraction('297.4'):
                            with self.assertRaisesRegex(WorkbenchError, 'SETTLED_FUNDING_BELOW_MINIMUM_ORDER'):
                                prepare_settled_cash_buys(value)
                        else:
                            result = prepare_settled_cash_buys(value); order = result['orders'][0]
                            quantity, budget = Fraction(order['quantity']), Fraction(order['budget_cny'])
                            self.assertEqual(Fraction(order['worst_total_cash_cny']), exact_cost(quantity))
                            self.assertLessEqual(exact_cost(quantity), budget)
                            self.assertGreater(exact_cost(quantity + Fraction(lot)), budget)
                        checked += 1
        self.assertEqual(checked, 108)

    def test_fact_range_dust_is_not_rounded_away_before_upward_cent_debit(self):
        original_precision = getcontext().prec
        value = preparation_input(str(10**37 + 11))
        need = value['needs'][0]
        need.update(currency='USD', close='10000000000000000000.000000000000000001',
            fx_cny_per_unit='1000000000000000000.000000000000000001',
            need_cny=value['cash']['settled_cny'], fx_observed_at='2025-02-08T06:00:00Z',
            fx_available_at='2025-02-08T06:01:00Z')
        value['execution'].update(buy_price_buffer_bps='0', buy_fx_buffer_bps='0')
        exact = Fraction(need['close']) * Fraction(need['fx_cny_per_unit'])
        self.assertGreater(exact, Fraction(value['cash']['settled_cny']))
        with self.assertRaisesRegex(WorkbenchError, 'SETTLED_FUNDING_BELOW_MINIMUM_ORDER'):
            prepare_settled_cash_buys(value)
        self.assertEqual(getcontext().prec, original_precision)
        value['cash']['settled_cny'] = need['need_cny'] = str(10**37 + 12)
        order = prepare_settled_cash_buys(value)['orders'][0]
        self.assertEqual(order['quantity'], '1')
        self.assertEqual(Fraction(order['worst_total_cash_cny']), Fraction(-(-(exact * 100).numerator // (exact * 100).denominator), 100))
        self.assertEqual(getcontext().prec, original_precision)

    def test_old_plans_and_incomplete_version_tags_cannot_select_the_new_funding_rule(self):
        from tests.research.settled_funding_fixtures import sale_funded_case
        from worker.research.snapshot import validate_plan
        data, original, unused = sale_funded_case()
        for variant in ('new_version', 'injected_funding_flag'):
            plan = deepcopy(original)
            if variant == 'new_version': plan['schema_version'] = 'research-plan-v6'
            else: plan['execution']['buy_funding'] = 'settled_cash_only'
            with self.assertRaises(WorkbenchError): validate_plan(plan, data)

    def test_malformed_claims_cannot_open_scope_reuse_ids_or_inject_a_frozen_quantity(self):
        mutations = [lambda v: v.update(extra=True), lambda v: v['needs'][0].update(quantity='29'),
            lambda v: v['needs'][0].update(need_cny=310), lambda v: v['cash'].update(settled_cny='NaN'),
            lambda v: v['book'].append(deepcopy(v['book'][0])),
            lambda v: v['book'][0].update(cash_intent_id='other-intent'),
            lambda v: v['needs'][0].update(fx_cny_per_unit='2'),
            lambda v: v['intent'].update(buy_listing_ids=['CN:OTHER']),
            lambda v: v['decision_times'].append(v['decision_times'][0])]
        for mutate in mutations:
            value = preparation_input(); mutate(value); before = deepcopy(value)
            with self.assertRaises(WorkbenchError): prepare_settled_cash_buys(value)
            self.assertEqual(value, before)


if __name__ == '__main__':
    unittest.main()
