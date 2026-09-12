"""Version/time eligibility and calendar-aware valuation completeness."""

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from .decimal_math import AccountingError
from .performance import utc


@dataclass(frozen=True)
class DataTimes:
    observed_at: datetime
    published_at: Optional[datetime]
    ingested_at: datetime
    historical_archive_verified: bool = False


@dataclass(frozen=True)
class Eligibility:
    eligible: bool
    mode: str
    reasons: tuple = ()


def eligible_at(data, decision_at, mode="actual_replay"):
    decision = utc(decision_at)
    observed, ingested = utc(data.observed_at), utc(data.ingested_at)
    published = utc(data.published_at) if data.published_at is not None else None
    if mode not in ("actual_replay", "historical_point_in_time", "reconstructed"):
        raise AccountingError("invalid_replay_mode")
    reasons = []
    if observed > decision:
        reasons.append("observation_after_decision")
    if published is not None and published > decision:
        reasons.append("publication_after_decision")
    if mode == "actual_replay":
        if ingested > decision:
            reasons.append("ingested_after_decision")
    elif mode == "historical_point_in_time":
        if published is None or not data.historical_archive_verified:
            reasons.append("historical_publication_archive_unverified")
    # Reconstructed history stays labeled, even if all observed dates precede
    # the decision; it cannot be promoted to point-in-time evidence.
    return Eligibility(not reasons, mode, tuple(reasons))


@dataclass(frozen=True)
class PriceRequirement:
    listing_id: str
    market: str
    expected_session: Optional[str]
    actual_session: Optional[str]
    times: Optional[DataTimes]
    price_basis: str = "unadjusted"
    corporate_actions_complete: bool = True
    quality_rule_approved: bool = True


@dataclass(frozen=True)
class QualityResult:
    quality: str
    issues: tuple
    decision_eligible: bool


def valuation_quality(requirements, cutoff_at, missing_fx=(), mode="actual_replay"):
    utc(cutoff_at)
    issues = ["missing_fx:" + currency for currency in missing_fx]
    blocked = bool(issues)
    for item in requirements:
        prefix = item.listing_id + ":"
        if item.expected_session is None:
            issues.append(prefix + "calendar_unknown")
            blocked = True
        if not item.quality_rule_approved:
            issues.append(prefix + "quality_rule_unapproved")
            blocked = True
        if item.times is None or item.actual_session is None:
            issues.append(prefix + "missing_price")
            blocked = True
            continue
        if item.price_basis != "unadjusted":
            issues.append(prefix + "price_basis_mismatch")
            blocked = True
        if item.actual_session != item.expected_session:
            issues.append(prefix + "session_not_latest_completed")
        eligible = eligible_at(item.times, cutoff_at, mode)
        if not eligible.eligible:
            issues.extend(prefix + reason for reason in eligible.reasons)
            blocked = True
        if not item.corporate_actions_complete:
            issues.append(prefix + "corporate_actions_unconfirmed")
    quality = "blocked" if blocked else "provisional" if issues else "complete"
    return QualityResult(quality, tuple(issues), quality == "complete" and mode == "actual_replay")
