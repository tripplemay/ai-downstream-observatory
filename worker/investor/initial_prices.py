"""First monitoring prices from the selected research authority, no licence defaults."""

from datetime import timedelta
import sqlite3
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, stamp, transaction
from worker.orchestration.jobs import JobCommit, assert_lease, enqueue_job, enqueue_notification
from . import data_evidence
from .confirmed_capture import resolve_confirmed_capture
from .data_evidence import _assert, _audit, _audit_binding, _fact_validation_scope, _object, _owner, collection_binding, resolve_capture
from .model_runtime import _clock, _latest
from .monitor_admission import current_monitor_model
from .monitor_bootstrap import MAX_QUOTE_AGE_SECONDS
from .reference_plan import reference_source_current
from .source_inputs import resolve_evidence_input

JOB_TYPE = "investor_initial_prices"
ENGINE = "investor-initial-price-producer-v1"
SCHEMA = "investor-initial-prices.schema.json"
CODES = {"collected": "INITIAL_PRICE_COLLECTED", "already_available": "INITIAL_PRICE_ALREADY_AVAILABLE",
    "superseded": "INITIAL_PRICE_SUPERSEDED", "transport_failed": "INITIAL_PRICE_TRANSPORT_FAILED"}


def _context(db, workspace, model_id, at):
    model, definition, reference = current_monitor_model(db, workspace, model_id, at)
    _assert(reference_source_current(db, workspace, model["plan_id"], at, verify_result=True))
    control = _latest(db, "investor_model_controls", model_id, "version DESC")
    _assert(control and control["enabled"] == 1 and control["created_at"] <= at)
    _assert(not db.execute("SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=?", (model_id,)).fetchone())
    source = resolve_evidence_input(db, workspace, reference["reference_evidence"]["source_input_id"], now=at)
    authorities = {}
    for ref in source["document"]["snapshot"]["capture_refs"]:
        row = db.execute("SELECT * FROM investor_price_captures WHERE id=? AND workspace_id=?", (ref["capture_id"], workspace)).fetchone()
        _assert(row is not None)
        mapping = _object(row["receipt_json"])["request"]["mapping"]
        spec = {kind + "_review_id": row[kind + "_review_id"] for kind in ("rights", "listing", "calendar")}
        identity = mapping["listing_id"]
        _assert(identity not in authorities or authorities[identity] == spec)
        authorities[identity] = spec
    targets = {target["listing_id"] for target in definition["targets"]}
    _assert(targets <= set(authorities))
    return model, definition, control, source, {identity: authorities[identity] for identity in targets}


def _plan(db, workspace, context, identity, at):
    model, definition, control, source, authorities = context; spec = authorities[identity]
    from .data_evidence import resolve_review
    calendar = resolve_review(db, workspace, spec["calendar_review_id"], "calendar", now=at)
    facts = calendar["facts"]; market = facts["market"]
    local_day = instant(at).astimezone(ZoneInfo(longport._MARKETS[market][0])).date().isoformat()
    _assert(facts["range_start"] <= local_day <= facts["range_end"])
    days = [day for day in facts["days"] if day["kind"] != "closed" and instant(day["close_at"]) <= instant(at)]
    _assert(days)
    day = max(days, key=lambda row: instant(row["close_at"]))
    # The historical endpoint still rejects the local current day, even after
    # close. Waiting for local midnight is not recovering a missed callback.
    _assert(day["date"] < local_day and instant(day["available_at"]) <= instant(at), "INITIAL_PRICE_WAITING_PAST_SESSION")
    binding = collection_binding(db, workspace, *(spec[kind + "_review_id"] for kind in ("rights", "listing", "calendar")), day["date"], day["date"], at)
    asset = binding["listing"]["facts"]; target = next(row for row in definition["targets"] if row["listing_id"] == identity)
    _assert(asset["listing_id"] == identity and all(asset[key] == target[key] for key in ("market", "currency")))
    expiry = min([instant(definition["valid_until"]), instant(source["document"]["valid_until"]), instant(binding["rights"]["facts"]["valid_until"]),
        instant(day["close_at"]) + timedelta(seconds=MAX_QUOTE_AGE_SECONDS)] + [instant(binding[kind]["review"]["valid_until"]) for kind in ("rights", "listing", "calendar")])
    _assert(instant(at) < expiry)
    value = {"schema_version": "investor-initial-price-request-v1", "engine_version": ENGINE, "workspace_id": workspace,
        "model_id": model["id"], "model_hash": model["content_hash"], "control_id": control["id"],
        "reference_input_id": source["row"]["id"], "reference_input_hash": source["row"]["content_hash"],
        "listing_id": identity, "market": market, "session_date": day["date"], **spec,
        "binding_hash": content_hash(binding), "valid_until": stamp(expiry), "live_advice_eligible": False}
    validate_contract(value, SCHEMA, fragment="$defs/request")
    return value


