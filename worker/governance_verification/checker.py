"""Independent Decimal assertions over recorded bytes, not production PASS claims."""

from decimal import Decimal
from hashlib import sha256
import json
import re

from worker.orchestration.db import canonical_json, content_hash, instant


CHECK_ID = "E-02.cash-contribution-neutrality.v1"
MAX_ARTIFACT_BYTES = 1024 * 1024
ASSERTION_IDS = ("fixed_synthetic_ledger", "balanced_postings", "normal_service_audit",
                 "real_valuation_binding", "cash_contribution_neutrality", "honest_estimate_quality")


def strict_json(raw):
    if not isinstance(raw, (str, bytes)) or len(raw if isinstance(raw, bytes) else raw.encode()) > MAX_ARTIFACT_BYTES:
        raise ValueError("VERIFICATION_JSON_LIMIT")
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="strict")
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("VERIFICATION_DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    def invalid(value):
        raise ValueError("VERIFICATION_NON_INTEGER_JSON_NUMBER")
    def integer(value):
        parsed = int(value)
        if abs(parsed) > 9007199254740991:
            raise ValueError("VERIFICATION_UNSAFE_JSON_INTEGER")
        return parsed
    try:
        parsed = json.loads(raw, object_pairs_hook=pairs, parse_float=invalid, parse_constant=invalid, parse_int=integer)
    except RecursionError as exc:
        raise ValueError("VERIFICATION_JSON_DEPTH_EXCEEDED") from exc
    def validate(value, depth=0):
        if isinstance(value, (dict, list)):
            if depth >= 64:
                raise ValueError("VERIFICATION_JSON_DEPTH_EXCEEDED")
            if isinstance(value, dict):
                for key in value:
                    key.encode("utf-8", errors="strict")
                value = value.values()
            for child in value:
                validate(child, depth + 1)
        elif isinstance(value, str):
            value.encode("utf-8", errors="strict")
    validate(parsed)
    return parsed


def _amount(value):
    if not isinstance(value, str) or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value) or len(value) > 100:
        raise ValueError("VERIFICATION_DECIMAL_INVALID")
    return Decimal(value)


def _identities(row, *keys):
    if (not isinstance(row, dict) or any(not isinstance(row.get(key), str)
            or not 1 <= len(row[key]) <= 160 for key in keys)):
        raise ValueError("VERIFICATION_IDENTITY_SHAPE_INVALID")


def _same(left, right):
    return canonical_json(left) == canonical_json(right)


def _quality(proof, portfolio, cutoff, period_start=None):
    expected = {"schema_version": "ledger-fact-quality-v1", "portfolio_id": portfolio, "ledger_revision": 2,
                "cutoff_at": cutoff, "knowledge_at": "2026-01-04T00:00:00.000000Z", "mode": "restated",
                "period_start": period_start, "nav_quality": "complete", "performance_quality": "complete",
                "attribution_quality": "complete", "dividends": [], "corporate_actions": [], "event_hashes": {}, "issues": []}
    return _same(proof, {**expected, "binding_id": content_hash(expected)})


