from copy import deepcopy
import unittest

from tests.research.cash_intent_interleavings import interleaving_case
from worker.orchestration.db import instant
from worker.research.rotation import run_rotation_portfolio


def run(kind):
    data, plan, parameters = interleaving_case(kind)
    original = deepcopy((data, plan, parameters))
    result = run_rotation_portfolio(data, plan, parameters, 'train')
    assert (data, plan, parameters) == original
    return result


class CashIntentInterleavingTests(unittest.TestCase):
    def test_repeated_sale_actions_keep_roots_generations_and_one_post_settlement_buy(self):
        result = run('repeated_sale_actions')
        intent = result['cash_intents'][0]
        self.assertEqual(intent['state'], 'resolved')
        self.assertEqual(intent['declaration']['sale_order_ids'], ['order:000003'])
        self.assertNotEqual(intent['current_sale_order_ids'], intent['declaration']['sale_order_ids'])
        self.assertEqual(result['corporate_action_cancellation_count'], 2)
        self.assertEqual(result['resolved_corporate_action_cancellation_count'], 2)
        self.assertEqual(result['failed_cash_intent_count'], 0)
        self.assertEqual(sum(e['type'] == 'cash_intent_buy_published' for e in result['events']), 1)
        self.assertEqual(sum(e['type'] == 'sale_cash_settlement' for e in result['events']), 1)

    def test_no_buy_is_frozen_until_every_partly_settled_sale_dependency_finishes(self):
        result = run('partial_sale_wait')
        intent = result['cash_intents'][0]
        self.assertEqual(len(intent['declaration']['sale_order_ids']), 2)
        self.assertEqual(intent['state'], 'resolved')
        sales = [e for e in result['events'] if e['type'] == 'sale_cash_settlement']
        self.assertEqual(len(sales), 2)
        self.assertLess(instant(sales[0]['at']), instant(sales[1]['at']))
        publication = next(e for e in result['events'] if e['type'] == 'cash_intent_buy_published')
        self.assertGreater(instant(publication['at']), instant(sales[-1]['at']))
        self.assertEqual(result['failed_cash_intent_count'], 0)

    def test_action_on_remaining_sale_never_undoes_completed_sale_or_credits_its_receipt_twice(self):
        result = run('partial_sale_action')
        self.assertEqual(result['cash_intents'][0]['state'], 'resolved')
        sales = [e for e in result['events'] if e['type'] == 'simulated_sell']
        self.assertEqual(len([e for e in sales if e['listing_id'] == 'CN:ALPHA']), 1)
        self.assertEqual(len([e for e in sales if e['listing_id'] == 'US:GAMMA']), 1)
        cancellations = [e for e in result['events'] if e['type'] == 'execution_skipped']
        self.assertEqual([e['listing_id'] for e in cancellations], ['US:GAMMA'])
        self.assertEqual(sum(e['type'] == 'sale_cash_settlement' for e in result['events']), 2)
        self.assertEqual(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['failed_cash_intent_count'], 0)

    def test_late_sale_settlement_keeps_both_fills_but_only_available_cash_and_no_buy(self):
        result = run('late_sale_settlement')
        self.assertEqual(result['cash_intents'][0]['state'], 'expired')
        self.assertEqual(result['failed_cash_intent_count'], 1)
        self.assertEqual(result['execution_failure_count'], 0)
        self.assertEqual(sum(e['type'] == 'simulated_sell' for e in result['events']), 2)
        self.assertEqual(sum(e['type'] == 'sale_cash_settlement' for e in result['events']), 1)
        self.assertFalse(any(e['type'] == 'cash_intent_buy_published' for e in result['events']))

    def test_below_minimum_lot_scope_expires_instead_of_becoming_a_zero_error_success(self):
        result = run('minimum_lot')
        self.assertEqual(result['execution_failure_count'], 0)
        self.assertEqual(result['failed_cash_intent_count'], 1)
        self.assertEqual(result['cash_intents'][0]['state'], 'expired')
        self.assertFalse(any(e['type'] == 'cash_intent_buy_published' for e in result['events']))

    def test_predeclared_nonzero_costs_remain_in_new_buy_and_complete_cash_ledger(self):
        result = run('fees')
        self.assertNotEqual(result['fees_cny'], '0')
        self.assertNotEqual(result['slippage_cny'], '0')
        self.assertEqual(result['failed_cash_intent_count'], 0)
        self.assertEqual(result['cash_intents'][0]['state'], 'resolved')
        self.assertEqual(sum(e['type'] == 'cash_intent_buy_published' for e in result['events']), 1)


if __name__ == '__main__': unittest.main()
