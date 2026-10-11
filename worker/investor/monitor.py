"""Pure model monitoring; funding is hypothetical, never cash or execution."""

from decimal import ROUND_DOWN

from worker.accounting.decimal_math import ONE, ZERO, canonical, decimal, financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp
from .implementation import implementation_hash
from .policy_monitor import ENGINE_VERSION as POLICY_ENGINE_VERSION, prepare_policy, evaluate_policy, next_policy_state


ENGINE_VERSION = "investor-model-monitor-v1"


def _cost_rates(costs):
    if costs is None:
        return None
    rates = {key: decimal(costs[key]) for key in ("commission_bps", "minimum_fee_cny", "fx_bps", "slippage_bps", "maximum_cost_fraction")}
    if (any(value < ZERO for value in rates.values())
            or any(rates[key] >= 10000 for key in ("commission_bps", "fx_bps", "slippage_bps"))
            or rates["maximum_cost_fraction"] > ONE):
        raise WorkbenchError("INVESTOR_MODEL_COST_INVALID")
    return rates


def _estimate_cost(changes, quotes, rates):
    total = ZERO
    for listing, amount in changes.items():
        notional = abs(amount)
        if notional == ZERO:
            continue
        total += max(rates["minimum_fee_cny"], notional * rates["commission_bps"] / 10000)
        total += notional * (rates["slippage_bps"] + (rates["fx_bps"] if quotes[listing]["currency"] != "CNY" else ZERO)) / 10000
    return total


def _contribution_repair(differences, available, quotes, rates):
    deficits = {key: max(ZERO, value) for key, value in differences.items()}
    total = sum(deficits.values(), ZERO)
    if total == ZERO or available == ZERO:
        return {key: ZERO for key in deficits}
    upper = min(ONE, available / total)
    lower = ZERO

    def amounts(scale):
        return {key: (value * scale).quantize(decimal("0.01"), rounding=ROUND_DOWN) for key, value in deficits.items()}

    proposal = amounts(upper)
    if sum(proposal.values(), ZERO) + _estimate_cost(proposal, quotes, rates) <= available:
        return proposal
    # Reserve estimated costs without selling overweight assets to fund them.
    for _ in range(100):
        midpoint = (lower + upper) / 2
        proposal = amounts(midpoint)
        if sum(proposal.values(), ZERO) + _estimate_cost(proposal, quotes, rates) <= available:
            lower = midpoint
        else:
            upper = midpoint
    return amounts(lower)


