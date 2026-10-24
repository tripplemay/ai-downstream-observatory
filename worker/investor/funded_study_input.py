"""A bounded calendar-only comparison of all frozen low-frequency candidates."""

from datetime import date, timedelta

from worker.orchestration.db import WorkbenchError, content_hash, instant
from .funded_history import funding_history_projection, prepare_funded_history


def prepare_funded_study_inputs(funding, source, declared, profile):
    def gap(reason):
        return {"historical_start_date": None, "candidate_hashes": [], "reason_codes": [reason], "inputs": []}

    dataset, plan, policy = (source["payload"][key] for key in ("dataset", "plan", "policy"))
    if profile["liquidity_need"] != "none_in_horizon":
        return gap("FUNDED_STUDY_LIQUIDITY_REVIEW_REQUIRED")
    if profile["exclusions"]:
        return gap("FUNDED_STUDY_EXCLUSIONS_REQUIRE_QUALIFIED_UNIVERSE")
    if any(row["market"] not in profile["markets"] for row in dataset["assets"]):
        return gap("FUNDED_STUDY_UNIVERSE_OUTSIDE_ALLOWED_MARKETS")
    if profile["horizon_years"] < policy["minimum_horizon_years"]:
        return gap("FUNDED_STUDY_HORIZON_OUTSIDE_STRATEGY_SCOPE")
    if profile["research_direction"] == "rotation":
        return gap("FUNDED_STUDY_ENHANCEMENT_EVIDENCE_REQUIRED")
    if plan.get("schema_version") == "research-plan-v4":
        return gap("FUNDED_STUDY_ACTION_AWARE_EXECUTION_NOT_SUPPORTED")
    if plan["evaluation_timezone"] != funding["evaluation_timezone"]:
        return gap("FUNDED_STUDY_TIMEZONE_CONFLICT")
    candidates = policy["candidates"]
    if not 1 <= len(candidates) <= 8 or any(row.get("schema_version") != "research-fixed-rebalance-parameters-v2" for row in candidates):
        return gap("FUNDED_STUDY_FIXED_POLICY_V2_REQUIRED")
    ordered = sorted(((content_hash(row), row) for row in candidates), key=lambda item: item[0])
    if len({digest for digest, _ in ordered}) != len(ordered):
        return gap("FUNDED_STUDY_DUPLICATE_CANDIDATES")

    def make(anchor, parameters, decisions):
        return {"schema_version": "investor-funded-history-input-v3" if plan["schema_version"] == "research-plan-v5" else "investor-funded-history-input-v2" if plan["schema_version"] == "research-plan-v3" else "investor-funded-history-input-v1", "funding_plan": funding,
            "historical_start_date": anchor, "dataset": dataset, "context": {
                "parameters_recorded_at": source["created_at"], "comparison_declared_at": declared, "information_cutoff_at": declared,
                "parameters": parameters, "decision_times": decisions, "execution": plan["execution"], "tax_coverage": plan["tax_coverage"]}}

    anchor, window = None, None
    for year in range(max(1970, int(source["range_start"][:4])), min(2199, int(source["range_end"][:4])) + 1):
        value = str(year) + funding["start_date"][4:]
        if value < source["range_start"]:
            continue
        try:
            last = date.fromisoformat(str(year + funding["horizon_years"]) + funding["start_date"][4:]) - timedelta(days=1)
            if last.isoformat() > source["range_end"]:
                break
            projection = funding_history_projection(make(value, ordered[0][1], plan["decision_times"]))
        except (ValueError, WorkbenchError):
            continue
        anchor, window = value, projection["window"]
        break
    if not anchor:
        return gap("FUNDED_STUDY_FULL_HORIZON_NOT_COVERED")
    decisions = [at for at in plan["decision_times"] if instant(window["start"]) <= instant(at) < instant(window["end"])]
    inputs = [make(anchor, parameters, decisions) for _, parameters in ordered]
    try:
        for document in inputs:
            prepare_funded_history(document)
    except (ValueError, WorkbenchError):
        return gap("FUNDED_STUDY_INPUT_UNSUPPORTED")
    return {"historical_start_date": anchor, "candidate_hashes": [digest for digest, _ in ordered], "reason_codes": [], "inputs": inputs}
