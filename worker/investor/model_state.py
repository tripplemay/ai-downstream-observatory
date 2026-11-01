"""Continuous, normalized observation model; no suggested trade is executed."""

from copy import deepcopy
from decimal import ROUND_DOWN
import re

from worker.accounting.decimal_math import ONE, ZERO, canonical, decimal, financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant
from .monitor import assess_model
from .model_contracts import validate_definition, definition_basis
from .planned_funding_monitor import project_planned_funding_monitor


INITIAL_NOTIONAL = "10000"


def _error(code):
    raise WorkbenchError("INVESTOR_MODEL_" + code)


@financial
def advance_model(definition, snapshot, previous, now):
    """Build a candidate checkpoint, then independently assess its freshness.

    The trusted publisher must bind source receipts and only persist a candidate
    with a valid assessment. Current snapshots are explicitly synthetic only.
    Prices use unadjusted basis; splits and dividend receivables are separate.
    Accept/defer/reject never appears in this state transition.
    """
    validate_definition(definition)
    validate_contract(snapshot, "investor-model-snapshot.schema.json")
    if definition["data_mode"] != "synthetic": _error("SOURCE_MODE_UNSUPPORTED")
    return _advance(definition, snapshot, previous, now)


@financial
def advance_evidence_model(definition, projection, previous, now, *, input_hash, sparse=False, planned_funding=None):
    """Receipt-qualified projection; the caller must independently replay it.

    This does not admit caller quotes or certify the reviewed source. Keeping
    distinct contracts prevents a real source from entering a synthetic path.
    """
    validate_definition(definition)
    validate_contract(projection, "investor-monitor-data-projection-v2.schema.json" if projection.get("schema_version") == "investor-monitor-data-projection-v2" else "investor-monitor-data-projection.schema.json")
    if definition["data_mode"] != "reconstructed" or not re.fullmatch(r"[a-f0-9]{64}", input_hash): _error("SOURCE_MODE_UNSUPPORTED")
    if not instant(projection["created_at"]) <= instant(now) < instant(projection["valid_until"]): _error("PROJECTION_EXPIRED_OR_FUTURE")
    if type(sparse) is not bool: _error("CHECKPOINT_POLICY_INVALID")
    funding = project_planned_funding_monitor(planned_funding) if planned_funding is not None else None
    if funding is not None:
        binding = funding["binding"]
        if (funding["evaluated_at"] != now or binding["model_id"] != definition["model_id"]
                or binding["model_hash"] != content_hash(definition) or binding["profile_hash"] != definition["profile_hash"]
                or binding["model_created_at"] != definition["created_at"]): _error("FUNDING_BINDING_INVALID")
        if projection["funding_intent"] is not None: _error("FUNDING_INTENTS_CONFLICT")
        if funding["status"] == "expired": _error("FUNDING_PLAN_WINDOW_EXPIRED")
    return _advance(definition, projection, previous, now, evidence_hash=input_hash, sparse=sparse, planned_funding=funding)


