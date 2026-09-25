"""Read-only, synthetic mixed-workload correctness oracle, not a performance gate."""

import argparse
from contextlib import contextmanager
from decimal import Decimal
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from worker.market.batches import OBSERVATION_COLUMNS, _normalized_observation
from worker.market.valuation import prepare_valuation
from worker.orchestration.csv_imports import committed_csv_job
from worker.orchestration.db import ROOT, canonical_json, content_hash, instant
from worker.orchestration.jobs import Lease


SCHEMA = "workbench-mixed-oracle-input-v1"
LIMIT = 16 * 1024 * 1024
KINDS = ("csv", "ledger", "approval", "valuation")


class OracleError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise OracleError(code)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(OracleError("NONFINITE_JSON")))


def exact(value, keys, code):
    require(isinstance(value, dict) and set(value) == set(keys), code)


def number(value):
    require(isinstance(value, str) and re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?", value), "INVALID_DECIMAL")
    return Decimal(value)


def rows(connection, sql, args=()):
    return [dict(row) for row in connection.execute(sql, args)]


def one(connection, sql, args, code):
    found = rows(connection, sql, args)
    require(len(found) == 1, code)
    return found[0]


@contextmanager
def readonly_database(filename):
    path = Path(filename)
    require(path.is_absolute() and path.is_file() and not path.is_symlink(), "EXPLICIT_DATABASE_REQUIRED")
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, isolation_level=None, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        require(connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal", "WAL_REQUIRED")
        manifest = strict_json((ROOT / "migrations/manifest.json").read_bytes())["migrations"]
        require(connection.execute("PRAGMA user_version").fetchone()[0] == len(manifest), "SCHEMA_VERSION_MISMATCH")
        require([tuple(row) for row in connection.execute("SELECT version,checksum FROM schema_migrations ORDER BY version")]
                == [(entry["version"], entry["sha256"]) for entry in manifest], "MIGRATION_HISTORY_MISMATCH")
        require(all(sha256((ROOT / "migrations" / entry["file"]).read_bytes()).hexdigest() == entry["sha256"] for entry in manifest), "MIGRATION_SOURCE_MISMATCH")
        connection.execute("BEGIN")
        yield connection
        require(connection.total_changes == 0, "ORACLE_MUTATED_DATABASE")
    finally:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        connection.close()


def baseline_snapshot(connection, portfolios, revisions=None):
    """Hash actual complete facts and children, or their immutable revision prefix."""
    result = {}
    for kind, portfolio in portfolios.items():
        head = one(connection, "SELECT revision FROM ledger_heads WHERE portfolio_id=?", (portfolio,), "PORTFOLIO_MISSING")["revision"]
        revision = head if revisions is None else revisions[kind]
        require(type(revision) is int and 0 <= revision <= head, "BASELINE_REVISION_INVALID")
        digest, counts = sha256(), {}
        queries = {"ledger_events": "SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=? ORDER BY ledger_revision,id"}
        for table in ("postings", "position_movements", "security_transit_movements"):
            queries[table] = f"SELECT c.* FROM {table} c JOIN ledger_events e ON e.id=c.event_id WHERE e.portfolio_id=? AND e.ledger_revision<=? ORDER BY c.id"
        for table, sql in queries.items():
            digest.update((table + "\n").encode())
            count = 0
            for row in connection.execute(sql, (portfolio, revision)):
                digest.update((canonical_json(dict(row)) + "\n").encode())
                count += 1
            counts[table] = count
        require(counts["ledger_events"] == revision, "LEDGER_REVISION_COVERAGE_INVALID")
        result[kind] = {"portfolio_id": portfolio, "revision": revision, "counts": counts, "ledger_sha256": digest.hexdigest()}
    return result


def _cash(connection, portfolio, currency):
    postings = rows(connection, "SELECT p.* FROM postings p JOIN ledger_events e ON e.id=p.event_id WHERE e.portfolio_id=?", (portfolio,))
    sums, by_event = {}, {}
    for row in postings:
        key = (row["account_id"], row["currency"], row["ledger_account"])
        sums[key] = sums.get(key, Decimal(0)) + number(row["amount"])
        balance_key = (row["event_id"], row["currency"])
        by_event[balance_key] = by_event.get(balance_key, Decimal(0)) + number(row["amount"])
    require(all(value == 0 for value in by_event.values()), "UNBALANCED_POSTINGS")
    projection = rows(connection, "SELECT p.* FROM account_projections p JOIN accounts a ON a.id=p.account_id WHERE a.portfolio_id=?", (portfolio,))
    actual = {(row["account_id"], row["currency"], row["ledger_account"]): number(row["balance"]) for row in projection}
    require({key: value for key, value in sums.items() if value} == {key: value for key, value in actual.items() if value}, "CASH_PROJECTION_MISMATCH")
    return sum((value for (account, unit, ledger), value in sums.items() if unit == currency and ledger == "cash_settled"), Decimal(0))


def _positions(connection, fixture):
    actual = rows(connection, "SELECT * FROM position_movements ORDER BY id")
    target = fixture["ids"]["valuation"]
    require(len(actual) == 1 and actual[0]["account_id"] == target["account_id"] and actual[0]["listing_id"] == target["listing_id"]
            and actual[0]["currency"] == "USD" and actual[0]["cost_known"] == 1, "POSITION_MOVEMENT_SCOPE_INVALID")
    movement = actual[0]
    require(number(movement["quantity"]) == number(fixture["expected"]["valuation_quantity"])
            and number(movement["cost_amount"]) == number(fixture["expected"]["valuation_cost_usd"]), "POSITION_MOVEMENT_VALUE_INVALID")
    projection = one(connection, "SELECT * FROM position_projections", (), "POSITION_PROJECTION_COUNT_INVALID")
    require(all(projection[key] == movement[key] for key in ("account_id", "listing_id", "currency", "cost_known"))
            and number(projection["quantity"]) == number(movement["quantity"])
            and number(projection["cost_amount"]) == number(movement["cost_amount"]), "POSITION_PROJECTION_MISMATCH")
    require(not connection.execute("SELECT 1 FROM security_transit_movements").fetchone(), "UNEXPECTED_SECURITY_TRANSIT")


def _fixture(connection, fixture):
    require(fixture.get("schema_version") == "workbench-mixed-fixture-v1" and fixture.get("synthetic_only") is True, "SYNTHETIC_FIXTURE_REQUIRED")
    ids = fixture["ids"]
    require(set(ids) == set(KINDS), "FIXTURE_SCOPE_INVALID")
    portfolios = {kind: ids[kind]["portfolio_id"] for kind in KINDS}
    require(len(set(portfolios.values())) == 4, "FIXTURE_SCOPE_INVALID")
    require(len(ids["csv"]["account_ids"]) == 7, "FIXTURE_ACCOUNT_COUNT_INVALID")
    for kind in KINDS:
        accounts = ids[kind]["account_ids"] if kind == "csv" else [ids[kind]["account_id"]]
        actual = [row["id"] for row in connection.execute("SELECT id FROM accounts WHERE portfolio_id=? ORDER BY id", (portfolios[kind],))]
        require(sorted(accounts) == actual, "FIXTURE_ACCOUNT_SCOPE_INVALID")
    require(connection.execute("SELECT COUNT(*) FROM accounts").fetchone()[0] == 10, "FIXTURE_ACCOUNT_COUNT_INVALID")
    require(connection.execute("SELECT COUNT(*) FROM portfolios").fetchone()[0] == 4, "FIXTURE_PORTFOLIO_COUNT_INVALID")
    require(fixture["prerequisites"]["fixture_only"] is True and fixture["prerequisites"]["real_gate_verified"] is False, "SYNTHETIC_PREREQUISITE_SCOPE_INVALID")
    return portfolios


def _job(connection, request_id, kind):
    request = one(connection, "SELECT * FROM command_requests WHERE id=?", (request_id,), "REQUEST_MISSING")
    require(request["command_type"] == kind, "REQUEST_TYPE_MISMATCH")
    payload = strict_json(request["payload_json"])
    require(content_hash(payload) == request["payload_hash"] and canonical_json(payload) == request["payload_json"], "REQUEST_HASH_MISMATCH")
    job = one(connection, "SELECT * FROM job_runs WHERE command_request_id=?", (request_id,), "JOB_MISSING_OR_DUPLICATE")
    require(job["status"] == "succeeded" and job["job_type"] == kind and job["scope"] == request["portfolio_id"]
            and job["input_version"] == request_id + ":" + request["payload_hash"]
            and job["lease_owner"] is None and job["lease_until"] is None, "JOB_NOT_VERIFIED_SUCCESS")
    attempt = one(connection, "SELECT * FROM job_attempts WHERE job_id=? AND attempt=?", (job["id"], job["attempt_count"]), "ATTEMPT_MISSING")
    require(attempt["status"] == "succeeded" and attempt["fencing_token"] == job["fencing_token"] and attempt["finished_at"] == job["updated_at"], "ATTEMPT_BINDING_MISMATCH")
    require(instant(request["created_at"]) <= instant(attempt["started_at"]) <= instant(attempt["finished_at"]), "JOB_TIME_INVALID")
    return request, payload, job, strict_json(job["result_json"])


def _csv(connection, fixture, spec, phase):
    exact(spec, ("preview_request_id", "confirm_request_id", "rows", "csv_sha256", "mapping_sha256"), "CSV_INPUT_INVALID")
    require(type(spec["rows"]) is int and 1 <= spec["rows"] <= 10000, "CSV_ROWS_INVALID")
    require(all(isinstance(spec[key], str) and re.fullmatch(r"[a-f0-9]{64}", spec[key]) for key in ("csv_sha256", "mapping_sha256")), "CSV_INPUT_HASH_INVALID")
    checked, batch_id = {}, None
    operations = [("preview", spec["preview_request_id"])]
    if phase == "complete":
        operations.append(("confirm", spec["confirm_request_id"]))
    else:
        require(spec["confirm_request_id"] is None, "PREVIEW_ALREADY_CONFIRMING")
    for operation, request_id in operations:
        request, _, job, _ = _job(connection, request_id, "csv_import_" + operation + "_v1")
        stored = one(connection, "SELECT * FROM csv_background_requests WHERE id=?", (request_id,), "CSV_REQUEST_MISSING")
        require(request["portfolio_id"] == fixture["ids"]["csv"]["portfolio_id"] and stored["account_id"] in fixture["ids"]["csv"]["account_ids"], "CSV_SCOPE_MISMATCH")
        if operation == "preview":
            require(sha256(stored["csv_bytes"]).hexdigest() == spec["csv_sha256"]
                    and sha256(strict_json(stored["input_json"])["mapping"].encode()).hexdigest() == spec["mapping_sha256"], "CSV_ORIGINAL_INPUT_MISMATCH")
        # Terminal rows erase lease_until; this historical read authenticates the retained deadline, not a lost lease timestamp.
        lease = Lease(job["id"], "readonly-oracle", job["fencing_token"], job["attempt_count"], stored["expires_at"])
        require(committed_csv_job(connection, lease) is not None, "CSV_RECEIPT_INVALID")
        record = one(connection, "SELECT * FROM csv_background_results WHERE request_id=?", (request_id,), "CSV_RESULT_MISSING")
        result = strict_json(record["result_json"])
        require(result["row_count"] == spec["rows"] and result["error_count"] == 0, "CSV_RESULT_COUNTS_INVALID")
        batch_id = batch_id or result["batch_id"]
        require(batch_id == result["batch_id"], "CSV_BATCH_MISMATCH")
        checked[operation] = {"request_id": request_id, "job_id": job["id"], "result_hash": record["result_hash"]}
    outcomes = rows(connection, "SELECT * FROM csv_import_outcomes WHERE batch_id=? ORDER BY row_number", (batch_id,))
    facts = rows(connection, "SELECT id FROM ledger_events WHERE import_batch_id=?", (batch_id,))
    if phase == "preview":
        require(not outcomes and not facts, "PREVIEW_WROTE_FINANCIAL_FACTS")
        require(not connection.execute("SELECT 1 FROM csv_background_requests WHERE batch_id=? AND operation='confirm'", (batch_id,)).fetchone(), "PREVIEW_ALREADY_CONFIRMING")
    else:
        require(len(outcomes) == spec["rows"] and [row["row_number"] for row in outcomes] == list(range(1, spec["rows"] + 1)), "CSV_OUTCOME_COVERAGE_INVALID")
        require(len(facts) == spec["rows"] and len({row["event_id"] for row in outcomes}) == spec["rows"] and all(row["duplicate"] == 0 for row in outcomes), "CSV_NEW_FACT_COUNT_INVALID")
        for row in connection.execute("SELECT normalized_json FROM import_rows WHERE batch_id=? ORDER BY row_number", (batch_id,)):
            fact = strict_json(row[0])["fact"]
            require(fact["type"] == "deposit" and fact["currency"] == "CNY", "CSV_SYNTHETIC_FACT_SHAPE_INVALID")
    return {"batch_id": batch_id, "row_count": spec["rows"], "actual_facts": len(facts), "actual_receipts": len(outcomes), "operations": checked}


def _records(connection, fixture, records):
    ids, keys, occurrences = set(), set(), set()
    target = fixture["ids"]["ledger"]
    for entry in records:
        exact(entry, ("command", "receipt"), "RECORD_INPUT_INVALID")
        command, receipt = entry["command"], entry["receipt"]
        require(command["portfolio_id"] == target["portfolio_id"] and command["fact"] == {"type": "deposit", "account_id": target["account_id"], "currency": "CNY", "amount": "1"}, "SMALL_FACT_SCOPE_INVALID")
        require(command["source_id"] == "synthetic-mixed-small" and command["idempotency_key"].startswith("mixed-small:") and command["source_event_id"] == command["idempotency_key"], "SMALL_FACT_IDENTITY_INVALID")
        semantic = {key: value for key, value in command.items() if key not in ("expected_revision", "idempotency_key")}
        digest = content_hash(semantic)
        event = one(connection, "SELECT * FROM ledger_events WHERE portfolio_id=? AND idempotency_key=?", (target["portfolio_id"], command["idempotency_key"]), "RECORD_IDEMPOTENCY_NOT_UNIQUE")
        source = one(connection, "SELECT id FROM ledger_events WHERE account_id=? AND source_id=? AND source_event_id=? AND event_type='deposit'", (target["account_id"], command["source_id"], command["source_event_id"]), "RECORD_SOURCE_NOT_UNIQUE")
        require(source["id"] == event["id"] == receipt["event_id"] and event["payload_hash"] == digest
                and strict_json(event["payload_json"]) == command and event["ledger_revision"] == receipt["revision"], "RECORD_RECEIPT_MISMATCH")
        dedup = one(connection, "SELECT * FROM command_dedup WHERE scope=? AND idempotency_key=?", ("ledger:" + target["portfolio_id"], command["idempotency_key"]), "RECORD_DEDUP_MISSING")
        require(dedup["payload_hash"] == digest and strict_json(dedup["result_json"]) == {key: value for key, value in receipt.items() if key != "duplicate"}, "RECORD_DEDUP_MISMATCH")
        audit = one(connection, "SELECT * FROM audit_events WHERE id=?", (receipt["audit_id"],), "RECORD_AUDIT_MISSING")
        require(audit["action"] == "record_fact" and audit["object_id"] == event["id"] and audit["portfolio_id"] == target["portfolio_id"] and strict_json(audit["payload_json"])["digest"] == digest, "RECORD_AUDIT_MISMATCH")
        postings = rows(connection, "SELECT account_id,currency,ledger_account,amount FROM postings WHERE event_id=? ORDER BY ledger_account", (event["id"],))
        require(postings == [{"account_id": target["account_id"], "currency": "CNY", "ledger_account": name, "amount": amount} for name, amount in (("cash_settled", "1"), ("external_capital", "-1"))], "RECORD_POSTINGS_MISMATCH")
        ids.add(event["id"]); keys.add(command["idempotency_key"]); occurrences.add(command["source_event_id"])
    actual = rows(connection, "SELECT id FROM ledger_events WHERE portfolio_id=? AND source_id='synthetic-mixed-small'", (target["portfolio_id"],))
    require({row["id"] for row in actual} == ids and len(ids) == len(keys) == len(occurrences), "RECORD_COVERAGE_MISMATCH")
    return len(ids)


def _audit_result(connection, action, result_id, portfolio):
    found = rows(connection, "SELECT * FROM audit_events WHERE action=? AND portfolio_id=? AND json_extract(payload_json,'$.result.id')=?", (action, portfolio, result_id))
    require(len(found) == 1, "GOVERNANCE_AUDIT_MISSING")
    body = strict_json(found[0]["payload_json"])
    exact(body, ("input", "result"), "GOVERNANCE_AUDIT_SHAPE_INVALID")
    require(found[0]["actor_id"] == "owner" and found[0]["object_type"] == "governance", "GOVERNANCE_ACTOR_INVALID")
    command = body["input"]
    require(command["portfolio_id"] == portfolio and command["idempotency_key"] == found[0]["object_id"], "GOVERNANCE_AUDIT_SCOPE_INVALID")
    semantic = {key: value for key, value in command.items() if key not in ("expected_revision", "idempotency_key")}
    dedup = one(connection, "SELECT * FROM command_dedup WHERE scope=? AND idempotency_key=?", ("governance:" + action + ":" + portfolio, command["idempotency_key"]), "GOVERNANCE_DEDUP_MISSING")
    require(dedup["payload_hash"] == content_hash(semantic) and strict_json(dedup["result_json"]) == body["result"], "GOVERNANCE_DEDUP_MISMATCH")
    return body


def _approvals(connection, fixture, approvals):
    target, seen = fixture["ids"]["approval"], set()
    for entry in approvals:
        exact(entry, ("proposal_id", "approval_id", "cancel_id"), "APPROVAL_INPUT_INVALID")
        require(entry["proposal_id"] not in seen, "APPROVAL_DUPLICATE_INPUT")
        seen.add(entry["proposal_id"])
        proposal = one(connection, "SELECT * FROM proposals WHERE id=? AND portfolio_id=?", (entry["proposal_id"], target["portfolio_id"]), "PROPOSAL_MISSING")
        _audit_result(connection, "create_proposal", proposal["id"], target["portfolio_id"])
        item = one(connection, "SELECT * FROM proposal_items WHERE proposal_id=?", (proposal["id"],), "PROPOSAL_ITEMS_INVALID")
        require(item["account_id"] == target["account_id"] and item["listing_id"] == target["listing_id"] and item["side"] == "buy"
                and item["currency"] == "CNY" and number(item["quantity"]) == 100 and number(item["limit_price"]) == 100 and number(item["estimated_fees"]) == 0, "PROPOSAL_SCOPE_INVALID")
        approval = one(connection, "SELECT * FROM approval_events WHERE id=? AND proposal_id=? AND action='approve'", (entry["approval_id"], proposal["id"]), "APPROVAL_MISSING")
        payload = strict_json(approval["payload_json"])
        risk = one(connection, "SELECT * FROM risk_runs WHERE id=? AND proposal_id=?", (payload["risk_run_id"], proposal["id"]), "APPROVAL_RISK_MISSING")
        require(risk["status"] == "pass" and risk["input_hash"] == approval["input_hash"] and payload["proposal_input_hash"] == proposal["input_hash"], "APPROVAL_RISK_MISMATCH")
        require(approval["expected_revision"] == proposal["ledger_revision"] == fixture["revisions"]["approval"], "APPROVAL_REVISION_MISMATCH")
        cancel = one(connection, "SELECT * FROM approval_events WHERE id=? AND proposal_id=? AND action='cancel_remainder'", (entry["cancel_id"], proposal["id"]), "CANCELLATION_MISSING")
        require(instant(cancel["created_at"]) >= instant(approval["created_at"]) and cancel["input_hash"] == proposal["input_hash"], "CANCELLATION_BINDING_MISMATCH")
        reservation = one(connection, "SELECT * FROM reservations WHERE approval_id=?", (approval["id"],), "RESERVATION_MISSING")
        require(all(reservation[key] == target[key] for key in ("portfolio_id", "account_id", "listing_id")) and reservation["proposal_item_id"] == item["id"]
                and reservation["status"] == "released" and number(reservation["amount"]) == number(reservation["quantity"]) == 0 and reservation["row_version"] == 1, "RESERVATION_RELEASE_MISMATCH")
        released = strict_json(cancel["payload_json"])["released"]
        require(released == [{"id": reservation["id"], "amount": "10000", "quantity": "100"}], "RESERVATION_ORIGINAL_BUDGET_MISMATCH")
        accepted = _audit_result(connection, "approve_proposal", approval["id"], target["portfolio_id"])["result"]
        require(accepted["broker_order_sent"] is False and accepted["proposal_id"] == proposal["id"] and accepted["status"] == "approved_pending_manual_execution", "APPROVAL_AUDIT_RESULT_MISMATCH")
        require(len(accepted["reservations"]) == 1 and accepted["reservations"][0]["id"] == reservation["id"] and number(accepted["reservations"][0]["amount"]) == 10000, "APPROVAL_RESERVATION_AUDIT_MISMATCH")
        cancelled = _audit_result(connection, "cancel_remainder", cancel["id"], target["portfolio_id"])["result"]
        require(cancelled["released"] == 1 and cancelled["facts_changed"] is False and cancelled["ledger_revision"] == fixture["revisions"]["approval"], "CANCEL_AUDIT_RESULT_MISMATCH")
    actual = rows(connection, "SELECT id FROM proposals WHERE portfolio_id=?", (target["portfolio_id"],))
    require({row["id"] for row in actual} == seen, "APPROVAL_COVERAGE_MISMATCH")
    require(not connection.execute("SELECT 1 FROM execution_reports WHERE portfolio_id=?", (target["portfolio_id"],)).fetchone(), "UNEXPECTED_EXECUTION_REPORT")
    return len(seen)


def _market(connection, fixture, request_ids):
    verified, scopes = [], {}
    for request_id in request_ids:
        request, payload, _, result = _job(connection, request_id, "market_ingest")
        require(payload["publish"] is True, "MARKET_NOT_PUBLISHED")
        document = payload["document"]; plan = document["batch"]
        require(plan["source_mode"] == "manual_verified" and plan["source_id"] == "synthetic-mixed-manual" and plan["scope"] in fixture["scopes"].values(), "MARKET_SYNTHETIC_SCOPE_INVALID")
        target = fixture["ids"]["approval" if plan["scope"] == fixture["scopes"]["approval"] else "valuation"]["portfolio_id"]
        require(request["portfolio_id"] == target, "MARKET_PORTFOLIO_MISMATCH")
        batch = one(connection, "SELECT * FROM market_batches WHERE id=?", (plan["id"],), "MARKET_BATCH_MISSING")
        validation = strict_json(batch["validation_json"])
        require(batch["status"] == "published" and validation["plan"] == plan and validation["issues"] == [], "MARKET_VALIDATION_MISMATCH")
        pages = rows(connection, "SELECT * FROM market_batch_pages WHERE batch_id=? ORDER BY page_number", (plan["id"],))
        require(len(pages) == plan["expected_pages"] == len(document["pages"]), "MARKET_PAGE_COUNT_MISMATCH")
        normalized = []
        for page, original in zip(pages, document["pages"]):
            observations = strict_json(page["observations_json"])
            require(page["page_number"] == original["page_number"] and observations == original["observations"] and content_hash(observations) == page["payload_hash"], "MARKET_PAGE_HASH_MISMATCH")
            normalized.extend(_normalized_observation(connection, raw, plan, page["received_at"]) for raw in observations)
        members = rows(connection, "SELECT o.* FROM market_batch_members m JOIN market_observations o ON o.id=m.observation_id WHERE m.batch_id=? ORDER BY o.id", (plan["id"],))
        require(len(members) == len(normalized) == plan["expected_rows"] == batch["row_count"], "MARKET_MEMBERSHIP_COUNT_MISMATCH")
        require([{key: item[key] for key in OBSERVATION_COLUMNS} for item in members] == sorted(normalized, key=lambda item: item["id"]), "MARKET_MEMBER_CONTENT_MISMATCH")
        manifest = {"schema_version": "market-publication-v1", "plan": plan,
                    "pages": [{key: page[key] for key in ("page_number", "payload_hash", "received_at")} for page in pages], "observation_ids": sorted(item["id"] for item in normalized)}
        digest = content_hash(manifest)
        require(validation["manifest"] == manifest and digest == batch["manifest_hash"] == result["manifest_hash"] and result["batch_id"] == plan["id"] and result["batch_status"] == "published", "MARKET_MANIFEST_MISMATCH")
        publication = one(connection, "SELECT * FROM market_publication_events WHERE batch_id=?", (plan["id"],), "MARKET_PUBLICATION_MISSING")
        require(publication["scope"] == plan["scope"] and publication["manifest_hash"] == digest and publication["revision"] == plan["expected_publication_revision"] + 1, "MARKET_PUBLICATION_MISMATCH")
        if plan["scope"] not in scopes or scopes[plan["scope"]]["revision"] < publication["revision"]:
            scopes[plan["scope"]] = publication
        verified.append({"request_id": request_id, "batch_id": plan["id"], "manifest_hash": digest, "members": len(members)})
    for scope, publication in scopes.items():
        head = one(connection, "SELECT * FROM market_publications WHERE scope=?", (scope,), "MARKET_HEAD_MISSING")
        require(all(head[key] == publication[key] for key in ("scope", "revision", "batch_id", "manifest_hash", "published_at")), "MARKET_HEAD_MISMATCH")
    return verified


def _valuations(connection, fixture, request_ids):
    verified = []
    for request_id in request_ids:
        request, payload, _, result = _job(connection, request_id, "valuation")
        run = one(connection, "SELECT * FROM valuation_runs WHERE id=?", (result["valuation_id"],), "VALUATION_MISSING")
        require(request["portfolio_id"] == run["portfolio_id"] and run["portfolio_id"] in [fixture["ids"][kind]["portfolio_id"] for kind in ("approval", "valuation")], "VALUATION_SCOPE_MISMATCH")
        manifest = strict_json(run["market_manifest"])
        require(payload["rules"] == manifest["rules"] and payload.get("mode", "as_known") == manifest["mode"], "VALUATION_REQUEST_MISMATCH")
        prepared = prepare_valuation(connection, run["portfolio_id"], payload["cutoff_at"], payload["rules"], manifest["mode"], manifest["ledger_fact_quality"]["knowledge_at"])
        require(all(getattr(prepared, key) == run[key] for key in ("ledger_revision", "market_manifest", "method_version", "cutoff_at", "quality", "nav_cny")), "VALUATION_REPLAY_MISMATCH")
        require(result["quality"] == run["quality"] == "complete" and result["nav_cny"] == run["nav_cny"], "VALUATION_NOT_COMPLETE")
        expected_nav = fixture["expected"]["approval_cash_cny" if run["portfolio_id"] == fixture["ids"]["approval"]["portfolio_id"] else "valuation_nav_cny"]
        require(number(run["nav_cny"]) == number(expected_nav), "VALUATION_NAV_MISMATCH")
        issues = strict_json(run["issues_json"])
        require(issues == {"codes": list(prepared.issues), "known_partial_cny": prepared.known_partial_cny, "complete_nav_available": True}, "VALUATION_ISSUES_MISMATCH")
        actual = [{key: value for key, value in item.items() if key not in ("id", "run_id")} for item in rows(connection, "SELECT * FROM valuation_items WHERE run_id=?", (run["id"],))]
        require(sorted(map(canonical_json, actual)) == sorted(map(canonical_json, prepared.items)), "VALUATION_ITEMS_MISMATCH")
        verified.append({"request_id": request_id, "valuation_id": run["id"], "nav_cny": run["nav_cny"], "items": len(actual), "market_manifest_sha256": content_hash(manifest)})
    return verified


def verify(connection, expected):
    exact(expected, ("schema_version", "phase", "fixture", "baseline", "csv", "records", "approvals", "market_request_ids", "valuation_request_ids"), "ORACLE_INPUT_INVALID")
    require(expected["schema_version"] == SCHEMA and expected["phase"] in ("baseline", "preview", "complete"), "ORACLE_SCHEMA_INVALID")
    fixture, phase = expected["fixture"], expected["phase"]
    portfolios = _fixture(connection, fixture)
    for field in ("records", "approvals", "market_request_ids", "valuation_request_ids"):
        require(isinstance(expected[field], list) and len(expected[field]) <= 10000, "ORACLE_ARRAY_LIMIT")
    for field in ("market_request_ids", "valuation_request_ids"):
        require(len(expected[field]) == len(set(expected[field])), "DUPLICATE_REQUEST_ID")
    current = baseline_snapshot(connection, portfolios)
    baseline = expected["baseline"]
    if phase == "baseline":
        require(baseline is None and expected["csv"] is None and not any(expected[field] for field in ("records", "approvals", "market_request_ids", "valuation_request_ids")), "BASELINE_NOT_EMPTY")
        require({kind: value["revision"] for kind, value in current.items()} == fixture["revisions"], "SEED_REVISION_MISMATCH")
        require(sum(value["counts"]["ledger_events"] for value in current.values()) == fixture["expected"]["seed_facts"], "SEED_FACT_COUNT_MISMATCH")
        for table in ("csv_background_requests", "csv_background_results", "market_publications", "valuation_runs", "proposals", "approval_events", "reservations", "execution_reports"):
            require(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, "BASELINE_HAS_WORKLOAD_EFFECTS")
        baseline = current
    else:
        require(isinstance(baseline, dict) and set(baseline) == set(KINDS), "BASELINE_MISSING")
        require({kind: baseline[kind]["revision"] for kind in KINDS} == fixture["revisions"], "BASELINE_FIXTURE_REVISION_MISMATCH")
        prefix = baseline_snapshot(connection, portfolios, {kind: baseline[kind]["revision"] for kind in KINDS})
        require(prefix == baseline, "BASELINE_FACTS_CHANGED")
        require(all(current[kind] == baseline[kind] for kind in ("approval", "valuation")), "UNRELATED_FINANCIAL_FACTS_CHANGED")
    csv = _csv(connection, fixture, expected["csv"], phase) if phase != "baseline" else None
    if phase == "preview":
        require(not any(expected[field] for field in ("records", "approvals", "market_request_ids", "valuation_request_ids")), "PREVIEW_RUNTIME_LISTS_NOT_FINAL")
        record_count, approval_count, market, valuations = None, None, [], []
    else:
        record_count = _records(connection, fixture, expected["records"])
        approval_count = _approvals(connection, fixture, expected["approvals"])
        market = _market(connection, fixture, expected["market_request_ids"])
        valuations = _valuations(connection, fixture, expected["valuation_request_ids"])
        require(current["ledger"]["revision"] == baseline["ledger"]["revision"] + record_count, "SMALL_FACT_TOTAL_MISMATCH")
    require(current["csv"]["revision"] == baseline["csv"]["revision"] + (csv["actual_facts"] if csv else 0), "CSV_FACT_TOTAL_MISMATCH")
    cash = {kind: _cash(connection, portfolios[kind], "USD" if kind == "valuation" else "CNY") for kind in KINDS}
    _positions(connection, fixture)
    for kind in ("approval", "valuation"):
        require(cash[kind] == number(fixture["expected"][kind + ("_cash_usd" if kind == "valuation" else "_cash_cny")]), "UNRELATED_CASH_CHANGED")
    if phase != "preview":
        require(cash["ledger"] == number(fixture["expected"]["ledger_cash_cny"]) + record_count, "SMALL_FACT_CASH_MISMATCH")
    csv_addition = sum((number(strict_json(row[0])["fact"]["amount"]) for row in connection.execute("SELECT normalized_json FROM import_rows WHERE batch_id=?", (csv["batch_id"],))), Decimal(0)) if csv and phase == "complete" else Decimal(0)
    require(cash["csv"] == number(fixture["expected"]["csv_cash_cny"]) + csv_addition, "CSV_CASH_MISMATCH")
    if phase == "complete":
        require(record_count > 0 and approval_count > 0 and len(market) >= 3 and len(valuations) >= 2, "MIXED_WORKLOAD_INCOMPLETE")
        require({row["scope"] for row in connection.execute("SELECT scope FROM market_publications")} == set(fixture["scopes"].values()), "MARKET_SCOPE_COVERAGE_MISMATCH")
        for kind, field in (("market_ingest", "market_request_ids"), ("valuation", "valuation_request_ids")):
            actual = {row[0] for row in connection.execute("SELECT id FROM command_requests WHERE command_type=?", (kind,))}
            require(actual == set(expected[field]), "BACKGROUND_REQUEST_COVERAGE_MISMATCH")
    dataset = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
               for table in ("accounts", "listings", "ledger_events", "market_observations")}
    require(dataset["listings"] == fixture["counts"]["listings"], "FIXTURE_LISTING_COUNT_MISMATCH")
    padding = connection.execute("SELECT COUNT(*) FROM market_observations WHERE source_id='synthetic-mixed-padding' AND provenance='reconstructed'").fetchone()[0]
    require(padding == fixture["counts"]["market_observations"] and fixture["expected"]["padding_is_valuation_evidence"] is False, "MARKET_PADDING_SCOPE_MISMATCH")
    return {"schema_version": "workbench-mixed-oracle-result-v1", "status": "passed", "phase": phase,
            "scope": "synthetic_mixed_correctness_only", "baseline": baseline, "current": current,
            "cash": {key: str(value) for key, value in cash.items()}, "csv": csv, "normal_fact_count": record_count,
            "approval_count": approval_count, "market": market, "valuations": valuations,
            "actual_dataset_counts": dataset, "reconstructed_padding_rows_not_valuation_evidence": padding,
            "runtime_request_coverage_verified": phase == "complete",
            "performance_sla_passed": False, "production_verified": False, "real_gate_verified": False,
            "broker_network_absence_verified": False, "historical_csv_lease_expiry_reconstructed": False,
            "boundaries": ["Readonly current SQLite snapshot and immutable attachments; no TypeScript verifier or network call.",
                           "CSV terminal proof uses the retained request deadline; erased original lease timestamps are not reconstructed.",
                           "No execution_reports and broker_order_sent=false in approval audit do not prove absence of all external network traffic.",
                           "Small smoke does not satisfy full-scale, resource-limited, 1000-sample mixed latency acceptance.",
                           "Legacy synthetic gate scaffolding is a fixture prerequisite, not real gate or investment acceptance."]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--expected", required=True)
    args = parser.parse_args()
    try:
        path = Path(args.expected)
        require(path.is_absolute() and path.is_file() and path.stat().st_size <= LIMIT, "EXPECTED_INPUT_PATH_INVALID")
        with path.open("rb") as stream:
            original = stream.read(LIMIT + 1)
        require(len(original) <= LIMIT, "EXPECTED_INPUT_LIMIT")
        expected = strict_json(original)
        require(Path(args.data_dir).is_absolute() and Path(args.data_dir).is_dir() and not Path(args.data_dir).is_symlink(), "DATA_DIRECTORY_INVALID")
        require(expected["fixture"]["filename"] == str(Path(args.db)) and expected["fixture"]["dataDir"] == str(Path(args.data_dir)), "FIXTURE_PATH_MISMATCH")
        os.environ["WORKBENCH_DATA_DIR"] = args.data_dir
        with readonly_database(args.db) as connection:
            result = verify(connection, expected)
        result["expected_sha256"] = sha256(original).hexdigest()
        print(canonical_json(result))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, OracleError) else "ORACLE_EVIDENCE_INVALID"
        print(canonical_json({"schema_version": "workbench-mixed-oracle-result-v1", "status": "failed", "code": code,
                              "performance_sla_passed": False, "production_verified": False}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
