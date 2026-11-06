"""Current qualified source preparation for a distinct, not-yet-admitted epoch."""

from copy import deepcopy
from zoneinfo import ZoneInfo

from worker.market.contracts import validate_contract
from worker.market.providers.longport import _MARKETS
from worker.orchestration.db import WorkbenchError, content_hash, instant, transaction
from . import action_review_workflow as review, managed_actions as managed
from .action_correction_impact import _ledger
from .corrected_action_source import read_correction_consent_baseline
from .data_evidence import _fact_validation_scope, _object, _owner, resolve_capture, resolve_review
from .confirmed_capture import resolve_confirmed_capture
from .model_epoch_transition import advance_corrected_model_epoch
from .model_runtime import _clock
from .monitor_admission import current_monitor_model
from .monitor_bootstrap import _settings
from .monitor_data import build_monitor_data, check_reference_listing_identity, resolve_monitor_data, validate_monitor_data_document
from .planned_funding_source import read_bound_planned_funding_monitor, read_planned_funding_monitor
from .retained_monitor_history import read_registered_correction_history
from .source_inputs import _review_kind


SCHEMA = "investor-model-epoch-source.schema.json"
FIELDS = ("definition", "origin", "head", "origin_projection", "head_projection", "original_actions")
MAX_CORRECTION_CANDIDATES = 64


def _check(value, code="INVALID"):
    if not value: raise WorkbenchError("INVESTOR_MODEL_EPOCH_SOURCE_" + code)


def _validate(value, kind): validate_contract(value, SCHEMA, fragment="$defs/" + kind)


def _base_review(db, workspace, identifier, at):
    if not identifier.startswith(managed.PREFIX): return identifier
    publication, _ = managed._publication_header(db, workspace, identifier, at)
    _, policy, _ = managed._authority(db, workspace, publication["authority_id"], at)
    return policy["base_review_id"]


def _descendant(db, workspace, actor, identifier, handover, at):
    seen = set()
    for _ in range(256):
        identifier = _base_review(db, workspace, identifier, at)
        if identifier == handover["new_review_id"]: return
        _check(identifier not in seen, "ACTION_LINEAGE_CHANGED"); seen.add(identifier)
        row = db.execute("SELECT id FROM investor_action_review_confirmations WHERE workspace_id=? AND new_review_id=?", (workspace, identifier)).fetchone()
        _check(row is not None, "ACTION_LINEAGE_CHANGED")
        doc = review.resolve_action_review_confirmation(db, workspace, actor, row["id"], now=at)
        identifier = doc["previous_review_id"]
    _check(False, "ACTION_LINEAGE_LIMIT")


def _correction_basis(db, workspace, actor, model_id, references, checked, frozen, stop_requested=None):
    _owner(db, workspace, actor)
    _check(type(references) is list and 1 <= len(references) <= 64)
    model, definition, reference = current_monitor_model(db, workspace, model_id, checked)
    corrections, handovers, history, maximum = [], {}, None, definition["valid_until"]
    original_maximum = maximum
    seen = set()
    for ref in references:
        managed._stopped(db, stop_requested)
        _validate(ref, "correction_ref")
        _check(ref["correction_id"] not in seen, "CORRECTION_SCOPE"); seen.add(ref["correction_id"])
        doc = read_correction_consent_baseline(db, workspace, actor, ref["correction_id"], now=checked, stop_requested=stop_requested)
        current = read_registered_correction_history(db, workspace, actor, ref["correction_id"], now=checked, stop_requested=stop_requested)
        handover = review.resolve_action_review_confirmation(db, workspace, actor, ref["handover_id"], now=checked)
        _check(content_hash(doc) == ref["confirmation_hash"] and content_hash(handover) == ref["handover_hash"]
            and handover["schema_version"] == "investor-corrected-action-handover-confirmation-v1"
            and handover["request"]["correction_id"] == doc["confirmation_id"] and handover["request"]["expected_correction_hash"] == content_hash(doc)
            and handover["source_proof"]["model_id"] == model_id == doc["model_id"] and current["definition"] == definition
            and handover["created_at"] <= frozen <= checked, "CORRECTION_CHANGED")
        if history is not None: _check(history == current, "HISTORY_CHANGED")
        history = current; baseline = doc["baseline"]; facts = baseline["approved_facts"]; listing = facts["listing_id"]
        _check(listing not in handovers and not doc["outstanding_new_report_dates"], "CORRECTION_SCOPE")
        request = _object(db.execute("SELECT document_json FROM investor_correction_impact_requests WHERE id=? AND workspace_id=?", (doc["impact_request_id"], workspace)).fetchone()[0])["body"]
        days = {row["date"] for row in request["decisions"]}
        affected = lambda row: row["listing_id"] == listing and instant(row.get("ex_at", row["effective_at"])).astimezone(managed.ZONE).date().isoformat() in days
        actions = sorted([row for row in history["original_actions"] if not affected(row)] + [row for row in _ledger(facts,
            history["head"]["market_cutoffs"]["US"], baseline["knowledge_at"]) if affected(row)], key=lambda row: row["id"])
        _check(content_hash(actions) == baseline["corrected_actions_hash"], "CORRECTION_CHANGED")
        corrections.append({"baseline": baseline, "corrected_actions": actions, **{key: ref[key] for key in ("confirmation_hash", "handover_id", "handover_hash")}, "handover_at": handover["created_at"]})
        handovers[listing] = handover
        maximum = min(maximum, doc["valid_until"], handover["source_valid_until"], history["proof"]["source_valid_until"], key=instant)
        original_maximum = min(original_maximum, doc["valid_until"], handover["source_valid_until"], baseline["original_history"]["source_valid_until"], key=instant)
    return {"model": model, "definition": definition, "reference": reference, "history": history, "corrections": corrections,
        "handovers": handovers, "maximum": maximum, "original_maximum": original_maximum}


