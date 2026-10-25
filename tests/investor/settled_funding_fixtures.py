"""Fictional annual capital and prices; no provider, account or personal policy."""

from copy import deepcopy
from datetime import timedelta

from tests.investor.bounded_funding_fixtures import bounded_input, vector
from tests.investor.event_review_funding_fixtures import documents as event_documents
from worker.orchestration.db import instant, stamp


def settled_input(years=1):
    value = bounded_input(years)
    value['schema_version'] = 'investor-funded-history-input-v4'
    value['context']['execution'].update(
        order_action_policy='defer_known_else_cancel_batch_and_reassess',
        buy_funding_policy='declare_sales_then_freeze_buy_from_settled_cash')
    return value


def documents():
    sales = settled_input()
    for row in sales['dataset']['observations']:
        if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2015-01-15':
            row['value'] = '20'
    orphan = deepcopy(sales)
    orphan['context']['decision_times'] = ['2015-01-01T07:01:00Z', '2015-02-05T07:01:00Z']
    result = {'sale_settlement': sales, 'orphan': orphan}
    three = deepcopy(sales)
    three['dataset']['assets'][1].update(listing_id='HK:BETA', market='HK', currency='HKD')
    three['dataset']['assets'].append({**sales['dataset']['assets'][0], 'listing_id': 'US:GAMMA', 'market': 'US', 'currency': 'USD'})
    three['context']['parameters'].update(weights={'CN:ALPHA': '0.4', 'HK:BETA': '0.4', 'US:GAMMA': '0.2'},
        roles={'CN:ALPHA': 'growth', 'HK:BETA': 'defensive', 'US:GAMMA': 'diversifier'})
    for row in three['dataset']['observations']:
        if row['listing_id'] == 'CN:BETA': row.update(listing_id='HK:BETA', series_key='HK:BETA', unit='HKD')
    quotes = {row['observed_at']: row for row in sales['dataset']['observations'] if row['listing_id'] == 'CN:ALPHA'}
    for session in sales['dataset']['sessions']:
        close = instant(session['close_at']).replace(hour=21)
        available = stamp(close + timedelta(minutes=1))
        three['dataset']['sessions'].extend([{**session, 'market': 'HK'},
            {**session, 'market': 'US', 'close_at': stamp(close), 'available_at': available}])
        if available < '2015-12-31T15:59:59.999000Z': three['context']['decision_times'].append(available)
        quote = deepcopy(quotes[session['close_at']])
        three['dataset']['observations'].append({**quote, 'id': 'us:' + session['session_date'], 'listing_id': 'US:GAMMA',
            'series_key': 'US:GAMMA', 'unit': 'USD', 'observed_at': stamp(close), 'published_at': available, 'ingested_at': available})
        quote.pop('listing_id')
        at = stamp(instant(session['close_at']) - timedelta(hours=1))
        for currency, rate in (('HKD', '0.5'), ('USD', '2')):
            three['dataset']['observations'].append({**quote, 'id': 'fx:' + currency + ':' + session['session_date'],
                'series_key': 'FX:' + currency, 'metric': 'fx_cny_per_unit', 'unit': 'CNY_per_unit_currency',
                'price_basis': 'not_applicable', 'value': rate, 'observed_at': at, 'published_at': at, 'ingested_at': at})
    for row in sales['dataset']['settlements']:
        three['dataset']['settlements'].extend([{**row, 'market': 'HK'}, {**row, 'market': 'US'}])
    three['context']['decision_times'] = sorted(set(three['context']['decision_times']))
    result['three_markets'] = three
    for name, value in event_documents().items():
        value['schema_version'] = 'investor-funded-history-input-v4'
        value['context']['execution']['buy_funding_policy'] = 'declare_sales_then_freeze_buy_from_settled_cash'
        result[name] = value
    return result


def vectors():
    return [vector(name, value) for name, value in documents().items()
            if name in ('sale_settlement', 'orphan', 'pending_action', 'foreign_fx_breach_costs', 'three_markets')]
