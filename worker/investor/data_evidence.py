"""Private owner-reviewed evidence; no text or hash certifies provider rights."""

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import date, timedelta
from hashlib import sha256
import json
from zoneinfo import ZoneInfo

from worker.accounting.decimal_math import decimal
from worker.market.contracts import validate_contract
from worker.market.providers import longport
from worker.orchestration.db import WorkbenchError, assert_writable, canonical_json, content_hash, instant, new_id, transaction
from .precision import validate_time_precision
from .runtime import _milliseconds


KINDS = ("rights", "listing", "calendar", "actions", "fx")
USES = {"private_research", "private_retention", "private_display", "private_backup"}
MAX_REVIEW_BYTES = 8388608
_FACT_VALIDATIONS = ContextVar("investor_snapshot_fact_validations", default=None)
_MAX_FACT_VALIDATIONS = 128


@contextmanager
def _fact_validation_scope():
    """Reuse pure validation only; source/audit/currentness reads never cache."""
    token = _FACT_VALIDATIONS.set(set())
    try:
        yield
    finally:
        _FACT_VALIDATIONS.reset(token)


def _assert(value, code="INVESTOR_DATA_EVIDENCE_INVALID"):
    if not value:
        raise WorkbenchError(code)


def _object(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        _assert(type(value) is dict)
        return value
    except Exception:
        raise WorkbenchError("INVESTOR_DATA_EVIDENCE_INVALID") from None


def _owner(db, workspace_id, actor_id):
    row = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (workspace_id,)).fetchone()
    _assert(row is not None and row[0] == actor_id, "INVESTOR_DATA_OUT_OF_SCOPE")


def _audit(db, actor, action, kind, identifier, payload, now):
    identity = new_id("investor-data-audit")
    db.execute("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
               (identity, actor, action, kind, identifier, canonical_json(payload), now))
    return identity


def _audit_binding(db, row, action, kind, object_id):
    event = db.execute("SELECT * FROM audit_events WHERE id=?", (row["audit_id"],)).fetchone()
    _assert(event is not None and event["actor_id"] == row["actor_id"] and event["action"] == action
            and event["object_type"] == kind and event["object_id"] == object_id and event["created_at"] == row["created_at"])
    payload = _object(event["payload_json"])
    _assert(payload == {"content_hash": row["content_hash"]})


def store_source(db, workspace_id, actor_id, kind, document, *, now=None):
    """Explicit operator-provided excerpt, never an arbitrary URL fetch."""
    _assert(kind in KINDS and type(document) is dict and set(document) == {"title", "reference", "excerpt"})
    _assert(all(type(value) is str and value.strip() for value in document.values()))
    _assert(len(document["title"]) <= 300 and len(document["reference"]) <= 2000 and len(document["excerpt"]) <= 100000)
    encoded = canonical_json(document)
    _assert(len(encoded.encode()) <= 131072, "INVESTOR_DATA_SOURCE_LIMIT")
    digest, created = content_hash(document), _milliseconds(now)
    with transaction(db):
        _owner(db, workspace_id, actor_id)
        previous = db.execute("SELECT * FROM investor_data_sources WHERE workspace_id=? AND kind=? AND content_hash=?", (workspace_id, kind, digest)).fetchone()
        if previous:
            _assert(previous["document_json"] == encoded and previous["created_at"] <= created)
            return dict(previous)
        identifier = new_id("investor-data-source")
        audit = _audit(db, actor_id, "investor_store_data_source", "investor_data_source", identifier, {"content_hash": digest}, created)
        db.execute("INSERT INTO investor_data_sources(id,workspace_id,kind,document_json,content_hash,actor_id,created_at,audit_id) VALUES(?,?,?,?,?,?,?,?)",
                   (identifier, workspace_id, kind, encoded, digest, actor_id, created, audit))
        return dict(db.execute("SELECT * FROM investor_data_sources WHERE id=?", (identifier,)).fetchone())


