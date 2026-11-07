"""Unpublished same-model economic bridge; registration and sources are not proved here."""

from copy import deepcopy

from worker.accounting.decimal_math import financial
from worker.market.contracts import contract_validation_scope, validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant
from .action_restatement_kernel import compare_action_restatement
from .model_state import advance_evidence_model
from .monitor import assess_model


SCHEMA = "investor-model-epoch-transition.schema.json"


def _check(value, code):
    if not value: raise WorkbenchError("INVESTOR_MODEL_EPOCH_" + code)


def _proof(value):
    return {key: item for key, item in value.items() if key not in ("checked_at", "source_valid_until")}


def _actions(value): return {row["id"]: content_hash(row) for row in value}


def _projection(value, epoch_id):
    if value["schema_version"] != "investor-monitor-data-projection-v4": return value
    _check(value["epoch"]["id"] == epoch_id, "PROJECTION_EPOCH_BINDING")
    return value["economic_projection"]


@financial
def advance_corrected_model_epoch(value):
    """Recompute approved arithmetic, combine disjoint listings and take a new close.

    The publisher must independently authenticate every baseline/handover and the
    complete retained prefix/current source. Hashes supplied to this pure kernel
    are bindings, not proof of an actual registration or permission.
    """
    with contract_validation_scope():
        validate_contract(value, SCHEMA)
        history, corrections = value["history"], value["corrections"]
        projection = _projection(value["projection"], value["epoch_id"])
        definition, head, origin = (history[key] for key in ("definition", "head", "origin"))
        at = instant(value["now"]); targets = {row["listing_id"]: row for row in definition["targets"]}
        original = history["original_actions"]; old_hashes = _actions(original)
        listings, identifiers, handovers, bindings, selected = set(), set(), set(), [], []
        first = corrections[0]["baseline"]["original_history"]
        inputs = first["input_bindings"]
        _check(first["model_id"] == definition["model_id"] and first["model_hash"] == content_hash(definition)
            and first["head_checkpoint_sequence"] == head["sequence"] == len(inputs)
            and [entry["sequence"] for entry in inputs] == list(range(1, head["sequence"] + 1))
            and first["origin_checkpoint_id"] == inputs[0]["checkpoint_id"] and first["head_checkpoint_id"] == inputs[-1]["checkpoint_id"]
            and first["original_actions_hash"] == content_hash(sorted(original, key=lambda row: row["id"]))
            and inputs[0]["checkpoint_hash"] == content_hash(origin) and inputs[-1]["checkpoint_hash"] == content_hash(head)
            and inputs[0]["input_hash"] == origin["input_hash"] and inputs[-1]["input_hash"] == head["input_hash"]
            and inputs[0]["projection_hash"] == origin["projection_hash"] and inputs[-1]["projection_hash"] == head["projection_hash"], "HISTORY_BINDING")
        for correction in corrections:
            baseline = correction["baseline"]; listing = baseline["approved_facts"]["listing_id"]; known = baseline["knowledge_at"]
            _check(listing in targets and listing not in listings and baseline["epoch_id"] not in identifiers
                and correction["handover_id"] not in handovers, "CORRECTION_SCOPE")
            listings.add(listing); identifiers.add(baseline["epoch_id"]); handovers.add(correction["handover_id"])
            _check(instant(head["created_at"]) <= instant(known) <= instant(correction["handover_at"]) < at
                and baseline["original_history"]["checked_at"] == known
                and instant(value["now"]) < instant(baseline["original_history"]["source_valid_until"]), "CORRECTION_CLOCK")
            _check(_proof(baseline["original_history"]) == _proof(first) and baseline["model_hash"] == content_hash(definition)
                and baseline["original_checkpoint_hash"] == content_hash(head) and baseline["original_projection_hash"] == content_hash(history["head_projection"])
                and baseline["policy_state"] == head.get("policy_state"), "BASELINE_BINDING")
            ledger = correction["corrected_actions"]
            _check(content_hash(ledger) == baseline["corrected_actions_hash"]
                and _actions([row for row in ledger if row["listing_id"] != listing]) == _actions([row for row in original if row["listing_id"] != listing]), "CORRECTION_SCOPE")
            _check(all(row["known_at"] == known for row in ledger if old_hashes.get(row["id"]) != content_hash(row)), "CORRECTION_KNOWLEDGE")
            compared = compare_action_restatement({"schema_version": "investor-action-restatement-kernel-input-v1", **history,
                "corrected_actions": ledger, "checked_at": known})
            _check(compared["changed_action_count"] > 0, "CORRECTION_EMPTY")
            _check(content_hash(compared) == baseline["comparison_hash"] and compared["restated"] == baseline["economics"]
                and {key: compared[key] for key in baseline["valuation_summary"]} == baseline["valuation_summary"], "BASELINE_ARITHMETIC")
            selected.extend(row for row in ledger if row["listing_id"] == listing)
            bindings.append({"correction_id": baseline["epoch_id"], "baseline_hash": content_hash(baseline),
                **{key: correction[key] for key in ("confirmation_hash", "handover_id", "handover_hash", "handover_at")},
                "knowledge_at": known, "listing_id": listing, "corrected_actions_hash": baseline["corrected_actions_hash"]})
        combined = sorted([row for row in original if row["listing_id"] not in listings] + selected, key=lambda row: row["id"])
        known = max((entry["knowledge_at"] for entry in bindings), key=instant)
        restated = compare_action_restatement({"schema_version": "investor-action-restatement-kernel-input-v1", **history,
            "corrected_actions": combined, "checked_at": known})
        # This bridge is never stored or used as the persisted parent hash.
        bridge = {**deepcopy(head), **deepcopy(restated["restated"])}
        boundary = max([instant(head["created_at"]), *(instant(entry["handover_at"]) for entry in bindings)])
        _check(len(projection["quotes"]) == len(targets) and {row["listing_id"] for row in projection["quotes"]} == set(targets)
            and all(row["market"] == targets[row["listing_id"]]["market"] for row in projection["quotes"]), "QUOTE_SCOPE")
        _check(all(instant(row["observed_at"]) > max(boundary, instant(head["market_cutoffs"][row["market"]])) for row in projection["quotes"]), "NEXT_CLOSE_REQUIRED")
        historical = [row for row in projection["corporate_actions"] if row["listing_id"] in targets
            and instant(row["effective_at"]) <= instant(head["market_cutoffs"][targets[row["listing_id"]]["market"]])]
        _check(len(_actions(historical)) == len(historical) and _actions(historical) == _actions(combined), "CURRENT_LEDGER_BINDING")
        binding = {"schema_version": "investor-model-epoch-binding-v1", "epoch_id": value["epoch_id"], "model_hash": content_hash(definition),
            "origin_hash": content_hash(origin), "original_head_hash": content_hash(head), "original_chain_hash": first["checkpoint_chain_hash"],
            "bridge_hash": content_hash(bridge), "combined_actions_hash": content_hash(combined), "corrections": sorted(bindings, key=lambda row: row["correction_id"])}
        _check(head["sequence"] < 1000, "CHECKPOINT_LIMIT_REQUIRES_CONTINUATION")
        advanced = advance_evidence_model(definition, projection, bridge, value["now"], input_hash=value["input_hash"], planned_funding=value["planned_funding"])
        candidate, request, assessment = advanced["checkpoint"], None, advanced["assessment"]
        if candidate is not None:
            candidate.update(schema_version="investor-evidence-model-checkpoint-v4", previous_hash=content_hash(head), epoch_binding=binding, projection_hash=content_hash(value["projection"]))
            validate_contract(candidate, "investor-evidence-model-checkpoint-v4.schema.json")
            request = advanced["monitor_request"]; request["document"]["model_state_hash"] = content_hash(candidate)
            assessment = assess_model(request["document"], value["now"])
            _check(assessment["outcome"] == advanced["assessment"]["outcome"], "ASSESSMENT_CHANGED")
        return _result(binding, candidate, request, assessment)


