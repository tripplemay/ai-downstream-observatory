"""Declared fictional v6 kernel inputs; never provider or personal evidence."""
from decimal import Decimal
from copy import deepcopy
from datetime import timedelta

from tests.research.settled_funding_fixtures import sale_funded_case
from worker.research.rotation import run_rotation_portfolio
from worker.research.snapshot import validate_dataset, validate_plan
from worker.orchestration.db import instant, stamp


def cash_intent_case(price='19.8'):
    data, plan, parameters = sale_funded_case(price)
    plan['schema_version'] = 'research-plan-v6'
    plan['execution']['buy_funding_policy'] = 'declare_sales_then_freeze_buy_from_settled_cash'
    plan['decision_times'] += ['2025-02-08T07:01:00Z', '2025-02-09T07:01:00Z', '2025-02-10T07:01:00Z']
    return data, plan, parameters


def partial_buy_case():
    data, plan, parameters = cash_intent_case()
    data['assets'].append({**data['assets'][1], 'listing_id': 'US:GAMMA', 'market': 'US', 'currency': 'USD'})
    shift = lambda value: stamp(instant(value) + timedelta(hours=14))
    for row in list(data['sessions']):
        data['sessions'].append({**row, 'market': 'US', 'close_at': shift(row['close_at']), 'available_at': shift(row['available_at'])})
    for row in list(data['settlements']):
        data['settlements'].append({**row, 'market': 'US', 'settled_at': shift(row['settled_at'])})
    for original in list(data['observations']):
        if original['listing_id'] != 'CN:BETA': continue
        row = {**original, 'id': original['id'].replace('CN:BETA', 'US:GAMMA'), 'listing_id': 'US:GAMMA',
               'series_key': 'US:GAMMA', 'unit': 'USD', 'value': '2'}
        for field in ('observed_at', 'published_at', 'ingested_at'): row[field] = shift(row[field])
        data['observations'].append(row)
        fx = {**row, 'id': row['id'].replace('US:GAMMA', 'FX:USD'), 'series_key': 'FX:USD',
              'metric': 'fx_cny_per_unit', 'unit': 'CNY_per_unit_currency', 'price_basis': 'not_applicable', 'value': '5'}
        del fx['listing_id']
        data['observations'].append(fx)
    parameters['weights'] = {'CN:ALPHA': '0.5', 'CN:BETA': '0.25', 'US:GAMMA': '0.25'}
    parameters['roles']['US:GAMMA'] = 'diversifier'
    plan.update(parameter_candidates=[deepcopy(parameters)], benchmark=deepcopy(parameters))
    plan['decision_times'] += ['2025-02-%02dT07:01:00Z' % day for day in range(11, 17)]
    data['actions'].append({'id': 'fictional:remaining-buy-action', 'listing_id': 'CN:BETA', 'type': 'dividend',
        'at': '2025-02-09T00:00:00Z', 'published_at': '2025-02-09T00:00:00Z', 'gross_per_unit': '0.1',
        'tax_per_unit': '0', 'pay_at': '2025-02-10T09:00:00Z', 'source_evidence': 'Invented action after other market fill'})
    return data, plan, parameters


def vectors():
    rows = []
    for kind in ('smaller_sale', 'larger_sale', 'no_decision', 'buy_failure', 'sale_review', 'buy_review', 'fresh_close', 'new_funding', 'sale_unneeded', 'partial_buy'):
        data, plan, parameters = partial_buy_case() if kind == 'partial_buy' else cash_intent_case('19' if kind == 'larger_sale' else '19.8')
        if kind == 'no_decision': plan['decision_times'] = plan['decision_times'][:2]
        if kind == 'buy_failure':
            for row in data['observations']:
                if row['listing_id'] == 'CN:BETA' and row['observed_at'].startswith('2025-02-09'): row['value'] = '20'
        if kind in ('sale_review', 'buy_review', 'sale_unneeded'):
            plan['decision_times'] += ['2025-02-11T07:01:00Z', '2025-02-12T07:01:00Z', '2025-02-13T07:01:00Z']
        if kind == 'sale_review':
            data['actions'].append({'id': 'fictional:sale-split', 'listing_id': 'CN:ALPHA', 'type': 'split',
                'at': '2025-02-06T00:00:00Z', 'published_at': '2025-02-06T00:00:00Z',
                'ratio': '2', 'source_evidence': 'Invented late sale action'})
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-02-06': row['value'] = str(Decimal(row['value']) / 2)
        if kind in ('buy_review', 'fresh_close'):
            at = '2025-02-09T00:00:00Z' if kind == 'buy_review' else '2025-02-08T07:00:30Z'
            data['actions'].append({'id': 'fictional:buy-dividend', 'listing_id': 'CN:BETA', 'type': 'dividend',
                'at': at, 'published_at': at, 'gross_per_unit': '0.1', 'tax_per_unit': '0',
                'pay_at': '2025-02-10T09:00:00Z', 'source_evidence': 'Invented buy action'})
        if kind in ('new_funding', 'sale_unneeded'):
            plan['contributions'] = [{'at': '2025-02-07T12:00:00Z', 'amount_cny': '1000' if kind == 'sale_unneeded' else '1'}]
        if kind == 'sale_unneeded':
            data['actions'].append({'id': 'fictional:sale-zero-dividend', 'listing_id': 'CN:ALPHA', 'type': 'dividend',
                'at': '2025-02-06T00:00:00Z', 'published_at': '2025-02-06T00:00:00Z', 'gross_per_unit': '0',
                'tax_per_unit': '0', 'pay_at': '2025-02-07T09:00:00Z', 'source_evidence': 'Invented zero distribution'})
            for row in data['observations']:
                if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-02-06': row['value'] = '5'
        validate_dataset(data); validate_plan(plan, data)
        result = run_rotation_portfolio(data, plan, parameters, 'train')
        rows.append({'kind': kind, 'dataset': data, 'plan': plan, 'parameters': parameters, 'result': result})
    return rows
