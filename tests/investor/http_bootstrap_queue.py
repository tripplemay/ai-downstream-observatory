"""Bounded default-core HTTP fixture, including its known earlier ECB retry."""

import json
from pathlib import Path
import tempfile
import time
from unittest.mock import patch

from tests.market.test_collection import fake_download
from worker.market.collection import verify_provider_capture
from worker.orchestration import runtime
from worker.orchestration.db import instant, stamp


def run_bootstrap_core(db, workspace, model_id, *, clock=None):
    path = Path(db.execute("PRAGMA database_list").fetchone()[2]).resolve(strict=True)
    assert path.name == "workbench.db" and path.parent.parent == Path(tempfile.gettempdir()).resolve(), "HTTP_BOOTSTRAP_FIXTURE_PATH"
    assert path.parent.name.startswith(("etf-workbench-http-", "etf-investor-synthetic-")), "HTTP_BOOTSTRAP_FIXTURE_PATH"
    clock = clock or (lambda: instant())
    prior = db.execute("""SELECT j.* FROM job_runs j JOIN command_requests r ON r.id=j.command_request_id
      WHERE j.job_type='market_collect' AND r.idempotency_key='http-collection-transport-failure'
        AND j.status='retry_queued' LIMIT 2""").fetchall()
    assert len(prior) <= 1, "AMBIGUOUS_HTTP_FIXTURE_RETRY"
    legacy = dict(prior[0]) if prior else None
    attempts = []
    if legacy:
        assert legacy["attempt_count"] == 1 and legacy["max_attempts"] == 3, "CHANGED_HTTP_FIXTURE_RETRY"
        attempts = [list(row) for row in db.execute("SELECT rowid,* FROM job_attempts WHERE job_id=? ORDER BY attempt", (legacy["id"],))]
        assert len(attempts) == 1, "HTTP_FIXTURE_ATTEMPT_COUNT"
        wait = max(0, (instant(legacy["not_before"]) - instant(clock())).total_seconds())
        assert wait <= 30, "HTTP_FIXTURE_RETRY_WAIT_LIMIT"
        if wait: time.sleep(wait)
        assert instant(legacy["not_before"]) <= instant(clock()), "HTTP_FIXTURE_RETRY_NOT_READY"
    types = (*runtime.role_commands("core"), "investor_research", "investor_funded_study", "investor_monitor", "investor_evidence_monitor", "investor_action_review")
    ready = db.execute("SELECT * FROM job_runs WHERE status IN ('queued','retry_queued') AND not_before<=? AND attempt_count<max_attempts",
        (stamp(clock()),)).fetchall()
    for row in ready:
        if row["job_type"] not in types: continue
        assert legacy is not None and row["id"] == legacy["id"], "UNEXPECTED_HTTP_CORE_READY_" + row["job_type"].upper()
    original = runtime.command_handler
    selected, legacy_active = [], []
    def handler(*args, **kwargs):
        real = original(*args, **kwargs)
        def guarded(job, lease):
            if job["job_type"] == "market_collect":
                assert legacy is not None and job["id"] == legacy["id"] and not legacy_active, "UNEXPECTED_HTTP_CORE_SELECTED_MARKET_COLLECT"
                legacy_active.append(job["id"])
            else:
                request = db.execute("SELECT model_id FROM investor_evidence_monitor_requests WHERE id=? AND workspace_id=?",
                    (job["period"], workspace)).fetchone()
                assert job["job_type"] == "investor_evidence_monitor" and request and request[0] == model_id, "UNEXPECTED_HTTP_CORE_SELECTED_" + job["job_type"].upper()
            selected.append(job["job_type"])
            return real(job, lease)
        return guarded
    def download(feed):
        assert legacy is not None and legacy_active == [legacy["id"]], "UNEXPECTED_HTTP_PROVIDER_CALL"
        value = fake_download()(feed)
        # Only the invented transport receipt clock is frozen, not the worker.
        value.update(started_at=stamp(clock()), completed_at=stamp(clock()))
        value["retrieved_at"] = value["completed_at"]
        return value
    monitor = None
    with patch.object(runtime, "command_handler", side_effect=handler), \
            patch("worker.market.collection.download_ecb_xml", side_effect=download) as transport:
        for unused in range(2 if legacy else 1):
            result = runtime.run_pending_once(db, "http-fictional-bootstrap-core", clock=clock)
            assert result is not None and result["status"] == "succeeded", "HTTP_BOOTSTRAP_JOB_NOT_COMPLETED"
            if result["job_type"] == "investor_evidence_monitor": monitor = result
    assert monitor is not None, "HTTP_BOOTSTRAP_MONITOR_NOT_COMPLETED"
    assert transport.call_count == (1 if legacy else 0), "HTTP_FIXTURE_TRANSPORT_COUNT"
    if legacy:
        current = db.execute("SELECT * FROM job_runs WHERE id=?", (legacy["id"],)).fetchone()
        assert current["status"] == "succeeded" and current["attempt_count"] == 2 and current["max_attempts"] == 3, "HTTP_FIXTURE_RETRY_OUTCOME"
        assert [list(row) for row in db.execute("SELECT rowid,* FROM job_attempts WHERE job_id=? AND attempt=1", (legacy["id"],))] == attempts, "HTTP_FIXTURE_ORIGINAL_ATTEMPT_CHANGED"
        verify_provider_capture(db, json.loads(current["result_json"])["batch_id"])
    return {"job": monitor, "selected_types": selected, "fixture_legacy_downloads": transport.call_count, "real_provider_calls": 0}
