"""Causal synthetic cash/positions journal, not the live ledger or strategy kernel."""

from copy import deepcopy
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from hashlib import sha256

from worker.market.contracts import validate_contract
from .bounded_cash import ROOT, _text, _time, digest, execute_buys, implementation_hash as buy_implementation_hash, plan_buys

ENGINE = 'bounded-cash-journal-sandbox-v1'
SOURCES = ('contracts/v1/bounded-cash-journal.schema.json', 'worker/execution_sandbox/journal.py',
           'worker/execution_sandbox/journal_store.py', 'web/src/server/execution-sandbox/journal.ts')
MAX_CASH = Decimal('999999999999999999.99')


class JournalError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise JournalError('CASH_JOURNAL_' + code)


def contract(value, kind):
    try:
        validate_contract(value, 'bounded-cash-journal.schema.json', '$defs/' + kind)
    except (ValueError, TypeError, KeyError) as error:
        raise JournalError('CASH_JOURNAL_CONTRACT_INVALID') from error


def implementation_hash():
    return digest({'engine_version': ENGINE, 'buy_implementation_hash': buy_implementation_hash(),
                   'sources': {path: sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCES}})


def _seal(value, key):
    result = deepcopy(value)
    result[key] = digest(value)
    return result


def _sealed(value, key):
    require(digest({name: item for name, item in value.items() if name != key}) == value[key], 'HASH_MISMATCH')


def _declaration(value):
    contract(value, 'declaration')
    require(value['implementation_hash'] == implementation_hash() and value['buy_implementation_hash'] == buy_implementation_hash(), 'IMPLEMENTATION_CHANGED')
    _time(value['registered_at'])
    policy = value['policy']
    require(all(Decimal(policy[key]) <= 10000 for key in ('price_buffer_bps', 'commission_bps', 'slippage_bps'))
            and Decimal(policy['slippage_bps']) <= Decimal(policy['price_buffer_bps']), 'POLICY_INVALID')


def declare_study(study_id, registered_at, policy):
    value = {'schema_version': 'bounded-cash-study-declaration-v1', 'engine_version': ENGINE, 'study_id': study_id,
             'registered_at': registered_at, 'qualification': 'synthetic_test_only', 'policy': deepcopy(policy),
             'implementation_hash': implementation_hash(), 'buy_implementation_hash': buy_implementation_hash(),
             'parameters_independently_preregistered': False, 'live_advice_eligible': False}
    _declaration(value)
    return value


def new_journal(declaration):
    _declaration(declaration)
    declared = digest(declaration)
    return _seal({'schema_version': 'bounded-cash-journal-v1', 'declaration': deepcopy(declaration),
                  'declaration_hash': declared, 'events': [], 'head_hash': declared}, 'journal_hash')


def reservations(state):
    return sorted([{'order_id': order['order_id'], 'budget_cny': order['reserved_cny']}
                   for batch in state['open_batches'].values() for order in batch['plan']['orders']
                   if Decimal(order['reserved_cny']) > 0], key=lambda row: row['order_id'])


def _state(value):
    reserved = sum((Decimal(row['budget_cny']) for row in reservations(value)), Decimal('0'))
    cash = Decimal(value['settled_cash_cny'])
    require(0 <= reserved <= cash <= MAX_CASH, 'CASH_INVARIANT_BROKEN')
    value['reserved_cny'], value['free_cash_cny'] = _text(reserved), _text(cash - reserved)
    result = _seal(value, 'state_hash')
    contract(result, 'state')
    return result


def _initial(declaration):
    return _state({'schema_version': 'bounded-cash-state-v1', 'study_id': declaration['study_id'], 'revision': 0,
                   'last_event_at': declaration['registered_at'], 'settled_cash_cny': '0', 'total_contributions_cny': '0',
                   'positions': {}, 'quantity_steps': {}, 'open_batches': {}, 'closed_batches': {},
                   'used_order_ids': [], 'contribution_ids': [], 'execution_failure_count': 0})


def command_from_event(event):
    return {key: deepcopy(event[key]) for key in ('command_id', 'at', 'kind', 'payload')}