def _result(binding, candidate, request, assessment):
    result = {"schema_version": "investor-model-epoch-transition-result-v1", "epoch_binding": binding,
        "checkpoint": candidate, "monitor_request": request, "assessment": assessment,
        **{key: False for key in ("registered_bindings_verified", "source_evidence_verified", "checkpoint_created", "state_published", "monitoring_resumed",
            "historical_observations_rewritten", "historical_strategy_results_recomputed", "trading_permission")},
        "provider_calls": 0, "database_writes": 0, "visibility": "private_owner_only_not_ai"}
    validate_contract(result, SCHEMA, fragment="$defs/result")
    return result


@financial
def continue_corrected_model_epoch(value):
    """Continue an independently requalified v4 chain; never authenticate it here."""
    with contract_validation_scope():
        validate_contract(value, SCHEMA, fragment="$defs/continuation_input")
        definition, previous = value["definition"], value["previous"]
        projection = _projection(value["projection"], previous["epoch_binding"]["epoch_id"])
        binding = previous["epoch_binding"]; targets = {row["listing_id"]: row for row in definition["targets"]}
        _check(binding["model_hash"] == content_hash(definition), "CONTINUATION_BINDING")
        historical = [row for row in projection["corporate_actions"] if row["listing_id"] in targets
            and instant(row["effective_at"]) <= instant(previous["market_cutoffs"][targets[row["listing_id"]]["market"]])]
        _check(len(_actions(historical)) == len(historical) and _actions(historical) == previous["processed_actions"], "CURRENT_LEDGER_BINDING")
        # Private arithmetic adapter only. Actual publishers must replay the
        # original epoch and every predecessor before supplying this v4 state.
        adapter = deepcopy(previous); del adapter["epoch_binding"]
        adapter["schema_version"] = ("investor-evidence-model-checkpoint-v3" if "funding_binding" in previous else
            "investor-evidence-model-checkpoint-v2" if definition["schema_version"] == "investor-model-definition-v2" else "investor-evidence-model-checkpoint-v1")
        try:
            advanced = advance_evidence_model(definition, projection, adapter, value["now"], input_hash=value["input_hash"], sparse=True, planned_funding=value["planned_funding"])
        except WorkbenchError as error:
            if str(error) == "INVESTOR_MODEL_CHECKPOINT_LIMIT_REQUIRES_RESTART": _check(False, "CHECKPOINT_LIMIT_REQUIRES_CONTINUATION")
            raise
        candidate, request, assessment = advanced["checkpoint"], None, advanced["assessment"]
        if candidate is not None:
            if candidate == adapter: candidate = deepcopy(previous)
            else: candidate.update(schema_version="investor-evidence-model-checkpoint-v4", previous_hash=content_hash(previous), epoch_binding=deepcopy(binding), projection_hash=content_hash(value["projection"]))
            validate_contract(candidate, "investor-evidence-model-checkpoint-v4.schema.json")
            request = advanced["monitor_request"]; request["document"]["model_state_hash"] = content_hash(candidate)
            assessment = assess_model(request["document"], value["now"])
            _check(assessment["outcome"] == advanced["assessment"]["outcome"], "ASSESSMENT_CHANGED")
        return _result(deepcopy(binding), candidate, request, assessment)


def verify_corrected_model_epoch_arithmetic(value, result):
    validate_contract(result, SCHEMA, fragment="$defs/result")
    calculated = advance_corrected_model_epoch(value)
    _check(content_hash(calculated) == content_hash(result), "RESULT_REPLAY_MISMATCH")
    return calculated


def verify_model_epoch_continuation_arithmetic(value, result):
    validate_contract(result, SCHEMA, fragment="$defs/result")
    calculated = continue_corrected_model_epoch(value)
    _check(content_hash(calculated) == content_hash(result), "RESULT_REPLAY_MISMATCH")
    return calculated
