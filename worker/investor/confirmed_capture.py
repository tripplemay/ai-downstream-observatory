"""Owner-reviewed callback receipts, not a licence or automatic monitor feed."""

from datetime import timedelta
from hashlib import sha256
import secrets

from worker.market.contracts import validate_contract
from worker.market.providers import longport, longport_confirmed as receiver
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, stamp, transaction
from .data_evidence import USES, _assert, _audit, _audit_binding, _object, _owner, resolve_review, validate_facts
from .runtime import _milliseconds


OFFICIAL = "isolated_official_sdk_callback"
SYNTHETIC = "injected_test_receiver"
MAX_PAYLOAD_BYTES = 3145728
MAX_RECEIPT_BYTES = 131072
_KINDS = ("rights", "listing", "calendar")


def _inputs(values):
    _assert(type(values) is list and 1 <= len(values) <= receiver.MAX_TARGETS)
    result = []
    for value in values:
        _assert(type(value) is dict and set(value) == {"rights_review_id", "listing_review_id", "calendar_review_id", "session_date"})
        _assert(all(type(value[kind + "_review_id"]) is str and longport._ID.fullmatch(value[kind + "_review_id"]) for kind in _KINDS))
        result.append({**value, "session_date": longport._day(value["session_date"]).isoformat()})
    return result


def _ref(value):
    return {"review_id": value["review"]["id"], "review_hash": value["review"]["content_hash"],
        "source_id": value["source"]["id"], "source_hash": value["source"]["content_hash"]}


def _bindings(db, workspace, inputs, checked, *, watch_seconds=None):
    bindings, reviews = [], []
    for spec in inputs:
        loaded = {kind: resolve_review(db, workspace, spec[kind + "_review_id"], kind, now=checked) for kind in _KINDS}
        grant, asset, calendar = (loaded[kind]["facts"] for kind in _KINDS)
        _assert(USES <= set(grant["uses"]) and asset["market"] in grant["markets"]
            and instant(grant["valid_from"]) <= instant(checked) < instant(grant["valid_until"]), "INVESTOR_DATA_USE_NOT_GRANTED")
        day = spec["session_date"]
        _assert(asset["market"] == calendar["market"] and calendar["range_start"] <= day <= calendar["range_end"])
        session = next(row for row in calendar["days"] if row["date"] == day)
        _assert(session["kind"] != "closed", "INVESTOR_DATA_CONFIRMED_SESSION_CLOSED")
        close = instant(session["close_at"])
        _assert(instant(asset["tradable_from"]) <= close and (asset["tradable_until"] is None or close < instant(asset["tradable_until"])))
        if watch_seconds is not None:
            _assert(instant(session["available_at"]) <= instant(checked) + timedelta(seconds=watch_seconds + receiver.STARTUP_SECONDS),
                "INVESTOR_DATA_CONFIRMED_WINDOW_TOO_EARLY")
        target = receiver._target({"mapping": {key: asset[key] for key in ("listing_id", "provider_symbol", "market", "currency")},
            "session_date": day, "close_at": session["close_at"], "available_at": session["available_at"],
            "calendar_hash": loaded["calendar"]["review"]["content_hash"]})
        bindings.append({"target": target, "reviews": {kind: _ref(loaded[kind]) for kind in _KINDS}})
        reviews.append(loaded)
    bindings.sort(key=lambda row: row["target"]["mapping"]["listing_id"])
    receiver.make_watch_request([row["target"] for row in bindings], "0" * 32, watch_seconds=watch_seconds or 1)
    return bindings, reviews


def _expiry(reviews, created):
    return _milliseconds(min(min(instant(value["rights"]["facts"]["valid_until"]), instant(value["rights"]["review"]["valid_until"]),
        instant(created) + timedelta(days=value["rights"]["facts"]["retention_days"])) for value in reviews))


def _payload(raw, request, started, returned, qualification):
    replay = receiver.parse_confirmed_watch(raw, request, started, returned)
    document = {"schema_version": "investor-confirmed-protocol-envelope-v1", "qualification": qualification,
        "call_started_at": started, "call_returned_at": returned,
        "frames": [longport._strict_json(line.decode()) for line in raw[:-1].split(b"\n")]}
    encoded = canonical_json(document).encode()
    _assert(0 < len(encoded) <= MAX_PAYLOAD_BYTES)
    return encoded, replay


