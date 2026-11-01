"""Read-only legacy transition evidence, never a monitoring input or approval."""

from copy import deepcopy

from worker.accounting.decimal_math import canonical, decimal, financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import content_hash, instant, transaction
from .data_evidence import _assert, _fact_validation_scope, _owner, resolve_review
from .evidence_monitor_runtime import _funding_at, _payload
from .model_runtime import _clock, _latest
from .model_state import advance_evidence_model
from .monitor_admission import current_monitor_model, latest_monitor_evidence, monitor_evidence_document
from .monitor_data import build_monitor_data, check_reference_listing_identity, resolve_monitor_data
from .runtime import _milliseconds


LEGACY = {"investor-monitor-data-input-v1", "investor-monitor-data-input-v2", "investor-monitor-data-input-v3"}
SCHEMA = "investor-legacy-action-transition-preview.schema.json"


def _stop(stop_requested):
    if stop_requested and stop_requested(): _assert(False, "WORKER_STOP_REQUESTED")


def _compare_original_input(db, workspace, definition, source, document, at):
    """Exact admitted legacy bytes under verified successors, for comparison only."""
    from . import managed_actions as managed
    from .action_checkpoint_replay import _SCOPE
    from .action_review_selection import check_action_review_extension, check_paused_checkpoint_extension, checkpoint_review_needs_replay, retired_action_review
    from .reviewed_actions import read_historical_action_review
    row, bound = monitor_evidence_document(db, workspace, definition["model_id"], source["id"], at)
    _assert(dict(row) == dict(source) and bound == document and document["schema_version"] in LEGACY,
        "LEGACY_TRANSITION_ORIGINAL_INPUT_CHANGED")
    original = resolve_monitor_data(db, workspace, definition, document, now=at, evaluated_at=document["created_at"])
    if original["unavailable_reason"] != "REFERENCE_SOURCE_NO_LONGER_CURRENT": return original
    allowed = {}
    for segment in document["segments"]:
        snapshot = segment["snapshot"]
        for ref in snapshot["review_refs"]:
            identifier = ref["review_id"]
            if not checkpoint_review_needs_replay(db, workspace, identifier, at): continue
            previous = read_historical_action_review(db, workspace, identifier, at) if identifier.startswith(managed.PREFIX) else resolve_review(db, workspace, identifier, "actions", now=at)
            _assert(previous["review"]["content_hash"] == ref["review_hash"] and previous["source"]["id"] == ref["source_id"]
                and previous["source"]["content_hash"] == ref["source_hash"], "LEGACY_TRANSITION_ORIGINAL_INPUT_CHANGED")
            current = [value for value in managed.current_action_reviews(db, workspace, [previous["facts"]["listing_id"]], at)
                if value["facts"]["range_start"] <= snapshot["range_start"] <= snapshot["range_end"] <= value["facts"]["range_end"]]
            _assert(len(current) == 1, "LEGACY_TRANSITION_SUCCESSION_AMBIGUOUS")
            extension = check_action_review_extension if retired_action_review(db, workspace, identifier, at) else check_paused_checkpoint_extension
            extension(db, workspace, previous, current[0], at, start_date=snapshot["range_start"], end_date=snapshot["range_end"])
            allowed[identifier] = previous
    if not allowed: return original
    token = _SCOPE.set((db, workspace, at, allowed))
    try:
        return resolve_monitor_data(db, workspace, definition, document, now=at, evaluated_at=document["created_at"])
    finally: _SCOPE.reset(token)


