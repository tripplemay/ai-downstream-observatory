"""Fictional sale-funded buys; no real study values or replay."""
from copy import deepcopy

from tests.research.bounded_fixtures import case
from tests.research.fixed_policy_fixtures import policy_parameters


def sale_funded_case(sale_close='20'):
    data, plan, _ = case()
    parameters = policy_parameters()
    plan.update(schema_version='research-plan-v5', parameter_candidates=[deepcopy(parameters)],
                benchmark=deepcopy(parameters),
                decision_times=['2025-01-05T07:01:00Z', '2025-02-05T07:01:00Z'])
    plan['execution']['order_action_policy'] = 'defer_known_else_cancel_batch_and_reassess'
    plan['windows']['train']['end'] = '2025-02-20T23:00:00Z'
    for row in data['observations']:
        if row['listing_id'] == 'CN:ALPHA' and row['observed_at'] >= '2025-01-15':
            row['value'] = sale_close if row['observed_at'].startswith('2025-02-06') else '20'
    return data, plan, parameters


def preparation_input(cash='297.4'):
    return {'schema_version': 'settled-cash-buy-preparation-v1',
        'intent': {'id': 'fictional-cash-intent:1', 'declared_at': '2025-02-05T07:01:00Z',
            'deadline': '2025-02-20T23:00:00Z', 'policy_hash': 'a' * 64,
            'sale_order_ids': ['fictional-sale:1'], 'buy_listing_ids': ['CN:BETA']},
        'decision_at': '2025-02-08T07:01:00Z',
        'decision_times': ['2025-02-05T07:01:00Z', '2025-02-08T07:01:00Z', '2025-02-09T07:01:00Z'],
        'cash': {'as_of': '2025-02-08T07:01:00Z', 'settled_cny': cash, 'reserved_cny': '0', 'floor_cny': '0'},
        'book': [{'id': 'fictional-sale:1', 'listing_id': 'CN:ALPHA', 'side': 'sell',
            'cash_intent_id': 'fictional-cash-intent:1', 'state': 'settled', 'settled_at': '2025-02-07T09:00:00Z'}],
        'needs': [{'listing_id': 'CN:BETA', 'order_id': 'fictional-new-buy:1', 'need_cny': '310',
            'quantity_step': '1', 'currency': 'CNY', 'close': '10', 'fx_cny_per_unit': '1',
            'observed_at': '2025-02-08T07:00:00Z', 'available_at': '2025-02-08T07:01:00Z',
            'fx_observed_at': None, 'fx_available_at': None, 'mark_kind': 'observed_close',
            'price_observation_id': 'fictional-price:1', 'fx_observation_id': 'fx:CNY:constant'}],
        'execution': {'commission_bps': '0', 'minimum_fee_cny': '0', 'fx_bps': '0', 'slippage_bps': '0',
            'buy_price_buffer_bps': '200', 'buy_fx_buffer_bps': '200', 'cash_quantum': '0.01',
            'max_fx_age_seconds': 86400}}


