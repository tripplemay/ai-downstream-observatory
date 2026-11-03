"""Current, receipt-backed inputs after an actual registered economic epoch.

This is preparation, not admission or monitoring activation. Callers cannot
supply a predecessor, corrected ledger, epoch definition or source-trust flag.
"""

from copy import deepcopy
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers.longport import _MARKETS
from worker.orchestration.db import WorkbenchError, content_hash, instant, transaction
from . import managed_actions as managed, model_epoch_source as source
from .data_evidence import _fact_validation_scope, _owner, resolve_capture, resolve_review
from .confirmed_capture import resolve_confirmed_capture
from .model_epoch_transition import continue_corrected_model_epoch
from .model_runtime import _clock
from .monitor_bootstrap import _check_action_selection, _check_fx_selection, _settings, plan_bootstrap
from .monitor_data import build_monitor_data, check_reference_listing_identity, resolve_monitor_data
from .planned_funding_source import read_bound_planned_funding_monitor, read_planned_funding_monitor
from .source_inputs import _review_kind, _snapshot_ids


SCHEMA = "investor-model-epoch-continuation-source.schema.json"


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("INVESTOR_MODEL_EPOCH_CONTINUATION_SOURCE_" + code)


def _basis(db, workspace, actor, epoch_id, checked, frozen, stop_requested):
    from .epoch_continuation import read_epoch_continuation_chain
    chain = read_epoch_continuation_chain(db, workspace, actor, epoch_id, now=checked, stop_requested=stop_requested)
    saved, prepared = chain["root"], chain["source"]
    record = chain["head"]
    definition = chain["definition"]; model_id = definition["model_id"]
    previous = prepared["candidate"]["checkpoint"]
    head = db.execute("SELECT id,content_hash,input_id FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1", (workspace, model_id)).fetchone()
    latest = db.execute("SELECT id,content_hash FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY rowid DESC LIMIT 1", (workspace, model_id)).fetchone()
    _check(head is not None and head["id"] == record["checkpoint"]["id"] and head["content_hash"] == content_hash(previous)
        and latest is not None and dict(latest) == record["input"], "LATEST_HEAD_CHANGED")
    control = db.execute("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1", (workspace, model_id)).fetchone()
    _check(control is not None and control["enabled"] == 1 and instant(control["created_at"]) <= instant(frozen)
        and {"id": control["id"], "content_hash": content_hash(dict(control))} == saved["source"]["epoch_definition"]["model_control"], "CONTROL_CHANGED")
    funding = read_planned_funding_monitor(db, workspace, actor, model_id, now=checked)
    _check((funding["request"]["binding"] if funding else None) == prepared["input"].get("funding_binding"), "FUNDING_PLAN_CHANGED")
    frozen_funding = read_bound_planned_funding_monitor(db, workspace, actor, funding["request"]["binding"], evaluated_at=frozen, now=checked) if funding else None
    _check((funding["context_hash"] if funding else None) == (frozen_funding["context_hash"] if frozen_funding else None), "FUNDING_CONTEXT_CHANGED")
    model, current_definition, reference = source.current_monitor_model(db, workspace, model_id, checked)
    _check(current_definition == definition, "MODEL_CHANGED")
    return {"saved": saved, "previous_source": prepared, "previous_refs": record, "previous_publication": chain["last_publication"],
        "source_ceiling": chain["read_valid_until"], "definition": definition, "previous": previous, "model": model, "reference": reference,
        "control": {"id": control["id"], "content_hash": content_hash(dict(control))}, "funding": funding}


