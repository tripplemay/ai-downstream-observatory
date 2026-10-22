"""Generic v3 execution parameters, not recommended buffers or real history."""

from copy import deepcopy
from datetime import timedelta

from tests.investor.fixtures import fixed_policy_input
from tests.research.test_rotation import flat
from worker.orchestration.db import instant, stamp
from worker.research.backtest import compare_backtest
from tests.research.fixed_policy_fixtures import policy_parameters


def bounded_plan(plan, price_buffer='200', fx_buffer='200'):
    value = deepcopy(plan)
    value['schema_version'] = 'research-plan-v3'
    value['execution'].update(model='next_session_close_bounded_fixed_quantity', buy_price_buffer_bps=price_buffer, buy_fx_buffer_bps=fx_buffer, cash_quantum='0.01')
    return value


def case(*, flat_prices=True):
    data, plan, policy = fixed_policy_input()
    if flat_prices:
        flat(data)
    return data, bounded_plan(plan), policy


def foreign_case(market='US'):
    data, plan, _ = case()
    currency, close_hour = ('USD', 20) if market == 'US' else ('HKD', 8)
    identity = market + ':ALPHA'
    data['assets'][0].update(listing_id=identity, market=market, currency=currency)
    parameters = policy_parameters({identity: '0.5', 'CN:BETA': '0.5'})
    parameters['roles'] = {identity: 'growth', 'CN:BETA': 'defensive'}
    plan.update(parameter_candidates=[parameters], benchmark=deepcopy(parameters))
    plan['execution']['max_fx_age_seconds'] = 86400
    original_sessions = deepcopy(data['sessions'])
    for row in data['observations']:
        if row['listing_id'] == 'CN:ALPHA':
            at = instant(row['observed_at']).replace(hour=close_hour)
            row.update(listing_id=identity, series_key=identity, id=identity + ':' + row['observed_at'][:10], unit=currency,
                       observed_at=stamp(at), published_at=stamp(at + timedelta(minutes=1)), ingested_at=stamp(at + timedelta(minutes=1)))
    for session, settlement in zip(original_sessions, deepcopy(data['settlements'])):
        at = instant(session['close_at']).replace(hour=close_hour)
        data['sessions'].append({**session, 'market': market, 'close_at': stamp(at), 'available_at': stamp(at + timedelta(minutes=1))})
        data['settlements'].append({**settlement, 'market': market, 'settled_at': stamp(at + timedelta(days=1, hours=2))})
        template = deepcopy(data['observations'][1])
        template.pop('listing_id', None)
        observed = at.replace(hour=6)
        template.update(id='fx:' + currency + ':' + session['session_date'], series_key='FX:' + currency,
                        metric='fx_cny_per_unit', value='5' if session['session_date'] <= '2025-01-05' else '5.11',
                        unit='CNY_per_unit_currency', price_basis='not_applicable', observed_at=stamp(observed),
                        published_at=stamp(observed + timedelta(minutes=1)), ingested_at=stamp(observed + timedelta(minutes=1)))
        data['observations'].append(template)
    extra = deepcopy(data['observations'][-1])
    at = instant('2025-01-05T07:30:00Z')
    extra.update(id='fx:' + currency + ':intraday', value='5.11', observed_at=stamp(at), published_at=stamp(at), ingested_at=stamp(at))
    data['observations'].append(extra)
    plan['decision_times'] = sorted(row['available_at'] for row in data['sessions'])
    return data, plan, parameters


def vectors():
    values = []
    for flat_prices in (True, False):
        data, plan, _ = case(flat_prices=flat_prices)
        parameters = policy_parameters()
        plan.update(parameter_candidates=[parameters], benchmark=deepcopy(parameters))
        for phase in ('train', 'validation', 'holdout'):
            values.append({'dataset': deepcopy(data), 'plan': deepcopy(plan), 'parameters': deepcopy(parameters), 'phase': phase})
    for market in ('HK', 'US'):
        data, plan, parameters = foreign_case(market)
        values.append({'dataset': data, 'plan': plan, 'parameters': parameters, 'phase': 'train'})
    data, plan, _ = case()
    parameters = policy_parameters()
    plan.update(parameter_candidates=[parameters], benchmark=deepcopy(parameters))
    plan['execution'].update(commission_bps='3', minimum_fee_cny='2', slippage_bps='5')
    plan['contributions'] = [{'at': '2025-01-12T00:00:00Z', 'amount_cny': '300'}]
    common = {'listing_id': 'CN:ALPHA', 'at': '2025-01-10T00:00:00Z', 'published_at': '2024-12-01T00:00:00Z', 'source_evidence': 'Invented actions'}
    data['actions'] = [{**common, 'id': 's', 'type': 'split', 'ratio': '2'},
                       {**common, 'id': 'd', 'type': 'dividend', 'gross_per_unit': '0.1', 'tax_per_unit': '0.01', 'pay_at': '2025-01-12T00:00:00Z'}]
    for row in data['observations']:
        if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-10':
            row['value'] = '4.9'
    values.append({'dataset': data, 'plan': plan, 'parameters': parameters, 'phase': 'train'})
    return [{'input': value, 'result': compare_backtest(**value)} for value in values]