def _original_chain(db, workspace, definition, at, stop_requested):
    from .monitor_costs import verify_settings
    headers = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence LIMIT 1001",
        (workspace, definition["model_id"])).fetchall()
    _assert(0 < len(headers) <= 1000, "LEGACY_TRANSITION_CHECKPOINT_CHAIN_REQUIRED")
    previous, ledger, bindings, expiry = None, {}, [], definition["valid_until"]
    for sequence, header in enumerate(headers, 1):
        _stop(stop_requested)
        _assert(header["sequence"] == sequence and header["previous_hash"] == (content_hash(previous) if previous else None)
            and header["created_at"] <= at < header["valid_until"], "LEGACY_TRANSITION_CHECKPOINT_CHAIN_CHANGED")
        _assert(not db.execute("SELECT 1 FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=?", (header["id"],)).fetchone(),
            "LEGACY_TRANSITION_CHECKPOINT_PAYLOAD_PURGED")
        source, document = monitor_evidence_document(db, workspace, definition["model_id"], header["input_id"], at)
        _assert(document["schema_version"] in LEGACY, "LEGACY_TRANSITION_LEGACY_INPUT_REQUIRED")
        expiry = min(expiry, document["valid_until"])
        _assert(header["valid_until"] == expiry, "LEGACY_TRANSITION_CHECKPOINT_CHAIN_CHANGED")
        replay = _compare_original_input(db, workspace, definition, source, document, at)
        _assert(replay["unavailable_reason"] is None, replay["unavailable_reason"] or "LEGACY_TRANSITION_ORIGINAL_INPUT_CHANGED")
        verify_settings(db, workspace, definition, document["settings"], header["created_at"])
        stored = _payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", header["id"], 4194304)
        funding = _funding_at(db, workspace, stored["funding_binding"], header["created_at"], at) if stored.get("schema_version") == "investor-evidence-model-checkpoint-v3" else None
        rebuilt = advance_evidence_model(definition, replay["projection"], previous, header["created_at"], input_hash=source["content_hash"],
            planned_funding=funding["request"] if funding else None)
        _assert(rebuilt["checkpoint"] == stored and content_hash(stored) == header["content_hash"]
            and stored["projection_hash"] == header["projection_hash"] == content_hash(replay["projection"]),
            "LEGACY_TRANSITION_CHECKPOINT_REPLAY_CHANGED")
        for action in replay["projection"]["corporate_actions"]:
            _assert(stored["processed_actions"].get(action["id"]) == content_hash(action), "LEGACY_TRANSITION_ACTION_LEDGER_CHANGED")
            ledger.setdefault(action["id"], {"action": action, "input_id": source["id"], "input_hash": source["content_hash"]})
        _assert({key: content_hash(value["action"]) for key, value in ledger.items()} == stored["processed_actions"],
            "LEGACY_TRANSITION_ACTION_LEDGER_CHANGED")
        bindings.append({**dict(header), "input_hash": source["content_hash"]})
        previous = stored
    return previous, ledger, bindings


@financial
def _audited_actions(db, workspace, definition, document, at):
    """Compare reported events even when stale quotes suppress projection coverage."""
    from .source_inputs import _review_kind
    targets = {row["listing_id"]: row for row in definition["targets"]}
    refs = {(row["review_id"], row["event_id"]): row for segment in document["segments"] for row in segment["snapshot"]["action_availability_refs"]}
    reviews, result = {}, []
    for segment in document["segments"]:
        for ref in segment["snapshot"]["review_refs"]:
            if _review_kind(db, workspace, ref["review_id"]) == "actions":
                reviews[ref["review_id"]] = resolve_review(db, workspace, ref["review_id"], "actions", now=at)
    for identifier, review in sorted(reviews.items()):
        facts = review["facts"]; target = targets[facts["listing_id"]]
        for event in facts["events"]:
            known = refs[(identifier, event["id"])]["known_at"]
            common = {"listing_id": target["listing_id"], "known_at": known}
            if event["type"] == "split":
                result.append({**common, "id": "split:" + event["id"], "kind": "split", "effective_at": _milliseconds(event["at"]), "ratio": event["ratio"]})
            else:
                result.extend(({**common, "id": "ex:" + event["id"], "kind": "dividend_ex", "effective_at": _milliseconds(event["at"]),
                    "currency": target["currency"], "net_per_unit": canonical(decimal(event["gross_per_unit"]) - decimal(event["tax_per_unit"])),
                    "entitlement_id": "entitlement:" + event["id"], "tax_assumption_hash": content_hash({"tax_assumption": facts["tax_assumption"], "tax_per_unit": event["tax_per_unit"]})},
                    {**common, "id": "pay:" + event["id"], "kind": "dividend_payment", "effective_at": _milliseconds(event["pay_at"]),
                    "currency": target["currency"], "entitlement_id": "entitlement:" + event["id"], "ex_at": _milliseconds(event["at"])}))
    _assert(len(result) <= 20000 and len({row["id"] for row in result}) == len(result), "LEGACY_TRANSITION_ACTION_LIMIT")
    return sorted(result, key=lambda row: row["id"])


