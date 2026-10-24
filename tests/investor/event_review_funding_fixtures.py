"""Synthetic continuous funding uses the same explicit event-review execution."""
from copy import deepcopy

from tests.investor.bounded_funding_fixtures import cases
from worker.investor.funded_history import calculate_funded_history, prepare_funded_history


def documents():
    original = cases()
    result = {}
    for name in ('pending_action', 'cross_year_actions', 'foreign_fx_breach_costs', 'ten_years'):
        value = deepcopy(original[name])
        value['schema_version'] = 'investor-funded-history-input-v3'
        value['context']['execution']['order_action_policy'] = 'defer_known_else_cancel_batch_and_reassess'
        if name == 'pending_action':
            value['dataset']['actions'][0]['published_at'] = value['dataset']['actions'][0]['at']
        result[name] = value
    return result


def vectors():
    return [{'name': name, 'input': value, 'result': calculate_funded_history(value, allow_synthetic=True),
             'prepared': dict(zip(('projection', 'input'), prepare_funded_history(value, allow_synthetic=True)))}
            for name, value in documents().items() if name != 'ten_years']