def check_artifact(artifact):
    allowed = {"schema_version", "check_id", "fixture_version", "data_provenance", "fixture", "ledger",
               "valuations", "performance", "runtime", "process"}
    if (not isinstance(artifact, dict) or set(artifact) not in (allowed, allowed | {"binding", "started_at", "finished_at"})
            or artifact["schema_version"] != "verification-execution-artifact-v2" or artifact["check_id"] != CHECK_ID
            or artifact["fixture_version"] != "cash-contribution-neutrality-v1" or artifact["data_provenance"] != "synthetic"
            or artifact["process"] != {"exit_code": 0} or type(artifact["process"]["exit_code"]) is not int
            or set(artifact["runtime"]) != {"python_version", "node_version"}
            or not all(isinstance(value, str) and 1 <= len(value) <= 64 for value in artifact["runtime"].values())):
        raise ValueError("VERIFICATION_ARTIFACT_SHAPE_INVALID")
    fixture, ledger = artifact["fixture"], artifact["ledger"]
    if (set(fixture) != {"portfolio_id", "account_id", "timeline"}
            or fixture["timeline"] != {"left": "2026-01-01T12:00:00.000000Z", "right": "2026-01-03T12:00:00.000000Z", "now": "2026-01-04T00:00:00.000000Z"}
            or set(ledger) != {"events", "postings", "head", "audits"}
            or len(ledger["events"]) != 2 or len(ledger["postings"]) != 4 or len(ledger["audits"]) != 4
            or len(artifact["valuations"]) != 2 or set(artifact["performance"]) != {"run"}):
        raise ValueError("VERIFICATION_FIXTURE_SHAPE_INVALID")
    portfolio, account = fixture["portfolio_id"], fixture["account_id"]
    if not all(isinstance(value, str) and re.fullmatch(r"[a-f0-9-]{36}", value) for value in (portfolio, account)):
        raise ValueError("VERIFICATION_FIXTURE_ID_INVALID")
    assertions = []
    def record(identity, passed):
        assertions.append({"id": identity, "status": "pass" if passed else "fail"})
    events, postings, audits = ledger["events"], ledger["postings"], ledger["audits"]
    for event in events:
        _identities(event, "id", "portfolio_id", "account_id", "idempotency_key")
        if not isinstance(event.get("reason"), str):
            raise ValueError("VERIFICATION_EVENT_TEXT_INVALID")
    for posting in postings:
        _identities(posting, "id", "event_id", "account_id")
    for audit in audits:
        _identities(audit, "id", "portfolio_id", "actor_id", "object_id")
    events_ok = (ledger["head"]["portfolio_id"] == portfolio and ledger["head"]["revision"] == 2
                 and len({event["id"] for event in events}) == 2)
    for index, (event, kind, amount, at) in enumerate(zip(events, ("opening_cash", "deposit"), ("100.25", "50.125"),
                                                        ("2026-01-01T00:00:00.000Z", "2026-01-02T12:00:00.000Z"))):
        payload = strict_json(event["payload_json"])
        _identities(payload, "portfolio_id", "idempotency_key")
        if not isinstance(payload.get("reason"), str):
            raise ValueError("VERIFICATION_EVENT_TEXT_INVALID")
        events_ok &= (type(event["ledger_revision"]) is int and type(payload["expected_revision"]) is int
            and event["portfolio_id"] == portfolio and event["account_id"] == account
            and event["event_type"] == kind and event["ledger_revision"] == index + 1
            and event["effective_at"] == at and event["recorded_at"] == at
            and event["time_precision"] == "second" and event["source_timezone"] == "UTC"
            and event["actor_id"] == "SYNTHETIC-VERIFICATION-FIXTURE" and event["reversal_of"] is None
            and event["source_id"] == "synthetic-cash-neutrality-v1" and event["source_event_id"] == kind
            and event["payload_hash"] == content_hash({key: value for key, value in payload.items() if key not in ("expected_revision", "idempotency_key")})
            and payload["fact"] == {"type": kind, "account_id": account, "currency": "CNY", "amount": amount}
            and payload["portfolio_id"] == portfolio and payload["expected_revision"] == index
            and all(payload[key] == event[key] for key in ("effective_at", "time_precision", "source_timezone", "source_id", "source_event_id", "idempotency_key", "reason")))
    record("fixed_synthetic_ledger", events_ok)
    posting_ok = len({row["id"] for row in postings}) == 4
    for event, value, contra in zip(events, (Decimal("100.25"), Decimal("50.125")), ("opening_equity", "external_capital")):
        rows = [row for row in postings if row["event_id"] == event["id"]]
        posting_ok &= (len(rows) == 2 and all(row["account_id"] == account and row["currency"] == "CNY" for row in rows)
                       and {row["ledger_account"]: _amount(row["amount"]) for row in rows} == {"cash_settled": value, contra: -value}
                       and sum((_amount(row["amount"]) for row in rows), Decimal(0)) == 0)
    record("balanced_postings", posting_ok)
    audit_ok = (len({row["id"] for row in audits}) == 4
                and all(row["portfolio_id"] == portfolio and row["actor_id"] == "SYNTHETIC-VERIFICATION-FIXTURE" for row in audits)
                and any(row["action"] == "create_portfolio" and row["object_id"] == portfolio for row in audits)
                and any(row["action"] == "create_account" and row["object_id"] == account for row in audits))
    for event in events:
        rows = [row for row in audits if row["action"] == "record_fact" and row["object_id"] == event["id"]]
        audit_ok &= (len(rows) == 1 and rows[0]["object_type"] == "ledger_event" and type(rows[0]["ledger_revision"]) is int
                     and rows[0]["ledger_revision"] == event["ledger_revision"] and rows[0]["created_at"] == event["recorded_at"]
                     and strict_json(rows[0]["payload_json"])["digest"] == event["payload_hash"])
    record("normal_service_audit", audit_ok)
    navs, runs, valuation_ok = [], [], True
    for snapshot, at in zip(artifact["valuations"], (fixture["timeline"]["left"], fixture["timeline"]["right"])):
        if set(snapshot) != {"run", "items"} or len(snapshot["items"]) != 1:
            raise ValueError("VERIFICATION_VALUATION_SHAPE_INVALID")
        run, item = snapshot["run"], snapshot["items"][0]
        _identities(run, "id", "portfolio_id")
        _identities(item, "id", "run_id", "account_id")
        manifest = strict_json(run["market_manifest"])
        expected_nav = sum((_amount(row["amount"]) for row in postings if row["ledger_account"] == "cash_settled"
                            and any(event["id"] == row["event_id"] and instant(event["effective_at"]) <= instant(at) for event in events)), Decimal(0))
        navs.append(expected_nav)
        runs.append(run)
        rules = {"schema_version": "valuation-rules-v1", "approved": True,
                 "approval_evidence": "SYNTHETIC fixed verification fixture; not investment approval",
                 "price_scope_by_market": {}, "expected_sessions": {}, "corporate_actions_complete": {}, "max_fx_age_seconds": 0}
        valuation_ok &= (run["portfolio_id"] == portfolio and type(run["ledger_revision"]) is int and run["ledger_revision"] == 2 and run["quality"] == "complete"
            and run["cutoff_at"] == at and run["created_at"] == fixture["timeline"]["now"]
            and run["method_version"] == "decimal-nav-cny-v4:restated" and _amount(run["nav_cny"]) == expected_nav
            and manifest["mode"] == "restated" and manifest["rules_hash"] == content_hash(manifest["rules"])
            and canonical_json(manifest["rules"]) == canonical_json(rules) and manifest["publications"] == {}
            and _quality(manifest["ledger_fact_quality"], portfolio, at)
            and item["run_id"] == run["id"] and item["account_id"] == account and item["currency"] == "CNY"
            and item["item_type"] == "cash_settled" and item["quality"] == "complete" and item["listing_id"] is None
            and _amount(item["amount"]) == expected_nav and _amount(item["value_cny"]) == expected_nav and item["fx_rate"] == "1"
            and strict_json(item["evidence_json"]) == {"fx_observation_id": None, "ledger_revision": 2})
    record("real_valuation_binding", valuation_ok and len({run["id"] for run in runs}) == 2)
    run = artifact["performance"]["run"]
    _identities(run, "id", "portfolio_id")
    manifest, result = strict_json(run["market_manifest"]), strict_json(run["result_json"])
    for reference in manifest["valuations"]:
        _identities(reference, "id")
    external_posting = next(row for row in postings if row["ledger_account"] == "external_capital")
    flow = -_amount(external_posting["amount"])
    profit = navs[1] - navs[0] - flow
    references = [{"id": value["id"], "content_hash": content_hash(value)} for value in runs]
    evidence = manifest["external_flow_evidence"]
    for proof in evidence:
        _identities(proof, "event_id", "posting_id", "portfolio_id")
    neutral = (run["portfolio_id"] == portfolio and type(run["ledger_revision"]) is int and run["ledger_revision"] == 2
        and run["period_start"] == fixture["timeline"]["left"] and run["period_end"] == fixture["timeline"]["right"]
        and run["created_at"] == fixture["timeline"]["now"] and _same(manifest["valuations"], references)
        and manifest["mode"] == "restated" and manifest["ledger_revision"] == 2 and manifest["evaluation_timezone"] == "UTC"
        and manifest["market_heads"] == {} and manifest["flow_fx_rules"] is None and manifest["flow_fx_rules_hash"] is None
        and _same(manifest["ledger_fact_quality"], result["ledger_fact_quality"])
        and len(manifest["ledger_fact_quality"]) == 2
        and all(_quality(proof, portfolio, at) for proof, at in zip(manifest["ledger_fact_quality"], (fixture["timeline"]["left"], fixture["timeline"]["right"])))
        and _same(manifest["period_fact_quality"], result["period_fact_quality"])
        and _quality(manifest["period_fact_quality"], portfolio, fixture["timeline"]["right"], fixture["timeline"]["left"])
        and len(evidence) == 1 and _same(evidence, result["external_flow_evidence"])
        and evidence[0]["event_id"] == events[1]["id"] and evidence[0]["event_hash"] == content_hash(events[1])
        and evidence[0]["posting_id"] == external_posting["id"] and evidence[0]["posting_hash"] == content_hash(external_posting)
        and evidence[0]["binding_id"] == content_hash({key: value for key, value in evidence[0].items() if key != "binding_id"})
        and evidence[0]["portfolio_id"] == portfolio and evidence[0]["event_ledger_revision"] == 2
        and evidence[0]["event_payload_hash"] == events[1]["payload_hash"] and evidence[0]["quality"] == "complete"
        and evidence[0]["currency"] == "CNY" and evidence[0]["source_timezone"] == "UTC" and evidence[0]["time_precision"] == "second"
        and evidence[0]["effective_at"] == events[1]["effective_at"] and evidence[0]["flow_time"] == "2026-01-02T12:00:00.000000Z"
        and evidence[0]["evaluation_date"] == "2026-01-02" and evidence[0]["mode"] == "restated" and evidence[0]["fx_rate"] == "1"
        and evidence[0]["observation"] is None and evidence[0]["publication"] is None and evidence[0]["issues"] == []
        and _amount(evidence[0]["amount_cny"]) == flow and _amount(evidence[0]["amount_native"]) == flow
        and profit == Decimal(0) and _amount(result["net_profit_cny"]) == profit
        and _amount(result["external_flow_cny"]) == flow and _amount(result["return"]["value"]) == 0)
    record("cash_contribution_neutrality", neutral)
    record("honest_estimate_quality", run["quality"] == "provisional" and run["method"] == "modified_dietz_estimate"
        and result["return"]["method"] == "linked_return_estimate" and result["return"]["status"] == "ok" and result["issues"] == []
        and isinstance(result["assumptions"], list)
        and set(result["assumptions"]) == {"interval_flow_valuation_unavailable_modified_dietz", "drawdown_measured_at_supplied_snapshots_only"})
    issues = ["ASSERTION_FAILED:" + row["id"] for row in assertions if row["status"] != "pass"]
    return {"schema_version": "verification-check-result-v2", "check_id": CHECK_ID,
            "status": "fail" if issues else "pass", "issues": issues, "assertions": assertions,
            "gate_eligible": False, "completed_requirements": []}


def check_bytes(body, expected_sha256=None):
    if not isinstance(body, bytes) or not 0 < len(body) <= MAX_ARTIFACT_BYTES:
        raise ValueError("VERIFICATION_ARTIFACT_BYTES_INVALID")
    if expected_sha256 is not None and sha256(body).hexdigest() != expected_sha256:
        raise ValueError("VERIFICATION_ARTIFACT_HASH_MISMATCH")
    return check_artifact(strict_json(body))
