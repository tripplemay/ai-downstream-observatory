"""Closed derived-data vocabulary; provider rights and consent are checked locally."""

from decimal import Decimal

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError


def validate_monitor_context(context):
    try:
        validate_contract(context, "ai-monitor-context.schema.json")
        rows = context["evidence"]
        names = ["max_abs_target_gap", "target_change_count", "estimated_cost_ratio"][:len(rows)]
        for row, name in zip(rows, names):
            if (row["evidence_id"] != "derived:" + name or row["metric"] != "model." + name
                    or row["as_of"] != context["evaluated_at"]):
                raise ValueError()
            number = Decimal(row["value"])
            if name == "target_change_count":
                if not row["value"].isdigit() or not 0 <= number <= 20: raise ValueError()
            elif not 0 <= number <= 1:
                raise ValueError()
            if row["value"] != format(number.normalize(), "f"): raise ValueError()
        if context["trigger_codes"] != sorted(context["trigger_codes"]): raise ValueError()
        return context
    except Exception:
        raise WorkbenchError("AI_GATEWAY_REQUEST_INVALID") from None
