"""Read-only economic comparison; not source proof, consent or a new checkpoint."""

from copy import deepcopy
from decimal import ROUND_DOWN

from worker.accounting.decimal_math import ONE, ZERO, canonical as _canonical, decimal, financial
from worker.market.contracts import contract_validation_scope, validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant
from .model_contracts import definition_basis, validate_definition


SCHEMA = "investor-action-restatement-kernel.schema.json"
ECONOMICS = ("initialized_at", "market_cutoffs", "quantities", "cash_by_currency", "receivables", "entitlements", "processed_actions", "initial_notional_cny")
RANK = {"split": 0, "dividend_ex": 1, "dividend_payment": 2}


def _check(value, code):
    if not value: raise WorkbenchError("INVESTOR_RESTATEMENT_" + code)


def canonical(value):
    _check(value.is_finite(), "DERIVED_RANGE")
    if value == ZERO: return "0"
    _, digits, exponent = value.as_tuple()
    trailing = 0
    for digit in reversed(digits):
        if digit != 0: break
        trailing += 1
    _check(value.is_finite() and value.adjusted() < 200 and max(0, -exponent - trailing) <= 120, "DERIVED_RANGE")
    text = _canonical(value)
    _check(len(text) <= 200, "DERIVED_RANGE")
    return text


def _economics(checkpoint): return {key: deepcopy(checkpoint[key]) for key in ECONOMICS}


def _quotes(definition, projection):
    targets = {row["listing_id"]: row for row in definition["targets"]}
    quotes = {row["listing_id"]: row for row in projection["quotes"]}
    fx = {row["currency"]: decimal(row["value"]) for row in projection["fx"]}
    _check(len(targets) == len(definition["targets"]) and len(quotes) == len(projection["quotes"]) and set(targets) == set(quotes), "QUOTE_SCOPE")
    _check(len(fx) == len(projection["fx"]) and set(fx) == {row["currency"] for row in targets.values()} - {"CNY"}
        and all(value > ZERO for value in fx.values()), "FX_SCOPE")
    _check(all(decimal(row["weight"]) > ZERO for row in targets.values())
        and sum((decimal(row["weight"]) for row in targets.values()), ZERO) == ONE, "TARGET_WEIGHTS")
    cutoffs = {}
    for listing, target in targets.items():
        row, market = quotes[listing], target["market"]
        _check(row["market"] == market and row["currency"] == target["currency"] and decimal(row["close"]) > ZERO, "QUOTE_IDENTITY")
        _check(market not in cutoffs or cutoffs[market] == row["observed_at"], "MARKET_CUTOFF")
        cutoffs[market] = row["observed_at"]
    return targets, quotes, {"CNY": ONE, **fx}, cutoffs


def _ledger(actions, targets, cutoffs, at):
    _check(len({row["id"] for row in actions}) == len(actions), "DUPLICATE_ACTION")
    for action in actions:
        target = targets.get(action["listing_id"])
        _check(target is not None, "ACTION_SCOPE")
        _check(instant(action["known_at"]) <= at and instant(action["effective_at"]) <= instant(cutoffs[target["market"]]), "ACTION_CLOCK")
        if action["kind"] == "split": _check(decimal(action["ratio"]) > ZERO, "SPLIT_RATIO")
        else:
            _check(action["currency"] == target["currency"], "ACTION_CURRENCY")
            if action["kind"] == "dividend_ex": _check(decimal(action["net_per_unit"]) >= ZERO, "DIVIDEND_AMOUNT")
            else: _check(instant(action["ex_at"]) <= instant(action["effective_at"]), "PAYMENT_CHRONOLOGY")
    return sorted(actions, key=lambda row: (instant(row["effective_at"]), RANK[row["kind"]], row["id"]))


def _replay(origin, actions, targets, cutoffs):
    result = _economics(origin)
    result.update(market_cutoffs=deepcopy(cutoffs), receivables=[], entitlements={}, processed_actions={})
    pending = {}
    for action in actions:
        listing, kind, identity = action["listing_id"], action["kind"], action["id"]
        inception = instant(origin["initialized_at"][targets[listing]["market"]])
        if instant(action["effective_at"]) <= inception:
            result["processed_actions"][identity] = content_hash(action)
            continue
        quantity = decimal(result["quantities"][listing])
        if kind == "split": result["quantities"][listing] = canonical(quantity * decimal(action["ratio"]))
        elif kind == "dividend_ex":
            entitlement_id = action["entitlement_id"]
            _check(entitlement_id not in result["entitlements"], "DUPLICATE_ENTITLEMENT")
            pending[entitlement_id] = {"id": entitlement_id, "listing_id": listing, "currency": action["currency"],
                "amount": canonical(quantity * decimal(action["net_per_unit"])), "ex_at": action["effective_at"], "tax_assumption_hash": action["tax_assumption_hash"]}
            _check(len(pending) <= 500, "RECEIVABLE_LIMIT")
            result["entitlements"][entitlement_id] = {**pending[entitlement_id], "paid": False}
        else:
            entitlement_id = action["entitlement_id"]
            receivable = pending.get(entitlement_id)
            if receivable is None:
                _check(instant(action["ex_at"]) <= inception and entitlement_id not in result["entitlements"], "PAYMENT_ENTITLEMENT_UNKNOWN")
            else:
                _check(receivable["listing_id"] == listing and receivable["currency"] == action["currency"]
                    and instant(receivable["ex_at"]) == instant(action["ex_at"]), "PAYMENT_BINDING")
                currency = action["currency"]
                result["cash_by_currency"][currency] = canonical(decimal(result["cash_by_currency"][currency]) + decimal(receivable["amount"]))
                result["entitlements"][entitlement_id]["paid"] = True
                del pending[entitlement_id]
        result["processed_actions"][identity] = content_hash(action)
    result["receivables"] = sorted(pending.values(), key=lambda row: row["id"])
    validate_contract(result, SCHEMA, fragment="$defs/economics")
    return result


