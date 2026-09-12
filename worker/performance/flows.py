"""Event-time translation evidence; never an FX trade or an extra ledger posting."""

from datetime import date, datetime, time, timedelta
from decimal import localcontext
import json
from zoneinfo import ZoneInfo

from worker.accounting import canonical, decimal
from worker.market.contracts import validate_contract
from worker.market.collection import source_verified
from worker.market.valuation import _choose_observation, _observed_instant
from worker.orchestration.db import WorkbenchError, content_hash, instant, stamp


SECURITY_EXTERNAL_TYPES = {"security_in", "security_out"}
SECURITY_INTERNAL_TYPES = {"security_transfer_out", "security_transfer_in", "security_transfer_return"}


def event_time(event):
    if event["time_precision"] == "second":
        return instant(event["effective_at"])
    return datetime.combine(date.fromisoformat(event["effective_at"]) + timedelta(days=1),
                            time.min, ZoneInfo(event["source_timezone"]))


def date_start(event):
    return datetime.combine(date.fromisoformat(event["effective_at"]), time.min,
                            ZoneInfo(event["source_timezone"]))


def in_period(event, posting, start, end):
    at = event_time(event)
    if event["time_precision"] == "date" and (posting["currency"] != "CNY" or event["event_type"] in SECURITY_EXTERNAL_TYPES):
        return date_start(event) <= end and at > start
    return start < at <= end


def _publication(connection, scope, known_at):
    return connection.execute("""SELECT e.*, b.validation_json, b.source_id, b.status,
        b.manifest_hash AS batch_manifest_hash FROM market_publication_events e
        JOIN market_batches b ON b.id=e.batch_id
        WHERE e.scope=? AND e.published_at<=? ORDER BY e.revision DESC LIMIT 1""",
        (scope, stamp(known_at))).fetchone()


def _correction_issue(connection, scope, publication, original, at, period_end):
    # Scan intermediate publications too: a latest-session batch omitting a
    # previously revised historical row does not undo that revision.
    rows = [dict(row) for row in connection.execute("""SELECT DISTINCT o.* FROM market_observations o
        JOIN market_batch_members m ON m.observation_id=o.id
        JOIN market_publication_events e ON e.batch_id=m.batch_id
        WHERE e.scope=? AND e.revision>? AND e.published_at<=?
        AND o.series_key=? AND o.metric=? AND o.price_basis=?""",
        (scope, publication["revision"], stamp(period_end), original["series_key"],
         original["metric"], original["price_basis"]))]
    rows = [row for row in rows if _observed_instant(row) >= _observed_instant(original)]
    chosen, problem = _choose_observation([original, *rows], at, period_end)
    if problem:
        return "FLOW_FX_AMBIGUOUS_REVISION"
    if (chosen["unit"] != original["unit"] or chosen["listing_id"] is not None
            or decimal(chosen["value"]) != decimal(original["value"])):
        return "FLOW_FX_KNOWLEDGE_CHANGED_RESTATE_REQUIRED"
    return None