def _basis(db, workspace, actor, model_id, references, checked, frozen, stop_requested=None):
    basis = _correction_basis(db, workspace, actor, model_id, references, checked, frozen, stop_requested)
    history = basis["history"]
    head = db.execute("SELECT id,content_hash FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence DESC LIMIT 1", (workspace, model_id)).fetchone()
    _check(head is not None and head["id"] == history["proof"]["head_checkpoint_id"] and head["content_hash"] == content_hash(history["head"]), "LATEST_HEAD_CHANGED")
    control = db.execute("SELECT * FROM investor_model_controls WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1", (workspace, model_id)).fetchone()
    _check(control is not None and control["created_at"] <= frozen, "CONTROL_CHANGED")
    funding = read_planned_funding_monitor(db, workspace, actor, model_id, now=checked)
    frozen_funding = read_bound_planned_funding_monitor(db, workspace, actor, funding["request"]["binding"], evaluated_at=frozen, now=checked) if funding else None
    _check((funding["context_hash"] if funding else None) == (frozen_funding["context_hash"] if frozen_funding else None), "FUNDING_CHANGED")
    return {**basis, "control": {"id": control["id"], "content_hash": content_hash(dict(control))}, "funding": funding}


def _selected_correction_references(rows):
    _check(len(rows) <= MAX_CORRECTION_CANDIDATES, "CORRECTION_SELECTION_LIMIT")
    _check(rows and all(row["handover_id"] is not None for row in rows), "CORRECTIONS_NOT_READY")
    _check(len({row["correction_id"] for row in rows}) == len(rows), "CORRECTION_SELECTION_AMBIGUOUS")
    return [dict(row) for row in rows]


def _extend_capture_scope(covered, supplied):
    overlap = covered.keys() & supplied.keys()
    _check(all(covered[key] == supplied[key] for key in overlap), "CAPTURE_PRICES_CONFLICT")
    if supplied.keys() <= covered.keys(): return False
    _check(not overlap, "CAPTURE_SCOPE_AMBIGUOUS")
    covered.update(supplied)
    return True


