"""Read-only source comparison for human action review, never economic admission."""

from collections import Counter
from datetime import timedelta
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_EVEN, ROUND_HALF_UP, localcontext

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, instant, stamp, transaction
from . import eodhd_sources, issuer_sources
from .data_evidence import _fact_validation_scope, _owner, resolve_review
from .model_runtime import _clock


SCHEMA = "investor-action-crosscheck.schema.json"
TARGETS = {"VT.US": "3141", "BND.US": "0928"}
_COUNTS = ("matched_dates", "nominal_amount_matches", "nominal_amount_differences",
    "record_date_matches", "record_date_differences", "record_date_unknown",
    "payment_date_matches", "payment_date_differences", "payment_date_unknown",
    "ambiguous_issuer_groups", "unsupported_issuer_groups", "reported_currency_mismatches")


def _check(value, code="INVALID"):
    if not value:
        raise WorkbenchError("INVESTOR_DATA_ACTION_CROSSCHECK_" + code)


def _precision_profile(pairs):
    differences = [(a, Decimal(b["unadjusted_value"]), b) for a, b in pairs if a != Decimal(b["unadjusted_value"])]
    ours, theirs = Counter(), Counter()
    adjusted_matches = 0
    for a, b, record in differences:
        ours[str(len(format(a, "f").partition(".")[2].rstrip("0")))] += 1
        theirs[str(len(format(b, "f").partition(".")[2].rstrip("0")))] += 1
        adjusted_matches += int(a == Decimal(record["value"]))
    probes = []
    with localcontext() as context:
        context.prec = 128
        for places in range(19):
            quantum = Decimal(1).scaleb(-places)
            for name, mode in (("half_up", ROUND_HALF_UP), ("half_even", ROUND_HALF_EVEN), ("toward_zero", ROUND_DOWN)):
                ours_rounded = sum(b == a.quantize(quantum, rounding=mode) for a, b, _ in differences)
                theirs_rounded = sum(a == b.quantize(quantum, rounding=mode) for a, b, _ in differences)
                if ours_rounded or theirs_rounded:
                    probes.append({"fraction_places": places, "mode": name,
                        "provider_equals_issuer_quantized": ours_rounded,
                        "issuer_equals_provider_quantized": theirs_rounded})
    return {"differing_pair_count": len(differences), "issuer_canonical_fraction_digits": dict(ours),
        "provider_canonical_fraction_digits": dict(theirs), "provider_adjusted_field_equals_issuer": adjusted_matches,
        "quantization_relationships": probes, "acceptance_tolerance_applied": False,
        "supplier_precision_contract_verified": False}


def _compare(issuer, dividends, splits, currency):
    sources = [draft["source"] for draft in (issuer, dividends, splits)]
    start = max(source["range_start"] for source in sources)
    end = min(source["range_end"] for source in sources)
    counts = dict.fromkeys(_COUNTS, 0)
    counts.update(issuer_only_dates=0, provider_only_dates=0,
        issuer_input_records=len(issuer["records"]), provider_dividend_input_records=len(dividends["records"]),
        provider_split_input_records=len(splits["records"]), issuer_window_records=0,
        provider_dividend_window_records=0, provider_split_window_records=0)
    if start > end:
        return {"status": "no_common_window", "common_window": None, "counts": counts,
            "precision": _precision_profile([])}
    grouped = {}
    for row in issuer["records"]:
        if start <= row["ex_date"] <= end:
            grouped.setdefault(row["ex_date"], []).append(row)
            counts["issuer_window_records"] += 1
    provider = {row["date"]: row for row in dividends["records"] if start <= row["date"] <= end}
    counts["provider_dividend_window_records"] = len(provider)
    _check(len(provider) == sum(start <= row["date"] <= end for row in dividends["records"]))
    counts["provider_split_window_records"] = sum(start <= row["date"] <= end for row in splits["records"])
    counts["issuer_only_dates"] = len(set(grouped) - set(provider))
    counts["provider_only_dates"] = len(set(provider) - set(grouped))
    pairs = []
    for day in sorted(set(grouped) & set(provider)):
        rows, other = grouped[day], provider[day]
        counts["matched_dates"] += 1
        components = [row["issuer_type_code"] for row in rows]
        if len(set(components)) != len(components) or not set(components) <= {"INC", "CGLT", "CGST"}:
            counts["unsupported_issuer_groups"] += 1
            continue
        if len({(row["record_date"], row["pay_date"]) for row in rows}) != 1:
            counts["ambiguous_issuer_groups"] += 1
            continue
        if other["reported_currency"] != currency:
            counts["reported_currency_mismatches"] += 1
            continue
        with localcontext() as context:
            context.prec = 128
            total = sum((Decimal(row["distribution_amount"]) for row in rows), Decimal(0))
            match = total == Decimal(other["unadjusted_value"])
        pairs.append((total, other))
        counts["nominal_amount_matches" if match else "nominal_amount_differences"] += 1
        for ours, theirs, prefix in (("record_date", "record_date", "record_date"), ("pay_date", "payment_date", "payment_date")):
            suffix = "unknown" if other[theirs] is None else "matches" if rows[0][ours] == other[theirs] else "differences"
            counts[prefix + "_" + suffix] += 1
    differences = any(counts[key] for key in ("nominal_amount_differences", "record_date_differences",
        "payment_date_differences", "record_date_unknown", "payment_date_unknown", "issuer_only_dates",
        "provider_only_dates", "ambiguous_issuer_groups", "unsupported_issuer_groups", "reported_currency_mismatches"))
    status = "reported_differences_require_review" if differences else (
        "reported_nominal_fields_match_not_approval" if counts["nominal_amount_matches"] else "no_matched_events_not_absence_proof")
    return {"status": status, "common_window": {"range_start": start, "range_end": end},
        "counts": counts, "precision": _precision_profile(pairs)}