@financial
def assess_model(document, now):
    """Internal trusted producer input, not an app/user prepared-result API.

    Calendar/quote/source hashes must be dereferenced by the publisher. This
    arithmetic kernel cannot certify their origins or update model holdings.
    """
    fixed = document.get("schema_version") == "investor-model-monitor-v3"
    validate_contract(document, "investor-model-monitor-v3.schema.json" if fixed else "investor-model-monitor-v2.schema.json" if document.get("schema_version") == "investor-model-monitor-v2" else "investor-model-monitor.schema.json")
    at = instant(now)
    context = prepare_policy(document, at) if fixed else None
    before, after = ({key: decimal(value) for key, value in document[name].items()} for name in ("before_weights", "after_weights"))
    quantities = {key: decimal(value) for key, value in document["quantities"].items()}
    cash = decimal(document["cash_cny"])
    non_cash = decimal(document.get("non_cash_assets_cny", "0"))
    policy = document["policy"]
    tolerance_rule = context["parameters"]["tolerance"] if fixed else None
    band, absolute = (decimal(tolerance_rule["weight"]), decimal(tolerance_rule["absolute_cny"])) if fixed else (decimal(policy["weight_band"]), decimal(policy["absolute_band_cny"]))
    rates = _cost_rates(policy["costs"])
    if (sum(before.values(), ZERO) != ONE or sum(after.values(), ZERO) != ONE
            or any(not ZERO <= value <= ONE for value in [*before.values(), *after.values()])
            or any(value < ZERO for value in quantities.values()) or cash < ZERO or non_cash < ZERO or not ZERO <= band <= ONE or absolute < ZERO):
        raise WorkbenchError("INVESTOR_MODEL_INPUT_INVALID")
    required = set(before) | set(after) | set(quantities)
    quotes = {row["listing_id"]: row for row in document["quotes"]}
    if len(quotes) != len(document["quotes"]) or set(quotes) != required:
        raise WorkbenchError("INVESTOR_MODEL_QUOTE_SCOPE_INVALID")
    fx = {row["currency"]: row for row in document["fx"]}
    currencies = {row["currency"] for row in quotes.values()} - {"CNY"}
    if len(fx) != len(document["fx"]) or set(fx) != currencies:
        raise WorkbenchError("INVESTOR_MODEL_FX_SCOPE_INVALID")
    gaps = list(document["quality_gaps"])
    cutoffs, deadlines = [], []
    for row in quotes.values():
        close, known, expected, expiry = (instant(row[key]) for key in ("observed_at", "known_at", "expected_close_at", "valid_until"))
        if decimal(row["close"]) <= ZERO or known < close or expected > at or expiry <= known:
            raise WorkbenchError("INVESTOR_MODEL_QUOTE_INVALID")
        if known > at or close > at: gaps.append("QUOTE_NOT_KNOWN_AT_EVALUATION")
        if close != expected or expiry <= at: gaps.append("MARKET_DATA_NOT_CURRENT:" + row["market"])
        cutoffs.append(close); deadlines.append(expiry)
    for row in fx.values():
        observed, known, expiry = (instant(row[key]) for key in ("observed_at", "known_at", "valid_until"))
        if decimal(row["value"]) <= ZERO or known < observed or expiry <= known:
            raise WorkbenchError("INVESTOR_MODEL_FX_INVALID")
        if known > at or observed > at: gaps.append("FX_NOT_KNOWN_AT_EVALUATION")
        if expiry <= at or (at - observed).total_seconds() > policy["max_fx_age_seconds"]: gaps.append("FX_NOT_CURRENT:" + row["currency"])
        cutoffs.append(observed); deadlines.append(expiry)
    intent = document["funding_intent"]
    if intent is not None and decimal(intent["amount_cny"]) <= ZERO:
        raise WorkbenchError("INVESTOR_MODEL_FUNDING_INTENT_INVALID")
    funding_due = intent is not None and instant(intent["expected_at"]) <= at
    if intent is not None and not funding_due: deadlines.append(instant(intent["expected_at"]))
    output = {"schema_version": "investor-model-assessment-v2" if fixed else "investor-model-assessment-v1", "engine_version": POLICY_ENGINE_VERSION if fixed else ENGINE_VERSION,
              "implementation_hash": implementation_hash(),
              "profile_id": document["profile_id"], "profile_version": document["profile_version"],
              "input_version": content_hash({"document": document, "funding_due": funding_due}), "evaluated_at": stamp(at),
              "data_cutoff": stamp(min(cutoffs)), "market_cutoffs": {market: stamp(min(instant(row["observed_at"]) for row in quotes.values() if row["market"] == market)) for market in sorted({row["market"] for row in quotes.values()})},
              "next_review_at": stamp(min(deadlines)) if min(deadlines) > at else None,
              "gaps": sorted(set(gaps)), "reason_codes": [], "changes": [], "model_nav_cny": None,
              "estimated_cost_cny": None, "allocation_method": "none", "hypothetical_cash_remaining_cny": None,
              "funding_status": "hypothetical_due" if funding_due else "not_due" if intent else "none",
              "constraints_not_checked": ["lot_size", "tradability", "actual_cash", "settlement", "tax", "account_permissions"],
              "scope": "research_model", "actual_holdings_linked": False, "execution_authorized": False, "live_advice_eligible": False}
    if fixed:
        output.update(policy_evaluation=None, next_policy_state=context["state"])

    def finish(outcome, reasons):
        if fixed:
            output["next_policy_state"] = next_policy_state(context, outcome)
        result = {**output, "outcome": outcome, "reason_codes": reasons}
        result["result_hash"] = content_hash(result)
        validate_contract(result, "investor-model-assessment-v2.schema.json" if fixed else "investor-model-assessment.schema.json")
        return result

    if gaps: return finish("insufficient_evidence", ["REQUIRED_INPUTS_NOT_CURRENT"])
    values = {key: quantities.get(key, ZERO) * decimal(row["close"]) * (ONE if row["currency"] == "CNY" else decimal(fx[row["currency"]]["value"])) for key, row in quotes.items()}
    nav = cash + non_cash + sum(values.values(), ZERO)
    if nav <= ZERO: raise WorkbenchError("INVESTOR_MODEL_NONPOSITIVE_NAV")
    funding = decimal(intent["amount_cny"]) if funding_due else ZERO
    projected = nav + funding
    tolerance = max(absolute, projected * band)
    output["model_nav_cny"] = canonical(nav)
    triggers = []
    if funding_due: triggers.append("NEW_PLANNED_FUNDING")
    if any(abs(after.get(key, ZERO) - before.get(key, ZERO)) > band for key in required): triggers.append("TARGET_WEIGHTS_CHANGED")
    if any(abs(values[key] - nav * after.get(key, ZERO)) > max(absolute, nav * band) for key in required): triggers.append("MODEL_DRIFT_OUTSIDE_BAND")
    repair = funding_due
    if fixed:
        output["policy_evaluation"] = evaluate_policy(context, document, values, nav, funding_due)
        context["document_funding_intent"] = document["funding_intent"]
        triggers, repair = context["triggers"], context["repair"]
    differences = {key: projected * after.get(key, ZERO) - values[key] for key in required}
    for key in sorted(required):
        current, target = values[key], projected * after.get(key, ZERO)
        output["changes"].append({"listing_id": key, "before_target_weight": canonical(before.get(key, ZERO)), "after_target_weight": canonical(after.get(key, ZERO)),
                                  "observed_model_weight": canonical(current / nav), "current_model_value_cny": canonical(current),
                                  "hypothetical_target_value_cny": canonical(target), "difference_cny": canonical(target - current),
                                  "within_band": abs(target - current) <= tolerance, "proposed_change_cny": "0",
                                  "remaining_target_difference_cny": canonical(target - current)})
    if not triggers: return finish("observe", ["FIXED_POLICY_WITHIN_CLASS_BANDS" if fixed else "MODEL_WITHIN_CONFIRMED_BANDS"])
    if fixed:
        if not context["eligible"]:
            return finish("observe", ["POLICY_COOLDOWN_NO_NEW_ADVICE", *triggers])
        if all(row["within_band"] for row in output["changes"]):
            return finish("observe", ["POLICY_TARGETS_WITHIN_TOLERANCE", *triggers])
    if rates is None:
        output["gaps"] = ["COST_ASSUMPTIONS_MISSING"]
        return finish("insufficient_evidence", ["CANNOT_COMPARE_CHANGE_COST"])
    if repair:
        needs = {key: value if abs(value) > tolerance else ZERO for key, value in differences.items()} if fixed else differences
        proposal = _contribution_repair(needs, cash + funding, quotes, rates)
        output["allocation_method"] = "contribution_repair_without_sales"
    else:
        proposal = {key: amount if abs(amount) > tolerance else ZERO for key, amount in differences.items()}
        output["allocation_method"] = "band_rebalance_research_not_executable"
    total_cost = _estimate_cost(proposal, quotes, rates)
    for row in output["changes"]:
        amount = proposal[row["listing_id"]]
        row["proposed_change_cny"] = canonical(amount)
        row["remaining_target_difference_cny"] = canonical(decimal(row["difference_cny"]) - amount)
    output["estimated_cost_cny"] = canonical(total_cost)
    if repair:
        output["hypothetical_cash_remaining_cny"] = canonical(cash + funding - sum(proposal.values(), ZERO) - total_cost)
        if not any(amount > ZERO for amount in proposal.values()):
            output["gaps"] = ["FUNDING_CANNOT_BE_ALLOCATED_WITHIN_COST_BUDGET"]
            return finish("insufficient_evidence", ["NO_COST_QUALIFIED_CONTRIBUTION_REPAIR"])
    if total_cost / projected > rates["maximum_cost_fraction"]:
        output["gaps"] = ["CHANGE_COST_EXCEEDS_POLICY"]
        return finish("insufficient_evidence", ["CHANGE_NOT_COST_QUALIFIED"])
    return finish("decision_required", triggers)