def _windows(db, workspace, basis, checked):
    _, definition, _, windows, _ = plan_bootstrap(db, workspace, basis["definition"]["model_id"], checked)
    _check(definition == basis["definition"], "MODEL_CHANGED")
    old = basis["previous_source"]["input"]
    result = []
    for selected in windows:
        window = deepcopy(selected)
        market = resolve_review(db, workspace, window["action_review_ids"][0], "actions", now=checked)["facts"]["listing_id"]
        market = next(row["market"] for row in definition["targets"] if row["listing_id"] == market)
        start = instant(basis["previous"]["market_cutoffs"][market]).astimezone(ZoneInfo(_MARKETS[market][0])).date().isoformat()
        _check(start <= window["end_date"], "CLOSE_REGRESSION")
        def scope(identifier, confirmed):
            value = (resolve_confirmed_capture if confirmed else resolve_capture)(db, workspace, identifier, now=checked)
            return {(row["listing_id"], row["observed_at"]) for row in value["records"] if start <= row["observed_at"] <= window["end_date"]}
        covered = set()
        for key in ("capture_ids", "confirmed_capture_ids"):
            for identifier in window.get(key, []): covered.update(scope(identifier, key == "confirmed_capture_ids"))
        for segment in old["segments"]:
            snapshot = segment["snapshot"]
            calendars = [resolve_review(db, workspace, ref["review_id"], "calendar", now=checked)["facts"]["market"]
                for ref in snapshot["review_refs"] if _review_kind(db, workspace, ref["review_id"]) == "calendar"]
            _check(len(calendars) == 1, "CALENDAR_SCOPE")
            if calendars[0] != market: continue
            for ref in snapshot["capture_refs"]:
                key = "confirmed_capture_ids" if ref.get("kind") == "confirmed_sdk" else "capture_ids"
                supplied = scope(ref["capture_id"], key == "confirmed_capture_ids")
                if supplied <= covered: continue
                _check(not supplied & covered, "CAPTURE_SCOPE_AMBIGUOUS")
                window.setdefault(key, []).append(ref["capture_id"]); covered.update(supplied)
        for key in ("capture_ids", "confirmed_capture_ids"):
            window[key] = sorted(set(window.get(key, [])))
        window["start_date"] = start
        result.append(window)
    return result


def _actions(db, workspace, document, checked):
    values = {}
    for segment in document["segments"]:
        for ref in segment["snapshot"]["review_refs"]:
            if _review_kind(db, workspace, ref["review_id"]) != "actions": continue
            value = resolve_review(db, workspace, ref["review_id"], "actions", now=checked)
            listing = value["facts"]["listing_id"]
            _check(listing not in values or values[listing] == value, "ACTION_SELECTION_CHANGED")
            values[listing] = value
    return values


def _assemble(db, workspace, actor, basis, raw, checked, stop_requested):
    definition, document = basis["definition"], raw["document"]
    settings = _settings(db, workspace, basis["model"], definition, basis["reference"], checked)
    windows = [{"start_date": segment["snapshot"]["range_start"], "end_date": segment["snapshot"]["range_end"],
        "action_review_ids": _snapshot_ids(db, workspace, segment["snapshot"], "actions"),
        "fx_review_ids": _snapshot_ids(db, workspace, segment["snapshot"], "fx")} for segment in document["segments"]]
    _check_action_selection(db, workspace, definition, windows, checked)
    _check_fx_selection(db, workspace, definition, windows, document["settings"], checked)
    ceiling = min(basis["source_ceiling"], basis["saved"]["source"]["epoch_definition"]["valid_until"], key=instant)
    return _assemble_evidence(db, workspace, actor, basis, raw, checked, checked, settings, ceiling, stop_requested)