def _available(db, workspace, spec, at):
    ids = tuple(spec[kind + "_review_id"] for kind in ("rights", "listing", "calendar")); day = spec["session_date"]
    rows = db.execute("""SELECT c.id FROM investor_price_captures c JOIN investor_price_payloads p ON p.capture_id=c.id
        WHERE c.workspace_id=? AND c.rights_review_id=? AND c.listing_review_id=? AND c.calendar_review_id=?
          AND c.qualification='isolated_official_sdk' AND c.created_at<=? AND c.retain_until>?
          AND json_extract(c.receipt_json,'$.request.start_date')<=? AND json_extract(c.receipt_json,'$.request.end_date')>=? LIMIT 129""",
        (workspace, *ids, at, at, day, day)).fetchall()
    _assert(len(rows) <= 128)
    for row in rows:
        value = resolve_capture(db, workspace, row["id"], now=at)
        if any(record["listing_id"] == spec["listing_id"] and record["observed_at"] == day for record in value["records"]): return True
    rows = db.execute("""SELECT c.id FROM investor_confirmed_captures c JOIN investor_confirmed_payloads p ON p.capture_id=c.id
        JOIN investor_confirmed_targets t ON t.capture_id=c.id AND t.workspace_id=c.workspace_id
        JOIN json_each(c.receipt_json,'$.bindings') b ON json_extract(b.value,'$.target.mapping.listing_id')=t.listing_id
        WHERE c.workspace_id=? AND t.rights_review_id=? AND t.listing_review_id=? AND t.calendar_review_id=?
          AND json_extract(b.value,'$.target.session_date')=?
          AND c.qualification='isolated_official_sdk_callback' AND c.status='complete' AND c.created_at<=? AND c.retain_until>? LIMIT 129""",
        (workspace, *ids, day, at, at)).fetchall()
    _assert(len(rows) <= 128)
    definition = _object(db.execute("SELECT document_json FROM investor_models WHERE id=?", (spec["model_id"],)).fetchone()[0])
    targets = {target["listing_id"] for target in definition["targets"]}
    for row in rows:
        value = resolve_confirmed_capture(db, workspace, row["id"], now=at)
        if {record["listing_id"] for record in value["records"]} <= targets and any(record["listing_id"] == spec["listing_id"] and record["observed_at"] == day for record in value["records"]): return True
    return False


