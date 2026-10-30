from copy import deepcopy
import unittest

from tests.research.cash_intent_fixtures import cash_intent_case, partial_buy_case
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError
from worker.research.rotation import run_rotation_portfolio
from worker.research.snapshot import validate_dataset, validate_plan


def run_case(price='19.8', mutate=None):
    data, plan, parameters = cash_intent_case(price)
    if mutate:
        mutate(data, plan, parameters)
    validate_dataset(data); validate_plan(plan, data)
    before = deepcopy((data, plan, parameters))
    result = run_rotation_portfolio(data, plan, parameters, 'train')
    assert (data, plan, parameters) == before
    return result


class CashIntentRuntimeTests(unittest.TestCase):
    def test_new_version_requires_its_funding_rule_and_cannot_be_relabelled_as_an_old_plan(self):
        data, plan, parameters = cash_intent_case()
        validate_plan(plan, data)
        validate_contract(plan, 'research-plan-input.schema.json')
        missing = deepcopy(plan); del missing['execution']['buy_funding_policy']
        with self.assertRaises(WorkbenchError): validate_plan(missing, data)
        older = deepcopy(plan); older['schema_version'] = 'research-plan-v5'
        with self.assertRaises(WorkbenchError): validate_plan(older, data)

    def test_partial_buy_in_another_market_is_preserved_when_only_the_remaining_leg_is_cancelled(self):
        data, plan, parameters = partial_buy_case()
        validate_dataset(data); validate_plan(plan, data)
        result = run_rotation_portfolio(data, plan, parameters, 'train')
        row = result['cash_intents'][0]
        self.assertEqual(row['state'], 'resolved')
        cancelled = [e for e in result['events'] if e['type'] == 'execution_skipped']
        self.assertEqual([e['listing_id'] for e in cancelled], ['CN:BETA'])
        committed_us = [e for e in result['events'] if e['type'] == 'simulated_buy' and e['listing_id'] == 'US:GAMMA' and e['at'] >= row['declaration']['declared_at']]
        self.assertEqual(len(committed_us), 1)
        self.assertEqual(len([e for e in result['events'] if e['type'] == 'cash_intent_buy_published']), 1)
        self.assertEqual(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['failed_cash_intent_count'], 0)
        self.assertFalse(any(e['type'] == 'external_contribution' for e in result['events']))

    def test_sell_only_declaration_precedes_settlement_and_new_buy_quantity(self):
        result = run_case()
        intents = result['cash_intents']
        self.assertEqual(len(intents), 1)
        intent = intents[0]
        self.assertEqual(intent['state'], 'resolved')
        declarations = [e for e in result['events'] if e['type'] == 'cash_intent_declared']
        declaration_at = declarations[0]['at']
        same_time = [e for e in result['events'] if e['type'] == 'research_order' and e['at'] == declaration_at]
        self.assertEqual([e['side'] for e in same_time], ['sell'])
        buys = [e for e in result['events'] if e['type'] == 'research_order' and e.get('cash_intent_id') and e['side'] == 'buy']
        self.assertEqual(len(buys), 1)
        self.assertGreater(buys[0]['at'], declaration_at)
        settlement = next(e for e in result['events'] if e['type'] == 'sale_cash_settlement')
        self.assertLess(settlement['at'], buys[0]['at'])
        self.assertEqual(buys[0]['at'], '2025-02-08T07:01:00.000000Z')
        self.assertEqual(result['pending_cash_intent_count'], 0)
        self.assertEqual(result['failed_cash_intent_count'], 0)
        self.assertEqual(result['terminal_execution_failure_count'], 0)

    def test_future_sale_price_changes_only_the_new_post_settlement_order(self):
        smaller, larger = run_case('19.8'), run_case('19')
        declaration = lambda r: next(e for e in r['events'] if e['type'] == 'cash_intent_declared')
        self.assertEqual(declaration(smaller), declaration(larger))
        prefix = lambda r: [e for e in r['events'] if e['type'] == 'research_order' and e['at'] <= declaration(r)['at']]
        self.assertEqual(prefix(smaller), prefix(larger))
        frozen = lambda r: next(e for e in r['events'] if e['type'] == 'cash_intent_buy_published')['preparation']['orders'][0]
        self.assertNotEqual(frozen(smaller)['quantity'], frozen(larger)['quantity'])
        self.assertEqual(smaller['failed_cash_intent_count'], 0)
        self.assertEqual(larger['failed_cash_intent_count'], 0)

    def test_no_future_declared_decision_leaves_a_failed_intent_not_a_resolved_rebalance(self):
        result = run_case(mutate=lambda d, p, a: p.update(decision_times=p['decision_times'][:2]))
        self.assertEqual(result['cash_intents'][0]['state'], 'expired')
        self.assertEqual(result['failed_cash_intent_count'], 1)
        self.assertFalse(any(e['type'] == 'cash_intent_buy_published' for e in result['events']))

    def test_price_failure_after_buy_publication_is_terminal_without_smaller_retry(self):
        def change(data, plan, parameters):
            for row in data['observations']:
                if row['listing_id'] == 'CN:BETA' and row['observed_at'].startswith('2025-02-09'):
                    row['value'] = '20'
        result = run_case(mutate=change)
        self.assertEqual(result['cash_intents'][0]['state'], 'failed')
        self.assertEqual(result['failed_cash_intent_count'], 1)
        self.assertEqual(len([e for e in result['events'] if e['type'] == 'cash_intent_buy_published']), 1)
        self.assertEqual(len([e for e in result['events'] if e['type'] == 'research_order' and e.get('cash_intent_id') and e['side'] == 'buy']), 1)
        self.assertTrue(any(e.get('reason') == 'EXECUTION_PRICE_OR_FX_BOUND_EXCEEDED' for e in result['events']))

    def test_uncommitted_intent_waits_for_an_observed_close_after_an_intervening_action(self):
        def change(data, plan, parameters):
            data['actions'].append({'id': 'fictional:buy-scope-dividend', 'listing_id': 'CN:BETA', 'type': 'dividend',
                'at': '2025-02-08T07:00:30Z', 'published_at': '2025-02-08T07:00:30Z', 'gross_per_unit': '0.1',
                'tax_per_unit': '0', 'pay_at': '2025-02-09T09:00:00Z', 'source_evidence': 'Invented runtime fixture'})
        result = run_case(mutate=change)
        frozen = next(e for e in result['events'] if e['type'] == 'cash_intent_buy_published')
        self.assertEqual(frozen['at'], '2025-02-09T07:01:00.000000Z')
        self.assertTrue(any('SETTLED_FUNDING_POST_SETTLEMENT_CLOSE_REQUIRED' in e.get('reason_codes', []) for e in result['events']))
        self.assertEqual(result['failed_cash_intent_count'], 0)

    def test_new_contribution_during_wait_is_not_recredited_and_keeps_its_own_trigger(self):
        def change(data, plan, parameters):
            plan['contributions'] = [{'at': '2025-02-07T12:00:00Z', 'amount_cny': '1'}]
            plan['decision_times'].append('2025-02-11T07:01:00Z')
        result = run_case(mutate=change)
        self.assertEqual(result['contributions_cny'], '1')
        self.assertEqual(len(result['cash_intents']), 1)
        frozen = next(e for e in result['events'] if e['type'] == 'cash_intent_buy_published')
        self.assertEqual(frozen['preparation']['available_cash_cny'], '298.4')
        self.assertTrue(any('NEW_CASH_REPAIR' in e.get('trigger_codes', []) and e['at'] > frozen['at'] for e in result['events']))

    def test_no_longer_needed_buy_scope_is_distinct_from_all_targets_within_tolerance(self):
        def change(data, plan, parameters):
            for row in data['observations']:
                if row['listing_id'] == 'CN:BETA' and row['observed_at'] >= '2025-02-08':
                    row['value'] = '30'
        result = run_case(mutate=change)
        self.assertEqual(result['cash_intents'][0]['reason'], 'original_buy_scope_no_longer_needed')
        self.assertFalse(any(e['type'] == 'cash_intent_buy_published' for e in result['events']))
        self.assertTrue(any(e['type'] == 'simulated_sell' for e in result['events']))

    def test_cancelled_sell_dependencies_are_followed_through_replacement_lineage(self):
        def change(data, plan, parameters):
            plan['decision_times'] += ['2025-02-11T07:01:00Z', '2025-02-12T07:01:00Z', '2025-02-13T07:01:00Z']
            data['actions'].append({'id': 'fictional:sale-split', 'listing_id': 'CN:ALPHA', 'type': 'split',
                'at': '2025-02-06T00:00:00Z', 'published_at': '2025-02-06T00:00:00Z',
                'ratio': '2', 'source_evidence': 'Invented late sale action'})
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-02-06':
                    from decimal import Decimal
                    row['value'] = str(Decimal(row['value']) / 2)
        result = run_case(mutate=change)
        self.assertEqual(result['cash_intents'][0]['state'], 'resolved')
        self.assertEqual(result['cash_intents'][0]['declaration']['sale_order_ids'], ['order:000003'])
        self.assertNotEqual(result['cash_intents'][0]['current_sale_order_ids'], ['order:000003'])
        self.assertEqual(result['corporate_action_cancellation_count'], 1)
        self.assertEqual(result['resolved_corporate_action_cancellation_count'], 1)
        self.assertEqual(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['failed_cash_intent_count'], 0)

    def test_buy_action_replacement_preserves_the_one_frozen_batch_and_its_new_order_lineage(self):
        def change(data, plan, parameters):
            data['actions'].append({'id': 'fictional:frozen-buy-dividend', 'listing_id': 'CN:BETA', 'type': 'dividend',
                'at': '2025-02-09T00:00:00Z', 'published_at': '2025-02-09T00:00:00Z', 'gross_per_unit': '0.1',
                'tax_per_unit': '0', 'pay_at': '2025-02-10T09:00:00Z', 'source_evidence': 'Invented buy action'})
            plan['decision_times'] += ['2025-02-11T07:01:00Z', '2025-02-12T07:01:00Z']
        result = run_case(mutate=change)
        row = result['cash_intents'][0]
        self.assertEqual(row['state'], 'resolved')
        self.assertNotEqual(row['buy_order_ids'], row['current_buy_order_ids'])
        self.assertEqual(len([e for e in result['events'] if e['type'] == 'cash_intent_buy_published']), 1)
        self.assertEqual(result['corporate_action_cancellation_count'], 1)
        self.assertEqual(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['failed_cash_intent_count'], 0)
        self.assertTrue(all(not r['allow_sales'] for r in result['order_reviews']))

    def test_cancelled_sales_can_be_reviewed_as_unneeded_without_inventing_sale_cash(self):
        def change(data, plan, parameters):
            plan['contributions'] = [{'at': '2025-02-07T12:00:00Z', 'amount_cny': '1000'}]
            plan['decision_times'] += ['2025-02-11T07:01:00Z', '2025-02-12T07:01:00Z']
            data['actions'].append({'id': 'fictional:sale-zero-dividend', 'listing_id': 'CN:ALPHA', 'type': 'dividend',
                'at': '2025-02-06T00:00:00Z', 'published_at': '2025-02-06T00:00:00Z', 'gross_per_unit': '0',
                'tax_per_unit': '0', 'pay_at': '2025-02-07T09:00:00Z', 'source_evidence': 'Invented zero distribution'})
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-02-06': row['value'] = '5'
        result = run_case(mutate=change)
        self.assertEqual(result['cash_intents'][0]['state'], 'resolved')
        self.assertEqual(result['cash_intents'][0]['current_sale_order_ids'], [])
        self.assertEqual(result['order_reviews'][0]['completion_reason'], 'sale_scope_no_longer_needed')
        self.assertFalse(any(e['type'] == 'sale_cash_settlement' for e in result['events']))
        receipt = next(e['preparation'] for e in result['events'] if e['type'] == 'cash_intent_buy_published')
        self.assertIsNone(receipt['latest_sale_settlement_at'])
        self.assertEqual(receipt['available_cash_cny'], '1040')
        self.assertEqual(result['terminal_execution_failure_count'], 0)
        self.assertEqual(result['failed_cash_intent_count'], 0)


if __name__ == '__main__': unittest.main()
