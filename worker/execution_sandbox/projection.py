"""Synthetic cash-only allocation and terminal-book unitized valuation, never live advice."""

from copy import deepcopy
from decimal import Decimal, ROUND_CEILING, ROUND_DOWN, ROUND_HALF_EVEN, localcontext
from hashlib import sha256

from worker.market.contracts import validate_contract
from .bounded_cash import ROOT, _text, _time, digest, plan_buys
from .journal import append_command, implementation_hash as journal_implementation_hash, new_journal, replay_journal

ENGINE = 'bounded-cash-projection-sandbox-v1'
SOURCES = ('contracts/v1/bounded-cash-projection.schema.json', 'worker/execution_sandbox/projection.py',
           'web/src/server/execution-sandbox/projection.ts')
ZERO, ONE, BPS = Decimal(0), Decimal(1), Decimal(10000)


class ProjectionError(ValueError):
    pass


def require(value, code):
    if not value:
        raise ProjectionError('CASH_PROJECTION_' + code)


def contract(value, kind):
    try:
        validate_contract(value, 'bounded-cash-projection.schema.json', '$defs/' + kind)
    except (ValueError, TypeError, KeyError) as error:
        raise ProjectionError('CASH_PROJECTION_CONTRACT_INVALID') from error


def implementation_hash():
    return digest({'engine_version': ENGINE, 'journal_implementation_hash': journal_implementation_hash(),
                   'sources': {path: sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCES}})


def seal(value, key):
    return {**value, key: digest(value)}


def _program(value):
    contract(value, 'program')
    require(digest({key: item for key, item in value.items() if key != 'program_hash'}) == value['program_hash'], 'PROGRAM_HASH_MISMATCH')
    require(value['implementation_hash'] == implementation_hash(), 'IMPLEMENTATION_CHANGED')
    targets = value['targets']
    require([row['listing_id'] for row in targets] == sorted({row['listing_id'] for row in targets}), 'TARGET_ORDER_OR_DUPLICATE')
    require(sum(row['weight_bps'] for row in targets) + value['cash_target_bps'] == 10000, 'WEIGHT_SUM_INVALID')
    require(all(Decimal(row['quantity_step']) > 0 for row in targets), 'STEP_INVALID')
    schedule = value['funding_schedule']
    require(len({row['contribution_id'] for row in schedule}) == len(schedule), 'FUNDING_DUPLICATE')
    require(schedule == sorted(schedule, key=lambda row: (row['at'], row['contribution_id'])), 'FUNDING_ORDER_INVALID')
    require(all(_time(row['at']) >= _time(value['registered_at']) and Decimal(row['amount_cny']) > 0 for row in schedule), 'FUNDING_INVALID')


def declare_program(declaration, targets, cash_target_bps, drift_threshold_bps, funding_schedule):
    new_journal(declaration)
    value = seal({'schema_version': 'bounded-cash-program-v1', 'engine_version': ENGINE,
                  'qualification': 'synthetic_test_only', 'journal_declaration_hash': digest(declaration),
                  'registered_at': declaration['registered_at'], 'targets': deepcopy(targets),
                  'cash_target_bps': cash_target_bps, 'drift_threshold_bps': drift_threshold_bps,
                  'funding_schedule': deepcopy(funding_schedule), 'implementation_hash': implementation_hash(),
                  'parameters_independently_preregistered': False, 'live_advice_eligible': False}, 'program_hash')
    _program(value)
    return value


def funding_commands(program):
    _program(program)
    return [{'command_id': 'fund:' + digest({'program_hash': program['program_hash'], 'contribution_id': row['contribution_id']}),
             'at': row['at'], 'kind': 'cash_contribution',
             'payload': {'contribution_id': row['contribution_id'], 'amount_cny': row['amount_cny']}}
            for row in program['funding_schedule']]


def _context(program, journal):
    _program(program)
    state = replay_journal(journal)
    require(program['journal_declaration_hash'] == journal['declaration_hash']
            and program['registered_at'] == journal['declaration']['registered_at'], 'JOURNAL_BINDING_MISMATCH')
    targets = {row['listing_id']: row for row in program['targets']}
    require(all(identity in targets and Decimal(step) == Decimal(targets[identity]['quantity_step'])
                for identity, step in state['quantity_steps'].items()), 'UNIVERSE_OR_STEP_CHANGED')
    flows = [{'at': row['at'], **row['payload']} for row in journal['events'] if row['kind'] == 'cash_contribution']
    require(flows == program['funding_schedule'][:len(flows)], 'FUNDING_SCHEDULE_MISMATCH')
    return state