def discover_initial_prices(db, *, limit=100, now=None, stop_requested=None):
    _assert(type(limit) is int and 1 <= limit <= 1000); at = _clock(now)
    _assert(not db.in_transaction, "INITIAL_PRICE_DISCOVERY_REQUIRES_AUTOCOMMIT")
    assert_writable(db)
    models = db.execute("""SELECT m.* FROM investor_models m JOIN investor_model_controls c ON c.model_id=m.id AND c.workspace_id=m.workspace_id
        WHERE c.version=(SELECT max(version) FROM investor_model_controls WHERE model_id=m.id) AND c.enabled=1 AND c.created_at<=?
          AND json_extract(m.document_json,'$.data_mode')='reconstructed' AND json_extract(m.document_json,'$.valid_until')>?
          AND m.profile_id=(SELECT id FROM investor_profiles WHERE workspace_id=m.workspace_id ORDER BY version DESC LIMIT 1)
          AND m.plan_id=(SELECT plan_id FROM investor_plan_selections WHERE workspace_id=m.workspace_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
          AND NOT EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=m.id) ORDER BY m.created_at,m.id LIMIT ?""", (at, at, limit)).fetchall()
    for model in models:
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        try:
            # A concurrent commit prevents this WAL read snapshot from upgrading
            # to a writer. Never publish a plan checked against an older snapshot.
            with transaction(db, immediate=False), _fact_validation_scope():
                context = _context(db, model["workspace_id"], model["id"], at)
                plans = []
                for identity in sorted(context[4]):
                    if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
                    spec = _plan(db, model["workspace_id"], context, identity, at)
                    if _available(db, model["workspace_id"], spec, at) or db.execute("SELECT 1 FROM investor_initial_price_requests WHERE model_id=? AND listing_id=? AND session_date=?",
                            (model["id"], identity, spec["session_date"])).fetchone(): continue
                    plans.append(spec)
                if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
                assert_writable(db)
                actor = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (model["workspace_id"],)).fetchone()[0]
                for spec in plans:
                    identifier, digest = new_id("initial-price-request"), content_hash(spec)
                    audit = _audit(db, actor, "investor_schedule_initial_price", "investor_initial_price_request", identifier, {"content_hash": digest}, at)
                    db.execute("INSERT INTO investor_initial_price_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (identifier, model["workspace_id"], model["id"], spec["control_id"], spec["reference_input_id"], spec["listing_id"], spec["market"], spec["session_date"],
                        spec["rights_review_id"], spec["listing_review_id"], spec["calendar_review_id"], canonical_json(spec), digest, actor, at, audit))
                if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        except sqlite3.OperationalError as error:
            if getattr(error, "sqlite_errorcode", None) not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_BUSY_SNAPSHOT): raise
            continue
        except WorkbenchError as error:
            if str(error) in ("WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW", "WORKER_STOP_REQUESTED"): raise
            enqueue_notification(db, "initial-price-gap:" + model["id"], "investor.initial_price_gap",
                {"workspace_id": model["workspace_id"], "model_id": model["id"], "code": "INITIAL_PRICE_SOURCE_GAP"}, now=at)
    rows = db.execute("""SELECT r.* FROM investor_initial_price_requests r LEFT JOIN job_runs j ON j.job_type=? AND j.scope=r.workspace_id
        AND j.period=r.id AND j.input_version=r.content_hash WHERE j.id IS NULL ORDER BY r.created_at,r.id LIMIT ?""", (JOB_TYPE, limit)).fetchall()
    return [enqueue_job(db, JOB_TYPE, row["workspace_id"], row["id"], row["content_hash"], max_attempts=1, now=at) for row in rows]


def request_header(db, workspace, identifier, at):
    try:
        row = db.execute("SELECT * FROM investor_initial_price_requests WHERE id=? AND workspace_id=?", (identifier, workspace)).fetchone()
        _assert(row is not None and row["created_at"] <= at)
        _owner(db, workspace, row["actor_id"]); _audit_binding(db, row, "investor_schedule_initial_price", "investor_initial_price_request", row["id"])
        value = _object(row["document_json"]); validate_contract(value, SCHEMA, fragment="$defs/request")
        _assert(canonical_json(value) == row["document_json"] and content_hash(value) == row["content_hash"])
        _assert(all(value[key] == row[key] for key in ("workspace_id", "model_id", "control_id", "reference_input_id", "listing_id", "market", "session_date", "rights_review_id", "listing_review_id", "calendar_review_id")))
        _assert(value["valid_until"] == stamp(instant(value["valid_until"])) and instant(row["created_at"]) < instant(value["valid_until"]))
        return row, value
    except Exception: raise WorkbenchError("INITIAL_PRICE_BINDING_INVALID") from None


def _current(db, row, value, at):
    context = _context(db, row["workspace_id"], row["model_id"], at)
    _assert(_plan(db, row["workspace_id"], context, row["listing_id"], at) == value)
    return context