def validate_facts(kind, facts):
    _assert(kind in KINDS and type(facts) is dict)
    _assert(len(canonical_json(facts).encode()) <= MAX_REVIEW_BYTES, "INVESTOR_DATA_REVIEW_LIMIT")
    validated = _FACT_VALIDATIONS.get()
    key = None
    if validated is not None:
        # Unlike canonical_json, keep JSON numeric representations distinct.
        # Store only digests, not calendar/FX documents, in this bounded scope.
        encoded = json.dumps(facts, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        key = kind, sha256(encoded.encode()).digest()
        if key in validated:
            return
    validate_time_precision(facts)
    try:
        validate_contract({"kind": kind, "facts": facts}, "investor-data-facts.schema.json")
        if kind == "rights":
            _assert(instant(facts["valid_from"]) < instant(facts["valid_until"]))
        elif kind == "listing":
            _assert(longport._SYMBOLS[facts["market"]].fullmatch(facts["provider_symbol"]) is not None
                    and facts["currency"] in longport._MARKETS[facts["market"]][1]
                    and decimal(facts["quantity_step"]) > 0 and 0 <= decimal(facts["fee_rate"]) <= 1)
            _assert(facts["tradable_until"] is None or instant(facts["tradable_from"]) < instant(facts["tradable_until"]))
        elif kind == "calendar":
            start, end = date.fromisoformat(facts["range_start"]), date.fromisoformat(facts["range_end"])
            _assert(0 <= (end - start).days < 3660)
            _assert([row["date"] for row in facts["days"]] == [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)])
            zone = ZoneInfo(longport._MARKETS[facts["market"]][0])
            for row in facts["days"]:
                values = [row[key] for key in ("close_at", "available_at", "settled_at", "settlement_rule_known_at")]
                if row["kind"] == "closed":
                    _assert(all(value is None for value in values))
                else:
                    _assert(all(value is not None for value in values))
                    close, available, settled, known = map(instant, values)
                    _assert(close.astimezone(zone).date().isoformat() == row["date"] and close <= available and close <= settled and known <= close)
        elif kind == "actions":
            _assert(facts["range_start"] <= facts["range_end"])
            _assert(all(row["listing_id"] == facts["listing_id"] for row in facts["events"]))
        else:
            times = [instant(row["observed_at"]) for row in facts["rows"]]
            _assert(times == sorted(set(times)))
            _assert(all(decimal(row["value"]) > 0 and instant(row["observed_at"]) <= instant(row["assumed_available_at"]) for row in facts["rows"]))
    except Exception:
        raise WorkbenchError("INVESTOR_DATA_FACTS_INVALID") from None
    if validated is not None and len(validated) < _MAX_FACT_VALIDATIONS:
        validated.add(key)


