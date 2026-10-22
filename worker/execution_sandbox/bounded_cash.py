"""Synthetic CNY buy batches with precommitted price bounds and fixed quantities."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_CEILING, ROUND_FLOOR, ROUND_HALF_EVEN, localcontext
from hashlib import sha256
import json
from pathlib import Path

from worker.market.contracts import validate_contract

ENGINE = 'bounded-cash-buy-sandbox-v1'
ROOT = Path(__file__).resolve().parents[2]
SOURCES = ('contracts/v1/bounded-cash-buy.schema.json', 'worker/execution_sandbox/__init__.py',
           'worker/execution_sandbox/bounded_cash.py', 'web/src/server/execution-sandbox/bounded-cash.ts',
           'worker/market/contracts.py', 'worker/orchestration/db.py', 'worker/accounting/decimal_math.py',
           'requirements-workbench.txt', 'web/package-lock.json')
ZERO = Decimal('0')


class BoundedCashError(ValueError):
    pass


def digest(value):
    def normalize(item):
        if isinstance(item, float) and item.is_integer():
            return int(item)
        if isinstance(item, list):
            return [normalize(child) for child in item]
        if isinstance(item, dict):
            return {key: normalize(child) for key, child in item.items()}
        return item
    return sha256(json.dumps(normalize(value), sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def implementation_hash():
    return digest({'engine_version': ENGINE, 'precision': 160,
                   'sources': {name: sha256((ROOT / name).read_bytes()).hexdigest() for name in SOURCES}})


def _require(condition, code):
    if not condition:
        raise BoundedCashError('BOUNDED_CASH_' + code)


def _contract(value, kind):
    try:
        validate_contract(value, 'bounded-cash-buy.schema.json', '$defs/' + kind)
    except (ValueError, TypeError, KeyError) as error:
        raise BoundedCashError('BOUNDED_CASH_CONTRACT_INVALID') from error


def _time(value):
    try:
        result = datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
        _require(result.isoformat(timespec='microseconds').replace('+00:00', 'Z') == value, 'INSTANT_INVALID')
        return result
    except (TypeError, ValueError) as error:
        raise BoundedCashError('BOUNDED_CASH_INSTANT_INVALID') from error


def _text(value):
    if not value:
        return '0'
    text = format(value, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def _cost(quantity, price, policy):
    principal = quantity * price
    fee = max(Decimal(policy['minimum_fee_cny']), principal * Decimal(policy['commission_bps']) / 10000)
    # Reserve/pay upward to cents; never let half-even rounding erase a debit.
    total = (principal + fee).quantize(Decimal('0.01'), rounding=ROUND_CEILING)
    return total, fee


def _plan(value):
    _contract(value, 'input')
    policy, at = value['policy'], _time(value['decision_at'])
    _require(all(Decimal(policy[key]) <= 10000 for key in ('price_buffer_bps', 'commission_bps', 'slippage_bps')), 'RATE_OUT_OF_RANGE')
    _require(Decimal(policy['slippage_bps']) <= Decimal(policy['price_buffer_bps']), 'SLIPPAGE_EXCEEDS_BOUND')
    settled = Decimal(value['settled_cash_cny'])
    ids = [row['order_id'] for row in [*value['existing_reservations'], *value['orders']]]
    _require(len(ids) == len(set(ids)), 'DUPLICATE_ORDER_ID')
    _require(len({row['listing_id'] for row in value['orders']}) == len(value['orders']), 'DUPLICATE_LISTING')
    _require(all(Decimal(row['budget_cny']) > ZERO for row in value['existing_reservations']), 'RESERVATION_INVALID')
    existing = sum((Decimal(row['budget_cny']) for row in value['existing_reservations']), ZERO)
    allocations = sum((Decimal(row['allocated_budget_cny']) for row in value['orders']), ZERO)
    _require(existing + allocations <= settled, 'SETTLED_CASH_EXCEEDED')
    orders = []
    for row in sorted(value['orders'], key=lambda item: item['order_id']):
        quote, budget, step = row['decision_quote'], Decimal(row['allocated_budget_cny']), Decimal(row['quantity_step'])
        observed, known, valid = (_time(quote[key]) for key in ('observed_at', 'known_at', 'valid_until'))
        execute, expire = _time(row['execute_at']), _time(row['expires_at'])
        _require(ZERO < budget and ZERO < step and ZERO < Decimal(quote['close']), 'NONPOSITIVE_ORDER_INPUT')
        _require(observed <= known <= at < valid and at - observed <= timedelta(seconds=policy['max_quote_age_seconds']), 'DECISION_QUOTE_UNAVAILABLE')
        _require(at < execute <= expire, 'EXECUTION_WINDOW_INVALID')
        cap = Decimal(quote['close']) * (1 + Decimal(policy['price_buffer_bps']) / 10000)
        low, high = 0, int((budget / (step * cap)).to_integral_value(rounding=ROUND_FLOOR))
        while low < high:
            middle = (low + high + 1) // 2
            if _cost(step * middle, cap, policy)[0] <= budget:
                low = middle
            else:
                high = middle - 1
        quantity = step * low
        worst = _cost(quantity, cap, policy)[0] if low else ZERO
        orders.append({'order_id': row['order_id'], 'listing_id': row['listing_id'], 'status': 'planned' if low else 'below_minimum',
                       'quantity': _text(quantity), 'quantity_step': row['quantity_step'], 'lot_count': str(low),
                       'allocated_budget_cny': row['allocated_budget_cny'], 'reserved_cny': _text(budget if low else ZERO),
                       'price_cap': _text(cap), 'worst_total_cash_cny': _text(worst), 'decision_quote_id': quote['id'],
                       'execute_at': row['execute_at'], 'expires_at': row['expires_at']})
    reserved = sum((Decimal(row['reserved_cny']) for row in orders), ZERO)
    result = {'schema_version': 'bounded-cash-buy-plan-v1', 'engine_version': ENGINE, 'qualification': 'synthetic_test_only',
              'implementation_hash': implementation_hash(), 'input_hash': digest(value), 'policy_hash': digest(policy),
              'batch_id': value['batch_id'], 'decision_at': value['decision_at'], 'settled_cash_cny': _text(settled),
              'existing_reserved_cny': _text(existing), 'new_reserved_cny': _text(reserved),
              'unreserved_cash_cny': _text(settled - existing - reserved), 'orders': orders}
    result['plan_hash'] = digest(result)
    _contract(result, 'plan')
    return result


def plan_buys(value):
    with localcontext() as context:
        context.prec = 160
        context.rounding = ROUND_HALF_EVEN
        return _plan(value)


def execute_buys(value, plan, outcome):
    with localcontext() as context:
        context.prec = 160
        context.rounding = ROUND_HALF_EVEN
        _contract(plan, 'plan')
        _require(plan == _plan(value), 'FROZEN_PLAN_MISMATCH')
        _contract(outcome, 'outcomeInput')
        evaluated = _time(outcome['evaluated_at'])
        _require(evaluated >= max(_time(row['expires_at']) for row in plan['orders']), 'BATCH_NOT_TERMINAL')
        ids = [row['order_id'] for row in outcome['observations']]
        active = {row['order_id'] for row in plan['orders'] if row['status'] == 'planned'}
        _require(len(ids) == len(set(ids)) and set(ids) <= active, 'EXECUTION_SCOPE_INVALID')
        observations = {row['order_id']: row for row in outcome['observations']}
        for row in observations.values():
            _require(ZERO < Decimal(row['close']), 'NONPOSITIVE_EXECUTION_PRICE')
            _require(_time(row['observed_at']) <= _time(row['known_at']) <= evaluated, 'FUTURE_EXECUTION_OBSERVATION')
        rows, debited, failures = [], ZERO, 0
        for order in plan['orders']:
            observed = observations.get(order['order_id'])
            reason = 'BUDGET_BELOW_ONE_STEP_TOTAL_COST' if order['status'] == 'below_minimum' else None
            price, fee, total = None, ZERO, ZERO
            if reason is None:
                if observed is None:
                    reason = 'MISSING_EXECUTION_OBSERVATION'
                elif observed['corporate_action_since_decision']:
                    reason = 'CORPORATE_ACTION_REVIEW_REQUIRED'
                elif observed['observed_at'] != order['execute_at']:
                    reason = 'EXECUTION_TIME_MISMATCH'
                elif _time(observed['known_at']) > _time(order['expires_at']):
                    reason = 'EXECUTION_EVIDENCE_LATE'
                else:
                    price = Decimal(observed['close']) * (1 + Decimal(value['policy']['slippage_bps']) / 10000)
                    required, required_fee = _cost(Decimal(order['quantity']), price, value['policy'])
                    if price > Decimal(order['price_cap']):
                        reason = 'PRICE_BOUND_EXCEEDED'
                    elif required > Decimal(order['reserved_cny']):
                        reason = 'PRECOMMITTED_BUDGET_EXCEEDED'
                    else:
                        reason, total, fee = 'SYNTHETIC_NEXT_CLOSE_PROXY', required, required_fee
            filled = reason == 'SYNTHETIC_NEXT_CLOSE_PROXY'
            failures += int(order['status'] == 'planned' and not filled)
            debited += total
            rows.append({'order_id': order['order_id'], 'listing_id': order['listing_id'],
                         'status': 'simulated_filled' if filled else 'below_minimum' if order['status'] == 'below_minimum' else 'skipped',
                         'reason': reason, 'quantity': order['quantity'], 'execution_price': _text(price) if price is not None else None,
                         'fee_cny': _text(fee), 'rounding_cny': _text(total - Decimal(order['quantity']) * price - fee if filled else ZERO), 'total_cash_cny': _text(total),
                         'released_cny': _text(Decimal(order['reserved_cny']) - total), 'quote_id': observed['quote_id'] if observed else None})
        cash = Decimal(plan['settled_cash_cny']) - debited
        _require(cash >= Decimal(plan['existing_reserved_cny']), 'RESERVATION_INVARIANT_BROKEN')
        result = {'schema_version': 'bounded-cash-buy-result-v1', 'engine_version': ENGINE, 'qualification': 'synthetic_test_only',
                  'implementation_hash': plan['implementation_hash'], 'input_hash': plan['input_hash'], 'policy_hash': plan['policy_hash'],
                  'plan_hash': plan['plan_hash'], 'outcome_input_hash': digest(outcome), 'batch_id': plan['batch_id'], 'evaluated_at': outcome['evaluated_at'],
                  'cash_after_cny': _text(cash), 'existing_reserved_cny': plan['existing_reserved_cny'],
                  'unreserved_cash_after_cny': _text(cash - Decimal(plan['existing_reserved_cny'])),
                  'new_reserved_released_cny': _text(Decimal(plan['new_reserved_cny']) - debited),
                  'total_debited_cny': _text(debited), 'execution_failure_count': failures, 'orders': rows, 'live_advice_eligible': False}
        result['result_hash'] = digest(result)
        _contract(result, 'result')
        return result


def verify_result(value, plan, outcome, result):
    _contract(result, 'result')
    _require(result == execute_buys(value, plan, outcome), 'RESULT_REPLAY_MISMATCH')
    return result