def _run(db, row, job, status, at, capture=None):
    if capture is not None:
        receipt = _object(capture["receipt_json"])
        attempt = db.execute("SELECT started_at FROM job_attempts WHERE job_id=? AND attempt=? AND fencing_token=? AND status='running'",
            (job["id"], job["attempt_count"], job["fencing_token"])).fetchone()
        _assert(attempt is not None)
        _assert(max(instant(row["created_at"]), instant(attempt["started_at"])) <= instant(receipt["source"]["call_started_at"])
            <= instant(receipt["source"]["call_returned_at"]) < instant(capture["created_at"]) + timedelta(milliseconds=1)
            and instant(capture["created_at"]) <= instant(at))
    identifier = new_id("initial-price-run")
    value = {"schema_version": "investor-initial-price-run-v1", "request_id": row["id"], "request_hash": row["content_hash"], "job_id": job["id"],
        "capture_id": capture["id"] if capture else None, "receipt_hash": capture["receipt_hash"] if capture else None,
        "status": status, "reason_code": CODES[status], "created_at": at, "live_advice_eligible": False}
    validate_contract(value, SCHEMA, fragment="$defs/run"); digest = content_hash(value)
    audit = _audit(db, row["actor_id"], "investor_complete_initial_price", "investor_initial_price_run", identifier, {"content_hash": digest}, at)
    db.execute("INSERT INTO investor_initial_price_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (identifier, row["workspace_id"], row["model_id"], row["id"], job["id"],
        value["capture_id"], status, canonical_json(value), digest, row["actor_id"], at, audit))
    return JobCommit({"run_id": identifier, "code": CODES[status], "live_advice_eligible": False},
        "succeeded" if status == "collected" else "failed" if status == "transport_failed" else "skipped")


def prepare_initial_price(db, job, lease, *, clock=None, stop_requested=None):
    clock = clock or (lambda: None); at = _clock(clock()); prepared, status = None, None
    row, value = request_header(db, job["scope"], job["period"], at)
    _assert(job["id"] == lease.job_id and job["job_type"] == JOB_TYPE and job["command_request_id"] is None
        and job["max_attempts"] == 1 and job["input_version"] == row["content_hash"])
    if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
    assert_lease(db, lease, now=at)
    try:
        with transaction(db, immediate=False):
            _current(db, row, value, at)
            if _available(db, row["workspace_id"], value, at): status = "already_available"
    except WorkbenchError: status = "superseded"
    if status is None:
        try:
            _assert(instant(at) + timedelta(seconds=longport.CALL_TIMEOUT_SECONDS + 1) < instant(value["valid_until"]))
            _assert(instant(at) + timedelta(seconds=longport.CALL_TIMEOUT_SECONDS + 1) < instant(lease.lease_until))
            prepared = data_evidence.prepare_prices(db, row["workspace_id"], row["actor_id"],
                *(row[kind + "_review_id"] for kind in ("rights", "listing", "calendar")), row["session_date"], row["session_date"], prevent_retained_overlap=True)
        except Exception: status = "transport_failed"
    def commit_effect(connection):
        checked = _clock(clock())
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        assert_lease(connection, lease, now=checked)
        if status is not None: return _run(connection, row, job, status, checked)
        try: _current(connection, row, value, checked)
        except WorkbenchError: return _run(connection, row, job, "superseded", checked)
        capture = prepared(connection)
        _assert(capture["qualification"] == "isolated_official_sdk")
        return _run(connection, row, job, "collected", _clock(clock()), capture)
    def effect(connection):
        try: return commit_effect(connection)
        except WorkbenchError as error:
            if str(error) in ("WORKER_STOP_REQUESTED", "STALE_OR_EXPIRED_LEASE"): raise
            raise WorkbenchError("INITIAL_PRICE_COMMIT_FAILED") from None
        except Exception: raise WorkbenchError("INITIAL_PRICE_COMMIT_FAILED") from None
    return {"effect": effect}
