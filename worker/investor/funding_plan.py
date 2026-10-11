"""Private planned local dates, never confirmed arrivals or profit forecasts."""

from datetime import date, timedelta
from decimal import ROUND_FLOOR
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.accounting import decimal
from worker.accounting.decimal_math import financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError


@financial
def funding_timeline(plan):
    validate_contract(plan, "investor-funding-plan.schema.json")
    try:
        ZoneInfo(plan["evaluation_timezone"])
        start = date.fromisoformat(plan["start_date"])
        end = start.replace(year=start.year + plan["horizon_years"])
        initial, annual = decimal(plan["initial_capital_cny"]), decimal(plan["annual_contribution_cny"])
        minimum = decimal("0.01" if plan["entry_method"] == "immediate" else "0.03")
        first = date.fromisoformat(plan["first_annual_date"]) if plan["first_annual_date"] is not None else None
        if initial < minimum or annual != 0 and annual < minimum or (annual == 0) != (first is None) or first is not None and not start <= first < end:
            raise ValueError()
        arrivals = [("initial", start, initial)]
        if first is not None:
            for year in range(11):
                at_text = "%04d%s" % (first.year + year, first.isoformat()[4:])
                if at_text >= end.isoformat():
                    break
                at = date.fromisoformat(at_text)
                arrivals.append(("annual:" + at_text, at, annual))
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise WorkbenchError("INVESTOR_FUNDING_INPUT_INVALID") from exc
    offsets = [0] if plan["entry_method"] == "immediate" else [0, 30, 60]
    lots = []
    for lot_id, arrival, amount in arrivals:
        tranche = (amount / len(offsets)).quantize(decimal("0.01"), rounding=ROUND_FLOOR)
        lots.append({"lot_id": lot_id, "arrival_date": arrival.isoformat(), "amount_cny": format(amount, ".2f"),
            "tranches": [{"release_date": (arrival + timedelta(days=offset)).isoformat(),
                "amount_cny": format(amount - tranche * index if index == len(offsets) - 1 else tranche, ".2f"),
                "within_horizon": arrival + timedelta(days=offset) < end} for index, offset in enumerate(offsets)]})
    return {"horizon_end_exclusive": end.isoformat(), "total_planned_principal_cny": format(sum(row[2] for row in arrivals), ".2f"), "lots": lots}
