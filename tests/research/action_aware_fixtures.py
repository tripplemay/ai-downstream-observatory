"""Fictional causal execution cases, not retuned real studies."""
from copy import deepcopy

from tests.research.bounded_fixtures import case as bounded_case, foreign_case
from worker.research.backtest import compare_backtest
from worker.orchestration.db import instant


def case():
    data, plan, policy = bounded_case()
    plan['schema_version'] = 'research-plan-v4'
    plan['execution']['order_action_policy'] = 'defer_known_scheduled_action_before_commit'
    data['actions'] = [{'id': 'invented:dividend', 'listing_id': 'CN:ALPHA', 'type': 'dividend',
        'at': '2025-01-06T00:00:00Z', 'published_at': '2024-12-01T00:00:00Z',
        'gross_per_unit': '0.1', 'tax_per_unit': '0.01', 'pay_at': '2025-01-08T00:00:00Z',
        'source_evidence': 'Invented causal execution case'}]
    return data, plan, policy


def vectors():
    values = []
    for mode in ('known', 'late_publication', 'late_ingestion', 'split', 'multiple', 'no_later_decision', 'funding', 'dependent_sale', 'unresolved_rebalance'):
        data, plan, _ = case()
        if mode == 'late_publication':
            data['actions'][0]['published_at'] = '2025-01-05T08:00:00Z'
        if mode == 'late_ingestion':
            data['mode'] = 'actual_replay'
            for row in data['observations']:
                row['provenance'] = 'live_observed'
            for row in data['settlements']:
                row['ingested_at'] = '2024-12-01T00:00:00Z'
            data['actions'][0]['ingested_at'] = '2025-01-05T08:00:00Z'
        if mode in ('split', 'multiple'):
            split = {key: value for key, value in data['actions'][0].items()
                     if key not in ('gross_per_unit', 'tax_per_unit', 'pay_at')}
            split.update(id='invented:split', type='split', ratio='2')
            data['actions'] = [split] if mode == 'split' else [data['actions'][0], split]
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-06':
                    row['value'] = '5'
        if mode == 'no_later_decision':
            plan['decision_times'] = ['2025-01-05T07:01:00Z']
        if mode == 'funding':
            data['actions'][0]['at'] = '2025-01-13T00:00:00Z'
            data['actions'][0]['pay_at'] = '2025-01-15T00:00:00Z'
            plan['contributions'] = [{'at': '2025-01-12T00:00:00Z', 'amount_cny': '300'}]
            for parameters in [*plan['parameter_candidates'], plan['benchmark']]:
                parameters['class_drift_threshold'] = '0.99'
        if mode in ('dependent_sale', 'unresolved_rebalance'):
            plan['windows']['train']['end'] = '2025-02-20T23:00:00Z'
            data['actions'][0].update(at='2025-02-05T00:00:00Z', pay_at='2025-02-07T00:00:00Z')
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-15':
                    row['value'] = '20'
            if mode == 'unresolved_rebalance':
                plan['decision_times'] = [at for at in plan['decision_times'] if instant(at) <= instant('2025-02-04T07:01:00Z')]
        for phase in (('train', 'validation', 'holdout') if mode == 'known' else ('train',)):
            value = {'dataset': deepcopy(data), 'plan': deepcopy(plan), 'parameters': deepcopy(plan['benchmark']), 'phase': phase}
            values.append({'input': value, 'result': compare_backtest(**value)})
    for market in ('HK', 'US'):
        data, plan, parameters = foreign_case(market)
        plan['schema_version'] = 'research-plan-v4'
        plan['execution']['order_action_policy'] = 'defer_known_scheduled_action_before_commit'
        data['actions'] = [{**case()[0]['actions'][0], 'listing_id': market + ':ALPHA',
            'at': '2025-01-05T08:00:00Z' if market == 'HK' else '2025-01-05T12:00:00Z'}]
        value = {'dataset': data, 'plan': plan, 'parameters': parameters, 'phase': 'train'}
        values.append({'input': value, 'result': compare_backtest(**value)})
    return values