def select_current_model_epoch_inputs(db, workspace, actor, model_id, *, now=None, stop_requested=None):
    """Select only retained, already approved inputs; never approve or admit them."""
    from .monitor_bootstrap import plan_bootstrap
    checked = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); managed._stopped(db, stop_requested)
        _check(not db.execute("SELECT 1 FROM investor_model_epochs WHERE workspace_id=? AND model_id=? LIMIT 1", (workspace, model_id)).fetchone(), "ALREADY_REGISTERED")
        rows = db.execute("""SELECT c.id correction_id,c.content_hash confirmation_hash,h.id handover_id,h.content_hash handover_hash
          FROM investor_correction_consents c LEFT JOIN investor_action_review_confirmations h
            ON h.workspace_id=c.workspace_id AND json_extract(h.document_json,'$.request.correction_id')=c.id
            AND json_extract(h.document_json,'$.schema_version')='investor-corrected-action-handover-confirmation-v1' AND h.created_at<=?
          WHERE c.workspace_id=? AND c.model_id=? AND c.created_at<=? AND c.valid_until>?
          ORDER BY c.id,h.id LIMIT ?""", (checked, workspace, model_id, checked, checked, MAX_CORRECTION_CANDIDATES + 1)).fetchall()
        references = _selected_correction_references(rows)
        basis = _basis(db, workspace, actor, model_id, references, checked, checked, stop_requested)
        managed._stopped(db, stop_requested)
        _, definition, _, windows, _ = plan_bootstrap(db, workspace, model_id, checked)
        _check(definition == basis["definition"], "MODEL_CHANGED")
        head = db.execute("SELECT input_id FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?",
            (basis["history"]["proof"]["head_checkpoint_id"], workspace, model_id)).fetchone()
        prior = db.execute("SELECT document_json,content_hash FROM investor_monitor_evidence_inputs WHERE id=? AND workspace_id=? AND model_id=?",
            (head["input_id"], workspace, model_id)).fetchone() if head else None
        _check(prior is not None, "LATEST_HEAD_CHANGED")
        original = _object(prior["document_json"])
        _check(content_hash(original) == prior["content_hash"], "LATEST_HEAD_CHANGED")
        result = []
        for selected in windows:
            managed._stopped(db, stop_requested); window = deepcopy(selected)
            listing = resolve_review(db, workspace, window["action_review_ids"][0], "actions", now=checked)["facts"]["listing_id"]
            market = next(row["market"] for row in definition["targets"] if row["listing_id"] == listing)
            start = instant(basis["history"]["head"]["market_cutoffs"][market]).astimezone(ZoneInfo(_MARKETS[market][0])).date().isoformat()
            _check(start <= window["end_date"], "CLOSE_REGRESSION")

            def scope(identifier, confirmed):
                value = (resolve_confirmed_capture if confirmed else resolve_capture)(db, workspace, identifier, now=checked)
                return {(row["listing_id"], row["observed_at"]): row["value"] for row in value["records"] if start <= row["observed_at"] <= window["end_date"]}

            covered = {}
            for key in ("capture_ids", "confirmed_capture_ids"):
                for identifier in window.get(key, []): _extend_capture_scope(covered, scope(identifier, key == "confirmed_capture_ids"))
            for segment in original["segments"]:
                snapshot = segment["snapshot"]
                calendars = [resolve_review(db, workspace, ref["review_id"], "calendar", now=checked)["facts"]["market"]
                    for ref in snapshot["review_refs"] if _review_kind(db, workspace, ref["review_id"]) == "calendar"]
                _check(len(calendars) == 1, "CALENDAR_SCOPE")
                if calendars[0] != market: continue
                for ref in snapshot["capture_refs"]:
                    key = "confirmed_capture_ids" if ref.get("kind") == "confirmed_sdk" else "capture_ids"
                    supplied = scope(ref["capture_id"], key == "confirmed_capture_ids")
                    if not _extend_capture_scope(covered, supplied): continue
                    window.setdefault(key, []).append(ref["capture_id"])
            for key in ("capture_ids", "confirmed_capture_ids"):
                window[key] = sorted(set(window.get(key, [])))
            window["start_date"] = start; result.append(window)
        managed._stopped(db, stop_requested)
        return references, result


def _assemble(db, workspace, actor, epoch_id, basis, raw, checked, frozen, maximum=None):
    ceiling = basis["maximum"] if maximum is None else maximum
    _check(instant(checked) < instant(ceiling) <= instant(basis["maximum"]), "EXPIRED")
    settings = _settings(db, workspace, basis["model"], basis["definition"], basis["reference"], checked)
    return _assemble_evidence(db, workspace, actor, epoch_id, basis, raw, checked, frozen, checked, settings, ceiling)