def _carry_actions(ledger, audited):
    current = {row["id"]: row for row in audited}
    _assert(len(current) == len(audited), "LEGACY_TRANSITION_ACTION_DUPLICATE")
    result = []
    for identifier, bound in sorted(ledger.items()):
        original, replacement = bound["action"], current.get(identifier)
        _assert(replacement is not None, "LEGACY_TRANSITION_ACTION_HISTORY_MISSING")
        _assert({key: value for key, value in original.items() if key != "known_at"}
            == {key: value for key, value in replacement.items() if key != "known_at"}, "LEGACY_TRANSITION_ACTION_ECONOMICS_CHANGED")
        _assert(instant(replacement["known_at"]) <= instant(original["known_at"]), "LEGACY_TRANSITION_ACTION_KNOWLEDGE_LATER")
        result.append({"id": identifier, "original_input_id": bound["input_id"], "original_input_hash": bound["input_hash"],
            "original_action_hash": content_hash(original), "audited_action_hash": content_hash(replacement),
            "recorded_known_at": original["known_at"], "audited_known_at": replacement["known_at"]})
    return result


def _check_unprocessed_history(definition, previous, ledger, audited):
    markets = {target["listing_id"]: target["market"] for target in definition["targets"]}
    for action in audited:
        market = markets[action["listing_id"]]
        _assert(action["id"] in ledger or not instant(previous["initialized_at"][market]) < instant(action["effective_at"]) <= instant(previous["market_cutoffs"][market]),
            "LEGACY_TRANSITION_ACTION_RESTATEMENT_REQUIRED")


def preview_legacy_action_transition(db, workspace, actor, model_id, *, now=None, stop_requested=None):
    """Reconstruct comparison evidence only; a future explicit protocol is required."""
    from .confirmed_feed import _refresh_action_windows, _windows
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); _stop(stop_requested)
        model, definition, reference = current_monitor_model(db, workspace, model_id, at)
        source = latest_monitor_evidence(db, workspace, model_id)
        _assert(source is not None, "LEGACY_TRANSITION_LEGACY_INPUT_REQUIRED")
        _, document = monitor_evidence_document(db, workspace, model_id, source["id"], at)
        _assert(document["schema_version"] in LEGACY, "LEGACY_TRANSITION_LEGACY_INPUT_REQUIRED")
        control = _latest(db, "investor_model_controls", model_id, "version DESC")
        _assert(control is not None and control["created_at"] <= at, "LEGACY_TRANSITION_CONTROL_CHANGED")
        previous, ledger, bindings = _original_chain(db, workspace, definition, at, stop_requested)
        original = _compare_original_input(db, workspace, definition, source, document, at)
        _assert(original["unavailable_reason"] is None, original["unavailable_reason"] or "LEGACY_TRANSITION_ORIGINAL_INPUT_CHANGED")
        windows = _windows(db, workspace, document)
        _refresh_action_windows(db, workspace, definition, windows, at); _stop(stop_requested)
        candidate = build_monitor_data(db, workspace, definition, [window for _, window in windows], deepcopy(document["settings"]),
            now=at, audited_action_knowledge=True)
        check_reference_listing_identity(reference["targets"], candidate["catalog"])
        audited = _audited_actions(db, workspace, definition, candidate["document"], at)
        carry = _carry_actions(ledger, audited)
        _check_unprocessed_history(definition, previous, ledger, audited)
        result = {"schema_version": "investor-legacy-action-transition-preview-v1", "workspace_id": workspace, "model_id": model_id,
            "model_hash": model["content_hash"], "control_hash": content_hash(dict(control)), "legacy_input_id": source["id"],
            "legacy_input_hash": source["content_hash"], "settings_hash": content_hash(document["settings"]),
            "checkpoint": {"id": bindings[-1]["id"], "sequence": previous["sequence"], "content_hash": content_hash(previous),
                "chain_hash": content_hash(bindings), "processed_actions_hash": content_hash(previous["processed_actions"])},
            "audited_document_hash": candidate["content_hash"], "audited_projection_hash": content_hash(candidate["projection"]),
            "carry_forward": carry, "projection_quality_gaps": candidate["projection"]["quality_gaps"],
            "checked_at": at, "source_valid_until": min(bindings[-1]["valid_until"], document["valid_until"], candidate["document"]["valid_until"], definition["valid_until"]),
            "status": "awaiting_explicit_protocol_confirmation", "admission_performed": False, "live_advice_eligible": False}
        validate_contract(result, SCHEMA); _stop(stop_requested)
        return result