def _security_evidence(connection, event, posting):
    try:
        fact = json.loads(event["payload_json"])["fact"]
        validate_contract(fact, "ledger-fact.schema.json")
        value = fact["value_evidence"]
        validate_contract(value, "security-transfer-value.schema.json")
        security = {key: fact[key] for key in ("listing_id", "quantity", "market_value", "value_evidence")}
        security["fact_hash"] = content_hash(fact)
        listing = connection.execute("SELECT currency FROM listings WHERE id=?", (fact["listing_id"],)).fetchone()
        movements = connection.execute("SELECT * FROM position_movements WHERE event_id=?", (event["id"],)).fetchall()
        expected_posting = decimal(fact["market_value"]) * (-1 if event["event_type"] == "security_in" else 1)
        issues = []
        if (fact["type"] != event["event_type"] or fact["account_id"] != event["account_id"]
                or posting["account_id"] != event["account_id"] or fact["currency"] != posting["currency"]
                or listing is None or listing["currency"] != posting["currency"]):
            issues.append("SECURITY_FLOW_SCOPE_MISMATCH")
        if decimal(fact["market_value"]) <= 0 or decimal(fact["quantity"]) <= 0 or decimal(posting["amount"]) != expected_posting:
            issues.append("SECURITY_FLOW_VALUE_MISMATCH")
        if (len(movements) != 1 or movements[0]["account_id"] != event["account_id"]
                or movements[0]["listing_id"] != fact["listing_id"] or movements[0]["currency"] != posting["currency"]):
            issues.append("SECURITY_FLOW_SCOPE_MISMATCH")
        elif decimal(movements[0]["quantity"]) != decimal(fact["quantity"]) * (1 if event["event_type"] == "security_in" else -1):
            issues.append("SECURITY_FLOW_VALUE_MISMATCH")
        same_time = value["effective_at"] == event["effective_at"] if event["time_precision"] == "date" else instant(value["effective_at"]) == instant(event["effective_at"])
        if (not value["reference"].strip() or not same_time or value["time_precision"] != event["time_precision"]
                or value["source_timezone"] != event["source_timezone"]):
            issues.append("SECURITY_FLOW_VALUE_EVIDENCE_INVALID")
        return security, issues
    except (KeyError, TypeError, ValueError):
        return None, ["SECURITY_FLOW_VALUE_EVIDENCE_INVALID"]


