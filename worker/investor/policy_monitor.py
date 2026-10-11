"""Stateful frozen-rule assessment; the publisher must prove state provenance."""

from copy import deepcopy
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.accounting.decimal_math import ONE, ZERO, canonical, decimal
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from worker.research.fixed_policy import class_drift, cooldown_elapsed, period
from worker.research.snapshot import fact_decimal


ENGINE_VERSION = "investor-fixed-policy-monitor-v1"


def funding_identity(intent):
    return content_hash({"id": intent["id"], "amount_cny": canonical(decimal(intent["amount_cny"])),
        "expected_at": stamp(instant(intent["expected_at"]))})


def prepare_policy(document, at):
    rule = document["fixed_policy"]
    parameters, state = rule["parameters"], rule["state"]
    try:
        zone = ZoneInfo(rule["evaluation_timezone"])
    except (ZoneInfoNotFoundError, ValueError):
        raise WorkbenchError("INVESTOR_FIXED_POLICY_TIMEZONE_INVALID") from None
    weights, roles = parameters["weights"], parameters["roles"]
    if (set(weights) != set(roles) or set(weights) != set(document["quantities"])
            or any(not ZERO <= fact_decimal(weight) <= ONE for weight in weights.values())
            or any(set(weights) != set(document[key]) or any(decimal(document[key][listing]) != decimal(weight)
                for listing, weight in weights.items()) for key in ("before_weights", "after_weights"))
            or document["before_plan_hash"] != document["after_plan_hash"]
            or not ZERO < fact_decimal(parameters["class_drift_threshold"]) <= ONE
            or fact_decimal(parameters["tolerance"]["absolute_cny"]) < ZERO
            or not ZERO <= fact_decimal(parameters["tolerance"]["weight"]) <= ONE):
        raise WorkbenchError("INVESTOR_FIXED_POLICY_SCOPE_INVALID")
    review, proposed = (instant(state[key]) if state[key] is not None else None for key in ("last_review_at", "last_proposed_at"))
    if (any(value is not None and value > at for value in (review, proposed))
            or proposed is not None and (review is None or proposed > review)
            or state["last_funding_hash"] is not None and proposed is None
            or state["cash_cny_seen"] is not None and decimal(state["cash_cny_seen"]) < ZERO
            or state["cash_cny_seen"] is None and (review is not None or proposed is not None or state["cash_repair_pending"])):
        raise WorkbenchError("INVESTOR_FIXED_POLICY_STATE_INVALID")
    current = period(at, zone, parameters["rebalance"])
    return {"parameters": parameters, "state": deepcopy(state), "at": at, "zone": zone,
        "calendar_due": review is None or period(review, zone, parameters["rebalance"]) != current,
        "review_period": current, "cooldown_active": not cooldown_elapsed(at, proposed, zone, parameters["minimum_days_between_rebalances"])}


def evaluate_policy(context, document, values, nav, funding_due):
    parameters, state = context["parameters"], context["state"]
    classes = class_drift(parameters["weights"], parameters["roles"], values, nav, decimal(parameters["class_drift_threshold"]))
    cash = decimal(document["cash_cny"])
    new_cash = state["cash_cny_seen"] is not None and cash > decimal(state["cash_cny_seen"])
    pending_cash = cash > ZERO and (state["cash_repair_pending"] or new_cash)
    new_funding = funding_due and funding_identity(document["funding_intent"]) != state["last_funding_hash"]
    triggers = (["NEW_PLANNED_FUNDING" if new_funding else "PLANNED_FUNDING_REVIEW_OPEN"] if funding_due else [])
    triggers += (["NEW_MODEL_CNY_CASH" if new_cash else "MODEL_CNY_CASH_REVIEW_OPEN"] if pending_cash else [])
    triggers += (["CALENDAR_POLICY_REVIEW"] if context["calendar_due"] else [])
    triggers += (["CLASS_WEIGHT_BREACH"] if any(row["threshold_breached"] for row in classes) else [])
    context.update(triggers=triggers, repair=funding_due or pending_cash,
        eligible=funding_due or pending_cash or not context["cooldown_active"], cash=cash,
        new_funding=new_funding, new_cash=new_cash, pending_cash=pending_cash, funding_due=funding_due)
    return {"parameters_hash": content_hash(parameters), "evaluation_timezone": document["fixed_policy"]["evaluation_timezone"],
        "review_period": context["review_period"], "calendar_due": context["calendar_due"], "cooldown_active": context["cooldown_active"],
        "new_funding": new_funding, "new_cny_cash": new_cash, "cash_repair_pending": pending_cash, "class_drift": classes}


def next_policy_state(context, outcome):
    state = deepcopy(context["state"])
    if outcome == "insufficient_evidence":
        return state
    state.update(cash_cny_seen=canonical(context["cash"]), cash_repair_pending=context["pending_cash"])
    if context["eligible"] and context["triggers"] and (context["calendar_due"] or not context["repair"] or context["new_funding"] or context["new_cash"]):
        state["last_review_at"] = stamp(context["at"])
    if outcome == "decision_required":
        # Repeated unexecuted funding/cash ideas stay visible but do not slide
        # the cooldown anchor forever; no model units are ever changed here.
        if state["last_proposed_at"] is None or not context["repair"] or context["new_funding"] or context["new_cash"]:
            state["last_proposed_at"] = stamp(context["at"])
        if context["funding_due"]:
            state["last_funding_hash"] = funding_identity(context["document_funding_intent"])
    return state