def _binding(value, grant, control):
    row = value["capture"]
    return {"capture_id": row["id"], "capture_hash": row["content_hash"], "raw_sha256": row["raw_sha256"],
        "raw_bytes": row["raw_bytes"], "qualification": row["qualification"], "retain_until": row["retain_until"],
        "authority_id": grant["id"], "authority_hash": grant["content_hash"],
        "control_id": control["id"], "control_hash": control["content_hash"]}


def check_action_crosscheck(db, workspace, actor, listing_review_id, issuer_capture_id,
        dividend_capture_id, split_capture_id, *, now=None, allow_synthetic=False):
    """Resolve exact retained originals in one snapshot; return only review metadata."""
    _check(type(allow_synthetic) is bool)
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor)
        listing = resolve_review(db, workspace, listing_review_id, "listing", now=at)
        asset = listing["facts"]; symbol = asset["provider_symbol"]
        _check(symbol in TARGETS and asset["market"] == "US" and asset["currency"] == "USD", "TARGET_UNSUPPORTED")
        issued = issuer_sources.resolve_issuer_capture(db, workspace, actor, issuer_capture_id, now=at, allow_synthetic=allow_synthetic)
        dividends = eodhd_sources.resolve_eodhd_capture(db, workspace, actor, dividend_capture_id, now=at, allow_synthetic=allow_synthetic)
        splits = eodhd_sources.resolve_eodhd_capture(db, workspace, actor, split_capture_id, now=at, allow_synthetic=allow_synthetic)
        _check(issued["draft"]["source"]["requested_fund_id"] == TARGETS[symbol], "TARGET_BINDING_DIFFERS")
        issuer_request = db.execute("SELECT * FROM investor_issuer_requests WHERE id=? AND workspace_id=?",
            (issued["capture"]["request_id"], workspace)).fetchone()
        issuer_grant, issuer_policy, issuer_control = issuer_sources._grant(db, workspace, issuer_request["authority_id"], at)
        _check(issuer_sources._active(issuer_policy, issuer_control, at) and issuer_control["id"] == issuer_request["control_id"], "AUTHORITY_INACTIVE")
        eod_grants = []
        days = [issuer_request["issuer_day"]]
        for value, kind in ((dividends, "div"), (splits, "splits")):
            source = value["draft"]["source"]
            _check(source["requested_symbol"] == symbol and source["kind"] == kind, "TARGET_BINDING_DIFFERS")
            request = db.execute("SELECT * FROM investor_eodhd_requests WHERE id=? AND workspace_id=?",
                (value["capture"]["request_id"], workspace)).fetchone()
            grant = eodhd_sources._grant(db, workspace, request["authority_id"], at)
            _check(eodhd_sources._active(grant, at) and grant[2]["id"] == request["control_id"], "AUTHORITY_INACTIVE")
            eod_grants.append(grant); days.append(request["source_day"])
        _check(len(set(days)) == 1, "SOURCE_DAYS_DIFFER")
        _check(eod_grants[0][0]["id"] == eod_grants[1][0]["id"] and eod_grants[0][2]["id"] == eod_grants[1][2]["id"], "AUTHORITY_BINDING_DIFFERS")
        comparison = _compare(issued["draft"], dividends["draft"], splits["draft"], asset["currency"])
        bindings = {"issuer": _binding(issued, issuer_grant, issuer_control),
            "dividends": _binding(dividends, eod_grants[0][0], eod_grants[0][2]),
            "splits": _binding(splits, eod_grants[1][0], eod_grants[1][2])}
        deadlines = [instant(at) + timedelta(seconds=60), instant(listing["review"]["valid_until"]),
            instant(issuer_policy["valid_until"]), *(instant(grant[1]["valid_until"]) for grant in eod_grants),
            *(instant(binding["retain_until"]) for binding in bindings.values())]
        report = {"schema_version": "investor-action-crosscheck-v1", "checked_at": at, "refresh_after": stamp(min(deadlines)),
            "listing_id": asset["listing_id"], "listing_review_id": listing_review_id,
            "listing_review_hash": listing["review"]["content_hash"], "provider_symbol": symbol,
            "requested_fund_id": TARGETS[symbol], "source_day": days[0], "bindings": bindings, "comparison": comparison,
            "evidence_mode": "official_capture_replay" if issued["capture"]["qualification"] == issuer_sources.OFFICIAL
                and all(value["capture"]["qualification"] == eodhd_sources.OFFICIAL for value in (dividends, splits)) else "synthetic_test_only",
            "review_requirements": ["INSTRUMENT_IDENTITY_BINDING", "ISSUER_CURRENCY_AND_AMOUNT_UNIT",
                "COMPLETE_ACTION_AND_ABSENCE_COVERAGE", "ANNOUNCEMENT_AND_EFFECTIVE_INSTANTS", "EXPLICIT_TAX_ASSUMPTION"],
            "empty_split_list_is_absence_proof": False, "owner_reviewed": False, "corporate_actions_complete": False,
            "research_admitted": False, "live_advice_eligible": False, "trading_permission": False,
            "market_values_output": False, "source_calls": 0, "database_writes": 0}
        _check(instant(at) < instant(report["refresh_after"]))
        validate_contract(report, SCHEMA)
        return report
