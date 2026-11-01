"""First monitor input from retained reviewed evidence, never guessed prices."""

from datetime import timedelta
from zoneinfo import ZoneInfo

from worker.market.providers.longport import _MARKETS
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant, transaction
from worker.orchestration.jobs import enqueue_notification
from .confirmed_capture import resolve_confirmed_capture
from .data_evidence import _assert, _audit, _object, resolve_capture, resolve_review, review_header
from .model_runtime import _clock
from .monitor_admission import admit_monitor_data, current_monitor_model
from .reference_plan import reference_source_current
from .source_inputs import resolve_evidence_input
from .fx_selection import GAPS as FX_GAPS, select_current_fx


VERSION = "investor-monitor-bootstrap-quality-v2"
MAX_QUOTE_AGE_SECONDS = 604800
MAX_CAPTURE_CANDIDATES = 128
MAX_REVIEW_CANDIDATES = 128
GAPS = {"INVESTOR_BOOTSTRAP_SOURCE_LIMIT", "INVESTOR_BOOTSTRAP_IDENTITY_CHANGED", "INVESTOR_BOOTSTRAP_PRICES_NOT_READY",
    "INVESTOR_BOOTSTRAP_CALENDAR_AMBIGUOUS", "INVESTOR_BOOTSTRAP_PRICES_CONFLICT", "INVESTOR_BOOTSTRAP_LISTING_AMBIGUOUS",
    "INVESTOR_BOOTSTRAP_CAPTURE_SCOPE_AMBIGUOUS", "INVESTOR_BOOTSTRAP_ACTIONS_NOT_UNIQUE",
    "INVESTOR_BOOTSTRAP_FX_SELECTION_CHANGED", "INVESTOR_BOOTSTRAP_ACTION_SELECTION_CHANGED",
    "INVESTOR_BOOTSTRAP_ACTIONS_NOT_READY"} | FX_GAPS


def _settings(db, workspace, model, definition, reference, at):
    _assert(reference_source_current(db, workspace, model["plan_id"], at, verify_result=True))
    evidence = reference["reference_evidence"]
    source = resolve_evidence_input(db, workspace, evidence["source_input_id"], now=at)
    run = db.execute("SELECT document_json FROM investor_research_runs WHERE id=? AND workspace_id=?", (evidence["run_id"], workspace)).fetchone()
    parameters = _object(run[0])["result"]["selected_parameters"]
    _assert(content_hash(parameters) == evidence["selected_parameters_hash"]
        and parameters["weights"] == {target["listing_id"]: target["weight"] for target in definition["targets"]})
    execution = source["payload"]["plan"]["execution"]
    # Data-quality ceilings are product policy, not a user loss budget. Unknown
    # monitoring cost limits stay unknown; research fees do not certify a broker.
    settings = {"policy": {"version": VERSION, "weight_band": parameters["tolerance"]["weight"],
        "absolute_band_cny": parameters["tolerance"]["absolute_cny"], "max_fx_age_seconds": min(MAX_QUOTE_AGE_SECONDS, execution["max_fx_age_seconds"]), "costs": None},
        "funding_intent": None, "max_quote_age_seconds": MAX_QUOTE_AGE_SECONDS}
    from .monitor_costs import current_settings
    settings = current_settings(db, workspace, definition, settings, at)
    validate_contract(settings, "investor-monitor-data-input-v3.schema.json" if "cost_assumptions" in settings else "investor-monitor-data-input.schema.json", fragment="$defs/settings")
    return settings