def _advance(definition, snapshot, previous, now, *, evidence_hash=None, sparse=False, planned_funding=None):
    validate_definition(definition)
    fixed = definition["schema_version"] == "investor-model-definition-v2"
    checkpoint_schema = "investor-evidence-model-checkpoint-v2.schema.json" if fixed else "investor-evidence-model-checkpoint.schema.json" if evidence_hash else "investor-model-checkpoint.schema.json"
    if planned_funding is not None:
        checkpoint_schema = "investor-evidence-model-checkpoint-v3.schema.json"
    snapshot_hash = evidence_hash or content_hash(snapshot)
    if not isinstance(now, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", now): _error("CLOCK_PRECISION")
    if snapshot["model_id"] != definition["model_id"]: _error("SNAPSHOT_OUT_OF_SCOPE")
    at = instant(now)
    if instant(definition["created_at"]) > at or instant(definition["valid_until"]) <= at: _error("DEFINITION_EXPIRED_OR_FUTURE")
    expected_hash = content_hash(definition_basis(definition))
    if definition["target_definition_hash"] != expected_hash: _error("TARGET_BINDING_INVALID")
    targets = {row["listing_id"]: row for row in definition["targets"]}
    if len(targets) != len(definition["targets"]): _error("DUPLICATE_TARGET")
    quotes = {row["listing_id"]: row for row in snapshot["quotes"]}
    fx = {row["currency"]: decimal(row["value"]) for row in snapshot["fx"]}
    if len(quotes) != len(snapshot["quotes"]) or set(quotes) != set(targets): _error("SNAPSHOT_LISTING_SCOPE")
    if len(fx) != len(snapshot["fx"]) or set(fx) != {row["currency"] for row in targets.values()} - {"CNY"}: _error("SNAPSHOT_FX_SCOPE")
    cutoffs = {}
    for listing, target in targets.items():
        quote = quotes[listing]
        if quote["market"] != target["market"] or quote["currency"] != target["currency"] or decimal(quote["close"]) <= ZERO:
            _error("SNAPSHOT_IDENTITY_OR_PRICE")
        if target["market"] in cutoffs and cutoffs[target["market"]] != quote["observed_at"]: _error("INCONSISTENT_MARKET_CUTOFF")
        cutoffs[target["market"]] = quote["observed_at"]
    if any(value <= ZERO for value in fx.values()): _error("SNAPSHOT_FX_VALUE")
    coverage = snapshot["corporate_action_coverage"]
    if set(coverage) != set(cutoffs): _error("ACTION_COVERAGE_SCOPE")
    gaps = list(snapshot["quality_gaps"])
    for market, window in coverage.items():
        if instant(window["from"]) > instant(window["to"]) or instant(window["to"]) != instant(cutoffs[market]): _error("ACTION_COVERAGE_WINDOW")
        if not window["complete"]: gaps.append("CORPORATE_ACTION_COVERAGE_INCOMPLETE")

    weights = {key: row["weight"] for key, row in targets.items()}
    if any(decimal(weight) <= ZERO for weight in weights.values()) or sum((decimal(value) for value in weights.values()), ZERO) != ONE: _error("TARGET_WEIGHTS_INVALID")
    if previous is not None:
        if previous.get("schema_version") == "investor-evidence-model-checkpoint-v3":
            if planned_funding is None: _error("FUNDING_CONTEXT_REQUIRED")
            validate_contract(previous, "investor-evidence-model-checkpoint-v3.schema.json")
            bound = previous["funding_binding"]
            if (bound["model_id"] != definition["model_id"] or bound["model_hash"] != content_hash(definition)
                    or bound["profile_hash"] != definition["profile_hash"] or bound["model_created_at"] != definition["created_at"]
                    or instant(bound["plan_declared_at"]) > instant(previous["created_at"])): _error("FUNDING_BINDING_INVALID")
        else:
            validate_contract(previous, "investor-evidence-model-checkpoint-v2.schema.json" if fixed else "investor-evidence-model-checkpoint.schema.json" if evidence_hash else "investor-model-checkpoint.schema.json")
        if fixed != ("policy_state" in previous): _error("CHECKPOINT_OUT_OF_SCOPE")
        if (previous["model_id"] != definition["model_id"] or previous["profile_id"] != definition["profile_id"]
                or previous["target_definition_hash"] != definition["target_definition_hash"]
                or set(previous["quantities"]) != set(targets) or set(previous["market_cutoffs"]) != set(cutoffs)
                or set(previous["initialized_at"]) != set(cutoffs)
                or instant(previous["created_at"]) > at): _error("CHECKPOINT_OUT_OF_SCOPE")
        if any(decimal(value) < ZERO for value in [*previous["quantities"].values(), *previous["cash_by_currency"].values()]): _error("NEGATIVE_CHECKPOINT_ASSET")
        for market, cutoff in cutoffs.items():
            if instant(previous["initialized_at"][market]) > instant(previous["market_cutoffs"][market]): _error("CHECKPOINT_INCEPTION_INVALID")
            if instant(cutoff) < instant(previous["market_cutoffs"][market]): _error("CHECKPOINT_TIME_REGRESSION")
            if instant(coverage[market]["from"]) > instant(previous["market_cutoffs"][market]): gaps.append("CORPORATE_ACTION_COVERAGE_GAP")
        if any(currency not in fx and decimal(value) != ZERO for currency, value in previous["cash_by_currency"].items() if currency != "CNY"):
            _error("CHECKPOINT_CURRENCY_OUT_OF_SCOPE")
        candidate = deepcopy(previous)
        candidate.update(market_cutoffs=cutoffs)
        if not sparse:
            candidate.update(sequence=previous["sequence"] + 1, previous_hash=content_hash(previous), created_at=now, input_hash=snapshot_hash)
    else:
        quantities = {}
        invested = ZERO
        for key, target in targets.items():
            price = decimal(quotes[key]["close"]) * (ONE if target["currency"] == "CNY" else fx[target["currency"]])
            quantity = (decimal(INITIAL_NOTIONAL) * decimal(target["weight"]) / price).quantize(decimal("0.000000000000000001"), rounding=ROUND_DOWN)
            if quantity <= ZERO: _error("INITIAL_UNIT_PRECISION_INSUFFICIENT")
            quantities[key] = canonical(quantity)
            invested += quantity * price
        residual = decimal(INITIAL_NOTIONAL) - invested
        if residual < ZERO: _error("INITIAL_VALUE_NOT_CONSERVED")
        candidate = {"schema_version": "investor-model-checkpoint-v1", "model_id": definition["model_id"], "profile_id": definition["profile_id"],
                     "target_definition_hash": definition["target_definition_hash"], "sequence": 1, "previous_hash": None,
                     "input_hash": snapshot_hash, "created_at": now, "initialized_at": deepcopy(cutoffs), "market_cutoffs": cutoffs,
                     "quantities": quantities, "cash_by_currency": {"CNY": canonical(residual), "HKD": "0", "USD": "0"},
                     "receivables": [], "entitlements": {}, "processed_actions": {}, "initial_notional_cny": INITIAL_NOTIONAL,
                     "assumptions": ["Normalized valuation-only reference starting at 10000 CNY, not personal cash or account performance",
                                     "Fractional model units; no entry trade, lot, settlement or execution is simulated",
                                     "Dividend amounts use declared net-per-unit tax assumptions, not actual account tax",
                                     "No proposed rebalance or planned funding is applied to model holdings"],
                     "scope": "research_model", "data_mode": "synthetic", "live_advice_eligible": False}

    if evidence_hash and (previous is None or not sparse):
        candidate.update(schema_version="investor-evidence-model-checkpoint-v2" if fixed else "investor-evidence-model-checkpoint-v1", data_mode="reconstructed", projection_hash=content_hash(snapshot))
    if fixed and previous is None:
        candidate["policy_state"] = {"last_review_at": None, "last_proposed_at": None, "last_funding_hash": None,
            "cash_cny_seen": None, "cash_repair_pending": False}
    if planned_funding is not None:
        candidate.update(schema_version="investor-evidence-model-checkpoint-v3", funding_binding=deepcopy(planned_funding["binding"]))

    actions = snapshot["corporate_actions"]
    if len({row["id"] for row in actions}) != len(actions): _error("DUPLICATE_ACTION")
    receivables = {row["id"]: deepcopy(row) for row in candidate["receivables"]}
    if len(receivables) != len(candidate["receivables"]): _error("DUPLICATE_RECEIVABLE")
    pending = {}
    for identity, entitlement in candidate["entitlements"].items():
        listing = entitlement["listing_id"]
        if (identity != entitlement["id"] or listing not in targets or entitlement["currency"] != targets[listing]["currency"]
                or decimal(entitlement["amount"]) < ZERO or instant(entitlement["ex_at"]) <= instant(candidate["initialized_at"][targets[listing]["market"]])
                or instant(entitlement["ex_at"]) > instant(candidate["market_cutoffs"][targets[listing]["market"]])): _error("ENTITLEMENT_INVALID")
        if not entitlement["paid"]: pending[identity] = {key: value for key, value in entitlement.items() if key != "paid"}
    if pending != receivables: _error("ENTITLEMENT_RECEIVABLE_BINDING_INVALID")
    for receivable in receivables.values():
        if (receivable["listing_id"] not in targets or receivable["currency"] != targets[receivable["listing_id"]]["currency"]
                or decimal(receivable["amount"]) < ZERO
                or instant(receivable["ex_at"]) <= instant(candidate["initialized_at"][targets[receivable["listing_id"]]["market"]])
                or instant(receivable["ex_at"]) > instant(candidate["market_cutoffs"][targets[receivable["listing_id"]]["market"]])): _error("RECEIVABLE_INVALID")
    ranks = {"split": 0, "dividend_ex": 1, "dividend_payment": 2}
    for action in sorted(actions, key=lambda row: (instant(row["effective_at"]), ranks[row["kind"]], row["id"])):
        listing = action["listing_id"]
        if listing not in targets: _error("ACTION_OUT_OF_SCOPE")
        market = targets[listing]["market"]
        effective = instant(action["effective_at"])
        if instant(action["known_at"]) > at: gaps.append("CORPORATE_ACTION_NOT_KNOWN")
        if effective > instant(cutoffs[market]): _error("ACTION_AFTER_MARKET_CUTOFF")
        kind, digest = action["kind"], content_hash(action)
        expected_keys = {"id", "listing_id", "kind", "effective_at", "known_at"} | {
            "split": {"ratio"}, "dividend_ex": {"currency", "net_per_unit", "entitlement_id", "tax_assumption_hash"},
            "dividend_payment": {"currency", "entitlement_id", "ex_at"}}[kind]
        if set(action) != expected_keys: _error("ACTION_FIELDS_INVALID")
        if kind == "split" and decimal(action["ratio"]) <= ZERO: _error("SPLIT_RATIO_INVALID")
        if kind != "split" and action["currency"] != targets[listing]["currency"]: _error("DIVIDEND_CURRENCY_INVALID")
        if kind == "dividend_ex" and decimal(action["net_per_unit"]) < ZERO: _error("DIVIDEND_AMOUNT_INVALID")
        if kind == "dividend_payment" and instant(action["ex_at"]) > effective: _error("DIVIDEND_CHRONOLOGY_INVALID")
        prior_hash = candidate["processed_actions"].get(action["id"])
        if prior_hash is not None:
            if prior_hash != digest: _error("ACTION_RESTATEMENT_REQUIRED")
            continue
        if previous is None or effective <= instant(previous["market_cutoffs"][market]):
            # Initial units start after this close. Newly discovered historical
            # events after inception require explicit restatement, not silence.
            if previous is not None and effective > instant(previous["initialized_at"][market]): _error("ACTION_RESTATEMENT_REQUIRED")
            candidate["processed_actions"][action["id"]] = digest
            continue
        quantity = decimal(candidate["quantities"][listing])
        if kind == "split": candidate["quantities"][listing] = canonical(quantity * decimal(action["ratio"]))
        elif kind == "dividend_ex":
            identity = action["entitlement_id"]
            if identity in candidate["entitlements"]: _error("DUPLICATE_DIVIDEND_ENTITLEMENT")
            receivables[identity] = {"id": identity, "listing_id": listing, "currency": action["currency"],
                                    "amount": canonical(quantity * decimal(action["net_per_unit"])), "ex_at": action["effective_at"], "tax_assumption_hash": action["tax_assumption_hash"]}
            candidate["entitlements"][identity] = {**receivables[identity], "paid": False}
        else:
            identity = action["entitlement_id"]
            receivable = receivables.get(identity)
            if receivable is None:
                if instant(action["ex_at"]) > instant(candidate["initialized_at"][market]): _error("DIVIDEND_ENTITLEMENT_UNKNOWN")
            else:
                if receivable["listing_id"] != listing or receivable["currency"] != action["currency"] or instant(receivable["ex_at"]) != instant(action["ex_at"]): _error("DIVIDEND_PAYMENT_BINDING_INVALID")
                currency = action["currency"]
                candidate["cash_by_currency"][currency] = canonical(decimal(candidate["cash_by_currency"][currency]) + decimal(receivable["amount"]))
                candidate["entitlements"][identity]["paid"] = True
                del receivables[identity]
        candidate["processed_actions"][action["id"]] = digest
    candidate["receivables"] = sorted(receivables.values(), key=lambda row: row["id"])
    if sparse and previous is not None and not fixed:
        # Re-evaluation, price/FX and funding changes are run evidence, not unit
        # transitions. Preserve the original state receipt and its expiry.
        metadata = {"sequence", "previous_hash", "created_at", "input_hash", "projection_hash"}
        if {key: value for key, value in candidate.items() if key not in metadata} == {key: value for key, value in previous.items() if key not in metadata}:
            candidate = deepcopy(previous)
        else:
            if previous["sequence"] >= 1000: _error("CHECKPOINT_LIMIT_REQUIRES_RESTART")
            candidate.update(sequence=previous["sequence"] + 1, previous_hash=content_hash(previous), created_at=now,
                             input_hash=snapshot_hash, projection_hash=content_hash(snapshot))
    validate_contract(candidate, checkpoint_schema)
    non_cash = sum((decimal(value) * fx[currency] for currency, value in candidate["cash_by_currency"].items() if currency != "CNY" and decimal(value) != ZERO), ZERO)
    non_cash += sum((decimal(row["amount"]) * (ONE if row["currency"] == "CNY" else fx[row["currency"]]) for row in candidate["receivables"]), ZERO)
    document = {"schema_version": "investor-model-monitor-v2", "profile_id": definition["profile_id"], "profile_version": definition["profile_version"],
                "profile_hash": definition["profile_hash"], "model_id": definition["model_id"], "model_state_hash": content_hash(candidate),
                "before_plan_hash": definition["target_definition_hash"], "after_plan_hash": definition["target_definition_hash"],
                "before_weights": weights, "after_weights": deepcopy(weights), "quantities": candidate["quantities"],
                "cash_cny": candidate["cash_by_currency"]["CNY"], "non_cash_assets_cny": canonical(non_cash),
                "quotes": snapshot["quotes"], "fx": snapshot["fx"], "funding_intent": deepcopy(planned_funding["funding_intent"] if planned_funding is not None else snapshot["funding_intent"]), "policy": snapshot["policy"], "quality_gaps": sorted(set(gaps))}
    if fixed:
        document.update(schema_version="investor-model-monitor-v3", fixed_policy={**deepcopy(definition["fixed_policy"]), "state": deepcopy(candidate["policy_state"])},
            policy={key: snapshot["policy"][key] for key in ("version", "max_fx_age_seconds", "costs")})
    assessment = assess_model(document, now)
    if fixed and assessment["outcome"] != "insufficient_evidence":
        candidate["policy_state"] = deepcopy(assessment["next_policy_state"])
        if sparse and previous is not None:
            metadata = {"sequence", "previous_hash", "created_at", "input_hash", "projection_hash"}
            if {key: value for key, value in candidate.items() if key not in metadata} == {key: value for key, value in previous.items() if key not in metadata}:
                candidate = deepcopy(previous)
            else:
                if previous["sequence"] >= 1000: _error("CHECKPOINT_LIMIT_REQUIRES_RESTART")
                candidate.update(sequence=previous["sequence"] + 1, previous_hash=content_hash(previous), created_at=now,
                    input_hash=snapshot_hash, projection_hash=content_hash(snapshot))
        validate_contract(candidate, checkpoint_schema)
        document["model_state_hash"] = content_hash(candidate)
        assessment = assess_model(document, now)
    # No checkpoint is published when any market/action input is unqualified.
    return {"checkpoint": candidate if assessment["outcome"] != "insufficient_evidence" else None,
            "monitor_request": {"action": "monitor", "document": document, "now": now}, "assessment": assessment}