def _prices(program, journal, marks, at):
    instant = _time(at)
    require([row['listing_id'] for row in marks] == [row['listing_id'] for row in program['targets']], 'MARK_UNIVERSE_OR_ORDER_INVALID')
    require(len({row['quote']['id'] for row in marks}) == len(marks), 'DUPLICATE_QUOTE_ID')
    prices = {}
    for row in marks:
        quote = row['quote']
        observed, known, valid = (_time(quote[key]) for key in ('observed_at', 'known_at', 'valid_until'))
        require(observed <= known <= instant < valid and (instant - observed).total_seconds() <= journal['declaration']['policy']['max_quote_age_seconds'], 'MARK_UNAVAILABLE')
        require(Decimal(quote['close']) > 0, 'PRICE_NOT_POSITIVE')
        prices[row['listing_id']] = Decimal(quote['close'])
    return prices


def _nav(state, prices):
    positions = sum((Decimal(quantity) * prices[identity] for identity, quantity in state['positions'].items()), ZERO)
    return Decimal(state['settled_cash_cny']) + positions, positions


def decide_cash(value):
    with localcontext() as context:
        context.prec, context.rounding = 160, ROUND_HALF_EVEN
        contract(value, 'decisionInput')
        program, journal = value['program'], value['journal']
        state = _context(program, journal)
        require(_time(value['at']) >= _time(state['last_event_at']), 'TIME_REVERSED')
        require(_time(value['at']) < _time(value['execute_at']) <= _time(value['expires_at']), 'WINDOW_INVALID')
        prices = _prices(program, journal, value['marks'], value['at'])
        nav, _ = _nav(state, prices)
        floor = (nav * program['cash_target_bps'] / BPS).quantize(Decimal('.01'), rounding=ROUND_CEILING)
        deployable = max(ZERO, Decimal(state['free_cash_cny']) - floor)
        rows, deficits = [], []
        for target in program['targets']:
            market_value = Decimal(state['positions'].get(target['listing_id'], '0')) * prices[target['listing_id']]
            desired = nav * target['weight_bps'] / BPS
            underweight = max(ZERO, desired - market_value)
            eligible = underweight if nav and underweight * BPS >= nav * program['drift_threshold_bps'] else ZERO
            deficits.append(eligible)
            rows.append({'listing_id': target['listing_id'], 'market_value_cny': _text(market_value),
                         'target_value_cny': _text(desired), 'underweight_cny': _text(underweight), 'allocated_budget_cny': '0'})
        total = sum(deficits, ZERO)
        status, command = 'no_eligible_underweight', None
        if state['open_batches']:
            status = 'waiting_for_pending_batches'
        elif not deployable:
            status = 'no_deployable_cash'
        elif total:
            identity = digest({'program_hash': program['program_hash'], 'decision_id': value['decision_id']})
            orders = []
            for target, mark, row, deficit in zip(program['targets'], value['marks'], rows, deficits):
                budget = (deficit if deployable >= total else deficit * deployable / total).quantize(Decimal('.01'), rounding=ROUND_DOWN)
                row['allocated_budget_cny'] = _text(budget)
                if budget:
                    orders.append({'order_id': 'o:' + digest({'decision': identity, 'listing_id': target['listing_id']}),
                                   'listing_id': target['listing_id'], 'market': 'CN', 'currency': 'CNY',
                                   'allocated_budget_cny': _text(budget), 'quantity_step': target['quantity_step'],
                                   'decision_quote': deepcopy(mark['quote']), 'execute_at': value['execute_at'], 'expires_at': value['expires_at']})
            if orders:
                buy_input = {'schema_version': 'bounded-cash-buy-input-v1', 'qualification': 'synthetic_test_only',
                             'batch_id': 'b:' + identity, 'decision_at': value['at'], 'policy': deepcopy(journal['declaration']['policy']),
                             'settled_cash_cny': state['settled_cash_cny'], 'unsettled_receivable_cny': '0', 'existing_reservations': [], 'orders': orders}
                command = {'command_id': 'cmd:' + identity, 'at': value['at'], 'kind': 'buy_plan',
                           'payload': {'input': buy_input, 'plan': plan_buys(buy_input)}}
                append_command(journal, command)
                status = 'cash_only_underweight_plan'
        result = seal({'schema_version': 'bounded-cash-decision-v1', 'qualification': 'synthetic_test_only',
                       'implementation_hash': implementation_hash(), 'program_hash': program['program_hash'], 'input_hash': digest(value),
                       'state_hash': state['state_hash'], 'at': value['at'], 'status': status, 'nav_cny': _text(nav),
                       'cash_floor_cny': _text(floor), 'deployable_cny': _text(deployable), 'allocations': rows,
                       'command': command, 'live_advice_eligible': False}, 'decision_hash')
        contract(result, 'decision')
        return result


