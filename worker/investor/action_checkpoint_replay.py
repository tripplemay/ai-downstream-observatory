"""Replay immutable v4 checkpoints through proven extensions, never admit old input."""

from contextvars import ContextVar
from copy import deepcopy

from worker.orchestration.db import content_hash, transaction
from .data_evidence import _assert, _fact_validation_scope

_SCOPE = ContextVar("investor_action_checkpoint_replay", default=None)


def checkpoint_action_review(db, workspace, identifier, kind, at):
    scope = _SCOPE.get()
    if scope is None or scope[0] is not db or scope[1] != workspace or scope[2] != at or kind != "actions": return None
    value = scope[3].get(identifier)
    return deepcopy(value) if value is not None else None


def replay_checkpoint_monitor_source(db, workspace, definition, checkpoint, document, now):
    from .action_review_selection import check_action_review_extension, check_paused_checkpoint_extension, checkpoint_review_needs_replay, retired_action_review
    from . import managed_actions as managed
    from .monitor_admission import monitor_evidence_document
    from .monitor_data import resolve_monitor_data
    from .reviewed_actions import read_historical_action_review
    from .data_evidence import resolve_review
    with transaction(db, immediate=False), _fact_validation_scope():
        original = resolve_monitor_data(db, workspace, definition, document, now=now, evaluated_at=checkpoint["created_at"])
        if original["unavailable_reason"] != "REFERENCE_SOURCE_NO_LONGER_CURRENT" or document["schema_version"] != "investor-monitor-data-input-v4": return original
        stored = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE id=? AND workspace_id=? AND model_id=?",
            (checkpoint["id"], workspace, definition["model_id"])).fetchone()
        _assert(stored is not None and dict(stored) == dict(checkpoint) and now < stored["valid_until"])
        _, bound = monitor_evidence_document(db, workspace, definition["model_id"], stored["input_id"], now)
        _assert(bound == document and document["projection_hash"] == stored["projection_hash"]
            and document["created_at"] <= stored["created_at"], "INVESTOR_MONITOR_CHECKPOINT_INPUT_CHANGED")
        allowed = {}
        for segment in document["segments"]:
            snapshot = segment["snapshot"]
            for ref in snapshot["review_refs"]:
                identifier = ref["review_id"]
                if not checkpoint_review_needs_replay(db, workspace, identifier, now): continue
                previous = read_historical_action_review(db, workspace, identifier, now) if identifier.startswith(managed.PREFIX) else resolve_review(db, workspace, identifier, "actions", now=now)
                _assert(previous["review"]["content_hash"] == ref["review_hash"] and previous["source"]["id"] == ref["source_id"]
                    and previous["source"]["content_hash"] == ref["source_hash"], "INVESTOR_MONITOR_CHECKPOINT_INPUT_CHANGED")
                candidates = [value for value in managed.current_action_reviews(db, workspace, [previous["facts"]["listing_id"]], now)
                    if value["facts"]["range_start"] <= snapshot["range_start"] <= snapshot["range_end"] <= value["facts"]["range_end"]]
                _assert(len(candidates) == 1, "INVESTOR_MONITOR_CHECKPOINT_SUCCESSION_AMBIGUOUS")
                check_extension = check_action_review_extension if retired_action_review(db, workspace, identifier, now) else check_paused_checkpoint_extension
                check_extension(db, workspace, previous, candidates[0], now, start_date=snapshot["range_start"], end_date=snapshot["range_end"])
                allowed[identifier] = previous
        if not allowed: return original
        token = _SCOPE.set((db, workspace, now, allowed))
        try:
            rebuilt = resolve_monitor_data(db, workspace, definition, document, now=now, evaluated_at=stored["created_at"])
            if rebuilt["unavailable_reason"] is None:
                _assert(content_hash(rebuilt["projection"]) == stored["projection_hash"], "INVESTOR_MONITOR_CHECKPOINT_INPUT_CHANGED")
            return rebuilt
        finally: _SCOPE.reset(token)
