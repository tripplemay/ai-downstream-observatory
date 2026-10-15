"""Invented, overlapping synthetic batches with later cash and cumulative holdings."""

from copy import deepcopy

from tests.execution_sandbox.fixtures import buy_input, buy_outcome
from worker.execution_sandbox.bounded_cash import execute_buys, plan_buys
from worker.execution_sandbox.journal import append_command, declare_study, new_journal


def scenario(*, second_missing=False):
    template = buy_input()
    declaration = declare_study('synthetic:continuous', '2025-01-02T06:00:00.000000Z', template['policy'])
    journal = new_journal(declaration)
    commands = [{'command_id': 'cmd:capital-1', 'at': '2025-01-02T07:02:00.000000Z', 'kind': 'cash_contribution',
                 'payload': {'contribution_id': 'capital:1', 'amount_cny': '2204'}}]
    first = deepcopy(template)
    first.update(batch_id='batch:1', settled_cash_cny='2204', unsettled_receivable_cny='0', existing_reservations=[])
    first['orders'][0]['order_id'] = 'order:1'
    first_plan = plan_buys(first)
    commands.append({'command_id': 'cmd:plan-1', 'at': first['decision_at'], 'kind': 'buy_plan', 'payload': {'input': first, 'plan': first_plan}})
    second = deepcopy(first)
    second.update(batch_id='batch:2', decision_at='2025-01-02T08:01:00.000000Z',
                  existing_reservations=[{'order_id': 'order:1', 'budget_cny': '1002'}])
    second['orders'][0].update(order_id='order:2', execute_at='2025-01-03T07:01:00.000000Z', expires_at='2025-01-03T08:01:00.000000Z')
    second['orders'][0]['decision_quote'].update(id='synthetic:decision-b', observed_at='2025-01-02T07:01:00.000000Z', known_at='2025-01-02T07:02:00.000000Z')
    second_plan = plan_buys(second)
    commands.append({'command_id': 'cmd:plan-2', 'at': second['decision_at'], 'kind': 'buy_plan', 'payload': {'input': second, 'plan': second_plan}})
    commands.append({'command_id': 'cmd:capital-2', 'at': '2025-01-02T08:02:00.000000Z', 'kind': 'cash_contribution',
                     'payload': {'contribution_id': 'capital:2', 'amount_cny': '100'}})
    for index, (value, plan, close) in enumerate(((first, first_plan, '10.12'), (second, second_plan, '10.2')), 1):
        outcome = buy_outcome(value, close=close)
        if index == 2 and second_missing:
            outcome['observations'] = []
        commands.append({'command_id': 'cmd:resolve-' + str(index), 'at': outcome['evaluated_at'], 'kind': 'buy_resolution',
                         'payload': {'batch_id': value['batch_id'], 'outcome': outcome, 'result': execute_buys(value, plan, outcome)}})
    prefixes = [deepcopy(journal)]
    for command in commands:
        journal = append_command(journal, command)
        prefixes.append(deepcopy(journal))
    return {'declaration': declaration, 'commands': commands, 'journal': journal, 'prefixes': prefixes}
