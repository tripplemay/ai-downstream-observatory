"""Explicit low-frequency research rules; no defaults, prices or execution."""

from worker.accounting.decimal_math import ONE, ZERO, canonical, decimal, financial
from worker.orchestration.db import WorkbenchError


VERSION = "research-fixed-rebalance-parameters-v2"


def period(at, zone, schedule):
    local = at.astimezone(zone)
    if schedule == "first_decision_each_year":
        return str(local.year)
    if schedule == "first_decision_each_half_year":
        return "%04d-H%d" % (local.year, 1 if local.month <= 6 else 2)
    raise WorkbenchError("INVALID_FIXED_POLICY_SCHEDULE")


def cooldown_elapsed(at, previous, zone, days):
    if type(days) is not int or not 1 <= days <= 366:
        raise WorkbenchError("INVALID_FIXED_POLICY_COOLDOWN")
    return previous is None or (at.astimezone(zone).date() - previous.astimezone(zone).date()).days >= days


@financial
def class_drift(weights, roles, values, nav, threshold):
    if (nav <= ZERO or not ZERO < threshold <= ONE or set(weights) != set(roles) or set(values) - set(roles)
            or any(role not in ("growth", "defensive", "diversifier") for role in roles.values())
            or any(value < ZERO for value in values.values())
            or any(decimal(weight) < ZERO for weight in weights.values())):
        raise WorkbenchError("INVALID_FIXED_POLICY_CLASS_SCOPE")
    targets, current = {}, {}
    for listing, weight in weights.items():
        role = roles[listing]
        targets[role] = targets.get(role, ZERO) + decimal(weight)
        current[role] = current.get(role, ZERO) + values.get(listing, ZERO) / nav
    return [{"role": role, "target_weight": canonical(targets[role]), "current_weight": canonical(current[role]),
             "difference_weight": canonical(current[role] - targets[role]),
             "threshold_breached": abs(current[role] - targets[role]) >= threshold}
            for role in sorted(targets)]