def _candidate(db, workspace, row, targets, at):
    confirmed = row["kind"] == "confirmed"
    value = resolve_confirmed_capture(db, workspace, row["id"], now=at) if confirmed else resolve_capture(db, workspace, row["id"], now=at)
    bindings = value["bindings"] if confirmed else [value["binding"]]
    identities = {bound["listing"]["facts"]["listing_id"] for bound in bindings}
    if not identities <= set(targets): return None
    markets = {bound["listing"]["facts"]["market"] for bound in bindings}
    if len(markets) != 1: return None
    market = markets.pop(); calendar = bindings[0]["calendar"]
    _assert(all(bound["calendar"]["review"]["id"] == calendar["review"]["id"] for bound in bindings))
    local_day = instant(at).astimezone(ZoneInfo(_MARKETS[market][0])).date().isoformat()
    if not calendar["facts"]["range_start"] <= local_day <= calendar["facts"]["range_end"]: return None
    days = [day for day in calendar["facts"]["days"] if day["kind"] != "closed" and instant(day["close_at"]) <= instant(at)]
    if not days: return None
    expected = max(days, key=lambda day: instant(day["close_at"]))
    if instant(expected["close_at"]) + timedelta(seconds=MAX_QUOTE_AGE_SECONDS) <= instant(at): return None
    records = {record["listing_id"]: record for record in value["records"] if record["observed_at"] == expected["date"]}
    if set(records) != identities: return None
    for bound in bindings:
        facts = bound["listing"]["facts"]; target = targets[facts["listing_id"]]
        _assert(all(facts[key] == target[key] for key in ("market", "currency")) and facts["provider_symbol"] == target["symbol"],
            "INVESTOR_BOOTSTRAP_IDENTITY_CHANGED")
    return {"id": row["id"], "kind": row["kind"], "market": market, "day": expected["date"], "records": records,
        "calendar": calendar["review"]["id"], "listings": {bound["listing"]["facts"]["listing_id"]: bound["listing"]["review"]["id"] for bound in bindings},
        "created_at": value["capture"]["created_at"]}


def _reviews(db, workspace, kind, at, listing_ids=None):
    if kind == "actions" and listing_ids is not None:
        from .managed_actions import current_action_reviews
        try:
            return current_action_reviews(db, workspace, listing_ids, at, limit=MAX_REVIEW_CANDIDATES)
        except WorkbenchError:
            raise WorkbenchError("INVESTOR_BOOTSTRAP_ACTIONS_NOT_READY") from None
    rows = db.execute("""SELECT r.id FROM investor_data_reviews r JOIN investor_data_sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id
        WHERE r.workspace_id=? AND s.kind=? AND r.decision='approved' AND r.created_at<=? AND r.valid_until>?
          AND r.version=(SELECT max(version) FROM investor_data_reviews WHERE source_id=r.source_id)
          AND (s.kind!='fx' OR NOT EXISTS(SELECT 1 FROM investor_fx_publications p WHERE p.workspace_id=r.workspace_id
                AND (p.usd_review_id=r.id OR p.hkd_review_id=r.id))
            OR EXISTS(SELECT 1 FROM investor_fx_publications p JOIN investor_fx_authorities a ON a.id=p.authority_id AND a.workspace_id=p.workspace_id
                JOIN investor_fx_controls control ON control.id=json_extract(p.document_json,'$.control_id') AND control.authority_id=a.id
                WHERE p.workspace_id=r.workspace_id AND (p.usd_review_id=r.id OR p.hkd_review_id=r.id)
                AND p.id=(SELECT id FROM investor_fx_publications head WHERE head.authority_id=p.authority_id AND head.status='published' ORDER BY head.sequence DESC LIMIT 1)
                AND control.enabled=1 AND control.version=(SELECT max(version) FROM investor_fx_controls WHERE authority_id=a.id)
                AND control.created_at<=? AND json_extract(a.document_json,'$.valid_from')<=? AND json_extract(a.document_json,'$.valid_until')>?))
        ORDER BY r.created_at DESC,r.id LIMIT ?""", (workspace, kind, at, at, at, at, at, MAX_REVIEW_CANDIDATES + 1)).fetchall()
    _assert(len(rows) <= MAX_REVIEW_CANDIDATES, "INVESTOR_BOOTSTRAP_SOURCE_LIMIT")
    return [resolve_review(db, workspace, row["id"], kind, now=at) for row in rows]


def _current_fx(db, workspace, targets, settings, at):
    currencies = {row["currency"] for row in targets} - {"CNY"}
    return select_current_fx(_reviews(db, workspace, "fx", at) if currencies else [], currencies,
        at=at, max_age_seconds=settings["policy"]["max_fx_age_seconds"])


def _check_fx_selection(db, workspace, definition, windows, settings, at):
    chosen = _current_fx(db, workspace, definition["targets"], settings, at)
    _assert(set(chosen.values()) == {identity for window in windows for identity in window["fx_review_ids"]},
        "INVESTOR_BOOTSTRAP_FX_SELECTION_CHANGED")


