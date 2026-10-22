"""Causal generated-policy run and executable same-flow synthetic market comparator."""

from copy import deepcopy
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from hashlib import sha256

from worker.market.contracts import validate_contract
from .bounded_cash import ROOT, _text, _time, digest, execute_buys
from .journal import append_command, new_journal, replay_journal
from .projection import (_context, _nav, _prices, decide_cash, funding_commands,
                         implementation_hash as projection_hash, seal, value_journal)

ENGINE = 'bounded-cash-run-sandbox-v1'
SOURCES = ('contracts/v1/bounded-cash-run.schema.json', 'worker/execution_sandbox/study_run.py',
           'web/src/server/execution-sandbox/study-run.ts')
ZERO, ONE = Decimal(0), Decimal(1)


class StudyRunError(ValueError):
    pass


def require(value, code):
    if not value:
        raise StudyRunError('CASH_RUN_' + code)


def contract(value, kind):
    try:
        validate_contract(value, 'bounded-cash-run.schema.json', '$defs/' + kind)
    except (ValueError, TypeError, KeyError) as error:
        raise StudyRunError('CASH_RUN_CONTRACT_INVALID') from error


def implementation_hash():
    return digest({'engine_version': ENGINE, 'projection_implementation_hash': projection_hash(),
                   'sources': {path: sha256((ROOT / path).read_bytes()).hexdigest() for path in SOURCES}})


def _ratio(value):
    return _text(value.quantize(Decimal('.000000000001')))


def run_program(value):
    with localcontext() as context:
        context.prec, context.rounding = 160, ROUND_HALF_EVEN
        contract(value, 'input')
        program, declaration = value['program'], value['declaration']
        journal = new_journal(declaration)
        state = _context(program, journal)
        frames, points = value['frames'], value['decision_points']
        frame_times = [row['at'] for row in frames]
        point_times = [row['at'] for row in points]
        require(frame_times == sorted(set(frame_times)) and all(_time(at) >= _time(program['registered_at']) for at in frame_times), 'FRAME_ORDER_INVALID')
        require(point_times == sorted(set(point_times)) and len({row['decision_id'] for row in points}) == len(points), 'DECISION_ORDER_OR_ID_INVALID')
        time_set = set(frame_times)
        require(all(row['at'] in time_set and row['expires_at'] in time_set and _time(row['at']) < _time(row['execute_at']) <= _time(row['expires_at']) for row in points), 'DECISION_WINDOW_UNCOVERED')
        funds = funding_commands(program)
        require(all(row['at'] in time_set for row in funds if row['at'] <= frames[-1]['at']), 'FUNDING_FRAME_MISSING')
        decision_map = {row['at']: row for row in points}
        units, peak, maximum = ZERO, ONE, ZERO
        fees, rounding, debited = ZERO, ZERO, ZERO
        event_frames, curve, records, mark_ids, execution_ids = [], [], [], {}, {}

        for frame in frames:
            at = frame['at']
            prices = _prices(program, journal, frame['marks'], at)
            for mark in frame['marks']:
                identity, content = mark['quote']['id'], digest(mark)
                require(identity not in mark_ids or mark_ids[identity] == content, 'QUOTE_ID_REBOUND')
                mark_ids[identity] = content
            observations = {row['listing_id']: row for row in frame['execution_observations']}
            require(len(observations) == len(frame['execution_observations']), 'DUPLICATE_EXECUTION_LISTING')
            require(set(observations) <= set(prices), 'EXECUTION_UNIVERSE_INVALID')
            for row in observations.values():
                require(_time(row['observed_at']) <= _time(row['known_at']) <= _time(at) and Decimal(row['close']) > 0, 'EXECUTION_EVIDENCE_UNAVAILABLE')
                identity, content = row['quote_id'], digest(row)
                require(identity not in execution_ids or execution_ids[identity] == content, 'EXECUTION_QUOTE_ID_REBOUND')
                execution_ids[identity] = content

            def mark_unit():
                nonlocal peak, maximum
                nav, position_value = _nav(state, prices)
                unit = nav / units if units else ONE
                require(unit > 0, 'ZERO_CAPITAL_WITH_UNITS')
                if units:
                    peak = max(peak, unit)
                    maximum = max(maximum, ONE - unit / peak)
                return nav, position_value, unit

            def apply(command):
                nonlocal journal, state, units
                unit = mark_unit()[2]
                if command['kind'] == 'cash_contribution':
                    units += Decimal(command['payload']['amount_cny']) / unit
                journal = append_command(journal, command)
                state = replay_journal(journal)
                event_frames.append({'at': at, 'marks': deepcopy(frame['marks'])})
                mark_unit()

            mark_unit()
            pending = sorted(state['open_batches'].items(), key=lambda item: (max(row['expires_at'] for row in item[1]['plan']['orders']), item[0]))
            for identity, batch in pending:
                terminal = max(row['expires_at'] for row in batch['plan']['orders'])
                require(terminal >= at, 'MISSED_BATCH_TERMINAL')
                if terminal != at:
                    continue
                actual = []
                for order in batch['plan']['orders']:
                    if order['status'] != 'planned':
                        continue
                    observed = observations.get(order['listing_id'])
                    if observed:
                        actual.append({'order_id': order['order_id'], **{key: deepcopy(item) for key, item in observed.items() if key != 'listing_id'}})
                outcome = {'schema_version': 'bounded-cash-buy-outcome-input-v1', 'qualification': 'synthetic_test_only', 'evaluated_at': at, 'observations': actual}
                result = execute_buys(batch['input'], batch['plan'], outcome)
                fees += sum((Decimal(row['fee_cny']) for row in result['orders']), ZERO)
                rounding += sum((Decimal(row['rounding_cny']) for row in result['orders']), ZERO)
                debited += Decimal(result['total_debited_cny'])
                apply({'command_id': 'resolve:' + digest(identity), 'at': at, 'kind': 'buy_resolution',
                       'payload': {'batch_id': identity, 'outcome': outcome, 'result': result}})
            for funding in funds:
                if funding['at'] == at:
                    apply(funding)
            if at in decision_map:
                point = decision_map[at]
                request = {'schema_version': 'bounded-cash-decision-input-v1', 'qualification': 'synthetic_test_only',
                           'program': program, 'journal': journal, **deepcopy(point), 'marks': deepcopy(frame['marks'])}
                before = journal['head_hash']
                decision = decide_cash(request)
                if decision['command'] is not None:
                    apply(decision['command'])
                records.append({'decision_id': point['decision_id'], 'before_head_hash': before,
                                'after_head_hash': journal['head_hash'], 'decision': decision})
            nav, position_value, unit = mark_unit()
            curve.append({'at': at, 'revision': state['revision'], 'state_hash': state['state_hash'], 'nav_cny': _text(nav),
                          'settled_cash_cny': state['settled_cash_cny'], 'reserved_cny': state['reserved_cny'], 'position_value_cny': _text(position_value),
                          'total_contributions_cny': state['total_contributions_cny'], 'units': _ratio(units), 'unit_nav': _ratio(unit) if units else None,
                          'total_return': _ratio(unit - ONE) if units else None, 'drawdown': _ratio(ONE - unit / peak) if units else None})
        require(not state['open_batches'], 'NONTERMINAL_BATCHES')
        valuation = value_journal({'schema_version': 'bounded-cash-valuation-input-v1', 'qualification': 'synthetic_test_only',
                                  'program': program, 'journal': journal, 'event_frames': event_frames,
                                  'final_frame': {'at': frames[-1]['at'], 'marks': frames[-1]['marks']}})
        require(valuation['end_nav_cny'] == curve[-1]['nav_cny'] and valuation['cash_flow_adjusted_return'] == curve[-1]['total_return'], 'VALUATION_REPLAY_MISMATCH')
        result = seal({'schema_version': 'bounded-cash-run-result-v1', 'qualification': 'synthetic_test_only', 'implementation_hash': implementation_hash(),
                       'input_hash': digest(value), 'program_hash': program['program_hash'], 'decision_policy_compliance_verified': True,
                       'valuation_basis': 'terminal_processing_not_execution_settlement', 'journal': journal, 'decisions': records,
                       'curve': curve, 'event_valuation': valuation, 'sampled_max_drawdown': _ratio(maximum) if units else None,
                       'fees_cny': _text(fees), 'rounding_cny': _text(rounding), 'total_debited_cny': _text(debited),
                       'execution_failure_count': state['execution_failure_count'], 'all_planned_batches_terminal': True,
                       'live_advice_eligible': False}, 'result_hash')
        contract(result, 'result')
        return result


