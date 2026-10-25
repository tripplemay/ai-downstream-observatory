"""Unpublished buy preparation from an already settled, current research book.

This arithmetic boundary is not source, intent-lineage, strategy or account
admission. Only the explicit v6 direct kernel invokes v2; ordinary admission
and the default investor runtime still reject that unintegrated plan version.
"""
from datetime import timedelta
from decimal import ROUND_CEILING, ROUND_FLOOR, localcontext
import re

from worker.accounting import canonical, decimal
from worker.accounting.decimal_math import AccountingError, fact_decimal, financial
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp


def _require(value, code='SETTLED_FUNDING_INPUT_INVALID'):
    if not value:
        raise WorkbenchError(code)


def _object(value, fields):
    _require(type(value) is dict and set(value) == set(fields.split()))
    return value


def _ids(value, maximum, *, empty=False):
    _require(type(value) is list and (0 if empty else 1) <= len(value) <= maximum)
    _require(all(type(item) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}', item) for item in value))
    _require(len(set(value)) == len(value))
    return value


def _number(value, *, positive=False):
    try:
        _require(type(value) is str and len(value) <= 100)
        number = fact_decimal(value)
        _require(number > 0 if positive else number >= 0)
        return number
    except AccountingError:
        raise WorkbenchError('SETTLED_FUNDING_INPUT_INVALID') from None


def _time(value):
    try:
        _require(type(value) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z', value))
        return instant(value)
    except (ValueError, TypeError):
        raise WorkbenchError('SETTLED_FUNDING_INPUT_INVALID') from None


@financial
def prepare_settled_cash_buys(value):
    with localcontext() as arithmetic:
        # Preserve products across the full fact range until the final cent ceiling.
        arithmetic.prec = 256
        return _prepare(value)


def _prepare(value):
    _object(value, 'schema_version intent decision_at decision_times cash book needs execution')
    _require(value['schema_version'] in ('settled-cash-buy-preparation-v1', 'settled-cash-buy-preparation-v2'))
    reviewed_leaves = value['schema_version'] == 'settled-cash-buy-preparation-v2'
    intent = _object(value['intent'], 'id declared_at deadline policy_hash sale_order_ids buy_listing_ids')
    _ids([intent['id']], 1)
    _require(type(intent['policy_hash']) is str and re.fullmatch(r'[a-f0-9]{64}', intent['policy_hash']))
    sales, scope = _ids(intent['sale_order_ids'], 100, empty=reviewed_leaves), _ids(intent['buy_listing_ids'], 20)
    declared, deadline, at = _time(intent['declared_at']), _time(intent['deadline']), _time(value['decision_at'])
    _require(declared < deadline)
    _require(type(value['decision_times']) is list and 0 < len(value['decision_times']) <= 30000)
    decisions = [_time(item) for item in value['decision_times']]
    _require(decisions == sorted(set(decisions)))
    _require(at in decisions and at > declared, 'SETTLED_FUNDING_DECISION_NOT_DECLARED')
    _require(at < deadline, 'SETTLED_FUNDING_INTENT_EXPIRED')
    _require(type(value['book']) is list and (0 if reviewed_leaves else 1) <= len(value['book']) <= 10000)
    book = {}
    for row in value['book']:
        _object(row, 'id listing_id side cash_intent_id state settled_at')
        _ids([row['id']], 1); _ids([row['listing_id']], 1)
        if row['cash_intent_id'] is not None:
            _ids([row['cash_intent_id']], 1)
        _require(row['id'] not in book and row['side'] in ('buy', 'sell')
                 and row['state'] in ('scheduled', 'waiting_for_sales', 'filled', 'settled', 'skipped', 'expired'))
        _require(row['settled_at'] is None or _time(row['settled_at']) <= at)
        book[row['id']] = row
    linked = [row for row in book.values() if row['cash_intent_id'] == intent['id']]
    _require(not any(row['side'] == 'buy' for row in linked), 'SETTLED_FUNDING_BUY_ALREADY_PUBLISHED')
    _require({row['id'] for row in linked} == set(sales), 'SETTLED_FUNDING_SCOPE_MISMATCH')
    _require(all(book[key]['state'] not in ('skipped', 'expired') for key in sales), 'SETTLED_FUNDING_SALE_FAILED')
    _require(all(book[key]['state'] == 'settled' and book[key]['settled_at'] is not None for key in sales),
             'SETTLED_FUNDING_SALES_UNSETTLED')
    _require(all(_time(book[key]['settled_at']) > declared for key in sales), 'SETTLED_FUNDING_SALES_UNSETTLED')
    settled = max((_time(book[key]['settled_at']) for key in sales), default=None)
    _require(settled is None or declared < settled < at, 'SETTLED_FUNDING_SALES_UNSETTLED')
    cash = _object(value['cash'], 'as_of settled_cny reserved_cny floor_cny')
    _require(_time(cash['as_of']) == at, 'SETTLED_FUNDING_CASH_SNAPSHOT_STALE')
    available = max(decimal('0'), _number(cash['settled_cny']) - _number(cash['reserved_cny']) - _number(cash['floor_cny']))
    _require(available > 0, 'SETTLED_FUNDING_NO_AVAILABLE_CASH')
    execution = _object(value['execution'], 'commission_bps minimum_fee_cny fx_bps slippage_bps buy_price_buffer_bps buy_fx_buffer_bps cash_quantum max_fx_age_seconds')
    rates = {key: _number(execution[key]) for key in ('commission_bps', 'fx_bps', 'slippage_bps', 'buy_price_buffer_bps', 'buy_fx_buffer_bps')}
    _require(all(amount <= 10000 for amount in rates.values()) and rates['slippage_bps'] < 10000)
    minimum = _number(execution['minimum_fee_cny'])
    _require(execution['cash_quantum'] == '0.01')
    age = execution['max_fx_age_seconds']
    _require(type(age) in (int, float) and 0 < age <= 31536000 and int(age) == age)
    age = int(age)
    _require(type(value['needs']) is list and len(value['needs']) == len(scope))
    needs, new_ids = {}, []
    for row in value['needs']:
        _object(row, 'listing_id order_id need_cny quantity_step currency close fx_cny_per_unit observed_at available_at fx_observed_at fx_available_at mark_kind price_observation_id fx_observation_id')
        listing = _ids([row['listing_id']], 1)[0]
        _require(listing in scope and listing not in needs, 'SETTLED_FUNDING_SCOPE_MISMATCH')
        _ids([row['order_id']], 1); _ids([row['price_observation_id']], 1); _ids([row['fx_observation_id']], 1)
        _require(row['order_id'] not in book and row['order_id'] not in new_ids, 'SETTLED_FUNDING_ORDER_ID_REUSED')
        new_ids.append(row['order_id'])
        _require(row['currency'] in ('CNY', 'HKD', 'USD'))
        observed, known = _time(row['observed_at']), _time(row['available_at'])
        _require(row['mark_kind'] == 'observed_close' and (settled or declared) <= observed <= known <= at,
                 'SETTLED_FUNDING_POST_SETTLEMENT_CLOSE_REQUIRED')
        if row['currency'] == 'CNY':
            _require(row['fx_observed_at'] is None and row['fx_available_at'] is None)
        else:
            fx_observed, fx_known = _time(row['fx_observed_at']), _time(row['fx_available_at'])
            _require(fx_observed <= fx_known <= at and at - fx_observed <= timedelta(seconds=age),
                     'SETTLED_FUNDING_FX_UNAVAILABLE')
        parsed = {key: _number(row[key], positive=True) for key in ('need_cny', 'quantity_step', 'close', 'fx_cny_per_unit')}
        _require(row['currency'] != 'CNY' or parsed['fx_cny_per_unit'] == 1)
        needs[listing] = row, parsed
    total_need = sum((parsed['need_cny'] for row, parsed in needs.values()), decimal('0'))
    deployment, orders = min(available, total_need), []
    for listing in sorted(needs):
        row, parsed = needs[listing]
        budget = (deployment * parsed['need_cny'] / total_need * 100).to_integral_value(rounding=ROUND_FLOOR) / 100
        price_cap = parsed['close'] * (1 + rates['buy_price_buffer_bps'] / 10000)
        fx_cap = parsed['fx_cny_per_unit'] * (1 + rates['buy_fx_buffer_bps'] / 10000) if row['currency'] != 'CNY' else decimal('1')
        step = parsed['quantity_step']

        def worst(units):
            principal = step * units * (price_cap * (1 + rates['slippage_bps'] / 10000)) * fx_cap
            fee = max(minimum, principal * rates['commission_bps'] / 10000)
            fx_fee = principal * rates['fx_bps'] / 10000 if row['currency'] != 'CNY' else decimal('0')
            return ((principal + fee + fx_fee) * 100).to_integral_value(rounding=ROUND_CEILING) / 100

        low, high = 0, int((budget / (price_cap * fx_cap * step)).to_integral_value(rounding=ROUND_FLOOR))
        _require(high <= 10**30, 'SETTLED_FUNDING_SIZING_RANGE')
        while low < high:
            middle = (low + high + 1) // 2
            if worst(middle) <= budget:
                low = middle
            else:
                high = middle - 1
        _require(low > 0, 'SETTLED_FUNDING_BELOW_MINIMUM_ORDER')
        try:
            fact_decimal(canonical(step * low))
        except AccountingError:
            raise WorkbenchError('SETTLED_FUNDING_SIZING_RANGE') from None
        orders.append({'order_id': row['order_id'], 'cash_intent_id': intent['id'], 'listing_id': listing,
            'side': 'buy', 'quantity': canonical(step * low), 'budget_cny': canonical(budget),
            'buy_price_cap': canonical(price_cap), 'buy_fx_cap': canonical(fx_cap), 'worst_total_cash_cny': canonical(worst(low)),
            'decision_price_observation_id': row['price_observation_id'], 'decision_fx_observation_id': row['fx_observation_id']})
    total_budget = sum((decimal(order['budget_cny']) for order in orders), decimal('0'))
    _require(total_budget <= available)
    return {'schema_version': 'settled-cash-buy-preparation-result-v2' if reviewed_leaves else 'settled-cash-buy-preparation-result-v1', 'input_hash': content_hash(value),
        'intent_id': intent['id'], 'policy_hash': intent['policy_hash'], 'decision_at': stamp(at),
        'latest_sale_settlement_at': stamp(settled) if settled else None, 'cash_snapshot_hash': content_hash(cash),
        'available_cash_cny': canonical(available), 'total_budget_cny': canonical(total_budget),
        'total_worst_cash_cny': canonical(sum((decimal(order['worst_total_cash_cny']) for order in orders), decimal('0'))),
        'unreserved_cash_cny': canonical(available - total_budget), 'orders': orders,
        'published': False, 'live_advice_eligible': False}