def resolve_flow(connection, portfolio_id, event, posting, mode, rules, evaluation_zone, period_end, now):
    foreign = posting["currency"] != "CNY"
    is_security = event["event_type"] in SECURITY_EXTERNAL_TYPES
    uncertain = (foreign or is_security) and event["time_precision"] != "second"
    at = event_time(event)
    flow_date = (at - timedelta(microseconds=1) if event["time_precision"] == "date" else at).astimezone(evaluation_zone).date()
    known_at = (at if mode == "as_known" else now) if foreign and not uncertain else None
    amount = decimal(posting["amount"]).copy_negate()
    evidence = {"schema_version": "flow-fx-evidence-v2", "portfolio_id": portfolio_id,
        "flow_kind": "security" if is_security else "cash", "security": None,
        "event_id": event["id"], "posting_id": posting["id"], "event_payload_hash": event["payload_hash"],
        "event_hash": content_hash(event), "posting_hash": content_hash(posting),
        "event_ledger_revision": event["ledger_revision"], "currency": posting["currency"],
        "amount_native": canonical(amount), "effective_at": event["effective_at"],
        "time_precision": event["time_precision"], "source_timezone": event["source_timezone"],
        "flow_time": None if uncertain else stamp(at), "evaluation_date": None if uncertain else flow_date.isoformat(),
        "mode": mode, "knowledge_at": stamp(known_at) if known_at else None,
        "rules_hash": content_hash(rules) if foreign and rules is not None else None,
        "publication": None, "observation": None, "observation_hash": None,
        "source_validation_hash": None, "source_mode": None, "source_evidence": None,
        "fx_rate": None, "amount_cny": None, "quality": "blocked", "issues": []}
    issues, heads = [], {}
    if is_security:
        evidence["security"], security_issues = _security_evidence(connection, event, posting)
        issues.extend(security_issues)
    if event["event_type"] in SECURITY_INTERNAL_TYPES:
        issues.append("INTERNAL_SECURITY_TRANSFER_EXTERNAL_CAPITAL")
    if uncertain:
        issues.append("FLOW_TIME_PRECISION_UNSUPPORTED")
    rate = decimal("1") if not foreign else None
    if foreign:
        if rules is None:
            issues.append("FLOW_FX_EVIDENCE_REQUIRED")
        elif not rules["approved"] or not rules.get("approval_evidence", "").strip():
            issues.append("FLOW_FX_RULES_UNAPPROVED")
        if rules is not None:
            scope = rules["fx_scope"]
            head = connection.execute("SELECT revision,manifest_hash FROM market_publications WHERE scope=?", (scope,)).fetchone()
            heads[scope] = dict(head) if head else None
        if not issues:
            publication = _publication(connection, scope, known_at)
            if publication is None:
                issues.append("FLOW_FX_NO_PUBLICATION")
            else:
                evidence["publication"] = {key: publication[key] for key in
                    ("scope", "revision", "batch_id", "manifest_hash", "published_at")}
                try:
                    validation = json.loads(publication["validation_json"])
                    plan = validation["plan"]
                    evidence.update(source_validation_hash=content_hash(validation),
                                    source_mode=plan.get("source_mode"), source_evidence=plan.get("source_evidence"))
                    if plan.get("source_mode") == "provider_observed":
                        evidence["schema_version"] = "flow-fx-evidence-v3"
                    if (not source_verified(connection, publication["batch_id"], plan, known_at=known_at)
                            or (plan.get("source_mode") == "manual_verified"
                                and (not isinstance(plan.get("source_evidence"), str) or not plan["source_evidence"].strip()))):
                        issues.append("FLOW_FX_SOURCE_UNVERIFIED")
                    if (publication["status"] != "published" or publication["manifest_hash"] != publication["batch_manifest_hash"]
                            or plan.get("source_id") != publication["source_id"] or plan.get("scope") != scope):
                        issues.append("FLOW_FX_PUBLICATION_INVALID")
                except (ValueError, TypeError, KeyError):
                    issues.append("FLOW_FX_PUBLICATION_INVALID")
                if mode == "restated" and {key: publication[key] for key in ("revision", "manifest_hash")} != heads[scope]:
                    issues.append("FLOW_FX_STALE_RESTATED_INPUT")
                candidates = [dict(row) for row in connection.execute("""SELECT o.* FROM market_observations o
                    JOIN market_batch_members m ON m.observation_id=o.id
                    WHERE m.batch_id=? AND o.series_key=? AND o.metric='fx_cny_per_unit'
                    AND o.price_basis='not_applicable'""", (publication["batch_id"], "FX:" + posting["currency"]))]
                chosen, problem = _choose_observation(candidates, at, known_at)
                if problem:
                    issues.append("FLOW_FX_" + problem)
                else:
                    observation = {key: value for key, value in chosen.items() if value is not None}
                    evidence.update(observation=observation, observation_hash=content_hash(observation))
                    if chosen["unit"] != "CNY_per_unit_currency" or chosen["listing_id"] is not None:
                        issues.append("FLOW_FX_UNIT_OR_SERIES_MISMATCH")
                    if chosen["source_id"] != publication["source_id"]:
                        issues.append("FLOW_FX_SOURCE_MISMATCH")
                    if chosen["published_at"] is None:
                        issues.append("FLOW_FX_PUBLICATION_TIME_REQUIRED")
                    if chosen["provenance"] == "reconstructed":
                        issues.append("FLOW_FX_RECONSTRUCTED")
                    if (at - _observed_instant(chosen)).total_seconds() > rules["max_fx_age_seconds"]:
                        issues.append("FLOW_FX_STALE")
                    rate = decimal(chosen["value"])
                    if rate <= 0:
                        issues.append("FLOW_FX_NONPOSITIVE")
                    if mode == "as_known":
                        problem = _correction_issue(connection, scope, publication, chosen, at, period_end)
                        if problem:
                            issues.append(problem)
    if not issues:
        # Two valid input decimals may produce more than 18 fractional digits.
        # This is a derived valuation, not a cash posting rounded to minor units.
        with localcontext() as context:
            context.prec = max(80, len(amount.as_tuple().digits) + len(rate.as_tuple().digits))
            evidence.update(fx_rate=canonical(rate), amount_cny=canonical(amount * rate), quality="complete")
    evidence["issues"] = sorted({code + ":" + event["id"] for code in issues})
    evidence["binding_id"] = content_hash(evidence)
    validate_contract(evidence, evidence["schema_version"] + ".schema.json")
    return evidence, heads