def _check_action_selection(db, workspace, definition, windows, at):
    from .managed_actions import current_action_reviews
    values = current_action_reviews(db, workspace, [target["listing_id"] for target in definition["targets"]], at, header_only=True)
    for window in windows:
        identities = {review_header(db, workspace, identifier, now=at)["facts"]["listing_id"] for identifier in window["action_review_ids"]}
        expected = [value["review"]["id"] for value in values if value["facts"]["listing_id"] in identities
            and value["facts"]["range_start"] <= window["start_date"] <= window["end_date"] <= value["facts"]["range_end"]]
        _assert(set(expected) == set(window["action_review_ids"]), "INVESTOR_BOOTSTRAP_ACTION_SELECTION_CHANGED")


def _plan_bootstrap(db, workspace, model_id, at):
    _assert(db.execute("SELECT 1 FROM investor_models WHERE id=? AND workspace_id=?", (model_id, workspace)).fetchone(), "INVESTOR_DATA_OUT_OF_SCOPE")
    earliest = (instant(at) - timedelta(seconds=MAX_QUOTE_AGE_SECONDS)).date().isoformat()
    # Cheap headers bound the first-input search; every selected receipt is then
    # replayed. It never calls a provider or picks a price from mutable latest rows.
    # An empty search cannot admit anything and needs no historical rebuild.
    rows = db.execute("""SELECT 'historical' kind,c.id,c.created_at FROM investor_price_captures c
        JOIN investor_price_payloads p ON p.capture_id=c.id WHERE c.workspace_id=? AND c.qualification='isolated_official_sdk'
          AND c.created_at<=? AND c.retain_until>? AND json_extract(c.receipt_json,'$.request.end_date')>=?
        UNION ALL SELECT 'confirmed' kind,c.id,c.created_at FROM investor_confirmed_captures c
        JOIN investor_confirmed_payloads p ON p.capture_id=c.id WHERE c.workspace_id=? AND c.qualification='isolated_official_sdk_callback'
          AND c.status='complete' AND c.created_at<=? AND c.retain_until>?
        ORDER BY created_at DESC,id LIMIT ?""", (workspace, at, at, earliest, workspace, at, at, MAX_CAPTURE_CANDIDATES + 1)).fetchall()
    _assert(len(rows) <= MAX_CAPTURE_CANDIDATES, "INVESTOR_BOOTSTRAP_SOURCE_LIMIT")
    _assert(rows, "INVESTOR_BOOTSTRAP_PRICES_NOT_READY")
    model, definition, reference = current_monitor_model(db, workspace, model_id, at)
    targets = {target["listing_id"]: target for target in reference["targets"]}
    candidates = []
    for row in rows:
        candidate = _candidate(db, workspace, row, targets, at)
        if candidate is not None: candidates.append(candidate)
    _assert(candidates, "INVESTOR_BOOTSTRAP_PRICES_NOT_READY")
    prices, listings, calendars = {}, {}, {}
    for row in candidates:
        signature = row["calendar"], row["day"]
        _assert(row["market"] not in calendars or calendars[row["market"]] == signature, "INVESTOR_BOOTSTRAP_CALENDAR_AMBIGUOUS")
        calendars[row["market"]] = signature
        for identity, record in row["records"].items():
            _assert(identity not in prices or prices[identity] == record["value"], "INVESTOR_BOOTSTRAP_PRICES_CONFLICT")
            _assert(identity not in listings or listings[identity] == row["listings"][identity], "INVESTOR_BOOTSTRAP_LISTING_AMBIGUOUS")
            prices[identity], listings[identity] = record["value"], row["listings"][identity]
    _assert(set(prices) == set(targets), "INVESTOR_BOOTSTRAP_PRICES_NOT_READY")
    chosen, covered = [], set()
    for row in sorted(candidates, key=lambda item: (len(item["records"]), instant(item["created_at"]), item["id"]), reverse=True):
        scope = set(row["records"])
        if scope & covered: continue
        chosen.append(row); covered.update(scope)
    _assert(covered == set(targets), "INVESTOR_BOOTSTRAP_CAPTURE_SCOPE_AMBIGUOUS")
    settings = _settings(db, workspace, model, definition, reference, at)
    actions = _reviews(db, workspace, "actions", at, targets)
    current_fx = _current_fx(db, workspace, targets.values(), settings, at)
    windows = []
    for market in sorted(calendars):
        day = calendars[market][1]
        selected = [row for row in chosen if row["market"] == market]
        identities = {identity for row in selected for identity in row["records"]}
        action_ids, fx_ids = [], []
        for identity in sorted(identities):
            matches = [row for row in actions if row["facts"]["listing_id"] == identity and row["facts"]["range_start"] <= day <= row["facts"]["range_end"]]
            _assert(len(matches) == 1, "INVESTOR_BOOTSTRAP_ACTIONS_NOT_UNIQUE")
            action_ids.append(matches[0]["review"]["id"])
        for currency in sorted({targets[identity]["currency"] for identity in identities} - {"CNY"}):
            fx_ids.append(current_fx[currency])
        window = {"capture_ids": sorted(row["id"] for row in selected if row["kind"] == "historical"),
            "action_review_ids": action_ids, "fx_review_ids": fx_ids, "start_date": day, "end_date": day}
        confirmed = sorted(row["id"] for row in selected if row["kind"] == "confirmed")
        if confirmed: window["confirmed_capture_ids"] = confirmed
        windows.append(window)
    return model, definition, reference, windows, settings