def _assemble_evidence(db, workspace, actor, basis, raw, checked, evaluated, settings, ceiling, stop_requested):
    """Derivation only. Recorded callers must authenticate actual journals first."""
    saved, previous, definition = (basis[key] for key in ("saved", "previous", "definition"))
    root, prior, record = saved["source"], basis["previous_source"], basis["previous_refs"]
    document, frozen = raw["document"], raw["document"]["created_at"]
    _check(document["schema_version"] == "investor-monitor-data-input-v4" and raw["projection"]["schema_version"] == "investor-monitor-data-projection-v2")
    _check(document["settings"] == settings, "SETTINGS_CHANGED")
    check_reference_listing_identity(basis["reference"]["targets"], raw["catalog"])
    _check(not raw["projection"]["quality_gaps"] and instant(evaluated) < instant(raw["projection"]["valid_until"]), "CURRENT_INPUTS_NOT_READY")
    selected, anchors = _actions(db, workspace, document, checked), _actions(db, workspace, prior["input"], checked)
    _check(set(selected) == set(anchors), "ACTION_SELECTION_CHANGED")
    for listing, current in selected.items():
        anchor = source._base_review(db, workspace, anchors[listing]["review"]["id"], checked)
        source._descendant(db, workspace, actor, current["review"]["id"], {"new_review_id": anchor}, checked)
    targets = {row["listing_id"]: row for row in definition["targets"]}
    historical = lambda row: instant(row["effective_at"]) <= instant(previous["market_cutoffs"][targets[row["listing_id"]]["market"]])
    carry = sorted([row for row in prior["projection"]["economic_projection"]["corporate_actions"] if historical(row)], key=lambda row: row["id"])
    _check({row["id"]: content_hash(row) for row in carry} == previous["processed_actions"] and len({row["id"] for row in carry}) == len(carry), "PREVIOUS_LEDGER_CHANGED")
    indexed = {row["id"]: row for row in carry}; future = []
    economics = lambda row: {key: value for key, value in row.items() if key != "known_at"}
    for action in raw["projection"]["corporate_actions"]:
        if not historical(action): future.append(action); continue
        old = indexed.get(action["id"])
        _check(old is not None and economics(old) == economics(action) and instant(old["known_at"]) <= instant(action["known_at"]), "HISTORICAL_ACTION_CHANGED")
    _check(instant(frozen) <= instant(evaluated) <= instant(checked) and instant(evaluated) < instant(ceiling), "EXPIRED")
    economic = deepcopy(raw["projection"]); economic["corporate_actions"] = sorted(carry + future, key=lambda row: row["id"])
    economic["valid_until"] = min(economic["valid_until"], ceiling, *([basis["funding"]["projection"]["valid_until"]] if basis["funding"] else []), key=instant)
    for row in [*economic["quotes"], *economic["fx"]]: row["valid_until"] = min(row["valid_until"], ceiling, key=instant)
    epoch = saved["registration"]["epoch"]
    projection = {"schema_version": "investor-monitor-data-projection-v4", "epoch": epoch,
        "knowledge_protocol": "approved_economic_restatement_and_recorded_carry_not_pit", "economic_projection": economic}
    document = {**deepcopy(document), "schema_version": "investor-monitor-data-input-v6", "epoch": epoch,
        "audited_projection_hash": document["projection_hash"], "audited_valid_until": document["valid_until"], "carry_hash": content_hash(carry), "carry_count": len(carry),
        "projection_hash": content_hash(projection), "valid_until": min(document["valid_until"], ceiling, key=instant)}
    if basis["funding"]: document.update(funding_binding=basis["funding"]["request"]["binding"], funding_context_hash=basis["funding"]["context_hash"])
    for kind, value in (("input", document), ("projection", projection)): source._validate(value, kind)
    kernel = {"schema_version": "investor-model-epoch-continuation-input-v1", "definition": definition, "previous": previous,
        "projection": projection, "input_hash": content_hash(document), "planned_funding": basis["funding"]["request"] if basis["funding"] else None, "now": evaluated}
    managed._stopped(db, stop_requested); candidate = continue_corrected_model_epoch(kernel)
    proof = {"schema_version": "investor-model-epoch-continuation-source-proof-v1", "workspace_id": workspace, "actor_id": actor, "model_id": definition["model_id"],
        "epoch": epoch, "registration_hash": saved["proof"]["registration_hash"], "previous_input": record["input"], "previous_checkpoint": record["checkpoint"],
        "model_control": basis["control"], "input_hash": content_hash(document), "projection_hash": content_hash(projection), "checked_at": evaluated,
        "valid_until": economic["valid_until"], "status": "qualified_continuation_prepared_not_admitted",
        "epoch_registration_verified": True, "previous_state_verified": True, "source_evidence_verified": True,
        **{key: False for key in ("continuation_admitted", "current_source_eligibility_restored", "checkpoint_created", "monitoring_resumed", "trading_permission")},
        "provider_calls": 0, "database_writes": 0, "distribution": "private_owner_only_not_ai"}
    validate_contract(proof, SCHEMA, fragment="$defs/proof"); managed._stopped(db, stop_requested)
    return {"epoch_definition": root["epoch_definition"], "input": document, "projection": projection, "proof": proof, "kernel_input": kernel, "candidate": candidate}


def prepare_model_epoch_continuation(db, workspace, actor, epoch_id, *, now=None, stop_requested=None):
    checked = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); managed._stopped(db, stop_requested)
        basis = _basis(db, workspace, actor, epoch_id, checked, checked, stop_requested)
        windows = _windows(db, workspace, basis, checked)
        raw = build_monitor_data(db, workspace, basis["definition"], windows,
            _settings(db, workspace, basis["model"], basis["definition"], basis["reference"], checked), now=checked, audited_action_knowledge=True)
        return _assemble(db, workspace, actor, basis, raw, checked, stop_requested)


def replay_model_epoch_continuation(db, workspace, actor, epoch_id, document, *, now=None, stop_requested=None):
    checked = _clock(now); source._validate(document, "input")
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); managed._stopped(db, stop_requested)
        basis = _basis(db, workspace, actor, epoch_id, checked, document["created_at"], stop_requested)
        _check(document["epoch"] == basis["saved"]["registration"]["epoch"], "EPOCH_CHANGED")
        raw = resolve_monitor_data(db, workspace, basis["definition"], source.audited_epoch_input(document), now=checked)
        _check(raw["unavailable_reason"] is None, raw["unavailable_reason"] or "CURRENT_INPUTS_NOT_READY")
        result = _assemble(db, workspace, actor, basis, raw, checked, stop_requested)
        _check(result["input"] == document, "DERIVATION_CHANGED")
        return result