def _assemble_evidence(db, workspace, actor, epoch_id, basis, raw, checked, frozen, calculated, settings, ceiling):
    """Shared derivation only; callers authenticate current or recorded context."""
    definition, history = basis["definition"], basis["history"]
    _check(raw["document"]["schema_version"] == "investor-monitor-data-input-v4" and raw["projection"]["schema_version"] == "investor-monitor-data-projection-v2")
    # Original cost metadata is authenticated by the normal source replay at its
    # recorded creation time; all raw reference access uses checked, never frozen.
    _check(raw["document"]["settings"] == settings, "SETTINGS_CHANGED")
    check_reference_listing_identity(basis["reference"]["targets"], raw["catalog"])
    _check(not raw["projection"]["quality_gaps"] and instant(calculated) < instant(raw["projection"]["valid_until"]), "CURRENT_INPUTS_NOT_READY")
    selected = {}
    for segment in raw["document"]["segments"]:
        for ref in segment["snapshot"]["review_refs"]:
            if _review_kind(db, workspace, ref["review_id"]) != "actions": continue
            source = resolve_review(db, workspace, ref["review_id"], "actions", now=checked); listing = source["facts"]["listing_id"]
            _check(listing not in selected or selected[listing] == source, "ACTION_SELECTION_CHANGED"); selected[listing] = source
    for listing, handover in basis["handovers"].items():
        _check(listing in selected and raw["catalog"][listing]["market"] == "US" and raw["catalog"][listing]["currency"] == "USD", "ACTION_SELECTION_CHANGED")
        _descendant(db, workspace, actor, selected[listing]["review"]["id"], handover, checked)
    changed = {entry["baseline"]["approved_facts"]["listing_id"] for entry in basis["corrections"]}
    carry = sorted([row for row in history["original_actions"] if row["listing_id"] not in changed] + [row for entry in basis["corrections"]
        for row in entry["corrected_actions"] if row["listing_id"] == entry["baseline"]["approved_facts"]["listing_id"]], key=lambda row: row["id"])
    indexed = {row["id"]: row for row in carry}; targets = {row["listing_id"]: row for row in definition["targets"]}; future = []
    economics = lambda row: {key: value for key, value in row.items() if key != "known_at"}
    for action in raw["projection"]["corporate_actions"]:
        cutoff = history["head"]["market_cutoffs"][targets[action["listing_id"]]["market"]]
        if instant(action["effective_at"]) > instant(cutoff): future.append(action); continue
        old = indexed.get(action["id"])
        _check(old is not None and economics(old) == economics(action) and instant(old["known_at"]) <= instant(action["known_at"]), "HISTORICAL_ACTION_CHANGED")
    economic = deepcopy(raw["projection"]); economic["corporate_actions"] = sorted(carry + future, key=lambda row: row["id"])
    _check(instant(frozen) <= instant(calculated) <= instant(checked) and instant(calculated) < instant(ceiling), "EXPIRED")
    economic["valid_until"] = min(economic["valid_until"], ceiling, key=instant)
    if basis["funding"]: economic["valid_until"] = min(economic["valid_until"], basis["funding"]["projection"]["valid_until"], key=instant)
    for row in [*economic["quotes"], *economic["fx"]]: row["valid_until"] = min(row["valid_until"], ceiling, key=instant)
    kernel = {"schema_version": "investor-model-epoch-transition-input-v1", "epoch_id": epoch_id,
        "history": {**{key: history[key] for key in FIELDS}, "corrected_coverage": history["head_projection"]["corporate_action_coverage"]},
        "corrections": basis["corrections"], "projection": economic, "input_hash": content_hash(raw["document"]), "planned_funding": basis["funding"]["request"] if basis["funding"] else None, "now": calculated}
    first = advance_corrected_model_epoch(kernel)
    epoch = {"schema_version": "investor-model-epoch-definition-v1", "epoch_id": epoch_id, "workspace_id": workspace, "actor_id": actor,
        "model_id": definition["model_id"], "model_hash": content_hash(definition), "model_control": basis["control"], "original_head_id": history["proof"]["head_checkpoint_id"],
        "binding": first["epoch_binding"], "created_at": frozen, "valid_until": ceiling, "purpose": "private_economic_epoch_basis_not_trading_authority"}
    _validate(epoch, "definition"); ref = {"id": epoch_id, "content_hash": content_hash(epoch)}
    projection = {"schema_version": "investor-monitor-data-projection-v4", "epoch": ref,
        "knowledge_protocol": "approved_economic_restatement_and_recorded_carry_not_pit", "economic_projection": economic}
    document = {**deepcopy(raw["document"]), "schema_version": "investor-monitor-data-input-v6", "epoch": ref,
        "audited_projection_hash": raw["document"]["projection_hash"], "audited_valid_until": raw["document"]["valid_until"],
        "carry_hash": content_hash(carry), "carry_count": len(carry), "projection_hash": content_hash(projection), "valid_until": min(raw["document"]["valid_until"], ceiling, key=instant)}
    if basis["funding"]: document.update(funding_binding=basis["funding"]["request"]["binding"], funding_context_hash=basis["funding"]["context_hash"])
    _validate(document, "input"); _validate(projection, "projection")
    kernel.update(projection=projection, input_hash=content_hash(document)); candidate = advance_corrected_model_epoch(kernel)
    proof = {"schema_version": "investor-model-epoch-source-proof-v1", "workspace_id": workspace, "actor_id": actor, "model_id": definition["model_id"], "epoch": ref,
        "input_hash": content_hash(document), "projection_hash": content_hash(projection), "original_head_id": epoch["original_head_id"], "original_chain_hash": history["proof"]["checkpoint_chain_hash"],
        "checked_at": calculated, "valid_until": economic["valid_until"], "status": "qualified_sources_prepared_not_registered",
        "coverage_basis": "selected_reports_and_owner_assumptions_not_objective_absence", "source_evidence_verified": True,
        **{key: False for key in ("epoch_registered", "current_source_eligibility_restored", "checkpoint_created", "monitoring_resumed", "trading_permission")},
        "provider_calls": 0, "database_writes": 0, "distribution": "private_owner_only_not_ai"}
    _validate(proof, "proof")
    return {"epoch_definition": epoch, "input": document, "projection": projection, "proof": proof, "kernel_input": kernel, "candidate": candidate}


