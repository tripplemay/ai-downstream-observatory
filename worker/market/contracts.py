"""Validate shared versioned schemas with no remote reference retrieval."""

from datetime import date
from functools import lru_cache
import json
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from worker.accounting import fact_decimal
from worker.orchestration.db import ROOT, WorkbenchError, instant


@lru_cache(maxsize=1)
def _schemas():
    paths = (ROOT / "contracts/v1").glob("*.schema.json")
    schemas = {path.name: json.loads(path.read_text()) for path in paths}
    registry = Registry().with_resources((schema["$id"], Resource.from_contents(schema)) for schema in schemas.values())
    checker = FormatChecker()

    @checker.checks("date-time", raises=(ValueError, TypeError))
    def check_instant(value):
        if not isinstance(value, str) or "T" not in value:
            return False
        instant(value)
        return True

    @checker.checks("date", raises=(ValueError, TypeError))
    def check_date(value):
        return isinstance(value, str) and date.fromisoformat(value).isoformat() == value

    return schemas, registry, checker


def validate_contract(value, name="market-batch.schema.json", fragment=None):
    schemas, registry, checker = _schemas()
    schema = schemas[name]
    if fragment is not None:
        # An absolute reference keeps relative common-schema references local.
        schema = {"$ref": schemas[name]["$id"] + "#/" + fragment}
    validator = Draft202012Validator(schema, registry=registry, format_checker=checker)
    errors = list(validator.iter_errors(value))
    if errors:
        error = errors[0]
        path = "/" + "/".join(str(item) for item in error.absolute_path)
        raise WorkbenchError("CONTRACT_INVALID:" + path + ":" + error.message)


def observation_semantics(row, batch):
    validate_contract(row, "market-observation.schema.json")
    if row["batch_id"] != batch["id"] or row["source_id"] != batch["source_id"]:
        raise WorkbenchError("OBSERVATION_PARENT_MISMATCH")
    try:
        ZoneInfo(row["source_timezone"])
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise WorkbenchError("UNKNOWN_SOURCE_TIMEZONE") from exc
    value = fact_decimal(row["value"])
    if row["metric"] == "close":
        if not row.get("listing_id") or value < 0 or row["price_basis"] == "not_applicable":
            raise WorkbenchError("INVALID_PRICE_OBSERVATION")
    elif row["metric"] == "fx_cny_per_unit":
        if row.get("listing_id") or value <= 0 or row["price_basis"] != "not_applicable" or row["unit"] != "CNY_per_unit_currency":
            raise WorkbenchError("INVALID_FX_OBSERVATION")
        if not re.fullmatch(r"FX:[A-Z]{3}", row["series_key"]):
            raise WorkbenchError("INVALID_FX_CURRENCY")
        if row["series_key"] == "FX:CNY" and value != 1:
            raise WorkbenchError("CNY_REFERENCE_RATE_MUST_BE_ONE")
    elif row["metric"] == "universe_member":
        if not row.get("listing_id") or value != 1 or row["price_basis"] != "not_applicable" or row["unit"] != "boolean":
            raise WorkbenchError("INVALID_UNIVERSE_MEMBER")
    else:
        raise WorkbenchError("UNSUPPORTED_MARKET_METRIC")
    permitted = {"prices": {"close"}, "fx": {"fx_cny_per_unit"},
                 "universe": {"universe_member"}, "mixed": {"close", "fx_cny_per_unit", "universe_member"}}
    if row["metric"] not in permitted[batch["batch_type"]]:
        raise WorkbenchError("BATCH_TYPE_METRIC_MISMATCH")
    if batch["source_mode"] == "synthetic" and row["provenance"] != "reconstructed":
        raise WorkbenchError("SYNTHETIC_SOURCE_MUST_BE_RECONSTRUCTED")
    if row["provenance"] == "historical_point_in_time" and "published_at" not in row:
        raise WorkbenchError("HISTORICAL_PUBLICATION_EVIDENCE_REQUIRED")
