"""Invented prices and cash; no market history, account or strategy recommendation."""


def buy_input():
    return {'schema_version': 'bounded-cash-buy-input-v1', 'qualification': 'synthetic_test_only',
            'batch_id': 'synthetic:batch', 'decision_at': '2025-01-02T08:00:00.000000Z',
            'policy': {'schema_version': 'bounded-cash-buy-policy-v1', 'price_buffer_bps': '200', 'commission_bps': '5',
                       'minimum_fee_cny': '2', 'slippage_bps': '0', 'cash_quantum': '0.01', 'max_quote_age_seconds': 3600},
            'settled_cash_cny': '1202', 'unsettled_receivable_cny': '5000',
            'existing_reservations': [{'order_id': 'synthetic:prior-order', 'budget_cny': '200'}],
            'orders': [{'order_id': 'synthetic:buy-a', 'listing_id': 'CN:SYNTHETIC_A', 'market': 'CN', 'currency': 'CNY',
                        'allocated_budget_cny': '1002', 'quantity_step': '10',
                        'decision_quote': {'id': 'synthetic:decision-a', 'close': '10',
                                           'observed_at': '2025-01-02T07:00:00.000000Z', 'known_at': '2025-01-02T07:01:00.000000Z',
                                           'valid_until': '2025-01-02T09:00:00.000000Z'},
                        'execute_at': '2025-01-03T07:00:00.000000Z', 'expires_at': '2025-01-03T08:00:00.000000Z'}]}


def buy_outcome(value=None, close='10.12'):
    value = value or buy_input()
    return {'schema_version': 'bounded-cash-buy-outcome-input-v1', 'qualification': 'synthetic_test_only',
            'evaluated_at': max(row['expires_at'] for row in value['orders']),
            'observations': [{'order_id': row['order_id'], 'quote_id': 'synthetic:execution-' + str(index), 'close': close,
                              'observed_at': row['execute_at'], 'known_at': row['execute_at'], 'corporate_action_since_decision': False}
                             for index, row in enumerate(value['orders'])]}