def _transition(state, declaration, command):
    contract(command, 'command')
    at = _time(command['at'])
    require(at >= _time(state['last_event_at']), 'TIME_REVERSED')
    kind, payload = command['kind'], command['payload']
    due = {identity: max(_time(order['expires_at']) for order in batch['plan']['orders'])
           for identity, batch in state['open_batches'].items()}
    overdue = [identity for identity, deadline in due.items() if deadline <= at]
    if overdue:
        earliest = min(due[identity] for identity in overdue)
        require(kind == 'buy_resolution' and payload['batch_id'] in overdue and due[payload['batch_id']] == earliest, 'RESOLVE_DUE_BATCH_FIRST')
    value = {key: deepcopy(item) for key, item in state.items() if key not in ('state_hash', 'reserved_cny', 'free_cash_cny')}
    if kind == 'cash_contribution':
        require(payload['contribution_id'] not in state['contribution_ids'], 'CONTRIBUTION_ALREADY_USED')
        require(Decimal(payload['amount_cny']) > 0, 'CONTRIBUTION_NOT_POSITIVE')
        value['settled_cash_cny'] = _text(Decimal(state['settled_cash_cny']) + Decimal(payload['amount_cny']))
        value['total_contributions_cny'] = _text(Decimal(state['total_contributions_cny']) + Decimal(payload['amount_cny']))
        value['contribution_ids'] = sorted([*state['contribution_ids'], payload['contribution_id']])
    elif kind == 'buy_plan':
        input_value, plan = payload['input'], payload['plan']
        identity = input_value['batch_id']
        require(command['at'] == input_value['decision_at'], 'DECISION_TIME_MISMATCH')
        require(digest(input_value['policy']) == digest(declaration['policy']), 'FROZEN_POLICY_MISMATCH')
        require(Decimal(input_value['settled_cash_cny']) == Decimal(state['settled_cash_cny'])
                and Decimal(input_value['unsettled_receivable_cny']) == 0, 'CASH_SNAPSHOT_MISMATCH')
        require(input_value['existing_reservations'] == reservations(state), 'RESERVATION_SNAPSHOT_MISMATCH')
        require(identity not in state['open_batches'] and identity not in state['closed_batches'], 'BATCH_ALREADY_USED')
        require(all(row['order_id'] not in state['used_order_ids'] for row in input_value['orders']), 'ORDER_ALREADY_USED')
        require(plan == plan_buys(input_value), 'PLAN_REPLAY_MISMATCH')
        for row in input_value['orders']:
            step = _text(Decimal(row['quantity_step']))
            require(row['listing_id'] not in value['quantity_steps'] or value['quantity_steps'][row['listing_id']] == step, 'QUANTITY_STEP_CHANGED')
            value['quantity_steps'][row['listing_id']] = step
        require(len(value['open_batches']) < 20 and len(value['quantity_steps']) <= 20, 'STUDY_SCOPE_LIMIT')
        value['open_batches'][identity] = deepcopy(payload)
        value['used_order_ids'] = sorted([*state['used_order_ids'], *[row['order_id'] for row in input_value['orders']]])
    else:
        identity = payload['batch_id']
        require(identity in state['open_batches'], 'BATCH_NOT_OPEN')
        require(command['at'] == payload['outcome']['evaluated_at'], 'EVALUATION_TIME_MISMATCH')
        batch = state['open_batches'][identity]
        result = execute_buys(batch['input'], batch['plan'], payload['outcome'])
        require(result == payload['result'], 'RESULT_REPLAY_MISMATCH')
        # A frozen batch cash snapshot is not today's balance. Apply only its debit.
        value['settled_cash_cny'] = _text(Decimal(state['settled_cash_cny']) - Decimal(result['total_debited_cny']))
        for row in result['orders']:
            if row['status'] == 'simulated_filled':
                value['positions'][row['listing_id']] = _text(Decimal(value['positions'].get(row['listing_id'], '0')) + Decimal(row['quantity']))
        del value['open_batches'][identity]
        value['closed_batches'][identity] = result['result_hash']
        value['execution_failure_count'] += result['execution_failure_count']
    value['revision'], value['last_event_at'] = state['revision'] + 1, command['at']
    return _state(value)


def replay_journal(journal):
    with localcontext() as context:
        context.prec, context.rounding = 160, ROUND_HALF_EVEN
        contract(journal, 'journal')
        _sealed(journal, 'journal_hash')
        _declaration(journal['declaration'])
        require(digest(journal['declaration']) == journal['declaration_hash'], 'DECLARATION_HASH_MISMATCH')
        state, previous, command_ids = _initial(journal['declaration']), journal['declaration_hash'], set()
        for index, event in enumerate(journal['events'], 1):
            _sealed(event, 'event_hash')
            require(event['sequence'] == index and event['previous_hash'] == previous and event['before_state_hash'] == state['state_hash'], 'CHAIN_MISMATCH')
            require(event['command_id'] not in command_ids, 'COMMAND_ALREADY_USED')
            state = _transition(state, journal['declaration'], command_from_event(event))
            require(event['after_state_hash'] == state['state_hash'], 'STATE_REPLAY_MISMATCH')
            previous = event['event_hash']
            command_ids.add(event['command_id'])
        require(previous == journal['head_hash'], 'HEAD_HASH_MISMATCH')
        return state


def append_command(journal, command):
    with localcontext() as context:
        context.prec, context.rounding = 160, ROUND_HALF_EVEN
        before = replay_journal(journal)
        contract(command, 'command')
        require(len(journal['events']) < 512, 'EVENT_LIMIT')
        require(all(event['command_id'] != command['command_id'] for event in journal['events']), 'COMMAND_ALREADY_USED')
        after = _transition(before, journal['declaration'], command)
        event = _seal({'schema_version': 'bounded-cash-event-v1', 'sequence': after['revision'], **deepcopy(command),
                       'previous_hash': journal['head_hash'], 'before_state_hash': before['state_hash'], 'after_state_hash': after['state_hash']}, 'event_hash')
        body = {key: deepcopy(value) for key, value in journal.items() if key != 'journal_hash'}
        body['events'].append(event)
        body['head_hash'] = event['event_hash']
        result = _seal(body, 'journal_hash')
        contract(result, 'journal')
        return result