def value_journal(value):
    with localcontext() as context:
        context.prec, context.rounding = 160, ROUND_HALF_EVEN
        contract(value, 'valuationInput')
        program, journal = value['program'], value['journal']
        final_state = _context(program, journal)
        require(len(value['event_frames']) == len(journal['events']), 'EVENT_FRAME_COUNT_MISMATCH')
        prefix = new_journal(journal['declaration'])
        state, units, peak, maximum, samples, quote_identities = replay_journal(prefix), ZERO, ONE, ZERO, [], {}

        def ratio(number):
            return _text(number.quantize(Decimal('.000000000001')))

        def sample(frame, event=None):
            nonlocal prefix, state, units, peak, maximum
            require(_time(frame['at']) >= _time(state['last_event_at']), 'TIME_REVERSED')
            prices = _prices(program, journal, frame['marks'], frame['at'])
            for mark in frame['marks']:
                identity, content = mark['quote']['id'], digest(mark)
                require(identity not in quote_identities or quote_identities[identity] == content, 'QUOTE_ID_REBOUND')
                quote_identities[identity] = content
            before, _ = _nav(state, prices)
            unit_before = before / units if units else ONE
            require(unit_before > 0, 'ZERO_CAPITAL_WITH_UNITS')
            peak = max(peak, unit_before)
            maximum = max(maximum, ONE - unit_before / peak)
            flow = ZERO
            if event:
                require(frame['at'] == event['at'], 'EVENT_FRAME_TIME_MISMATCH')
                if event['kind'] == 'cash_contribution':
                    flow = Decimal(event['payload']['amount_cny'])
                    units += flow / unit_before
                prefix = append_command(prefix, {key: deepcopy(event[key]) for key in ('command_id', 'at', 'kind', 'payload')})
                state = replay_journal(prefix)
                require(state['state_hash'] == event['after_state_hash'], 'EVENT_STATE_MISMATCH')
            nav, position_value = _nav(state, prices)
            unit_after = nav / units if units else ONE
            peak = max(peak, unit_after)
            drawdown = ONE - unit_after / peak
            maximum = max(maximum, drawdown)
            samples.append({'revision': state['revision'], 'at': frame['at'], 'state_hash': state['state_hash'], 'marks_hash': digest(frame['marks']),
                            'pre_flow_nav_cny': _text(before), 'external_flow_cny': _text(flow), 'nav_cny': _text(nav),
                            'settled_cash_cny': state['settled_cash_cny'], 'reserved_cny': state['reserved_cny'], 'position_value_cny': _text(position_value),
                            'units': ratio(units), 'unit_nav': ratio(unit_after) if units else None,
                            'total_return': ratio(unit_after - ONE) if units else None, 'drawdown': ratio(drawdown) if units else None})

        for event, frame in zip(journal['events'], value['event_frames']):
            sample(frame, event)
        sample(value['final_frame'])
        require(state == final_state, 'FINAL_STATE_MISMATCH')
        end, contributed = samples[-1]['nav_cny'], state['total_contributions_cny']
        profit = _text(Decimal(end) - Decimal(contributed))
        result = seal({'schema_version': 'bounded-cash-valuation-report-v1', 'qualification': 'synthetic_test_only',
                       'implementation_hash': implementation_hash(), 'program_hash': program['program_hash'], 'input_hash': digest(value),
                       'journal_head_hash': journal['head_hash'], 'valuation_basis': 'terminal_processing_not_execution_settlement',
                       'allocation_policy_compliance_verified': False,
                       'samples': samples, 'total_contributions_cny': contributed, 'end_nav_cny': end, 'net_profit_cny': profit,
                       'return_status': 'calculated' if units else 'no_contributed_capital',
                       'cash_flow_adjusted_return': samples[-1]['total_return'], 'sampled_max_drawdown': ratio(maximum) if units else None,
                       'cash_reference': {'kind': 'same_flow_cash_zero_interest_zero_cost', 'nav_cny': contributed, 'total_return': '0' if units else None,
                                          'difference_cny': profit, 'investable_market_benchmark': False},
                       'execution_failure_count': state['execution_failure_count'], 'open_batch_count': len(state['open_batches']),
                       'live_advice_eligible': False}, 'report_hash')
        contract(result, 'report')
        return result


def verify_decision(value, result):
    contract(result, 'decision')
    require(result == decide_cash(value), 'DECISION_REPLAY_MISMATCH')


def verify_report(value, result):
    contract(result, 'report')
    require(result == value_journal(value), 'REPORT_REPLAY_MISMATCH')
