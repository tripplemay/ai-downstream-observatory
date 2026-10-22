from copy import deepcopy
from decimal import localcontext
import unittest

from tests.execution_sandbox.fixtures import buy_input, buy_outcome
from worker.execution_sandbox.bounded_cash import BoundedCashError, digest, execute_buys, implementation_hash, plan_buys, verify_result


class BoundedCashTests(unittest.TestCase):
    def test_hand_computed_plan_and_fill(self):
        value = buy_input()
        plan = plan_buys(value)
        order = plan['orders'][0]
        self.assertEqual((order['quantity'], order['price_cap'], order['worst_total_cash_cny']), ('90', '10.2', '920'))
        self.assertEqual((plan['existing_reserved_cny'], plan['new_reserved_cny'], plan['unreserved_cash_cny']), ('200', '1002', '0'))
        result = execute_buys(value, plan, buy_outcome())
        self.assertEqual((result['total_debited_cny'], result['cash_after_cny'], result['unreserved_cash_after_cny']), ('912.8', '289.2', '89.2'))
        self.assertEqual(result['orders'][0]['fee_cny'], '2')
        self.assertEqual(result['execution_failure_count'], 0)
        self.assertFalse(result['live_advice_eligible'])

    def test_no_buffer_diagnostic_skips_instead_of_resizing(self):
        value = buy_input(); value['policy']['price_buffer_bps'] = '0'
        plan = plan_buys(value)
        self.assertEqual(plan['orders'][0]['quantity'], '100')
        result = execute_buys(value, plan, buy_outcome())
        self.assertEqual(result['orders'][0]['quantity'], '100')
        self.assertEqual(result['orders'][0]['reason'], 'PRICE_BOUND_EXCEEDED')
        self.assertEqual(result['total_debited_cny'], '0')
        self.assertEqual(result['execution_failure_count'], 1)

    def test_price_at_boundary_fills_and_one_cent_above_skips(self):
        value = buy_input(); plan = plan_buys(value)
        self.assertEqual(execute_buys(value, plan, buy_outcome(close='10.2'))['orders'][0]['status'], 'simulated_filled')
        result = execute_buys(value, plan, buy_outcome(close='10.21'))
        self.assertEqual((result['total_debited_cny'], result['execution_failure_count']), ('0', 1))
        self.assertEqual(result['orders'][0]['released_cny'], '1002')

    def test_slippage_is_inside_price_bound_and_commission_switches(self):
        value = buy_input(); value['policy']['slippage_bps'] = '100'; value['policy']['minimum_fee_cny'] = '0'
        plan = plan_buys(value)
        result = execute_buys(value, plan, buy_outcome(close='10'))
        self.assertEqual(result['orders'][0]['execution_price'], '10.1')
        self.assertEqual(result['orders'][0]['fee_cny'], '0.4545')
        self.assertEqual(result['orders'][0]['rounding_cny'], '0.0055')
        self.assertEqual(result['total_debited_cny'], '909.46')
        value['policy']['slippage_bps'] = '201'
        with self.assertRaisesRegex(BoundedCashError, 'SLIPPAGE_EXCEEDS_BOUND'): plan_buys(value)

    def test_rounding_is_upward_and_maximum_quantity_is_exact(self):
        value = buy_input(); value['policy'].update(price_buffer_bps='0', commission_bps='0', minimum_fee_cny='0')
        value['settled_cash_cny'] = '1'; value['existing_reservations'] = []
        value['orders'][0].update(allocated_budget_cny='1', quantity_step='1'); value['orders'][0]['decision_quote']['close'] = '0.33333333'
        plan = plan_buys(value)
        self.assertEqual((plan['orders'][0]['quantity'], plan['orders'][0]['worst_total_cash_cny']), ('3', '1'))
        result = execute_buys(value, plan, buy_outcome(value, close='0.33333333'))
        self.assertEqual(result['cash_after_cny'], '0')

    def test_fees_below_one_step_do_not_create_a_paid_order(self):
        value = buy_input(); value['orders'][0]['allocated_budget_cny'] = '1'
        plan = plan_buys(value)
        self.assertEqual((plan['orders'][0]['status'], plan['new_reserved_cny']), ('below_minimum', '0'))
        outcome = buy_outcome(value); outcome['observations'] = []
        result = execute_buys(value, plan, outcome)
        self.assertEqual((result['total_debited_cny'], result['execution_failure_count']), ('0', 0))
        self.assertEqual(result['orders'][0]['reason'], 'BUDGET_BELOW_ONE_STEP_TOTAL_COST')

    def test_unsettled_and_expected_money_cannot_fund_the_batch(self):
        value = buy_input(); value['settled_cash_cny'] = '1201.99'
        with self.assertRaisesRegex(BoundedCashError, 'SETTLED_CASH_EXCEEDED'): plan_buys(value)
        value = buy_input(); value['expected_contribution_cny'] = '1000'
        with self.assertRaisesRegex(BoundedCashError, 'CONTRACT_INVALID'): plan_buys(value)

    def test_multiple_orders_never_borrow_each_others_budget(self):
        value = buy_input(); second = deepcopy(value['orders'][0]); second.update(order_id='synthetic:buy-b', listing_id='CN:SYNTHETIC_B')
        value['orders'].append(second); value['settled_cash_cny'] = '2204'
        plan = plan_buys(value); outcome = buy_outcome(value); outcome['observations'][1]['close'] = '10.21'
        result = execute_buys(value, plan, outcome)
        self.assertEqual([row['status'] for row in result['orders']], ['simulated_filled', 'skipped'])
        self.assertEqual(result['cash_after_cny'], '1291.2')
        self.assertEqual(result['existing_reserved_cny'], '200')
        self.assertEqual(result['execution_failure_count'], 1)
        self.assertEqual(result['orders'][1]['quantity'], '90')

    def test_missing_and_late_prices_are_retained_failures(self):
        value = buy_input(); plan = plan_buys(value)
        cases = [(None, 'MISSING_EXECUTION_OBSERVATION'), ('2025-01-03T08:00:00.000001Z', 'EXECUTION_EVIDENCE_LATE')]
        for known, reason in cases:
            outcome = buy_outcome()
            if known is None: outcome['observations'] = []
            else:
                outcome['observations'][0]['known_at'] = known
                outcome['evaluated_at'] = known
            result = execute_buys(value, plan, outcome)
            self.assertEqual((result['orders'][0]['reason'], result['execution_failure_count']), (reason, 1))

    def test_corporate_actions_invalidate_not_rewrite_frozen_quantity(self):
        value = buy_input(); plan = plan_buys(value); outcome = buy_outcome()
        outcome['observations'][0].update(corporate_action_since_decision=True, close='5')
        result = execute_buys(value, plan, outcome)
        self.assertEqual(result['orders'][0]['reason'], 'CORPORATE_ACTION_REVIEW_REQUIRED')
        self.assertEqual(result['orders'][0]['quantity'], '90')
        self.assertEqual(result['cash_after_cny'], '1202')

    def test_microseconds_and_source_availability_are_not_rounded_away(self):
        for field, text in [('known_at', '2025-01-02T08:00:00.000001Z'), ('valid_until', '2025-01-02T08:00:00.000000Z'),
                            ('observed_at', '2025-01-02T06:59:59.999999Z')]:
            value = buy_input(); value['orders'][0]['decision_quote'][field] = text
            with self.assertRaisesRegex(BoundedCashError, 'DECISION_QUOTE_UNAVAILABLE'): plan_buys(value)

    def test_reject_bad_policy_and_numeric_coercion(self):
        for field, bad in [('price_buffer_bps', '10001'), ('commission_bps', '10001'), ('cash_quantum', '0.001'),
                           ('commission_bps', 0.1), ('max_quote_age_seconds', True)]:
            value = buy_input(); value['policy'][field] = bad
            with self.assertRaises(BoundedCashError): plan_buys(value)

    def test_other_markets_and_real_qualifications_are_not_admitted(self):
        for market, currency in [('HK', 'HKD'), ('US', 'USD'), ('CN', 'USD')]:
            value = buy_input(); value['orders'][0].update(market=market, currency=currency)
            with self.assertRaisesRegex(BoundedCashError, 'CONTRACT_INVALID'): plan_buys(value)
        value = buy_input(); value['qualification'] = 'owner_reviewed_reconstructed'
        with self.assertRaisesRegex(BoundedCashError, 'CONTRACT_INVALID'): plan_buys(value)

    def test_duplicates_and_partial_fill_fields_are_rejected(self):
        value = buy_input(); value['orders'][0]['order_id'] = value['existing_reservations'][0]['order_id']
        with self.assertRaisesRegex(BoundedCashError, 'DUPLICATE_ORDER_ID'): plan_buys(value)
        value = buy_input(); outcome = buy_outcome(); outcome['observations'][0]['filled_quantity'] = '80'
        with self.assertRaisesRegex(BoundedCashError, 'CONTRACT_INVALID'): execute_buys(value, plan_buys(value), outcome)

    def test_resealed_plan_or_result_is_rejected_by_economic_replay(self):
        value = buy_input(); plan = plan_buys(value); outcome = buy_outcome(); result = execute_buys(value, plan, outcome)
        changed = deepcopy(plan); changed['orders'][0]['quantity'] = '80'
        changed['plan_hash'] = digest({key: val for key, val in changed.items() if key != 'plan_hash'})
        with self.assertRaisesRegex(BoundedCashError, 'FROZEN_PLAN_MISMATCH'): execute_buys(value, changed, outcome)
        changed = deepcopy(result); changed['cash_after_cny'] = '999'
        changed['result_hash'] = digest({key: val for key, val in changed.items() if key != 'result_hash'})
        with self.assertRaisesRegex(BoundedCashError, 'RESULT_REPLAY_MISMATCH'): verify_result(value, plan, outcome, changed)

    def test_deterministic_no_mutation_or_global_decimal_context_change(self):
        value = buy_input(); outcome = buy_outcome(); original = deepcopy((value, outcome))
        with localcontext() as context:
            context.prec = 5
            plan = plan_buys(value); result = execute_buys(value, plan, outcome)
            self.assertEqual(context.prec, 5)
        self.assertEqual((value, outcome), original)
        self.assertEqual(plan, plan_buys(value))
        self.assertEqual(result, execute_buys(value, plan, outcome))

    def test_integral_json_number_hashes_match_javascript_canonicalization(self):
        value = buy_input(); plan = plan_buys(value)
        value['policy']['max_quote_age_seconds'] = 3600.0
        self.assertEqual(plan, plan_buys(value))

    def test_sandbox_identity_is_separate_from_versioned_production_research(self):
        from worker.research.registry import implementation_manifest
        from worker.orchestration.runtime import role_commands
        manifest = implementation_manifest()['source_hashes']
        self.assertNotIn('contracts/v1/bounded-cash-buy.schema.json', manifest)
        self.assertFalse(any('execution_sandbox' in path for path in manifest))
        from worker.execution_sandbox.bounded_cash import SOURCES
        self.assertFalse(any(path.startswith(('worker/research/', 'worker/investor/')) for path in SOURCES))
        self.assertNotIn('bounded_cash_buy', role_commands('core'))
        self.assertEqual(len(implementation_hash()), 64)


if __name__ == '__main__':
    unittest.main()