def review_source(db, workspace_id, actor_id, source_id, decision, facts, reason, valid_until, *, now=None, continues_calendar_review_id=None):
    _assert(decision in ("approved", "rejected", "withdrawn") and type(reason) is str and 0 < len(reason.strip()) <= 2000)
    created, expiry = _milliseconds(now), _milliseconds(valid_until)
    _assert(created < expiry)
    with transaction(db):
        _owner(db, workspace_id, actor_id)
        source = db.execute("SELECT * FROM investor_data_sources WHERE id=? AND workspace_id=?", (source_id, workspace_id)).fetchone()
        _assert(source is not None and source["created_at"] <= created, "INVESTOR_DATA_OUT_OF_SCOPE")
        _assert(content_hash(_object(source["document_json"])) == source["content_hash"])
        _audit_binding(db, source, "investor_store_data_source", "investor_data_source", source_id)
        if decision == "approved":
            validate_facts(source["kind"], facts)
            if source["kind"] == "listing":
                _assert(facts["fee_as_of"] <= created[:10], "INVESTOR_DATA_FEE_DATE_IN_FUTURE")
        else:
            _assert(facts is None)
        previous = db.execute("SELECT id,version,created_at FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (source_id,)).fetchone()
        _assert(previous is None or previous["created_at"] <= created)
        if continues_calendar_review_id is not None:
            _assert(source["kind"] == "calendar" and decision == "approved" and previous is not None
                and continues_calendar_review_id == previous["id"], "INVESTOR_CALENDAR_CONTINUATION_INVALID")
            from .calendar_continuation import check_extension, check_registration_depth
            old = resolve_review(db, workspace_id, continues_calendar_review_id, "calendar", now=created)
            check_extension(old, facts)
            check_registration_depth(db, workspace_id, continues_calendar_review_id)
        identifier, version = new_id("investor-data-review"), (previous["version"] if previous else 0) + 1
        document = {"schema_version": "investor-data-review-v1", "source_id": source_id, "source_hash": source["content_hash"],
            "kind": source["kind"], "version": version, "decision": decision, "facts": facts, "reason": reason,
            "valid_until": expiry, "review_basis": "owner_reviewed_not_provider_certified"}
        encoded, digest = canonical_json(document), content_hash(document)
        _assert(len(encoded.encode()) <= MAX_REVIEW_BYTES, "INVESTOR_DATA_REVIEW_LIMIT")
        audit = _audit(db, actor_id, "investor_review_data_source", "investor_data_review", identifier, {"content_hash": digest}, created)
        db.execute("INSERT INTO investor_data_reviews(id,workspace_id,source_id,version,decision,document_json,content_hash,actor_id,created_at,valid_until,audit_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (identifier, workspace_id, source_id, version, decision, encoded, digest, actor_id, created, expiry, audit))
        result = dict(db.execute("SELECT * FROM investor_data_reviews WHERE id=?", (identifier,)).fetchone())
        if continues_calendar_review_id is not None:
            from .calendar_continuation import register_continuation
            result["calendar_continuation_id"] = register_continuation(db, workspace_id, actor_id, continues_calendar_review_id, identifier, created)
        return result


def review_header(db, workspace_id, review_id, *, now=None):
    """Authenticate metadata, not current permission or underlying payloads."""
    checked = _milliseconds(now)
    if review_id.startswith("managed-actions-review:"):
        from .managed_actions import managed_review_header
        return managed_review_header(db, workspace_id, review_id, checked)
    review = db.execute("SELECT * FROM investor_data_reviews WHERE id=? AND workspace_id=?", (review_id, workspace_id)).fetchone()
    _assert(review is not None, "INVESTOR_DATA_OUT_OF_SCOPE")
    source = db.execute("SELECT * FROM investor_data_sources WHERE id=? AND workspace_id=?", (review["source_id"], workspace_id)).fetchone()
    _assert(source is not None and source["created_at"] <= review["created_at"] <= checked)
    _owner(db, workspace_id, source["actor_id"]); _owner(db, workspace_id, review["actor_id"])
    _assert(content_hash(_object(source["document_json"])) == source["content_hash"])
    _audit_binding(db, source, "investor_store_data_source", "investor_data_source", source["id"])
    _audit_binding(db, review, "investor_review_data_source", "investor_data_review", review["id"])
    document = _object(review["document_json"])
    _assert(set(document) == {"schema_version", "source_id", "source_hash", "kind", "version", "decision", "facts", "reason", "valid_until", "review_basis"}
        and document["schema_version"] == "investor-data-review-v1" and content_hash(document) == review["content_hash"]
        and document["source_hash"] == source["content_hash"] and document["source_id"] == source["id"] and document["kind"] == source["kind"]
        and document["version"] == review["version"] and document["decision"] == review["decision"]
        and document["valid_until"] == review["valid_until"] and document["review_basis"] == "owner_reviewed_not_provider_certified")
    return {"review": dict(review), "source": dict(source), "facts": document["facts"]}


def resolve_review(db, workspace_id, review_id, kind, *, now=None, require_current=True):
    checked = _milliseconds(now)
    if review_id.startswith("managed-actions-review:"):
        _assert(kind == "actions")
        from .managed_actions import resolve_managed_review
        return resolve_managed_review(db, workspace_id, review_id, now=checked)
    value = review_header(db, workspace_id, review_id, now=checked)
    review, source = value["review"], value["source"]
    _assert(source["kind"] == kind and checked < review["valid_until"] and review["decision"] == "approved")
    if require_current:
        latest = db.execute("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1", (source["id"],)).fetchone()
        if latest[0] != review_id:
            _assert(kind == "calendar", "INVESTOR_DATA_REVIEW_SUPERSEDED")
            from .calendar_continuation import current_calendar_review
            current_calendar_review(db, workspace_id, review_id, checked)
    validate_facts(kind, value["facts"])
    if kind == "fx":
        from .managed_fx import validate_managed_review
        validate_managed_review(db, workspace_id, review, value["facts"], checked)
    return value


def collection_binding(db, workspace, rights_id, listing_id, calendar_id, start, end, now, *, allow_continued=False):
    rights = resolve_review(db, workspace, rights_id, "rights", now=now)
    listing = resolve_review(db, workspace, listing_id, "listing", now=now)
    calendar = resolve_review(db, workspace, calendar_id, "calendar", now=now)
    _assert(type(allow_continued) is bool)
    if not allow_continued:
        from .calendar_continuation import assert_collection_calendar
        assert_collection_calendar(db, calendar)
    grant, asset, days = rights["facts"], listing["facts"], calendar["facts"]
    _assert(USES <= set(grant["uses"]) and asset["market"] in grant["markets"]
        and instant(grant["valid_from"]) <= instant(now) < instant(grant["valid_until"]), "INVESTOR_DATA_USE_NOT_GRANTED")
    _assert(asset["market"] == days["market"] and days["range_start"] <= start <= end <= days["range_end"])
    mapping = {key: asset[key] for key in ("listing_id", "provider_symbol", "market", "currency")}
    zone = ZoneInfo(longport._MARKETS[asset["market"]][0])
    selected = [row for row in days["days"] if start <= row["date"] <= end and row["kind"] != "closed"
        and instant(row["close_at"]) >= instant(asset["tradable_from"])
        and (asset["tradable_until"] is None or instant(row["close_at"]) < instant(asset["tradable_until"]))]
    _assert(end < instant(now).astimezone(zone).date().isoformat() and selected, "INVESTOR_DATA_WINDOW_NOT_COMPLETE")
    request = longport._request(mapping, start, end, [row["date"] for row in selected])
    return {"request": request, "rights": rights, "listing": listing, "calendar": calendar}


def _no_retained_overlap(db, workspace_id, rights_id, listing_id, calendar_id, start, end, checked):
    existing = db.execute("""SELECT c.id FROM investor_price_captures c
        JOIN investor_price_payloads p ON p.capture_id=c.id
        WHERE c.workspace_id=? AND c.rights_review_id=? AND c.listing_review_id=? AND c.calendar_review_id=?
          AND c.retain_until>?
          AND json_extract(c.receipt_json,'$.request.start_date')<=?
          AND json_extract(c.receipt_json,'$.request.end_date')>=? LIMIT 1""",
        (workspace_id, rights_id, listing_id, calendar_id, checked, end, start)).fetchone()
    _assert(existing is None, "INVESTOR_DATA_HISTORY_CAPTURE_WINDOWS_CONFLICT")


def prepare_prices(db, workspace_id, actor_id, rights_id, listing_id, calendar_id, start, end, *, now=None, client=None, sdk_version=None, credentials_file=None, prevent_retained_overlap=False, before_collect=None):
    """Internal same-connection commit closure, never caller-supplied prepared JSON."""
    _assert(client is not None or now is None, "INVESTOR_DATA_PRODUCTION_CLOCK_NOT_CALLER_CONTROLLED")
    _assert(type(prevent_retained_overlap) is bool)
    _assert(before_collect is None or callable(before_collect))
    assert_writable(db)
    _owner(db, workspace_id, actor_id)
    before = _milliseconds(now)
    binding = collection_binding(db, workspace_id, rights_id, listing_id, calendar_id, start, end, before)
    frozen_binding = canonical_json(binding)
    if prevent_retained_overlap:
        _no_retained_overlap(db, workspace_id, rights_id, listing_id, calendar_id, start, end, before)
    if before_collect is not None: before_collect()
    request = _object(frozen_binding)["request"]
    result = longport.collect_longport_candles(mapping=request["mapping"], start_date=start, end_date=end,
        expected_dates=request["expected_dates"], client=client, sdk_version=sdk_version, credentials_file=credentials_file)
    completed = instant(now)
    qualification = "injected_test_client" if client is not None else "isolated_official_sdk"
    payload = result["projection_bytes"]
    _assert(type(payload) is bytes and sha256(payload).hexdigest() == result["projection_sha256"] and 0 < len(payload) <= 2097152)
    projection = _object(payload); source = projection["source"]
    _assert(source == result["source"] and source["collector_runtime"] == qualification)
    started, returned = instant(source["call_started_at"]), instant(source["call_returned_at"])
    _assert(instant(before) <= started <= returned <= completed)
    request = _object(frozen_binding)["request"]
    if qualification == "isolated_official_sdk":
        longport._parse_child_projection(payload, request, instant(before), completed)
    else:
        candles = [{**candle, "volume": int(candle["volume"]), "timestamp": instant(candle["timestamp"])} for candle in projection["candlesticks"]]
        replay = longport._normalize(candles, request=request, sdk_version=source["sdk_version"], call_started_at=source["call_started_at"], call_returned_at=source["call_returned_at"],
            datetime_basis=source["sdk_datetime_basis"], collector_runtime=qualification)
        _assert(replay["projection_bytes"] == payload)
    payload_hash = sha256(payload).hexdigest()
    frozen_source = canonical_json(source)

    def persist(connection):
        _assert(connection is db, "INVESTOR_DATA_PREPARED_CONNECTION_CHANGED")
        created = _milliseconds(now)
        with transaction(connection):
            _owner(connection, workspace_id, actor_id)
            current = collection_binding(connection, workspace_id, rights_id, listing_id, calendar_id, start, end, created)
            _assert(canonical_json(current) == frozen_binding, "INVESTOR_DATA_CHANGED_DURING_COLLECTION")
            if prevent_retained_overlap:
                _no_retained_overlap(connection, workspace_id, rights_id, listing_id, calendar_id, start, end, created)
            _assert(returned < instant(created) + timedelta(milliseconds=1))
            return _persist_prices(connection, workspace_id, rights_id, listing_id, calendar_id, current, _object(frozen_binding)["request"],
                payload, payload_hash, _object(frozen_source), qualification, created)
    return persist


def _persist_prices(db, workspace_id, rights_id, listing_id, calendar_id, binding, request, payload, payload_hash, source, qualification, created):
    current = binding
    with transaction(db):
        retain = min(instant(current["rights"]["facts"]["valid_until"]), instant(current["rights"]["review"]["valid_until"]),
            instant(created) + timedelta(days=current["rights"]["facts"]["retention_days"]))
        _assert(retain > instant(created))
        expiry = retain.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        identifier = new_id("investor-price-capture")
        receipt = {"schema_version": "investor-price-capture-v1", "capture_id": identifier, "workspace_id": workspace_id,
            "rights_review_id": rights_id, "listing_review_id": listing_id, "calendar_review_id": calendar_id,
            "review_hashes": {kind: binding[kind]["review"]["content_hash"] for kind in ("rights", "listing", "calendar")},
            "request": request, "projection_sha256": payload_hash, "qualification": qualification,
            "source": source, "created_at": created, "retain_until": expiry,
            "publication_time_status": "not_supplied", "historical_archive_verified": False}
        db.execute("INSERT INTO investor_price_captures(id,workspace_id,rights_review_id,listing_review_id,calendar_review_id,qualification,projection_sha256,receipt_json,receipt_hash,created_at,retain_until) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (identifier, workspace_id, rights_id, listing_id, calendar_id, qualification, payload_hash, canonical_json(receipt), content_hash(receipt), created, expiry))
        db.execute("INSERT INTO investor_price_payloads(capture_id,projection) VALUES(?,?)", (identifier, payload))
        return dict(db.execute("SELECT * FROM investor_price_captures WHERE id=?", (identifier,)).fetchone())


def collect_prices(db, workspace_id, actor_id, rights_id, listing_id, calendar_id, start, end, **kwargs):
    """Preserved direct collector; fixed SDK only, injected clients stay synthetic."""
    return prepare_prices(db, workspace_id, actor_id, rights_id, listing_id, calendar_id, start, end, **kwargs)(db)


def resolve_capture(db, workspace_id, capture_id, *, now=None, allow_synthetic=False):
    checked = _milliseconds(now)
    row = db.execute("SELECT * FROM investor_price_captures WHERE id=? AND workspace_id=?", (capture_id, workspace_id)).fetchone()
    _assert(row is not None, "INVESTOR_DATA_OUT_OF_SCOPE")
    _assert(_milliseconds(row["created_at"]) == row["created_at"] and _milliseconds(row["retain_until"]) == row["retain_until"])
    _assert(row["created_at"] <= checked < row["retain_until"], "INVESTOR_DATA_RETENTION_EXPIRED")
    _assert(type(allow_synthetic) is bool and (row["qualification"] == "isolated_official_sdk" or allow_synthetic), "INVESTOR_DATA_SYNTHETIC_CAPTURE_FORBIDDEN")
    receipt = _object(row["receipt_json"])
    _assert(content_hash(receipt) == row["receipt_hash"] and set(receipt) == {"schema_version", "capture_id", "workspace_id", "rights_review_id", "listing_review_id", "calendar_review_id", "review_hashes", "request", "projection_sha256", "qualification", "source", "created_at", "retain_until", "publication_time_status", "historical_archive_verified"})
    _assert(receipt["schema_version"] == "investor-price-capture-v1" and receipt["capture_id"] == capture_id and receipt["workspace_id"] == workspace_id
        and receipt["projection_sha256"] == row["projection_sha256"] and receipt["qualification"] == row["qualification"]
        and receipt["created_at"] == row["created_at"] and receipt["retain_until"] == row["retain_until"]
        and receipt["publication_time_status"] == "not_supplied" and receipt["historical_archive_verified"] is False)
    for key in ("rights_review_id", "listing_review_id", "calendar_review_id"):
        _assert(receipt[key] == row[key])
    _assert(instant(receipt["source"]["call_started_at"]) <= instant(receipt["source"]["call_returned_at"])
        < instant(row["created_at"]) + timedelta(milliseconds=1))
    request = receipt["request"]
    binding = collection_binding(db, workspace_id, row["rights_review_id"], row["listing_review_id"], row["calendar_review_id"], request["start_date"], request["end_date"], checked, allow_continued=True)
    _assert(all(instant(binding[kind]["review"]["created_at"]) <= instant(receipt["source"]["call_started_at"]) for kind in ("rights", "listing", "calendar")))
    _assert(binding["request"] == request and receipt["review_hashes"] == {kind: binding[kind]["review"]["content_hash"] for kind in ("rights", "listing", "calendar")})
    expected_retain = min(instant(binding["rights"]["facts"]["valid_until"]), instant(binding["rights"]["review"]["valid_until"]),
        instant(row["created_at"]) + timedelta(days=binding["rights"]["facts"]["retention_days"]))
    _assert(row["retain_until"] == expected_retain.isoformat(timespec="milliseconds").replace("+00:00", "Z"))
    payload = db.execute("SELECT projection FROM investor_price_payloads WHERE capture_id=?", (capture_id,)).fetchone()
    _assert(payload is not None, "INVESTOR_DATA_PAYLOAD_PURGED")
    raw = bytes(payload[0]); _assert(sha256(raw).hexdigest() == row["projection_sha256"])
    projection = _object(raw)
    _assert(projection["source"] == receipt["source"] and projection["source"]["collector_runtime"] == row["qualification"])
    if row["qualification"] == "isolated_official_sdk":
        replay = longport._parse_child_projection(raw, request, instant(receipt["source"]["call_started_at"]), instant(receipt["source"]["call_returned_at"]))
    else:
        source = projection["source"]
        candles = [{**candle, "volume": int(candle["volume"]), "timestamp": instant(candle["timestamp"])} for candle in projection["candlesticks"]]
        replay = longport._normalize(candles, request=request, sdk_version=source["sdk_version"], call_started_at=source["call_started_at"], call_returned_at=source["call_returned_at"],
            datetime_basis=source["sdk_datetime_basis"], collector_runtime="injected_test_client")
        _assert(replay["projection_bytes"] == raw)
    return {"capture": dict(row), "receipt": receipt, "binding": binding, "records": replay["records"]}


def purge_price_payload(db, workspace_id, actor_id, capture_id, *, now=None):
    checked = _milliseconds(now)
    with transaction(db):
        _owner(db, workspace_id, actor_id)
        capture = db.execute("SELECT * FROM investor_price_captures WHERE id=? AND workspace_id=?", (capture_id, workspace_id)).fetchone()
        _assert(capture is not None and capture["created_at"] <= checked, "INVESTOR_DATA_OUT_OF_SCOPE")
        previous = db.execute("SELECT * FROM investor_price_purges WHERE capture_id=?", (capture_id,)).fetchone()
        if previous:
            _assert(previous["created_at"] <= checked, "INVESTOR_DATA_INVALID_CLOCK")
            return dict(previous)
        if capture["retain_until"] <= checked:
            reason = "retention_expired"
        else:
            latest = db.execute("SELECT d.created_at FROM investor_data_reviews d JOIN investor_data_reviews bound ON bound.source_id=d.source_id WHERE bound.id=? ORDER BY d.version DESC LIMIT 1", (capture["rights_review_id"],)).fetchone()
            _assert(latest is not None and latest["created_at"] <= checked, "INVESTOR_DATA_INVALID_CLOCK")
            try:
                grant = resolve_review(db, workspace_id, capture["rights_review_id"], "rights", now=checked)
            except WorkbenchError:
                grant = None
            _assert(grant is None or not USES <= set(grant["facts"]["uses"]) or not instant(grant["facts"]["valid_from"]) <= instant(checked) < instant(grant["facts"]["valid_until"]), "INVESTOR_DATA_PURGE_NOT_DUE")
            reason = "rights_no_longer_active"
        audit = _audit(db, actor_id, "investor_purge_price_payload", "investor_price_capture", capture_id, {"reason": reason}, checked)
        db.execute("INSERT INTO investor_price_purges(capture_id,reason,actor_id,created_at,audit_id) VALUES(?,?,?,?,?)", (capture_id, reason, actor_id, checked, audit))
        db.execute("DELETE FROM investor_price_payloads WHERE capture_id=?", (capture_id,))
        return dict(db.execute("SELECT * FROM investor_price_purges WHERE capture_id=?", (capture_id,)).fetchone())
