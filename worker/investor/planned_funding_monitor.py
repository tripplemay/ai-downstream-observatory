"""Pure annual-plan projection; no database authority, cash, orders or data I/O."""

from copy import deepcopy
from datetime import datetime, time
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant
from .funding_plan import funding_timeline


CONTRACT = "investor-planned-funding-monitor.schema.json"
SCALE = 10 ** 18
NORMALIZATION = "sum_selected_annual_cents_divided_by_initial_cents_times_10000_floor_18_places"


def _cents(value):
    whole, _, fraction = value.partition(".")
    return int(whole) * 100 + int(fraction.ljust(2, "0") or "0")


def _normalized(cents, initial):
    # Integer rational arithmetic is independent of the caller's Decimal context.
    scaled = cents * 10000 * SCALE // initial
    whole, fraction = divmod(scaled, SCALE)
    tail = str(fraction).rjust(18, "0").rstrip("0")
    return str(whole) + ("." + tail if tail else "")


def _stamp(value):
    return instant(value).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def project_planned_funding_monitor(request):
    validate_contract(request, CONTRACT)
    plan, binding = request["funding_plan"], request["binding"]
    if content_hash(plan) != binding["funding_plan_hash"]:
        raise WorkbenchError("INVESTOR_PLANNED_FUNDING_HASH_INVALID")
    timeline = funding_timeline(plan)
    evaluated = instant(request["evaluated_at"])
    anchor = max(instant(binding["model_created_at"]), instant(binding["plan_declared_at"]))
    if anchor > evaluated:
        raise WorkbenchError("INVESTOR_PLANNED_FUNDING_CLOCK_REGRESSION")
    zone = ZoneInfo(plan["evaluation_timezone"])

    def midnight(text):
        local = datetime.combine(datetime.fromisoformat(text).date(), time.min)
        candidates = set()
        for fold in (0, 1):
            candidate = instant(local.replace(tzinfo=zone, fold=fold))
            if candidate.astimezone(zone).replace(tzinfo=None) == local:
                candidates.add(candidate)
        if len(candidates) != 1:
            raise WorkbenchError("INVESTOR_PLANNED_FUNDING_CALENDAR_INVALID")
        return candidates.pop()

    end = midnight(timeline["horizon_end_exclusive"])
    releases, due, future = [], [], []
    for lot in timeline["lots"]:
        # The observation model already has a normalized initial notional. This
        # projection neither applies nor simulates the initial-entry tranches.
        if lot["lot_id"] == "initial":
            continue
        for index, tranche in enumerate(lot["tranches"]):
            at = midnight(tranche["release_date"])
            status = "excluded_outside_horizon" if not tranche["within_horizon"] else "excluded_before_anchor" if at < anchor \
                else "due" if at <= evaluated else "scheduled"
            release = {"id": lot["lot_id"] + ":tranche:" + str(index), "release_date": tranche["release_date"],
                "expected_at": _stamp(at), "status": status}
            releases.append(release)
            if status in ("due", "scheduled"):
                (due if status == "due" else future).append((release, _cents(tranche["amount_cny"])))
    initial = _cents(plan["initial_capital_cny"])
    next_at = min((row[0]["expected_at"] for row in future), default=None)
    selected = due or [row for row in future if row[0]["expected_at"] == next_at]
    expired = evaluated >= end
    binding_hash = content_hash(binding)
    intent = None
    if selected and not expired:
        intent = {"id": "planned-annual:" + content_hash({"binding_hash": binding_hash, "release_ids": [row[0]["id"] for row in selected]}),
            "amount_cny": _normalized(sum(row[1] for row in selected), initial),
            "expected_at": max(row[0]["expected_at"] for row in selected)}
    status = "expired" if expired else "hypothetical_due" if due else "not_due" if future \
        else "none" if plan["first_annual_date"] is None else "no_eligible_releases"
    body = {"schema_version": "investor-planned-funding-monitor-projection-v1", "input_version": content_hash(request),
        "binding": deepcopy(binding), "binding_hash": binding_hash, "evaluated_at": request["evaluated_at"], "anchor_at": _stamp(anchor),
        "horizon_end_at": _stamp(end), "evaluation_timezone": plan["evaluation_timezone"], "initial_notional_cny": "10000",
        "normalization": NORMALIZATION, "status": status, "releases": releases,
        "due_amount_normalized_cny": _normalized(sum(row[1] for row in due), initial), "funding_intent": intent,
        "next_release_at": None if expired else next_at, "valid_until": None if expired else min(next_at or _stamp(end), _stamp(end)),
        "qualification": "unadmitted_planned_funding_projection", "actual_arrivals_confirmed": False,
        "model_cash_changed": False, "model_units_changed": False, "execution_authorized": False, "live_advice_eligible": False}
    result = {**body, "result_hash": content_hash(body)}
    validate_contract(result, CONTRACT, fragment="$defs/projection")
    return result


def verify_planned_funding_monitor(request, result):
    validate_contract(result, CONTRACT, fragment="$defs/projection")
    if result != project_planned_funding_monitor(request):
        raise WorkbenchError("INVESTOR_PLANNED_FUNDING_RESULT_INVALID")
    return deepcopy(result)


def planned_funding_context_hash(request):
    """Stable release bucket, rebuilt from the plan, not a self-reported result."""
    result = project_planned_funding_monitor(request)
    return content_hash({"schema_version": "investor-planned-funding-context-v1", **{
        key: result[key] for key in ("binding_hash", "status", "releases", "due_amount_normalized_cny",
            "funding_intent", "next_release_at", "valid_until")}})
