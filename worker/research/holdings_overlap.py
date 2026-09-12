"""Deterministic overlap of two disclosed long-only NAV-weight vectors.

Undisclosed constituents are unknown, not zero. The bound concerns the two
snapshots' own dates; it does not estimate their composition on another date.
Source hashes retain decimal text, but ignore the input ordering of items.
"""

from datetime import date, datetime, timezone
from hashlib import sha256
import json
import re

from worker.accounting.decimal_math import ONE, ZERO, canonical, fact_decimal, financial


SNAPSHOT_VERSION = "holdings-disclosure-v1"
METHOD_VERSION = "holdings-overlap-v1"
WEIGHT_BASIS = "net_assets_long_only"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_SECURITY_ID = re.compile(r"^[A-Z][A-Z0-9_]{0,31}:[A-Za-z0-9._:/-]{1,160}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_INSTANT = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$")
_FIELDS = {"schema_version", "snapshot_id", "portfolio_id", "listing_id", "version", "as_of", "known_at", "weight_basis",
           "complete", "coverage", "items", "content_hash"}


class HoldingsOverlapError(ValueError):
    """A disclosure cannot support the requested bounded comparison."""


def _canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def _hash(value):
    return sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _instant(value, field):
    if not isinstance(value, str) or not _INSTANT.fullmatch(value):
        raise HoldingsOverlapError("INVALID_" + field)
    try:
        result = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise HoldingsOverlapError("INVALID_" + field) from exc
    if result.tzinfo is None:
        raise HoldingsOverlapError("INVALID_" + field)
    return result.astimezone(timezone.utc)


def _day(value):
    if not isinstance(value, str):
        raise HoldingsOverlapError("INVALID_AS_OF")
    try:
        result = date.fromisoformat(value)
    except ValueError as exc:
        raise HoldingsOverlapError("INVALID_AS_OF") from exc
    if result.isoformat() != value:
        raise HoldingsOverlapError("INVALID_AS_OF")
    return result


def _identifier(value, field):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise HoldingsOverlapError("INVALID_" + field)
    return value


def _weight(value, field):
    if not isinstance(value, str):
        raise HoldingsOverlapError("DECIMAL_STRING_REQUIRED:" + field)
    try:
        number = fact_decimal(value)
    except ValueError as exc:
        raise HoldingsOverlapError("INVALID_WEIGHT:" + field) from exc
    if number < ZERO or number > ONE:
        raise HoldingsOverlapError("WEIGHT_OUT_OF_RANGE:" + field)
    return number


@financial
def _validated(snapshot):
    if not isinstance(snapshot, dict) or set(snapshot) != _FIELDS:
        raise HoldingsOverlapError("INVALID_DISCLOSURE_SHAPE")
    if snapshot["schema_version"] != SNAPSHOT_VERSION:
        raise HoldingsOverlapError("UNSUPPORTED_DISCLOSURE_VERSION")
    _identifier(snapshot["snapshot_id"], "SNAPSHOT_ID")
    _identifier(snapshot["portfolio_id"], "PORTFOLIO_ID")
    _identifier(snapshot["listing_id"], "LISTING_ID")
    if type(snapshot["version"]) is not int or not 1 <= snapshot["version"] <= 9007199254740991:
        raise HoldingsOverlapError("INVALID_DISCLOSURE_REVISION")
    as_of = _day(snapshot["as_of"])
    known_at = _instant(snapshot["known_at"], "KNOWN_AT")
    if snapshot["weight_basis"] != WEIGHT_BASIS:
        raise HoldingsOverlapError("UNSUPPORTED_WEIGHT_BASIS")
    if type(snapshot["complete"]) is not bool:
        raise HoldingsOverlapError("INVALID_COMPLETENESS")
    coverage = _weight(snapshot["coverage"], "coverage")
    if not isinstance(snapshot["items"], list) or len(snapshot["items"]) > 10000:
        raise HoldingsOverlapError("INVALID_HOLDINGS_ITEMS")
    weights = {}
    for row in snapshot["items"]:
        if not isinstance(row, dict) or set(row) != {"security_id", "weight"}:
            raise HoldingsOverlapError("INVALID_HOLDING_SHAPE")
        identity = row["security_id"]
        if not isinstance(identity, str) or not _SECURITY_ID.fullmatch(identity):
            raise HoldingsOverlapError("INVALID_SECURITY_ID")
        if identity in weights:
            raise HoldingsOverlapError("DUPLICATE_SECURITY_ID:" + identity)
        weights[identity] = _weight(row["weight"], identity)
    total = sum(weights.values(), ZERO)
    if total > ONE:
        raise HoldingsOverlapError("DISCLOSURE_COVERAGE_EXCEEDS_ONE")
    if coverage != total:
        raise HoldingsOverlapError("DISCLOSURE_COVERAGE_MISMATCH")
    if snapshot["complete"] and (not weights or coverage != ONE):
        raise HoldingsOverlapError("COMPLETE_DISCLOSURE_REQUIRES_FULL_COVERAGE")
    return weights, coverage, as_of, known_at


