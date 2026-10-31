"""Invented EODHD producer states for independent Web metadata checks."""

import argparse
from hashlib import sha256
import json
import os

from worker.investor import eodhd_sources as source
from worker.market.providers.eodhd_actions import action_url, parse_eodhd_actions
from worker.market.providers.eodhd_transport import VERSION
from worker.orchestration.db import WorkbenchError, open_database
from worker.orchestration.jobs import claim_job, fail_job, run_one

REGISTER = "2026-01-02T12:00:01.000Z"
AT = "2026-01-03T07:00:00.000Z"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--mode", required=True, choices=("future", "disabled", "waiting", "queued", "running", "expired_job", "unknown", "captured", "partial", "failed", "retention", "history"))
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--actor", default="synthetic-investor")
    args = parser.parse_args()
    assert args.actor in ("synthetic-investor", "other-investor"), "SYNTHETIC_ACTOR_REQUIRED"
    db = open_database(args.db)
    owner = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (args.workspace,)).fetchone()
    assert owner and owner[0] == args.actor
    assert db.execute("SELECT count(*) FROM portfolios").fetchone()[0] == 0
    assert "EODHD_API_TOKEN" not in os.environ
    os.environ["WORKBENCH_EODHD_ENABLED"] = "1"
    policy = {"schema_version": "investor-eodhd-policy-v1", "provider": "eodhd_action_drafts", "symbols": ["VT.US", "BND.US"],
        "kinds": ["div", "splits"], "uses": ["private_research", "private_retention", "private_display", "private_backup"],
        "valid_from": "2026-01-03T05:00:00.000Z", "valid_until": "2038-01-03T05:00:00.000Z" if args.mode == "retention" else "2027-01-03T05:00:00.000Z",
        "retention_years": 10, "timezone": "America/New_York", "run_after_hour": 1, "lookback_days": 365, "max_requests_per_day": 4,
        "automatic_retry": False, "clause_references": ["FICTIONAL test-only consent, no provider certification"],
        "authorization_basis": "owner_declared_private_use_not_provider_certified", "raw_ai_sharing": False,
        "quote_replacement": False, "trading_permission": False}
    authority = source.register_authority(db, args.workspace, args.actor, policy, now=REGISTER)
    if args.mode != "disabled":
        source.set_authority_enabled(db, args.workspace, args.actor, authority["id"], True, now=REGISTER)
    calls = []

    def collector(**options):
        request = {key: options[key] for key in ("kind", "symbol", "start_date", "end_date")}
        calls.append(request)
        if args.mode == "failed":
            raise WorkbenchError("EODHD_CAPTURE_HTTP_UNAUTHORIZED")
        raw = b"[]"
        receipt = {"schema_version": VERSION, "url_without_credentials": action_url(**request), "request": request,
            "started_at": AT, "completed_at": AT, "retrieved_at": AT, "http_status": 200,
            "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0,
            "response_format": "utf8_json_identity", "credential_in_receipt": False}
        return {"schema_version": source.receiver.VERSION, "raw": raw, "receipt": receipt,
            "draft": parse_eodhd_actions(raw, **request, retrieved_at=AT)}

    if args.mode not in ("future", "disabled", "waiting"):
        source.discover_eodhd_requests(db, now=AT)
        if args.mode == "history":
            for _ in range(35):
                source.set_authority_enabled(db, args.workspace, args.actor, authority["id"], False, now=AT)
                source.set_authority_enabled(db, args.workspace, args.actor, authority["id"], True, now=AT)
            for index in range(12):
                source.register_authority(db, args.workspace, args.actor, {**policy,
                    "valid_from": "2026-01-01T05:00:00.000Z", "valid_until": "2026-01-02T05:00:00.000Z",
                    "clause_references": ["FICTIONAL historical rule " + str(index)]}, now=AT)
        if args.mode in ("running", "unknown", "expired_job"):
            lease = claim_job(db, "fictional-progress", job_type=source.JOB_TYPE, lease_seconds=180, now=AT)
            assert lease
            if args.mode == "unknown":
                fail_job(db, lease, {"code": "FICTIONAL_UNKNOWN_IO"}, retryable=False, now=AT)
            if args.mode == "expired_job":
                claim_job(db, "fictional-expire", job_type=source.JOB_TYPE, lease_seconds=180, now="2026-01-03T07:04:00.000Z")
        if args.mode in ("captured", "partial", "failed", "retention"):
            for _ in range(1 if args.mode == "partial" else 4):
                assert run_one(db, "fictional-progress", lambda job, lease: source.prepare_eodhd_capture(db, job, lease,
                    clock=lambda: AT, test_collector=collector), job_type=source.JOB_TYPE, lease_seconds=180, clock=lambda: AT)
    db.close()
    print(json.dumps({"real_provider_called": False, "real_gateway_called": False, "synthetic_collector_calls": len(calls)}))


if __name__ == "__main__":
    main()
