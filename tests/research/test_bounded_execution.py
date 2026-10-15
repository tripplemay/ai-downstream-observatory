from copy import deepcopy
from decimal import Decimal
import unittest

from tests.research.bounded_fixtures import bounded_plan, case, foreign_case
from tests.research.rotation_fixtures import dataset, plan
from tests.research.fixed_policy_fixtures import policy_parameters
from tests.research.test_rotation import flat, rows
from worker.orchestration.db import WorkbenchError
from worker.research.backtest import compare_backtest
from worker.research.snapshot import validate_plan
from worker.research.rotation import run_rotation_portfolio
from worker.investor.strategy import research_reference
from tests.investor.fixtures import profile


class BoundedExecutionTests(unittest.TestCase):
    def test_legacy_numeric_receipts_are_byte_identical_to_frozen_pre_v3_baseline(self):
        d, p, a = dataset(), plan(), policy_parameters()
        p.update(parameter_candidates=[a], benchmark=deepcopy(a))
        self.assertEqual(compare_backtest(d, p, a, 'train')['result_hash'], 'a5133395853d1c6b8abc079be83053a0b756b45da2864ad2e6edd87a9d0bdc0d')
        flat(d)
        self.assertEqual(compare_backtest(d, p, a, 'train')['result_hash'], 'b1188a6bf39558e03c14b3e7c52b9c1c158cfbf667399e515b9264849f5f1012')
        p['contributions'] = [{'at': '2025-01-12T00:00:00Z', 'amount_cny': '300'}]
        self.assertEqual(compare_backtest(d, p, a, 'train')['result_hash'], 'ce6e2d03dddfee7d055e2429da0b27b01d74a3814957876e94ca3f67bea4c91a')

    def test_v3_reserves_full_cent_budgets_and_sizes_at_price_and_fx_caps(self):
        d, p, policy = case()
        a = policy_parameters()
        p.update(parameter_candidates=[a], benchmark=deepcopy(a))
        result = compare_backtest(d, p, a, 'train')
        self.assertEqual(result['schema_version'], 'research-result-v2')
        self.assertEqual(result['strategy']['engine_version'], 'fixed-policy-bounded-rebalance-v3')
        first = rows(result['strategy'], 'research_order')
        self.assertEqual([row['quantity'] for row in first], ['58', '58'])
        self.assertEqual([row['buy_price_cap'] for row in first], ['10.2', '10.2'])
        self.assertEqual([row['buy_fx_cap'] for row in first], ['1', '1'])
        self.assertEqual([row['worst_total_cash_cny'] for row in first], ['591.6', '591.6'])
        self.assertTrue(all(Decimal(row['worst_total_cash_cny']) <= Decimal(row['budget_cny']) for row in first))
        self.assertEqual(result['strategy']['twr'], '0')
        self.assertEqual(result['strategy']['ending_cash']['CNY'], '40')
        self.assertEqual(result['strategy'], result['benchmark'])

    def test_a_small_future_jump_executes_frozen_quantity_but_above_cap_is_retained_failure(self):
        d, p, _ = case()
        a = policy_parameters()
        p.update(parameter_candidates=[a], benchmark=deepcopy(a))
        frozen = rows(run_rotation_portfolio(d, p, a, 'train'), 'research_order')[0]
        for value, expected in [('10.2', True), ('10.20000001', False)]:
            changed = deepcopy(d)
            for row in changed['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'].startswith('2025-01-06'):
                    row['value'] = value
            result = run_rotation_portfolio(changed, p, a, 'train')
            self.assertEqual(rows(result, 'research_order')[0], frozen)
            initial = [row for row in rows(result, 'simulated_buy') if row['order_id'] == frozen['order_id']]
            self.assertEqual(bool(initial), expected)
            if not expected:
                self.assertEqual(rows(result, 'execution_skipped')[0]['reason'], 'EXECUTION_PRICE_OR_FX_BOUND_EXCEEDED')
                self.assertGreater(result['execution_failure_count'], 0)

    def test_new_bounds_cannot_be_inserted_into_v2_or_omitted_from_v3(self):
        d, p, _ = case()
        for mutate in [lambda v: v.update(schema_version='research-plan-v2'),
                       lambda v: v['execution'].pop('buy_price_buffer_bps'),
                       lambda v: v['execution'].update(buy_fx_buffer_bps='-1'),
                       lambda v: v['execution'].update(buy_price_buffer_bps='10001'),
                       lambda v: v['execution'].update(cash_quantum='0.001')]:
            value = deepcopy(p)
            mutate(value)
            with self.assertRaises(WorkbenchError):
                validate_plan(value, d)

    def test_upward_cash_rounding_is_used_in_both_sizing_and_fill(self):
        d, p, _ = case()
        a = policy_parameters()
        p.update(parameter_candidates=[a], benchmark=deepcopy(a))
        p['execution'].update(buy_price_buffer_bps='0', commission_bps='3', minimum_fee_cny='0')
        for row in d['observations']:
            row['value'] = '10.12345678'
        result = compare_backtest(d, p, a, 'train')['strategy']
        for row in rows(result, 'simulated_buy'):
            self.assertGreaterEqual(Decimal(row['cash_rounding_cny']), 0)
            self.assertLess(Decimal(row['cash_rounding_cny']), Decimal('.01'))
        self.assertGreater(Decimal(result['fees_cny']), 0)

    def test_pending_orders_are_cancelled_not_resized_at_corporate_actions(self):
        d, p, _ = case()
        a = policy_parameters()
        p.update(parameter_candidates=[a], benchmark=deepcopy(a))
        d['actions'] = [{'id': 'synthetic:pending-split', 'listing_id': 'CN:ALPHA', 'type': 'split', 'ratio': '2',
                         'at': '2025-01-06T00:00:00Z', 'published_at': '2024-12-01T00:00:00Z', 'source_evidence': 'Invented split'}]
        for row in d['observations']:
            if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-06':
                row['value'] = '5'
        result = compare_backtest(d, p, a, 'train')['strategy']
        first = rows(result, 'research_order')[0]
        skipped = rows(result, 'execution_skipped')[0]
        self.assertEqual(skipped['quantity'], first['quantity'])
        self.assertEqual(skipped['reason'], 'CORPORATE_ACTION_INVALIDATES_FROZEN_ORDER')
        self.assertFalse(any(row['order_id'] == first['order_id'] for row in rows(result, 'simulated_buy')))

    def test_existing_dividend_split_and_receivable_accounting_remains_in_the_real_engine(self):
        d, p, _ = case()
        a = policy_parameters()
        p.update(parameter_candidates=[a], benchmark=deepcopy(a))
        common = {'listing_id': 'CN:ALPHA', 'at': '2025-01-10T00:00:00Z', 'published_at': '2024-12-01T00:00:00Z', 'source_evidence': 'Invented actions'}
        d['actions'] = [{**common, 'id': 's', 'type': 'split', 'ratio': '2'},
                        {**common, 'id': 'd', 'type': 'dividend', 'gross_per_unit': '0.1', 'tax_per_unit': '0.01', 'pay_at': '2025-01-12T00:00:00Z'}]
        for row in d['observations']:
            if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-10':
                row['value'] = '4.9'
        result = compare_backtest(d, p, a, 'train')['strategy']
        self.assertEqual(rows(result, 'split')[0]['ratio'], '2')
        self.assertEqual(rows(result, 'dividend_entitlement')[0]['gross'], '11.6')
        self.assertEqual(rows(result, 'dividend_payment')[0]['amount'], '10.44')
        self.assertTrue(rows(result, 'stock_settlement'))
        self.assertTrue(any(row['derived_carry_marks'] for row in result['curve']))

    def test_selector_keeps_the_same_risk_gates_and_never_opens_later_phases_after_a_gap(self):
        d, p, policy = case()
        for row in d['observations']:
            if row['observed_at'].startswith('2025-03-02'):
                row['value'] = '20'
        visited = []
        from worker.investor.strategy import _summary
        def evaluate(parameters, phase):
            visited.append(phase)
            return _summary(compare_backtest(d, p, parameters, phase))
        result = research_reference(d, p, policy, profile('0.50'), allow_synthetic=True, evaluate=evaluate)
        self.assertEqual(result['status'], 'insufficient_evidence')
        self.assertEqual(result['reason_codes'], ['SELECTED_CANDIDATE_FAILED_VALIDATION'])
        self.assertNotIn('holdout', visited)

    def test_source_independent_train_only_options_keep_risk_unknown(self):
        d, p, policy = case(flat_prices=False)
        result = research_reference(d, p, policy, profile(), allow_synthetic=True)
        self.assertEqual(result['status'], 'risk_options_ready')
        self.assertIsNone(result['selected_parameters'])
        self.assertEqual(result['phase_evidence'], [])

    def test_hk_and_us_fill_fx_is_bounded_without_using_future_fx_for_sizing(self):
        for market in ('HK', 'US'):
            d, p, a = foreign_case(market)
            result = compare_backtest(d, p, a, 'train')['strategy']
            order = next(row for row in rows(result, 'research_order') if row['listing_id'] == market + ':ALPHA')
            self.assertEqual(order['buy_fx_cap'], '5.1')
            skip = next(row for row in rows(result, 'execution_skipped') if row['order_id'] == order['order_id'])
            self.assertEqual(skip['reason'], 'EXECUTION_PRICE_OR_FX_BOUND_EXCEEDED')
            self.assertEqual(skip['observed_fx'], '5.11')
            self.assertGreater(result['execution_failure_count'], 0)


if __name__ == '__main__':
    unittest.main()