def disclosure_hash(snapshot):
    """Hash the immutable comparison input, retaining weights' exact source text.

    This helper checks shape and arithmetic, not the claimed content_hash.
    Adapters can supply content_hash=None while creating a new snapshot.
    """
    _validated(snapshot)
    payload = {key: value for key, value in snapshot.items() if key != "content_hash"}
    payload["items"] = sorted(snapshot["items"], key=lambda item: item["security_id"])
    return _hash(payload)


def _reference(snapshot):
    return {key: snapshot[key] for key in ("snapshot_id", "portfolio_id", "listing_id", "version", "as_of", "known_at", "content_hash", "complete")}


@financial
def compare_holdings(snapshot_a, snapshot_b, comparison_at):
    """Return a known lower bound and conservative upper bound, without imputation.

    as_of is a disclosure date label, checked against the UTC comparison date.
    known_at controls point-in-time availability; no close or timezone is inferred.
    Snapshot source/ownership authorization belongs to the calling service.
    """
    at = _instant(comparison_at, "COMPARISON_AT")
    inputs = []
    for label, snapshot in (("A", snapshot_a), ("B", snapshot_b)):
        weights, coverage, as_of, known_at = _validated(snapshot)
        if as_of > at.date():
            raise HoldingsOverlapError("FUTURE_DISCLOSURE_DATE:" + label)
        if known_at > at:
            raise HoldingsOverlapError("DISCLOSURE_NOT_YET_KNOWN:" + label)
        claimed_hash = snapshot["content_hash"]
        if not isinstance(claimed_hash, str) or not _HASH.fullmatch(claimed_hash) or disclosure_hash(snapshot) != claimed_hash:
            raise HoldingsOverlapError("DISCLOSURE_HASH_MISMATCH:" + label)
        inputs.append((weights, coverage))
    if snapshot_a["portfolio_id"] != snapshot_b["portfolio_id"]:
        raise HoldingsOverlapError("DISCLOSURE_PORTFOLIO_MISMATCH")
    if (snapshot_a["snapshot_id"] == snapshot_b["snapshot_id"] and snapshot_a["version"] == snapshot_b["version"]
            and snapshot_a["content_hash"] != snapshot_b["content_hash"]):
        raise HoldingsOverlapError("DISCLOSURE_VERSION_CONFLICT")
    (weights_a, coverage_a), (weights_b, coverage_b) = inputs
    common = [{"security_id": identity, "weight_a": canonical(weights_a[identity]),
               "weight_b": canonical(weights_b[identity]), "overlap_weight": canonical(min(weights_a[identity], weights_b[identity]))}
              for identity in sorted(weights_a.keys() & weights_b.keys())]
    overlap = sum((min(weights_a[identity], weights_b[identity]) for identity in weights_a.keys() & weights_b.keys()), ZERO)
    uncovered_a, uncovered_b = ONE - coverage_a, ONE - coverage_b
    # Any overlap not already counted consumes undisclosed weight on at least
    # one side; counting both budgets may overestimate but never understates it.
    upper = min(ONE, overlap + uncovered_a + uncovered_b)
    different_dates = snapshot_a["as_of"] != snapshot_b["as_of"]
    quality = "different_dates" if different_dates else "exact" if snapshot_a["complete"] and snapshot_b["complete"] else "lower_bound"
    issues = []
    if different_dates:
        issues.append("DISCLOSURE_DATES_DIFFER")
    if not snapshot_a["complete"]:
        issues.append("PARTIAL_DISCLOSURE:A")
    if not snapshot_b["complete"]:
        issues.append("PARTIAL_DISCLOSURE:B")
    result = {"schema_version": METHOD_VERSION, "method_version": METHOD_VERSION, "portfolio_id": snapshot_a["portfolio_id"],
              "comparison_at": at.isoformat(timespec="microseconds").replace("+00:00", "Z"),
              "weight_basis": WEIGHT_BASIS, "snapshot_a": _reference(snapshot_a), "snapshot_b": _reference(snapshot_b),
              "known_overlap": canonical(overlap), "coverage_a": canonical(coverage_a), "coverage_b": canonical(coverage_b),
              "uncovered_a": canonical(uncovered_a), "uncovered_b": canonical(uncovered_b),
              "conservative_upper_bound": canonical(upper), "quality": quality,
              "same_date": not different_dates, "bound_scope": "the_two_disclosed_date_vectors",
              "common_holdings": common, "issues": sorted(issues)}
    result["binding_id"] = _hash(result)
    return result