def plan_bootstrap(db, workspace, model_id, at):
    try: return _plan_bootstrap(db, workspace, model_id, at)
    except WorkbenchError as error:
        if str(error) in GAPS: raise
        raise WorkbenchError("INVESTOR_BOOTSTRAP_PLAN_INVALID") from None
    except Exception: raise WorkbenchError("INVESTOR_BOOTSTRAP_PLAN_INVALID") from None


def bootstrap_monitor_inputs(db, *, limit=100, now=None, stop_requested=None):
    _assert(type(limit) is int and 1 <= limit <= 1000); at = _clock(now); admitted = []
    rows = db.execute("""SELECT m.* FROM investor_models m JOIN investor_model_controls c ON c.model_id=m.id AND c.workspace_id=m.workspace_id
          WHERE c.version=(SELECT max(version) FROM investor_model_controls WHERE model_id=m.id) AND c.enabled=1 AND c.created_at<=?
          AND m.profile_id=(SELECT id FROM investor_profiles WHERE workspace_id=m.workspace_id ORDER BY version DESC LIMIT 1)
          AND m.plan_id=(SELECT plan_id FROM investor_plan_selections WHERE workspace_id=m.workspace_id ORDER BY created_at DESC,rowid DESC LIMIT 1)
          AND json_extract(m.document_json,'$.data_mode')='reconstructed' AND json_extract(m.document_json,'$.valid_until')>?
          AND NOT EXISTS(SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=m.id) ORDER BY m.created_at,m.id LIMIT ?""", (at, at, limit)).fetchall()
    for row in rows:
        if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
        try:
            with transaction(db, immediate=False):
                model, definition, reference, windows, settings = plan_bootstrap(db, row["workspace_id"], row["id"], at)
            with transaction(db):
                checked = _clock(now)
                control = db.execute("SELECT * FROM investor_model_controls WHERE model_id=? ORDER BY version DESC LIMIT 1", (row["id"],)).fetchone()
                _assert(control and control["enabled"] == 1 and control["created_at"] <= checked, "INVESTOR_BOOTSTRAP_MODEL_DISABLED")
                if db.execute("SELECT 1 FROM investor_monitor_evidence_inputs WHERE model_id=?", (row["id"],)).fetchone(): continue
                _check_fx_selection(db, row["workspace_id"], definition, windows, settings, checked)
                _check_action_selection(db, row["workspace_id"], definition, windows, checked)
                actor = db.execute("SELECT owner_id FROM investor_workspaces WHERE id=?", (row["workspace_id"],)).fetchone()[0]
                source = admit_monitor_data(db, row["workspace_id"], actor, row["id"], windows, settings, now=checked)
                if stop_requested and stop_requested(): raise WorkbenchError("WORKER_STOP_REQUESTED")
                _audit(db, actor, "investor_bootstrap_monitor_source", "investor_monitor_evidence_input", source["id"],
                    {"content_hash": source["content_hash"], "model_hash": model["content_hash"], "plan_hash": content_hash(reference), "policy_version": VERSION}, checked)
                admitted.append(source["id"])
        except WorkbenchError as error:
            if str(error) in ("WORKER_STOP_REQUESTED", "WORKBENCH_READ_ONLY", "RESTORE_PENDING_REVIEW"): raise
            enqueue_notification(db, "monitor-bootstrap-gap:" + row["id"], "investor.monitor_bootstrap_gap",
                {"workspace_id": row["workspace_id"], "model_id": row["id"], "code": "MONITOR_BOOTSTRAP_EVIDENCE_GAP"}, now=_clock(now))
    return admitted