def compare_programs(value):
    with localcontext() as context:
        context.prec, context.rounding = 160, ROUND_HALF_EVEN
        contract(value, 'comparisonInput')
        left, right = value['candidate'], value['benchmark']
        require(left['declaration']['registered_at'] == right['declaration']['registered_at'], 'COMPARISON_START_MISMATCH')
        require(left['declaration']['policy'] == right['declaration']['policy'], 'COMPARISON_EXECUTION_POLICY_MISMATCH')
        require(left['program']['funding_schedule'] == right['program']['funding_schedule'], 'COMPARISON_CASH_FLOW_MISMATCH')
        scope = lambda side: [(row['listing_id'], Decimal(row['quantity_step'])) for row in side['program']['targets']]
        require(scope(left) == scope(right), 'COMPARISON_UNIVERSE_OR_STEP_MISMATCH')
        sides = [run_program({'schema_version': 'bounded-cash-run-input-v1', 'qualification': 'synthetic_test_only',
                              **side, 'frames': value['frames'], 'decision_points': value['decision_points']}) for side in (left, right)]
        candidate, benchmark = sides
        a, b = candidate['event_valuation'], benchmark['event_valuation']
        result = seal({'schema_version': 'bounded-cash-comparison-v1', 'qualification': 'synthetic_test_only', 'implementation_hash': implementation_hash(),
                       'input_hash': digest(value), 'candidate': candidate, 'benchmark': benchmark, 'same_recorded_cash_flows': True,
                       'same_execution_policy': True, 'benchmark_kind': 'simulated_cash_only_market_portfolio_not_index_or_actual_execution',
                       'end_nav_difference_cny': _text(Decimal(a['end_nav_cny']) - Decimal(b['end_nav_cny'])),
                       'excess_cash_flow_adjusted_return': _ratio(Decimal(a['cash_flow_adjusted_return']) - Decimal(b['cash_flow_adjusted_return'])) if a['cash_flow_adjusted_return'] is not None and b['cash_flow_adjusted_return'] is not None else None,
                       'parameters_independently_preregistered': False, 'live_advice_eligible': False}, 'comparison_hash')
        contract(result, 'comparison')
        return result


def verify_run(value, result):
    contract(result, 'result')
    require(result == run_program(value), 'FULL_RUN_REPLAY_MISMATCH')


def verify_comparison(value, result):
    contract(result, 'comparison')
    require(result == compare_programs(value), 'COMPARISON_REPLAY_MISMATCH')