def _receivables(state):
    result = {currency: ZERO for currency in state["cash_by_currency"]}
    for row in state["receivables"]: result[row["currency"]] += decimal(row["amount"])
    return result


def _value(state, targets, quotes, fx):
    result = sum((decimal(state["quantities"][key]) * decimal(quotes[key]["close"]) * fx[target["currency"]] for key, target in targets.items()), ZERO)
    result += sum((decimal(value) * fx[currency] for currency, value in state["cash_by_currency"].items() if decimal(value) != ZERO), ZERO)
    result += sum((decimal(row["amount"]) * fx[row["currency"]] for row in state["receivables"]), ZERO)
    return result


@financial
def compare_action_restatement(value):
    """Reconstruct both ledgers at one old valuation point without backdating knowledge."""
    with contract_validation_scope():
        validate_contract(value, SCHEMA)
        definition, origin, head = (value[key] for key in ("definition", "origin", "head"))
        validate_definition(definition)
        at = instant(value["checked_at"])
        _check(definition["data_mode"] == "reconstructed" and definition["target_definition_hash"] == content_hash(definition_basis(definition)), "DEFINITION_BINDING")
        _check(origin["sequence"] == 1 and origin["previous_hash"] is None and instant(definition["created_at"]) <= instant(origin["created_at"])
            <= instant(head["created_at"]) < instant(definition["valid_until"]) and instant(head["created_at"]) <= at, "ORIGIN_OR_CLOCK")
        _check(head["sequence"] >= 1 and (content_hash(head) == content_hash(origin) if head["sequence"] == 1 else head["previous_hash"] is not None), "HEAD_SEQUENCE")
        if head["sequence"] == 2: _check(head["previous_hash"] == content_hash(origin), "HEAD_SEQUENCE")
        for checkpoint in (origin, head):
            _check(all(checkpoint[key] == definition[key] for key in ("model_id", "profile_id", "target_definition_hash")), "CHECKPOINT_SCOPE")
            _check(checkpoint["initialized_at"] == origin["initialized_at"] and set(checkpoint["quantities"]) == {row["listing_id"] for row in definition["targets"]}, "INCEPTION_SCOPE")
            _check(("policy_state" in checkpoint) == (definition["schema_version"] == "investor-model-definition-v2"), "POLICY_SCOPE")
            if "funding_binding" in checkpoint:
                binding = checkpoint["funding_binding"]
                _check(binding["model_id"] == definition["model_id"] and binding["model_hash"] == content_hash(definition)
                    and binding["profile_hash"] == definition["profile_hash"] and binding["model_created_at"] == definition["created_at"]
                    and instant(binding["plan_declared_at"]) <= instant(checkpoint["created_at"]), "FUNDING_SCOPE")
        _check(origin["market_cutoffs"] == origin["initialized_at"] and not origin["receivables"] and not origin["entitlements"], "ORIGIN_ASSETS")
        bindings = []
        for key, checkpoint in (("origin_projection", origin), ("head_projection", head)):
            projection = value[key]
            _check(projection["model_id"] == definition["model_id"] and content_hash(projection) == checkpoint["projection_hash"]
                and instant(projection["created_at"]) <= instant(checkpoint["created_at"]) < instant(projection["valid_until"])
                and not projection["quality_gaps"], "PROJECTION_BINDING")
            _check(all(instant(row["observed_at"]) <= instant(row["known_at"]) <= instant(checkpoint["created_at"]) < instant(row["valid_until"])
                for row in [*projection["quotes"], *projection["fx"]]) and all(instant(row["observed_at"]) == instant(row["expected_close_at"])
                for row in projection["quotes"]), "ORIGINAL_PRICE_CLOCK")
            binding = _quotes(definition, projection); bindings.append(binding)
            _check(binding[3] == checkpoint["market_cutoffs"], "CHECKPOINT_CUTOFF")
            _check(set(projection["corporate_action_coverage"]) == set(binding[3]) and all(
                row["complete"] and instant(row["from"]) <= instant(row["to"]) == instant(binding[3][market])
                for market, row in projection["corporate_action_coverage"].items()), "ORIGINAL_COVERAGE")
        targets, quotes, fx, cutoffs = bindings[1]
        _check(set(origin["initialized_at"]) == set(cutoffs)
            and all(instant(origin["initialized_at"][market]) <= instant(cutoff) <= instant(head["created_at"]) for market, cutoff in cutoffs.items()), "INCEPTION_CUTOFF")
        _, initial_quotes, initial_fx, _ = bindings[0]
        initial_prices = {key: decimal(initial_quotes[key]["close"]) * initial_fx[target["currency"]] for key, target in targets.items()}
        quantities = {key: canonical((decimal("10000") * decimal(target["weight"]) / initial_prices[key]).quantize(decimal("0.000000000000000001"), rounding=ROUND_DOWN)) for key, target in targets.items()}
        residual = decimal("10000") - sum((decimal(quantities[key]) * initial_prices[key] for key in targets), ZERO)
        _check(all(decimal(quantity) > ZERO for quantity in quantities.values()) and residual >= ZERO and origin["quantities"] == quantities
            and origin["cash_by_currency"] == {"CNY": canonical(residual), "HKD": "0", "USD": "0"}, "ORIGIN_VALUE")
        original_actions = _ledger(value["original_actions"], targets, cutoffs, instant(head["created_at"]))
        origin_actions = _ledger(value["origin_projection"]["corporate_actions"], targets, origin["market_cutoffs"], instant(origin["created_at"]))
        old_hashes = {row["id"]: content_hash(row) for row in original_actions}
        _check({row["id"]: content_hash(row) for row in origin_actions} == origin["processed_actions"]
            and all(old_hashes.get(key) == digest for key, digest in origin["processed_actions"].items()), "ORIGIN_LEDGER")
        original = _replay(origin, original_actions, targets, cutoffs)
        _check(original == _economics(head), "ORIGINAL_REPLAY_MISMATCH")
        coverage = value["corrected_coverage"]
        _check(set(coverage) == set(cutoffs) and all(row["complete"] and instant(row["from"]) <= instant(origin["initialized_at"][market])
            and instant(row["to"]) == instant(cutoffs[market]) for market, row in coverage.items()), "CORRECTED_COVERAGE_GAP")
        corrected_actions = _ledger(value["corrected_actions"], targets, cutoffs, at)
        restated = _replay(origin, corrected_actions, targets, cutoffs)
        old_value, new_value = _value(original, targets, quotes, fx), _value(restated, targets, quotes, fx)
        old_pending, new_pending = _receivables(original), _receivables(restated)
        old_hashes, new_hashes = original["processed_actions"], restated["processed_actions"]
        result = {"schema_version": "investor-action-restatement-kernel-result-v1", "model_id": definition["model_id"], "checked_at": value["checked_at"],
            "basis": {key + "_hash": content_hash(value[key]) for key in ("definition", "origin", "head", "origin_projection", "head_projection", "original_actions", "corrected_actions", "corrected_coverage")},
            "original": original, "restated": restated,
            "delta": {"quantities": {key: canonical(decimal(restated["quantities"][key]) - decimal(original["quantities"][key])) for key in sorted(targets)},
                "cash_by_currency": {key: canonical(decimal(restated["cash_by_currency"][key]) - decimal(original["cash_by_currency"][key])) for key in sorted(original["cash_by_currency"])},
                "receivables_by_currency": {key: canonical(new_pending[key] - old_pending[key]) for key in sorted(old_pending)}},
            "original_valuation_cny": canonical(old_value), "restated_valuation_cny": canonical(new_value), "difference_cny": canonical(new_value - old_value),
            "changed_action_count": sum(old_hashes.get(key) != new_hashes.get(key) for key in old_hashes.keys() | new_hashes.keys()),
            "economics_changed": any(original[key] != restated[key] for key in ECONOMICS if key != "processed_actions"),
            "valuation_basis": "same_original_checkpoint_quotes_and_fx_not_current_nav", "knowledge_basis": "corrected_economic_history_as_of_checked_at_not_point_in_time_strategy",
            "visibility": "private_owner_only_not_ai", **{key: False for key in ("source_evidence_verified", "checkpoint_created", "state_published", "historical_observations_rewritten", "historical_strategy_results_recomputed", "monitoring_resumed", "current_advice_certified", "trading_permission")},
            "provider_calls": 0, "database_writes": 0}
        validate_contract(result, SCHEMA, fragment="$defs/result")
        return result


def verify_action_restatement_arithmetic(value, result):
    validate_contract(result, SCHEMA, fragment="$defs/result")
    calculated = compare_action_restatement(value)
    _check(content_hash(calculated) == content_hash(result), "RESULT_REPLAY_MISMATCH")
    return calculated