def prepare_confirmed_prices(db, workspace_id, actor_id, targets, *, watch_seconds=900,
        credentials_file=None, stop_requested=None, now=None, test_receiver=None):
    """No write lock across I/O. Injected Python receivers are always synthetic."""
    _assert(test_receiver is None or callable(test_receiver))
    _assert(test_receiver is not None or now is None, "INVESTOR_DATA_PRODUCTION_CLOCK_NOT_CALLER_CONTROLLED")
    _assert(test_receiver is None or credentials_file is None, "INVESTOR_DATA_SYNTHETIC_CREDENTIALS_FORBIDDEN")
    _assert(type(watch_seconds) is int and 1 <= watch_seconds <= receiver.MAX_WATCH_SECONDS)
    inputs = _inputs(targets)
    assert_writable(db); _owner(db, workspace_id, actor_id)
    before = _milliseconds(now)
    binding, initial_reviews = _bindings(db, workspace_id, inputs, before, watch_seconds=watch_seconds)
    request = receiver.make_watch_request([row["target"] for row in binding], secrets.token_hex(16), watch_seconds=watch_seconds)
    refs = {value["reviews"][kind]["review_id"]: (kind, value["reviews"][kind]) for value in binding for kind in _KINDS}
    deadline = min([instant(value[kind]["review"]["valid_until"]) for value in initial_reviews for kind in _KINDS]
        + [instant(value["rights"]["facts"]["valid_until"]) for value in initial_reviews])

    def guard():
        if stop_requested and stop_requested():
            return True
        assert_writable(db); _owner(db, workspace_id, actor_id)
        checked = _milliseconds(now)
        _assert(instant(checked) < deadline, "INVESTOR_DATA_CHANGED_DURING_COLLECTION")
        # Immutable headers suffice for frequent cancellation polls. Full facts,
        # source/audit bytes and bindings are revalidated before committing.
        for kind, ref in refs.values():
            row = db.execute("""SELECT r.id,r.source_id,r.content_hash,r.decision,r.actor_id,r.created_at,r.valid_until,
                s.content_hash source_hash,s.kind,s.actor_id source_actor,
                (SELECT id FROM investor_data_reviews WHERE source_id=r.source_id ORDER BY version DESC LIMIT 1) latest
                FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id
                WHERE r.id=? AND r.workspace_id=? AND s.workspace_id=?""", (ref["review_id"], workspace_id, workspace_id)).fetchone()
            _assert(row is not None and row["source_id"] == ref["source_id"] and row["content_hash"] == ref["review_hash"]
                and row["source_hash"] == ref["source_hash"] and row["kind"] == kind and row["latest"] == row["id"]
                and row["decision"] == "approved" and row["actor_id"] == row["source_actor"] == actor_id
                and row["created_at"] <= checked < row["valid_until"], "INVESTOR_DATA_CHANGED_DURING_COLLECTION")
        return False

    if guard():
        raise WorkbenchError("WORKER_STOP_REQUESTED")
    result = receiver.collect_confirmed_days(request, credentials_file=credentials_file, stop_requested=guard) if test_receiver is None else test_receiver(request, guard)
    if guard():
        raise WorkbenchError("WORKER_STOP_REQUESTED")
    completed = instant(now)
    qualification = OFFICIAL if test_receiver is None else SYNTHETIC
    _assert(type(result) is dict and result.get("qualification") == OFFICIAL)
    started, returned = result["call_started_at"], result["call_returned_at"]
    _assert(type(started) is str and type(returned) is str and started == stamp(instant(started)) and returned == stamp(instant(returned)))
    _assert(instant(before) <= instant(started) <= instant(returned) <= completed)
    raw = result["protocol_bytes"]
    _assert(type(raw) is bytes and sha256(raw).hexdigest() == result["protocol_sha256"])
    payload, replay = _payload(raw, request, started, returned, qualification)
    # A closure retains the collector's frozen bytes, not an external prepared
    # JSON. Jobs may invoke it inside their lease-fenced finalization transaction.
    def persist(connection):
        _assert(connection is db, "INVESTOR_DATA_PREPARED_DATABASE_DIFFERS")
        with transaction(connection):
            if guard(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            created = _milliseconds(now)
            _assert(instant(returned) < instant(created) + timedelta(milliseconds=1))
            _owner(connection, workspace_id, actor_id)
            current, reviews = _bindings(connection, workspace_id, inputs, created)
            _assert(current == binding and all(instant(value[kind]["review"]["created_at"]) <= instant(started) for value in reviews for kind in _KINDS))
            expiry = _expiry(reviews, created); _assert(created < expiry)
            identifier, digest = new_id("investor-confirmed-capture"), sha256(payload).hexdigest()
            receipt = {"schema_version": "investor-confirmed-capture-v1", "capture_id": identifier, "workspace_id": workspace_id,
                "watch_id": request["watch_id"], "qualification": qualification, "status": replay["status"], "request": request, "bindings": binding,
                "payload_sha256": digest, "call_started_at": started, "call_returned_at": returned, "created_at": created, "retain_until": expiry,
                "publication_time_status": "not_supplied", "confirmation_semantics": "pinned_sdk_local_engine_not_exchange_signoff",
                "network_bytes_preserved": False, "stream_continuity_verified": False, "live_advice_eligible": False}
            validate_contract(receipt, "investor-confirmed-capture.schema.json")
            encoded = canonical_json(receipt); _assert(len(encoded.encode()) <= MAX_RECEIPT_BYTES)
            receipt_hash = content_hash(receipt)
            audit = _audit(connection, actor_id, "investor_store_confirmed_capture", "investor_confirmed_capture", identifier, {"content_hash": receipt_hash}, created)
            connection.execute("INSERT INTO investor_confirmed_captures VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (identifier, workspace_id, request["watch_id"], actor_id, audit, qualification, replay["status"], digest, encoded, receipt_hash, created, expiry))
            for row in binding:
                connection.execute("INSERT INTO investor_confirmed_targets VALUES(?,?,?,?,?,?)", (identifier, workspace_id, row["target"]["mapping"]["listing_id"],
                    *(row["reviews"][kind]["review_id"] for kind in _KINDS)))
            connection.execute("INSERT INTO investor_confirmed_payloads VALUES(?,?)", (identifier, payload))
            if guard(): raise WorkbenchError("WORKER_STOP_REQUESTED")
            return dict(connection.execute("SELECT * FROM investor_confirmed_captures WHERE id=?", (identifier,)).fetchone())
    return persist


def collect_confirmed_prices(db, workspace_id, actor_id, targets, *, watch_seconds=900,
        credentials_file=None, stop_requested=None, now=None, test_receiver=None):
    return prepare_confirmed_prices(db, workspace_id, actor_id, targets, watch_seconds=watch_seconds,
        credentials_file=credentials_file, stop_requested=stop_requested, now=now, test_receiver=test_receiver)(db)


def _header(db, workspace_id, capture_id, checked):
    row = db.execute("SELECT * FROM investor_confirmed_captures WHERE id=? AND workspace_id=?", (capture_id, workspace_id)).fetchone()
    _assert(row is not None and row["created_at"] <= checked, "INVESTOR_DATA_OUT_OF_SCOPE")
    _owner(db, workspace_id, row["actor_id"])
    receipt = _object(row["receipt_json"])
    validate_contract(receipt, "investor-confirmed-capture.schema.json")
    _assert(canonical_json(receipt) == row["receipt_json"] and content_hash(receipt) == row["receipt_hash"])
    _assert(_milliseconds(row["created_at"]) == row["created_at"] and _milliseconds(row["retain_until"]) == row["retain_until"])
    _assert(all(receipt[key] == row[column] for key, column in (("capture_id", "id"), ("workspace_id", "workspace_id"), ("watch_id", "watch_id"),
        ("qualification", "qualification"), ("status", "status"), ("payload_sha256", "payload_sha256"), ("created_at", "created_at"), ("retain_until", "retain_until"))))
    event = db.execute("SELECT * FROM audit_events WHERE id=?", (row["audit_id"],)).fetchone()
    _assert(event is not None and event["actor_id"] == row["actor_id"] and event["created_at"] == row["created_at"]
        and event["action"] == "investor_store_confirmed_capture" and event["object_type"] == "investor_confirmed_capture" and event["object_id"] == capture_id
        and _object(event["payload_json"]) == {"content_hash": row["receipt_hash"]})
    request = receiver._request(receipt["request"])
    _assert(request["watch_id"] == row["watch_id"] and request["targets"] == [value["target"] for value in receipt["bindings"]])
    stored = db.execute("SELECT * FROM investor_confirmed_targets WHERE capture_id=? ORDER BY listing_id", (capture_id,)).fetchall()
    expected = [{"capture_id": capture_id, "workspace_id": workspace_id, "listing_id": value["target"]["mapping"]["listing_id"],
        **{kind + "_review_id": value["reviews"][kind]["review_id"] for kind in _KINDS}} for value in receipt["bindings"]]
    _assert([dict(value) for value in stored] == expected)
    started, returned = receipt["call_started_at"], receipt["call_returned_at"]
    _assert(started == stamp(instant(started)) and returned == stamp(instant(returned))
        and instant(started) <= instant(returned) < instant(row["created_at"]) + timedelta(milliseconds=1))
    return dict(row), receipt


def resolve_confirmed_capture(db, workspace_id, capture_id, *, now=None, allow_synthetic=False):
    checked = _milliseconds(now)
    row, receipt = _header(db, workspace_id, capture_id, checked)
    _assert(checked < row["retain_until"], "INVESTOR_DATA_RETENTION_EXPIRED")
    _assert(type(allow_synthetic) is bool and (row["qualification"] == OFFICIAL or allow_synthetic), "INVESTOR_DATA_SYNTHETIC_CAPTURE_FORBIDDEN")
    _assert(db.execute("SELECT 1 FROM investor_confirmed_purges WHERE capture_id=?", (capture_id,)).fetchone() is None,
        "INVESTOR_DATA_PAYLOAD_PURGED")
    specs = [{**{kind + "_review_id": value["reviews"][kind]["review_id"] for kind in _KINDS},
        "session_date": value["target"]["session_date"]} for value in receipt["bindings"]]
    binding, reviews = _bindings(db, workspace_id, specs, checked)
    _assert(binding == receipt["bindings"] and row["retain_until"] == _expiry(reviews, row["created_at"])
        and all(instant(value[kind]["review"]["created_at"]) <= instant(receipt["call_started_at"]) for value in reviews for kind in _KINDS))
    raw = db.execute("SELECT projection FROM investor_confirmed_payloads WHERE capture_id=?", (capture_id,)).fetchone()
    _assert(raw is not None, "INVESTOR_DATA_PAYLOAD_PURGED")
    encoded = bytes(raw[0]); _assert(0 < len(encoded) <= MAX_PAYLOAD_BYTES and sha256(encoded).hexdigest() == row["payload_sha256"])
    document = _object(encoded)
    _assert(set(document) == {"schema_version", "qualification", "call_started_at", "call_returned_at", "frames"}
        and document["schema_version"] == "investor-confirmed-protocol-envelope-v1" and document["qualification"] == row["qualification"]
        and canonical_json(document).encode() == encoded and type(document["frames"]) is list and 2 <= len(document["frames"]) <= receiver.MAX_TARGETS + 2
        and all(document[key] == receipt[key] for key in ("call_started_at", "call_returned_at")))
    protocol = b"".join(canonical_json(value).encode() + b"\n" for value in document["frames"])
    _, replay = _payload(protocol, receipt["request"], receipt["call_started_at"], receipt["call_returned_at"], row["qualification"])
    _assert(replay["status"] == row["status"])
    return {"capture": row, "receipt": receipt, "records": [bar["record"] for bar in replay["bars"]], "bindings": reviews}


def _rights_no_longer_active(db, workspace, ref, market, checked):
    source = db.execute("SELECT * FROM investor_data_sources WHERE id=? AND workspace_id=?", (ref["source_id"], workspace)).fetchone()
    _assert(source is not None and source["kind"] == "rights" and source["content_hash"] == ref["source_hash"]
        and content_hash(_object(source["document_json"])) == source["content_hash"])
    _owner(db, workspace, source["actor_id"])
    _audit_binding(db, source, "investor_store_data_source", "investor_data_source", source["id"])
    bound = db.execute("SELECT * FROM investor_data_reviews WHERE id=? AND workspace_id=?", (ref["review_id"], workspace)).fetchone()
    latest = db.execute("SELECT * FROM investor_data_reviews WHERE source_id=? AND workspace_id=? ORDER BY version DESC LIMIT 1", (source["id"], workspace)).fetchone()
    _assert(bound is not None and latest is not None and bound["content_hash"] == ref["review_hash"])
    documents = []
    for row in (bound, latest):
        _assert(source["created_at"] <= row["created_at"] <= checked, "INVESTOR_DATA_INVALID_CLOCK")
        _owner(db, workspace, row["actor_id"])
        _audit_binding(db, row, "investor_review_data_source", "investor_data_review", row["id"])
        document = _object(row["document_json"])
        _assert(set(document) == {"schema_version", "source_id", "source_hash", "kind", "version", "decision", "facts", "reason", "valid_until", "review_basis"}
            and content_hash(document) == row["content_hash"] and document["schema_version"] == "investor-data-review-v1"
            and document["source_id"] == row["source_id"] == source["id"] and document["source_hash"] == source["content_hash"]
            and document["kind"] == "rights" and document["version"] == row["version"] and document["decision"] == row["decision"]
            and document["valid_until"] == row["valid_until"] and document["review_basis"] == "owner_reviewed_not_provider_certified")
        if document["decision"] == "approved":
            validate_facts("rights", document["facts"])
        else:
            _assert(document["decision"] in ("withdrawn", "rejected") and document["facts"] is None)
        documents.append(document)
    if bound["id"] != latest["id"] or bound["decision"] != "approved" or checked >= bound["valid_until"]:
        return True
    facts = documents[0]["facts"]
    return market not in facts["markets"] or not USES <= set(facts["uses"]) or not instant(facts["valid_from"]) <= instant(checked) < instant(facts["valid_until"])


def purge_confirmed_payload(db, workspace_id, actor_id, capture_id, *, now=None):
    checked = _milliseconds(now)
    with transaction(db):
        _owner(db, workspace_id, actor_id)
        row, receipt = _header(db, workspace_id, capture_id, checked)
        previous = db.execute("SELECT * FROM investor_confirmed_purges WHERE capture_id=?", (capture_id,)).fetchone()
        if previous:
            _assert(row["created_at"] <= previous["created_at"] <= checked, "INVESTOR_DATA_INVALID_CLOCK")
            _assert(_milliseconds(previous["created_at"]) == previous["created_at"])
            _assert(previous["actor_id"] == actor_id and previous["reason"] in ("retention_expired", "rights_no_longer_active"))
            _assert(previous["reason"] != "retention_expired" or row["retain_until"] <= previous["created_at"])
            event = db.execute("SELECT * FROM audit_events WHERE id=?", (previous["audit_id"],)).fetchone()
            _assert(event is not None and event["actor_id"] == actor_id and event["created_at"] == previous["created_at"]
                and event["action"] == "investor_purge_confirmed_payload" and event["object_type"] == "investor_confirmed_capture"
                and event["object_id"] == capture_id and _object(event["payload_json"]) == {"reason": previous["reason"]})
            _assert(db.execute("SELECT 1 FROM investor_confirmed_payloads WHERE capture_id=?", (capture_id,)).fetchone() is None)
            return dict(previous)
        reason = "retention_expired" if row["retain_until"] <= checked else None
        if reason is None:
            for value in receipt["bindings"]:
                if _rights_no_longer_active(db, workspace_id, value["reviews"]["rights"], value["target"]["mapping"]["market"], checked):
                    reason = "rights_no_longer_active"
            _assert(reason is not None, "INVESTOR_DATA_PURGE_NOT_DUE")
        audit = _audit(db, actor_id, "investor_purge_confirmed_payload", "investor_confirmed_capture", capture_id, {"reason": reason}, checked)
        db.execute("INSERT INTO investor_confirmed_purges VALUES(?,?,?,?,?)", (capture_id, reason, actor_id, checked, audit))
        db.execute("DELETE FROM investor_confirmed_payloads WHERE capture_id=?", (capture_id,))
        return dict(db.execute("SELECT * FROM investor_confirmed_purges WHERE capture_id=?", (capture_id,)).fetchone())