def prepare_model_epoch_source(db, workspace, actor, model_id, epoch_id, references, windows, *, now=None, stop_requested=None):
    checked = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); managed._stopped(db, stop_requested)
        basis = _basis(db, workspace, actor, model_id, references, checked, checked, stop_requested)
        settings = _settings(db, workspace, basis["model"], basis["definition"], basis["reference"], checked)
        raw = build_monitor_data(db, workspace, basis["definition"], windows, settings, now=checked, audited_action_knowledge=True)
        managed._stopped(db, stop_requested)
        result = _assemble(db, workspace, actor, epoch_id, basis, raw, checked, checked)
        managed._stopped(db, stop_requested); return result


def audited_epoch_input(document):
    _validate(document, "input"); raw = deepcopy(document)
    for key in ("epoch", "audited_projection_hash", "audited_valid_until", "carry_hash", "carry_count", "funding_binding", "funding_context_hash"): raw.pop(key, None)
    raw.update(schema_version="investor-monitor-data-input-v4", projection_hash=document["audited_projection_hash"], valid_until=document["audited_valid_until"])
    validate_monitor_data_document(raw); return raw


def replay_model_epoch_source(db, workspace, actor, epoch, document, *, now=None, stop_requested=None):
    checked = _clock(now); _validate(epoch, "definition"); _validate(document, "input")
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor)
        managed._stopped(db, stop_requested)
        _check(epoch["workspace_id"] == workspace and epoch["actor_id"] == actor and epoch["model_id"] == document["model_id"]
            and epoch["created_at"] == document["created_at"] <= checked and document["epoch"] == {"id": epoch["epoch_id"], "content_hash": content_hash(epoch)}, "EPOCH_CHANGED")
        refs = [{key: entry[key] for key in ("correction_id", "confirmation_hash", "handover_id", "handover_hash")} for entry in epoch["binding"]["corrections"]]
        basis = _basis(db, workspace, actor, epoch["model_id"], refs, checked, document["created_at"], stop_requested)
        raw = resolve_monitor_data(db, workspace, basis["definition"], audited_epoch_input(document), now=checked)
        _check(raw["unavailable_reason"] is None, raw["unavailable_reason"] or "CURRENT_INPUTS_NOT_READY")
        result = _assemble(db, workspace, actor, epoch["epoch_id"], basis, raw, checked, document["created_at"], epoch["valid_until"])
        _check(result["epoch_definition"] == epoch and result["input"] == document, "DERIVATION_CHANGED")
        managed._stopped(db, stop_requested)
        return result
