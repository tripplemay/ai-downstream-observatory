"""Declared fictional execution interleavings, not a real trial or account."""

from copy import deepcopy
from datetime import timedelta
from decimal import Decimal

from tests.research.cash_intent_fixtures import cash_intent_case, partial_buy_case
from worker.orchestration.db import instant, stamp
from worker.research.rotation import run_rotation_portfolio
from worker.research.snapshot import validate_dataset, validate_plan


def interleaving_case(kind):
    if kind in ('partial_sale_wait', 'partial_sale_action', 'late_sale_settlement'):
        data, plan, parameters = partial_buy_case()
        data['actions'] = []
        parameters.update(weights={'CN:ALPHA': '0.4', 'CN:BETA': '0.2', 'US:GAMMA': '0.4'})
        plan['decision_times'] = ['2025-02-05T06:59:00Z' if at == '2025-02-05T07:01:00Z' else at
                                  for at in plan['decision_times']]
        for row in data['observations']:
            if row.get('listing_id') == 'US:GAMMA' and row['observed_at'] >= '2025-01-15': row['value'] = '4'
        plan['decision_times'] += ['2025-02-06T21:01:00Z', '2025-02-07T21:01:00Z']
        if kind == 'partial_sale_wait':
            for row in data['settlements']:
                if row['market'] == 'US' and row['session_date'] == '2025-02-05':
                    row['settled_at'] = stamp(instant(row['settled_at']) + timedelta(days=3))
        if kind == 'partial_sale_action':
            data['actions'].append({'id': 'fictional:remaining-sale-split', 'listing_id': 'US:GAMMA', 'type': 'split',
                'at': '2025-02-05T12:00:00Z', 'published_at': '2025-02-05T12:00:00Z', 'ratio': '2',
                'source_evidence': 'Invented action after domestic sale fill, not provider evidence'})
            for row in data['observations']:
                if row.get('listing_id') == 'US:GAMMA' and row['observed_at'] >= '2025-02-05T12': row['value'] = '2'
        if kind == 'late_sale_settlement':
            for row in data['settlements']:
                if row['market'] == 'US' and row['session_date'] == '2025-02-05':
                    row['settled_at'] = '2025-02-21T23:00:00Z'
    else:
        data, plan, parameters = cash_intent_case()
        if kind == 'repeated_sale_actions':
            for day in (6, 7):
                data['actions'].append({'id': 'fictional:repeated-sale-split:' + str(day), 'listing_id': 'CN:ALPHA', 'type': 'split',
                    'at': '2025-02-%02dT00:00:00Z' % day, 'published_at': '2025-02-%02dT00:00:00Z' % day,
                    'ratio': '2', 'source_evidence': 'Invented repeated action before replacement fill'})
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-02-06':
                    row['value'] = str(Decimal(row['value']) / (4 if row['observed_at'] >= '2025-02-07' else 2))
        elif kind == 'minimum_lot':
            data['assets'][1]['quantity_step'] = '50'
        elif kind == 'fees':
            plan['execution'].update(commission_bps='3', minimum_fee_cny='1.01', slippage_bps='5', fx_bps='20')
        else:
            raise ValueError('UNKNOWN_FICTIONAL_INTERLEAVING')
    plan['decision_times'] = sorted(set(plan['decision_times'] + ['2025-02-%02dT07:01:00Z' % day for day in range(6, 17)]))
    plan.update(parameter_candidates=[deepcopy(parameters)], benchmark=deepcopy(parameters))
    validate_dataset(data); validate_plan(plan, data)
    return data, plan, parameters


def vectors():
    result = []
    for kind in ('repeated_sale_actions', 'partial_sale_wait', 'partial_sale_action', 'late_sale_settlement', 'minimum_lot', 'fees'):
        data, plan, parameters = interleaving_case(kind)
        result.append({'kind': kind, 'dataset': data, 'plan': plan, 'parameters': parameters,
                       'result': run_rotation_portfolio(data, plan, parameters, 'train')})
    return result
