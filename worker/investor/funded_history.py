"""Map planned capital into an explicit past window without backdating research."""

import argparse
from copy import deepcopy
from datetime import date, datetime, time, timedelta
import re
import sys
from zoneinfo import ZoneInfo

from worker.accounting import decimal
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp
from .__main__ import MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, parse_request
from .funding_plan import funding_timeline
from .long_horizon import compare_funding_paths, validate_input


INPUT_CONTRACT = "investor-funded-history-input.schema.json"
OUTPUT_CONTRACT = "investor-funded-history-result.schema.json"
BOUNDED_INPUT_CONTRACT = "investor-funded-history-input-v2.schema.json"
BOUNDED_OUTPUT_CONTRACT = "investor-funded-history-result-v2.schema.json"
REQUEST_CONTRACT = "investor-funded-history-request.schema.json"


def _midnight(text, zone):
    local = datetime.combine(date.fromisoformat(text), time.min)
    candidates = set()
    for fold in (0, 1):
        utc = instant(local.replace(tzinfo=zone, fold=fold))
        if utc.astimezone(zone).replace(tzinfo=None) == local:
            candidates.add(utc)
    if len(candidates) != 1:
        raise WorkbenchError("INVESTOR_FUNDED_HISTORY_LOCAL_TIME_INVALID")
    return candidates.pop()


def funding_history_projection(document):
    bounded = isinstance(document, dict) and document.get("schema_version") == "investor-funded-history-input-v2"
    validate_contract(document, BOUNDED_INPUT_CONTRACT if bounded else INPUT_CONTRACT)
    funding = document["funding_plan"]
    original = funding_timeline(funding)
    anchor = document["historical_start_date"]
    if anchor[4:] != funding["start_date"][4:]:
        raise WorkbenchError("INVESTOR_FUNDED_HISTORY_MONTH_DAY_MISMATCH")
    shift = int(anchor[:4]) - int(funding["start_date"][:4])

    def translated(text):
        try:
            return date.fromisoformat(text).replace(year=int(text[:4]) + shift).isoformat()
        except ValueError as exc:
            raise WorkbenchError("INVESTOR_FUNDED_HISTORY_CALENDAR_INVALID") from exc

    mapped = {**funding, "start_date": anchor, "entry_method": "three_tranches_60_days",
              "first_annual_date": translated(funding["first_annual_date"]) if funding["first_annual_date"] else None}
    try:
        timeline = funding_timeline(mapped)
    except WorkbenchError as exc:
        raise WorkbenchError("INVESTOR_FUNDED_HISTORY_SCHEDULE_INVALID") from exc
    if len(timeline["lots"]) != len(original["lots"]) or timeline["total_planned_principal_cny"] != original["total_planned_principal_cny"]:
        raise WorkbenchError("INVESTOR_FUNDED_HISTORY_PRINCIPAL_CHANGED")
    zone = ZoneInfo(funding["evaluation_timezone"])
    end = _midnight(timeline["horizon_end_exclusive"], zone)
    lots = []
    for planned, historical in zip(original["lots"], timeline["lots"]):
        if translated(planned["arrival_date"]) != historical["arrival_date"] or planned["amount_cny"] != historical["amount_cny"]:
            raise WorkbenchError("INVESTOR_FUNDED_HISTORY_PRINCIPAL_CHANGED")
        lots.append({"lot_id": planned["lot_id"], "planned_arrival_date": planned["arrival_date"],
                     "historical_arrival_date": historical["arrival_date"],
                     "arrival_at": stamp(_midnight(historical["arrival_date"], zone)), "amount_cny": historical["amount_cny"],
                     "staged_releases": [{"at": stamp(_midnight(row["release_date"], zone)), "amount_cny": row["amount_cny"],
                                          "within_window": row["within_horizon"]} for row in historical["tranches"]]})
    projection = {"schema_version": "investor-funding-history-projection-v1", "funding_plan_hash": content_hash(funding),
                  "historical_start_date": anchor, "translation_years": shift,
                  "window": {"start": stamp(_midnight(anchor, zone)), "end": stamp(end - timedelta(milliseconds=1))},
                  "evaluation_timezone": funding["evaluation_timezone"],
                  "preferred_path": "immediate" if funding["entry_method"] == "immediate" else "staged",
                  "total_assumed_principal_cny": timeline["total_planned_principal_cny"], "lots": lots}
    validate_contract(projection, INPUT_CONTRACT, fragment="$defs/projection")
    return projection


def prepare_funded_history(document, *, allow_synthetic=False):
    projection = funding_history_projection(document)
    bounded = document["schema_version"] == "investor-funded-history-input-v2"
    if decimal(document["context"]["execution"]["cash_quantum"]) != decimal("0.01"):
        raise WorkbenchError("INVESTOR_FUNDED_HISTORY_CASH_QUANTUM_INVALID")
    lots = projection["lots"]
    plan = {"schema_version": "investor-long-horizon-plan-v3" if bounded else "investor-long-horizon-plan-v2", "study_basis": "retrospective_exploratory",
            "window": projection["window"], "evaluation_timezone": projection["evaluation_timezone"],
            **deepcopy(document["context"]), "initial_capital_cny": lots[0]["amount_cny"],
            "contributions": [{"at": lot["arrival_at"], "amount_cny": lot["amount_cny"]} for lot in lots[1:]],
            "funding_policy": {"method": "equal_tranches_on_frozen_local_day_offsets", "initial_offsets_days": [0, 30, 60],
                               "contribution_offsets_days": [0, 30, 60]}}
    kernel_input = {"schema_version": "investor-long-horizon-input-v3" if bounded else "investor-long-horizon-input-v2", "dataset": deepcopy(document["dataset"]), "plan": plan}
    validate_input(kernel_input, allow_synthetic=allow_synthetic)
    return projection, kernel_input


def calculate_funded_history(document, *, allow_synthetic=False, progress=None):
    projection, kernel_input = prepare_funded_history(document, allow_synthetic=allow_synthetic)
    comparison = compare_funding_paths(kernel_input, allow_synthetic=allow_synthetic, progress=progress)
    bounded = document["schema_version"] == "investor-funded-history-input-v2"
    result = {"schema_version": "investor-funded-history-result-v2" if bounded else "investor-funded-history-result-v1", "input_hash": content_hash(document),
              "projection": projection, "comparison": comparison, "qualification": "planned_capital_retrospective_exploration_only",
              "economics_independently_replayed": False, "source_independently_verified": False,
              "parameters_independently_preregistered": False, "actual_arrivals_confirmed": False,
              "execution_authorized": False, "live_advice_eligible": False}
    result["result_hash"] = content_hash(result)
    validate_contract(result, BOUNDED_OUTPUT_CONTRACT if bounded else OUTPUT_CONTRACT)
    if len(canonical_json(result).encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise WorkbenchError("INVESTOR_KERNEL_OUTPUT_TOO_LARGE")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Planned capital in an explicit historical window; no DB, forecast or advice publication")
    parser.add_argument("--allow-synthetic", action="store_true")
    args = parser.parse_args(argv)
    try:
        document = parse_request(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1), REQUEST_CONTRACT)
        print(canonical_json(calculate_funded_history(document, allow_synthetic=args.allow_synthetic)))
        return 0
    except (ValueError, TypeError, KeyError, ArithmeticError, RecursionError, OSError) as exc:
        code = str(exc).split(":", 1)[0]
        if not re.fullmatch(r"(?:INVESTOR_[A-Z_]+|CONTRACT_INVALID)", code):
            code = "INVESTOR_FUNDED_HISTORY_FAILED"
        print(canonical_json({"error": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
