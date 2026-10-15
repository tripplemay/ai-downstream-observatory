"""Entirely invented two-asset timelines with a prospective model comparator."""

from copy import deepcopy

from tests.execution_sandbox.fixtures import buy_input
from tests.execution_sandbox.projection_fixtures import mark
from worker.execution_sandbox.bounded_cash import digest
from worker.execution_sandbox.journal import declare_study
from worker.execution_sandbox.projection import declare_program
from worker.execution_sandbox.study_run import compare_programs


def comparison_input():
    policy = buy_input()['policy']
    policy.update(price_buffer_bps='0', commission_bps='0', minimum_fee_cny='0')
    schedule = [{'contribution_id': 'cash:1', 'at': '2025-01-02T07:00:00.000000Z', 'amount_cny': '1000'},
                {'contribution_id': 'cash:2', 'at': '2025-01-04T07:00:00.000000Z', 'amount_cny': '500'}]
    sides = []
    for identity, weights in [('candidate', (9000, 1000)), ('benchmark', (5000, 5000))]:
        declaration = declare_study('synthetic:' + identity, '2025-01-02T06:00:00.000000Z', policy)
        targets = [{'listing_id': asset, 'weight_bps': weight, 'quantity_step': '1'}
                   for asset, weight in zip(['CN:SYNTHETIC_A', 'CN:SYNTHETIC_B'], weights)]
        program = declare_program(declaration, targets, 0, 0, schedule)
        sides.append({'declaration': declaration, 'program': program})
    points = [{'decision_id': 'decision:' + str(index), 'at': at, 'execute_at': execute, 'expires_at': expires}
              for index, (at, execute, expires) in enumerate([
                  ('2025-01-02T08:00:00.000000Z', '2025-01-03T07:00:00.000000Z', '2025-01-03T08:00:00.000000Z'),
                  ('2025-01-04T08:00:00.000000Z', '2025-01-05T07:00:00.000000Z', '2025-01-05T08:00:00.000000Z')])]
    times = sorted([row['at'] for row in schedule] + [row[key] for row in points for key in ('at', 'expires_at')]
                   + ['2025-01-05T10:00:00.000000Z', '2025-01-06T08:00:00.000000Z'])
    frames = []
    for at in times:
        close = '10' if at < schedule[1]['at'] or at.startswith('2025-01-06') else '40' if 'T10:' in at else '20'
        marks = [mark(at, close), mark(at, '10', 'CN:SYNTHETIC_B')]
        observations = []
        point = next((row for row in points if row['expires_at'] == at), None)
        if point:
            for row in marks:
                observations.append({'listing_id': row['listing_id'], 'quote_id': 'exec:' + digest([at, row['listing_id']]),
                                     'close': row['quote']['close'], 'observed_at': point['execute_at'], 'known_at': at,
                                     'corporate_action_since_decision': False})
        frames.append({'at': at, 'marks': marks, 'execution_observations': observations})
    return {'schema_version': 'bounded-cash-comparison-input-v1', 'qualification': 'synthetic_test_only',
            'candidate': sides[0], 'benchmark': sides[1], 'frames': frames, 'decision_points': points}


def run_input(value=None, side='candidate'):
    value = deepcopy(value if value is not None else comparison_input())
    return {'schema_version': 'bounded-cash-run-input-v1', 'qualification': 'synthetic_test_only',
            **value[side], 'frames': value['frames'], 'decision_points': value['decision_points']}


def scenario():
    value = comparison_input()
    return {'input': value, 'comparison': compare_programs(value)}