def preparation_vectors():
    from worker.orchestration.db import WorkbenchError
    from worker.research.settled_funding import prepare_settled_cash_buys
    values = []
    for mode in ('smaller_sale', 'larger_sale', 'reserved_cash', 'foreign_hk', 'foreign_us', 'two_buys',
                 'fee_ceiling', 'unsettled', 'failed_sale', 'unknown_sale', 'already_published',
                 'same_order_id', 'undeclared_decision', 'expired', 'old_close', 'carry_close',
                 'late_quote', 'stale_cash', 'no_cash', 'below_lot', 'extra_projected_sales', 'stale_fx',
                 'exact_fx_age', 'micro_stale_fx', 'scope_subset', 'future_settlement', 'multiple_sales',
                 'missing_second_settlement', 'rounding_remainder', 'sizing_range', 'duplicate_buy_id',
                 'old_frozen_quantity', 'integer_json_seconds', 'overprecise_time', 'large_cent_short', 'large_cent_room'):
        value = preparation_input('287' if mode == 'larger_sale' else '297.4')
        need = value['needs'][0]
        if mode == 'reserved_cash': value['cash'].update(reserved_cny='100', floor_cny='20')
        if mode in ('foreign_hk', 'foreign_us', 'stale_fx', 'exact_fx_age', 'micro_stale_fx'):
            market, currency = ('HK', 'HKD') if mode == 'foreign_hk' else ('US', 'USD')
            need.update(listing_id=market + ':BETA', currency=currency, fx_cny_per_unit='5',
                fx_observed_at='2025-02-08T06:00:00Z', fx_available_at='2025-02-08T06:01:00Z', fx_observation_id='fictional-fx:1')
            value['intent']['buy_listing_ids'] = [need['listing_id']]
        if mode == 'stale_fx': need.update(fx_observed_at='2025-02-01T06:00:00Z', fx_available_at='2025-02-01T06:01:00Z')
        if mode in ('exact_fx_age', 'micro_stale_fx'):
            need.update(fx_observed_at='2025-02-07T07:01:00Z' if mode == 'exact_fx_age' else '2025-02-07T07:00:59.999999Z',
                        fx_available_at='2025-02-07T07:01:00Z')
        if mode == 'rounding_remainder':
            value['cash']['settled_cny'] = '0.03'; need.update(need_cny='1', close='0.001', quantity_step='0.001')
        if mode in ('two_buys', 'duplicate_buy_id', 'rounding_remainder'):
            second = {**need, 'listing_id': 'CN:GAMMA', 'order_id': 'fictional-new-buy:2', 'need_cny': '100', 'close': '5',
                'price_observation_id': 'fictional-price:2'}
            if mode == 'rounding_remainder': second.update(need_cny='1', close='0.001')
            if mode == 'duplicate_buy_id': second['order_id'] = need['order_id']
            value['needs'].append(second); value['intent']['buy_listing_ids'].append('CN:GAMMA')
        if mode == 'fee_ceiling': value['execution'].update(commission_bps='3', minimum_fee_cny='1.01', slippage_bps='5')
        if mode == 'unsettled': value['book'][0].update(state='filled', settled_at=None)
        if mode == 'failed_sale': value['book'][0].update(state='skipped', settled_at=None)
        if mode == 'unknown_sale': value['intent']['sale_order_ids'].append('unknown-sale')
        if mode == 'already_published': value['book'].append({'id': 'previous-buy', 'listing_id': 'CN:BETA', 'side': 'buy',
            'cash_intent_id': value['intent']['id'], 'state': 'skipped', 'settled_at': None})
        if mode == 'same_order_id': need['order_id'] = value['book'][0]['id']
        if mode == 'undeclared_decision': value['decision_times'].pop(1)
        if mode == 'expired': value['intent']['deadline'] = value['decision_at']
        if mode == 'old_close': need.update(observed_at='2025-02-07T07:00:00Z', available_at='2025-02-07T07:01:00Z')
        if mode == 'carry_close': need['mark_kind'] = 'theoretical_ex_action_carry'
        if mode == 'late_quote': need['available_at'] = '2025-02-08T07:01:00.000001Z'
        if mode == 'stale_cash': value['cash']['as_of'] = '2025-02-08T07:00:00Z'
        if mode == 'no_cash': value['cash']['reserved_cny'] = '300'
        if mode == 'below_lot': need['quantity_step'] = '100'
        if mode == 'extra_projected_sales': value['cash']['projected_sale_proceeds_cny'] = '999'
        if mode in ('scope_subset', 'multiple_sales', 'missing_second_settlement'):
            value['book'].append({**value['book'][0], 'id': 'fictional-sale:2', 'listing_id': 'CN:DELTA', 'settled_at': '2025-02-07T10:00:00Z'})
            if mode != 'scope_subset': value['intent']['sale_order_ids'].append('fictional-sale:2')
            if mode == 'missing_second_settlement': value['book'][-1].update(state='filled', settled_at=None)
        if mode == 'future_settlement': value['book'][0]['settled_at'] = '2025-02-09T09:00:00Z'
        if mode == 'sizing_range':
            value['cash']['settled_cny'] = '1000000000000000000'
            need.update(need_cny='1000000000000000000', close='0.000000000000000001')
        if mode == 'old_frozen_quantity': need['quantity'] = '29'
        if mode == 'integer_json_seconds': value['execution']['max_fx_age_seconds'] = 86400.0
        if mode == 'overprecise_time': need['available_at'] = '2025-02-08T07:01:00.0000001Z'
        if mode in ('large_cent_short', 'large_cent_room'):
            value['cash']['settled_cny'] = str(10**37 + (11 if mode == 'large_cent_short' else 12))
            need.update(currency='USD', close='10000000000000000000.000000000000000001',
                fx_cny_per_unit='1000000000000000000.000000000000000001',
                need_cny=value['cash']['settled_cny'], fx_observed_at='2025-02-08T06:00:00Z',
                fx_available_at='2025-02-08T06:01:00Z')
            value['execution'].update(buy_price_buffer_bps='0', buy_fx_buffer_bps='0')
        try:
            result = {'prepared': prepare_settled_cash_buys(value)}
        except WorkbenchError as error:
            result = {'blocked': str(error)}
        values.append({'kind': mode, 'input': value, 'result': result})
    return values
