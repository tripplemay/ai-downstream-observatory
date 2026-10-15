"""Invented exact-arithmetic cash flows; no owner plan, vendor data or chosen strategy."""

from copy import deepcopy
from datetime import timedelta

from tests.execution_sandbox.fixtures import buy_input, buy_outcome
from worker.execution_sandbox.bounded_cash import _time, digest, execute_buys
from worker.execution_sandbox.journal import append_command, declare_study, new_journal
from worker.execution_sandbox.projection import declare_program, decide_cash, funding_commands, value_journal


def mark(at, close='10', listing_id='CN:SYNTHETIC_A'):
    return {'listing_id': listing_id, 'quote': {'id': 'mark:' + digest([listing_id, at, close]), 'close': close, 'observed_at': at, 'known_at': at,
            'valid_until': (_time(at) + timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%S.%fZ')}, 'corporate_action_unaccounted': False}


def scenario():
    policy = buy_input()['policy']
    policy.update(price_buffer_bps='0', commission_bps='0', minimum_fee_cny='0')
    declaration = declare_study('synthetic:unitization', '2025-01-02T06:00:00.000000Z', policy)
    program = declare_program(declaration, [{'listing_id': 'CN:SYNTHETIC_A', 'weight_bps': 10000, 'quantity_step': '1'}], 0, 0,
                              [{'contribution_id': 'cash:1', 'at': '2025-01-02T07:00:00.000000Z', 'amount_cny': '1000'},
                               {'contribution_id': 'cash:2', 'at': '2025-01-04T07:00:00.000000Z', 'amount_cny': '500'}])
    journal = new_journal(declaration)
    frames, decisions, inputs = [], [], []
    for index, (funding, close, decision_at, execute_at, expires_at) in enumerate(zip(funding_commands(program), ['10', '20'],
            ['2025-01-02T08:00:00.000000Z', '2025-01-04T08:00:00.000000Z'],
            ['2025-01-03T07:00:00.000000Z', '2025-01-05T07:00:00.000000Z'],
            ['2025-01-03T08:00:00.000000Z', '2025-01-05T08:00:00.000000Z'])):
        journal = append_command(journal, funding)
        frames.append({'at': funding['at'], 'marks': [mark(funding['at'], close)]})
        value = {'schema_version': 'bounded-cash-decision-input-v1', 'qualification': 'synthetic_test_only', 'program': program,
                 'journal': deepcopy(journal), 'decision_id': 'decision:' + str(index), 'at': decision_at,
                 'execute_at': execute_at, 'expires_at': expires_at, 'marks': [mark(decision_at, close)]}
        decision = decide_cash(value)
        decisions.append(decision)
        inputs.append(value)
        command = decision['command']
        journal = append_command(journal, command)
        frames.append({'at': decision_at, 'marks': [mark(decision_at, close)]})
        batch = command['payload']
        outcome = buy_outcome(batch['input'], close)
        result = execute_buys(batch['input'], batch['plan'], outcome)
        journal = append_command(journal, {'command_id': 'resolve:' + str(index), 'at': expires_at, 'kind': 'buy_resolution',
                                         'payload': {'batch_id': batch['input']['batch_id'], 'outcome': outcome, 'result': result}})
        frames.append({'at': expires_at, 'marks': [mark(expires_at, close)]})
    final_at = '2025-01-06T08:00:00.000000Z'
    value = {'schema_version': 'bounded-cash-valuation-input-v1', 'qualification': 'synthetic_test_only', 'program': program,
             'journal': journal, 'event_frames': frames, 'final_frame': {'at': final_at, 'marks': [mark(final_at)]}}
    return {'program': program, 'decision_inputs': inputs, 'decisions': decisions, 'valuation_input': value, 'report': value_journal(value)}
