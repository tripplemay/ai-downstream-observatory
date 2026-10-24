"""Fictional post-event order lifecycles, never real trial replay."""
from copy import deepcopy

from tests.research.action_aware_fixtures import case as precommit_case
from tests.research.bounded_fixtures import foreign_case
from worker.research.backtest import compare_backtest


def case():
    data, plan, policy = precommit_case()
    plan['schema_version'] = 'research-plan-v5'
    plan['execution']['order_action_policy'] = 'defer_known_else_cancel_batch_and_reassess'
    policy.update(schema_version='investor-strategy-policy-v2', execution_admission='causal_review_zero_terminal_gaps')
    data['actions'][0]['published_at'] = data['actions'][0]['at']
    return data, plan, policy


def vectors():
    values = []
    for mode in ('late_action', 'known_action', 'repeated_action', 'failed_replacement', 'no_decision', 'missing_fresh_close', 'funding_during_sale_review'):
        data, plan, _ = case()
        if mode == 'known_action': data['actions'][0]['published_at'] = '2024-12-01T00:00:00Z'
        if mode == 'repeated_action':
            split = {'id': 'invented:second-split', 'listing_id': 'CN:ALPHA', 'type': 'split', 'ratio': '2',
                     'at': '2025-01-07T00:00:00Z', 'published_at': '2025-01-07T00:00:00Z', 'source_evidence': 'Invented split'}
            data['actions'].append(split)
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-07': row['value'] = '5'
        if mode == 'failed_replacement':
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'].startswith('2025-01-07'): row['value'] = '20'
        if mode == 'no_decision': plan['decision_times'] = ['2025-01-05T07:01:00Z']
        if mode == 'missing_fresh_close':
            data['observations'] = [row for row in data['observations'] if not (row['listing_id'] == 'CN:ALPHA'
                and '2025-01-06' <= row['observed_at'] < '2025-01-09')]
        if mode == 'funding_during_sale_review':
            plan['windows']['train']['end'] = '2025-02-20T23:00:00Z'
            data['actions'][0].update(at='2025-02-05T00:00:00Z', published_at='2025-02-05T00:00:00Z',
                                      pay_at='2025-02-07T00:00:00Z')
            plan['contributions'] = [{'at': '2025-02-05T06:00:00Z', 'amount_cny': '1'}]
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-15': row['value'] = '20'
        value = {'dataset': data, 'plan': plan, 'parameters': deepcopy(plan['benchmark']), 'phase': 'train'}
        values.append({'kind': mode, 'input': value, 'result': compare_backtest(**value)})
    data, plan, parameters = foreign_case('US')
    plan['schema_version'] = 'research-plan-v5'
    plan['execution']['order_action_policy'] = 'defer_known_else_cancel_batch_and_reassess'
    for row in data['observations']:
        if row['metric'] == 'fx_cny_per_unit': row['value'] = '5'
    data['actions'] = [{**case()[0]['actions'][0], 'listing_id': 'CN:BETA'}]
    value = {'dataset': data, 'plan': plan, 'parameters': parameters, 'phase': 'train'}
    values.append({'kind': 'partial_fill', 'input': value, 'result': compare_backtest(**value)})
    return values
