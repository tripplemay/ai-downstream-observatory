"""Versioned rule bindings; schema versions never upgrade existing records."""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.accounting.decimal_math import decimal
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError


def definition_schema(value):
    return "investor-model-definition-v2.schema.json" if value.get("schema_version") == "investor-model-definition-v2" else "investor-model-definition.schema.json"


def reference_schema(value):
    return "investor-reference-plan-v2.schema.json" if value.get("schema_version") == "investor-reference-plan-v2" else "investor-reference-plan.schema.json"


def definition_basis(value):
    result = {key: value[key] for key in ("profile_hash", "plan_hash", "targets")}
    if value["schema_version"] == "investor-model-definition-v2": result["fixed_policy"] = value["fixed_policy"]
    return result


def validate_definition(value):
    validate_contract(value, definition_schema(value))
    if value["schema_version"] != "investor-model-definition-v2": return
    rule = value["fixed_policy"]
    weights = rule["parameters"]["weights"]
    targets = {row["listing_id"]: row["weight"] for row in value["targets"]}
    try:
        ZoneInfo(rule["evaluation_timezone"])
        if (len(targets) != len(value["targets"]) or set(weights) != set(targets)
                or set(weights) != set(rule["parameters"]["roles"])
                or any(decimal(weight) != decimal(targets[key]) for key, weight in weights.items())):
            raise ValueError()
    except (ZoneInfoNotFoundError, ValueError):
        raise WorkbenchError("INVESTOR_MODEL_FIXED_POLICY_BINDING_INVALID") from None
