from copy import deepcopy
import unittest

from tests.research.action_aware_fixtures import case, vectors
from tests.research.test_rotation import rows
from worker.investor.strategy import research_reference
from tests.investor.fixtures import profile
from worker.orchestration.db import WorkbenchError
from worker.research.backtest import compare_backtest
from worker.research.snapshot import validate_plan


class ActionAwareExecutionTests(unittest.TestCase):
    def test_known_action_defers_entire_tentative_batch_without_committing_orders(self):
        data, plan, _ = case()
        result = compare_backtest(data, plan, plan['benchmark'], 'train')['strategy']
        deferred = [row for row in rows(result, 'evaluation') if row['outcome'] == 'deferred']
        self.assertEqual(len(deferred), 1)
        self.assertEqual(deferred[0]['reason_codes'], ['KNOWN_ACTION_BEFORE_SCHEDULED_CLOSE'])
        self.assertFalse(any(row['at'] == deferred[0]['at'] for row in rows(result, 'research_order')))
        first = rows(result, 'research_order')[0]
        self.assertEqual(first['order_id'], 'order:000001')
        self.assertEqual(first['at'], '2025-01-06T07:01:00.000000Z')
        self.assertEqual(first['execute_at'], '2025-01-07T07:00:00.000000Z')
        later = next(row for row in rows(result, 'evaluation') if row['outcome'] == 'proposed')
        self.assertIn('CALENDAR_REVIEW', later['trigger_codes'])
        self.assertEqual(result['execution_failure_count'], 0)
        self.assertEqual(result['policy_evaluation_counts']['deferred'], 1)
        self.assertEqual(result['engine_version'], 'fixed-policy-action-aware-bounded-rebalance-v4')

    def test_v3_still_cancels_the_same_orders_and_retains_failure(self):
        data, plan, _ = case()
        plan['schema_version'] = 'research-plan-v3'
        plan['execution'].pop('order_action_policy')
        result = compare_backtest(data, plan, plan['benchmark'], 'train')['strategy']
        self.assertTrue(any(row['reason'] == 'CORPORATE_ACTION_INVALIDATES_FROZEN_ORDER' for row in rows(result, 'execution_skipped')))
        self.assertGreater(result['execution_failure_count'], 0)
        self.assertNotIn('deferred', result['policy_evaluation_counts'])

    def test_deferred_sale_does_not_publish_its_dependent_buy_or_borrow_unsettled_cash(self):
        vector = next(row for row in vectors() if row['input']['plan']['windows']['train']['end'] == '2025-02-20T23:00:00Z'
            and len(row['input']['plan']['decision_times']) > 100)
        data, plan = vector['input']['dataset'], vector['input']['plan']
        result = vector['result']['strategy']
        deferred = next(row for row in rows(result, 'evaluation') if row['outcome'] == 'deferred')
        self.assertEqual(deferred['deferred_actions'][0]['side'], 'sell')
        self.assertFalse(any(row['at'] == deferred['at'] for row in rows(result, 'research_order')))
        dependent = next(row for row in rows(result, 'research_order') if row['dependency_order_ids'])
        settlement = next(row for row in rows(result, 'sale_cash_settlement') if row['order_id'] in dependent['dependency_order_ids'])
        fill = next(row for row in rows(result, 'simulated_buy') if row['order_id'] == dependent['order_id'])
        self.assertGreater(fill['at'], settlement['at'])
        self.assertEqual(result['execution_failure_count'], 0)
        old = deepcopy(plan); old['schema_version'] = 'research-plan-v3'; old['execution'].pop('order_action_policy')
        legacy = compare_backtest(data, old, old['benchmark'], 'train')['strategy']
        self.assertTrue(any(row['reason'] == 'DEPENDENT_SALE_NOT_COMPLETED' for row in rows(legacy, 'execution_skipped')))

    def test_unresolved_rebalance_after_initial_deployment_is_not_hidden_as_zero_gap(self):
        vector = next(row for row in vectors() if row['input']['plan']['windows']['train']['end'] == '2025-02-20T23:00:00Z'
            and len(row['input']['plan']['decision_times']) < 100)
        result = vector['result']['strategy']
        self.assertEqual({row['listing_id'] for row in rows(result, 'simulated_buy')}, {'CN:ALPHA', 'CN:BETA'})
        self.assertEqual(result['execution_failure_count'], 1)
        self.assertEqual(rows(result, 'policy_deployment_failed')[0]['reason'], 'DEFERRED_POLICY_REVIEW_UNRESOLVED')
        self.assertFalse(rows(result, 'policy_review_resumed'))

    def test_all_v3_receipts_match_the_separate_pre_change_source_baseline(self):
        from tests.research.bounded_fixtures import vectors as legacy_vectors
        expected = [
            'c1f4220343346c481e963bbe3326082d85ef70cefeab6f21a01fbd6a7b44a348',
            'c5d41c888634440e4b7c20f98de4ab8fa7be657613313ccf9bc8cde16adde3ca',
            '237294cf6676748346efa4770022818c2e36d14399e3a1b059a57e956d277f9f',
            'a7eceeac15e9a6e53699cf3ffb634390fc68b65964c815497efd18b84b7a2017',
            '2fea20c4d6827313a7e222e0bab863f4562debeece89bb80b82b5ddeb6efd9a9',
            'cbb82cfc0b0e3bb8c7aa17970655c81b312235106ef22ba89528896437b065b0',
            '4b985796e0cdbfc48ffe210409f40414b0382fa07074e554b7c9ffa051f0dcdf',
            '7a0f2a3b0e7256c4cd5e90e2cca975808af868aed7dd998be42b0ed2fc3e1bcd',
            '9e3c9b19beac5122dfb51bb4c67ae3add174976ad98b0f38598d8601de1c1f10',
        ]
        self.assertEqual([row['result']['result_hash'] for row in legacy_vectors()], expected)

    def test_unobserved_future_prices_cannot_change_the_precommit_deferral_evidence(self):
        data, plan, _ = case()
        before = compare_backtest(data, plan, plan['benchmark'], 'train')['strategy']
        for row in data['observations']:
            if row['observed_at'] >= '2025-01-06': row['value'] = '20'
        after = compare_backtest(data, plan, plan['benchmark'], 'train')['strategy']
        deferred = lambda result: next(row for row in rows(result, 'evaluation') if row['outcome'] == 'deferred')
        self.assertEqual(deferred(before), deferred(after))

    def test_without_actions_all_existing_economics_and_events_are_unchanged(self):
        data, plan, _ = case(); data['actions'] = []
        result = compare_backtest(data, plan, plan['benchmark'], 'train')['strategy']
        old = deepcopy(plan); old['schema_version'] = 'research-plan-v3'; old['execution'].pop('order_action_policy')
        legacy = compare_backtest(data, old, old['benchmark'], 'train')['strategy']
        for key in legacy:
            if key not in ('engine_version', 'policy_evaluation_counts', 'assumptions'):
                self.assertEqual(result[key], legacy[key], key)

    def test_new_continuous_semantics_are_not_silently_downgraded(self):
        from worker.investor.funded_study_input import prepare_funded_study_inputs
        data, plan, policy = case()
        result = prepare_funded_study_inputs({}, {'payload': {'dataset': data, 'plan': plan, 'policy': policy}},
            '2026-01-01T00:00:00Z', profile())
        self.assertEqual(result['reason_codes'], ['FUNDED_STUDY_ACTION_AWARE_EXECUTION_NOT_SUPPORTED'])
        self.assertEqual(result['inputs'], [])

    def test_unknown_at_decision_actions_are_not_used_as_future_information(self):
        for vector in vectors():
            data, result = vector['input']['dataset'], vector['result']['strategy']
            if data['actions'][0].get('ingested_at') or data['actions'][0]['published_at'] == '2025-01-05T08:00:00Z':
                self.assertEqual(result['policy_evaluation_counts']['deferred'], 0)
                self.assertGreater(result['execution_failure_count'], 0)

    def test_action_at_the_decision_is_already_processed_but_fill_boundary_is_inclusive(self):
        data, plan, _ = case()
        for at, deferred in [('2025-01-05T07:01:00Z', 0), ('2025-01-06T07:00:00Z', 1), ('2025-01-06T07:00:00.000001Z', 0)]:
            data['actions'][0]['at'] = at
            result = compare_backtest(data, plan, plan['benchmark'], 'train')['strategy']
            self.assertEqual(result['policy_evaluation_counts']['deferred'], deferred)

    def test_deferral_does_not_hide_initial_non_deployment_or_retry_without_declared_decision(self):
        vector = next(row for row in vectors() if len(row['input']['plan']['decision_times']) == 1)
        result = vector['result']['strategy']
        self.assertFalse(rows(result, 'research_order'))
        self.assertEqual(result['execution_failure_count'], 1)
        self.assertEqual(rows(result, 'policy_deployment_failed')[0]['reason'], 'INITIAL_DEPLOYMENT_NOT_EXECUTED')

    def test_new_funding_trigger_and_unused_policy_slot_survive_deferral(self):
        vector = next(row for row in vectors() if row['input']['plan']['contributions'])
        result = vector['result']['strategy']
        deferred = next(row for row in rows(result, 'evaluation') if row['outcome'] == 'deferred')
        self.assertIn('NEW_CASH_REPAIR', deferred['trigger_codes'])
        later = next(row for row in rows(result, 'evaluation') if row['at'] > deferred['at'] and row['outcome'] == 'proposed')
        self.assertIn('NEW_CASH_REPAIR', later['trigger_codes'])
        self.assertEqual(later['last_proposed_at'], deferred['last_proposed_at'])

    def test_new_contract_requires_explicit_policy_and_old_contract_rejects_it(self):
        data, plan, _ = case()
        for mutate in [lambda p: p['execution'].pop('order_action_policy'),
                       lambda p: p.update(schema_version='research-plan-v3'),
                       lambda p: p['execution'].update(order_action_policy='ignore_failures')]:
            changed = deepcopy(plan); mutate(changed)
            with self.assertRaises(WorkbenchError): validate_plan(changed, data)

    def test_price_bounds_and_selector_zero_gap_gate_remain_enforced(self):
        data, plan, policy = case()
        for row in data['observations']:
            if row['observed_at'].startswith('2025-01-07'):
                row['value'] = '20'
        visited = []
        from worker.investor.strategy import _summary
        def evaluate(parameters, phase):
            visited.append(phase)
            return _summary(compare_backtest(data, plan, parameters, phase))
        result = research_reference(data, plan, policy, profile('0.50'), allow_synthetic=True, evaluate=evaluate)
        self.assertEqual(result['status'], 'insufficient_evidence')
        self.assertEqual(set(visited), {'train'})
        self.assertTrue(all(row['train']['execution_failure_count'] > 0 for row in result['candidates']))


if __name__ == '__main__': unittest.main()
