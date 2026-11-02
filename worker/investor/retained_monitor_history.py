"""Read recorded model economics from actual retained inputs, never resume them."""

from copy import deepcopy

from worker.accounting.decimal_math import canonical, decimal, financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import canonical_json, content_hash, transaction
from .data_evidence import _assert, _fact_validation_scope, _owner, resolve_capture, resolve_review, review_header
from .data_snapshot import _assemble_dataset
from .evidence_monitor_runtime import _funding_at, _payload
from .legacy_action_transition import LEGACY, _carry_actions, _check_unprocessed_history, _stop
from .model_runtime import _clock, _latest
from .model_state import advance_evidence_model
from .monitor_admission import current_monitor_model, monitor_evidence_document
from .monitor_costs import current_settings, verify_settings
from .monitor_data import QUALIFICATION, _settings, check_reference_listing_identity, project_monitor_data, validate_monitor_data_document
from .retained_action_evidence import read_retained_action_evidence
from .retained_action_lineage import retained_action_knowledge
from .source_inputs import _review_kind


SCHEMA = "investor-retained-monitor-history.schema.json"


def _check(value):
    _assert(value, "INVESTOR_RETAINED_MONITOR_HISTORY_INVALID")


def _input(db, workspace, model_id, identifier, at):
    row, document = monitor_evidence_document(db, workspace, model_id, identifier, at)
    _check(canonical_json(document) == row["document_json"])
    return row, document


def _review(db, workspace, actor, ref, at, listing_review_id=None):
    kind = _review_kind(db, workspace, ref["review_id"])
    if kind == "actions":
        retained = read_retained_action_evidence(db, workspace, actor, ref["review_id"], now=at, listing_review_id=listing_review_id)
        value = {"review": retained["original_review"], "source": retained["original_source"], "facts": retained["original_facts"]}
        deadline = retained["proof"]["valid_until"]
    else:
        value = resolve_review(db, workspace, ref["review_id"], kind, now=at)
        deadline = value["review"]["valid_until"]
        if kind == "calendar":
            from .calendar_continuation import current_calendar_review
            current = current_calendar_review(db, workspace, ref["review_id"], at)
            deadline = min(deadline, current["review"]["valid_until"])
    _check(ref == {"review_id": value["review"]["id"], "review_hash": value["review"]["content_hash"],
        "source_id": value["source"]["id"], "source_hash": value["source"]["content_hash"]})
    return value, deadline


def _snapshot(db, workspace, actor, segment, at, frozen):
    from .confirmed_capture import resolve_confirmed_capture
    manifest = segment["snapshot"]
    audited = manifest["schema_version"] == "investor-monitor-source-snapshot-v2"
    confirmed = manifest["schema_version"] != "investor-data-snapshot-v1"
    validate_contract(manifest, "investor-monitor-source-snapshot-v2.schema.json" if audited else
        "investor-monitor-price-snapshot.schema.json" if confirmed else "investor-data-snapshot.schema.json")
    _check(manifest["workspace_id"] == workspace and manifest["created_at"] == frozen <= at and manifest["mode"] == "reconstructed")
    known = {ref["review_id"]: _review(db, workspace, actor, ref, at) for ref in manifest["review_refs"] if _review_kind(db, workspace, ref["review_id"]) != "actions"}
    listings = {row[0]["facts"]["listing_id"]: row[0]["review"]["id"] for row in known.values() if row[0]["source"]["kind"] == "listing"}
    resolved = []
    for ref in manifest["review_refs"]:
        if ref["review_id"] in known:
            resolved.append(known[ref["review_id"]]); continue
        identity = review_header(db, workspace, ref["review_id"], now=at)["facts"]["listing_id"]
        _check(identity in listings)
        resolved.append(_review(db, workspace, actor, ref, at, listings[identity]))
    reviews, deadlines = [row[0] for row in resolved], [row[1] for row in resolved]
    captures = []
    for ref in manifest["capture_refs"]:
        callback = confirmed and ref["kind"] == "confirmed_sdk"
        _check(not db.execute("SELECT 1 FROM " + ("investor_confirmed_purges" if callback else "investor_price_purges") + " WHERE capture_id=?", (ref["capture_id"],)).fetchone())
        if callback:
            value = resolve_confirmed_capture(db, workspace, ref["capture_id"], now=at)
            for binding in value["bindings"]:
                listing_id = binding["listing"]["facts"]["listing_id"]
                captures.append({"capture": {**value["capture"], "qualification": "isolated_official_sdk", "projection_sha256": value["capture"]["payload_sha256"]},
                    "capture_kind": "confirmed_sdk", "binding": binding, "records": [row for row in value["records"] if row["listing_id"] == listing_id]})
        else:
            value = resolve_capture(db, workspace, ref["capture_id"], now=at)
            captures.append({**value, "capture_kind": "historical_sdk"})
    actions = [row for row in reviews if row["source"]["kind"] == "actions"]
    rates = [row for row in reviews if row["source"]["kind"] == "fx"]
    availability, ancestry, knowledge_deadline = retained_action_knowledge(db, workspace, actor, actions, at, frozen, listings) if audited else (None, {}, None)
    if knowledge_deadline is not None: deadlines.append(knowledge_deadline)
    source = _assemble_dataset(captures, actions, rates, manifest["range_start"], manifest["range_end"], workspace, frozen,
        confirmed=any(row["capture_kind"] == "confirmed_sdk" for row in captures), availability=availability)
    _check(source["manifest"] == manifest and source["dataset_hash"] == segment["dataset_hash"]
        and content_hash(source["catalog"]) == segment["catalog_hash"] and at < source["valid_until"])
    return {**source, "reviews": reviews, "ancestry": ancestry, "read_valid_until": min(source["valid_until"], *deadlines)}


def _base_source(db, workspace, actor, definition, document, at, stop_requested=None):
    validate_monitor_data_document(document); _settings(document["settings"])
    _check(document["schema_version"] in LEGACY | {"investor-monitor-data-input-v4"}
        and document["workspace_id"] == workspace and document["model_id"] == definition["model_id"]
        and definition["created_at"] <= document["created_at"] <= at < document["valid_until"]
        and document["created_at"] < definition["valid_until"] and document["target_definition_hash"] == definition["target_definition_hash"])
    frozen = document["created_at"]; deadline = verify_settings(db, workspace, definition, document["settings"], frozen)
    sources, catalog, reviews, observations, sessions, markets, ancestry = [], {}, {}, {}, [], set(), {}
    for segment in document["segments"]:
        _stop(stop_requested); source = _snapshot(db, workspace, actor, segment, at, frozen); sources.append(source)
        scope = {row["market"] for row in source["catalog"].values()}
        _check(len(scope) == 1 and not scope & markets and not set(source["catalog"]) & set(catalog))
        markets.update(scope); catalog.update(source["catalog"]); ancestry.update(source["ancestry"])
        for row in source["reviews"]: reviews[row["review"]["id"]] = row
        for row in source["dataset"]["observations"]:
            _check(row["id"] not in observations or observations[row["id"]] == row); observations[row["id"]] = row
        sessions.extend(source["dataset"]["sessions"])
    _check(sources)
    merged = {"dataset": {"mode": "reconstructed", "observations": list(observations.values()), "sessions": sessions},
        "catalog": catalog, "valid_until": min(row["valid_until"] for row in sources)}
    audited = document["schema_version"] == "investor-monitor-data-input-v4"
    availability = [ref for row in sources for ref in row["manifest"]["action_availability_refs"]] if audited else None
    projection = project_monitor_data(definition, merged, list(reviews.values()), document["settings"], frozen,
        cost_deadline=deadline, action_availability=availability)
    version = "investor-monitor-data-input-v2" if any(row["manifest"]["schema_version"] == "investor-monitor-price-snapshot-v1" for row in sources) else "investor-monitor-data-input-v1"
    if "cost_assumptions" in document["settings"]: version = "investor-monitor-data-input-v3"
    if audited: version = "investor-monitor-data-input-v4"
    rebuilt = {"schema_version": version, "workspace_id": workspace, "model_id": definition["model_id"],
        "target_definition_hash": definition["target_definition_hash"], "source_qualification": QUALIFICATION,
        "segments": [{"snapshot": row["manifest"], "dataset_hash": row["dataset_hash"], "catalog_hash": content_hash(row["catalog"])}
            for row in sorted(sources, key=lambda row: row["manifest"]["capture_refs"][0]["capture_id"])],
        "settings": document["settings"], "projection_hash": content_hash(projection), "created_at": frozen,
        "valid_until": merged["valid_until"], "live_advice_eligible": False}
    _check(rebuilt == document)
    return {"document": rebuilt, "projection": projection, "catalog": catalog, "reviews": list(reviews.values()), "ancestry": ancestry,
        "read_valid_until": min(row["read_valid_until"] for row in sources)}


@financial
def _audited(definition, source):
    targets = {row["listing_id"]: row for row in definition["targets"]}
    refs = {(row["review_id"], row["event_id"]): row for segment in source["document"]["segments"] for row in segment["snapshot"]["action_availability_refs"]}
    actions = []
    for review in source["reviews"]:
        if review["source"]["kind"] != "actions": continue
        facts = review["facts"]; target = targets[facts["listing_id"]]
        for event in facts["events"]:
            common = {"listing_id": target["listing_id"], "known_at": refs[(review["review"]["id"], event["id"])]["known_at"]}
            if event["type"] == "split":
                actions.append({**common, "id": "split:" + event["id"], "kind": "split", "effective_at": _clock(event["at"]), "ratio": event["ratio"]})
            else:
                actions.extend(({**common, "id": "ex:" + event["id"], "kind": "dividend_ex", "effective_at": _clock(event["at"]),
                    "currency": target["currency"], "net_per_unit": canonical(decimal(event["gross_per_unit"]) - decimal(event["tax_per_unit"])),
                    "entitlement_id": "entitlement:" + event["id"], "tax_assumption_hash": content_hash({"tax_assumption": facts["tax_assumption"], "tax_per_unit": event["tax_per_unit"]})},
                    {**common, "id": "pay:" + event["id"], "kind": "dividend_payment", "effective_at": _clock(event["pay_at"]),
                    "currency": target["currency"], "entitlement_id": "entitlement:" + event["id"], "ex_at": _clock(event["at"])}))
    _check(len(actions) <= 20000 and len({row["id"] for row in actions}) == len(actions))
    return sorted(actions, key=lambda row: row["id"])


def _origin_pin(db, workspace, review, at):
    from . import managed_actions as managed
    if not review["review"]["id"].startswith(managed.PREFIX):
        return review["review"]["id"], review["review"]["content_hash"]
    row, _ = managed._publication_header(db, workspace, review["review"]["id"], at)
    _, policy, _ = managed._authority(db, workspace, row["authority_id"], at)
    return policy["base_review_id"], policy["base_review_hash"]


def _action_extension(db, workspace, previous, current, at):
    before = {row["facts"]["listing_id"]: row for row in previous["reviews"] if row["source"]["kind"] == "actions"}
    after = {row["facts"]["listing_id"]: row for row in current["reviews"] if row["source"]["kind"] == "actions"}
    _check(set(before) == set(after))
    for listing_id, review in before.items():
        selected = after[listing_id]; identifier, digest = _origin_pin(db, workspace, review, at)
        _check(current["ancestry"].get(selected["review"]["id"], {}).get(identifier) == digest
            and selected["facts"]["range_start"] <= review["facts"]["range_start"]
            and review["facts"]["range_end"] <= selected["facts"]["range_end"])


def _preview_scope(db, workspace, definition, previous, candidate, at):
    old, new = previous["document"], candidate["document"]
    _check(candidate["document"]["settings"] == current_settings(db, workspace, definition, old["settings"], new["created_at"])
        and len(old["segments"]) == len(new["segments"]))
    for before, after in zip(old["segments"], new["segments"]):
        original, selected = before["snapshot"], after["snapshot"]
        non_actions = lambda value: [row for row in value["review_refs"] if _review_kind(db, workspace, row["review_id"]) != "actions"]
        _check(non_actions(original) == non_actions(selected))
        expected = {**original, "schema_version": "investor-monitor-source-snapshot-v2", "created_at": new["created_at"],
            "capture_refs": [{"kind": "historical_sdk", **row} for row in original["capture_refs"]] if original["schema_version"] == "investor-data-snapshot-v1" else original["capture_refs"],
            "review_refs": selected["review_refs"], "action_availability_refs": selected["action_availability_refs"],
            "publication_times": "reconstructed_prices_and_audited_action_review_times_not_point_in_time", "use_scope": "monitor_only"}
        _check(expected == selected)
    _action_extension(db, workspace, previous, candidate, at)


def _bind_v5(db, workspace, definition, raw, context, at):
    receipt, ledger, state = context["receipt"], context["ledger"], context["state"]
    _check(context["admission"]["created_at"] <= raw["document"]["created_at"] <= at < receipt["valid_until"])
    _action_extension(db, workspace, context["candidate"], raw, at)
    actions = _audited(definition, raw); carry = _carry_actions(ledger, actions)
    _check(content_hash(carry) == receipt["carry_hash"] and len(carry) == receipt["carry_count"])
    _check_unprocessed_history(definition, state, ledger, actions)
    indexed = {row["id"]: row for row in actions}; projection = deepcopy(raw["projection"])
    for action in projection["corporate_actions"]:
        _check(action == indexed.get(action["id"]))
        if action["id"] in ledger: action["known_at"] = ledger[action["id"]]["action"]["known_at"]
    reference = {"id": receipt["confirmation_id"], "content_hash": content_hash(receipt)}
    projection.update(schema_version="investor-monitor-data-projection-v3", transition=reference,
        knowledge_protocol="owner_confirmed_legacy_accounting_carry_v1", valid_until=min(projection["valid_until"], receipt["valid_until"]))
    for row in [*projection["quotes"], *projection["fx"]]: row["valid_until"] = min(row["valid_until"], receipt["valid_until"])
    validate_contract(projection, "investor-monitor-data-projection-v3.schema.json")
    document = {**raw["document"], "schema_version": "investor-monitor-data-input-v5", "transition": reference,
        "audited_projection_hash": raw["document"]["projection_hash"], "audited_valid_until": raw["document"]["valid_until"],
        "projection_hash": content_hash(projection), "valid_until": min(raw["document"]["valid_until"], receipt["valid_until"])}
    validate_monitor_data_document(document)
    return {**raw, "document": document, "projection": projection}


def _source(db, workspace, actor, definition, document, at, bindings, protocols, ledger, stop_requested):
    if document["schema_version"] != "investor-monitor-data-input-v5":
        return _base_source(db, workspace, actor, definition, document, at, stop_requested)
    from .legacy_transition_source import _admission_header, audited_document
    from .legacy_transition_workflow import _confirmation_header, _preview_header
    _, receipt = _confirmation_header(db, workspace, actor, document["transition"]["id"])
    _check(document["transition"]["content_hash"] == content_hash(receipt) and receipt["model_hash"] == content_hash(definition)
        and receipt["model_id"] == definition["model_id"] and receipt["created_at"] <= at < receipt["valid_until"])
    _, admission = _admission_header(db, workspace, actor, receipt["confirmation_id"])
    sequence = receipt["checkpoint"]["sequence"]
    _check(type(sequence) is int and 1 <= sequence <= len(bindings) and all(protocol in LEGACY for protocol in protocols[:sequence]))
    head = bindings[sequence - 1]; state = _payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", head["id"], 4194304)
    _check(content_hash(state) == head["content_hash"] and receipt["checkpoint"] == {"id": head["id"], "sequence": sequence,
        "content_hash": head["content_hash"], "chain_hash": content_hash(bindings[:sequence]), "processed_actions_hash": content_hash(state["processed_actions"])})
    prefix = {key: ledger[key] for key in state["processed_actions"] if key in ledger}
    _check({key: content_hash(row["action"]) for key, row in prefix.items()} == state["processed_actions"])
    _, old = _input(db, workspace, definition["model_id"], receipt["legacy_input_id"], at)
    _check(old["schema_version"] in LEGACY and content_hash(old) == receipt["legacy_input_hash"]
        and receipt["valid_until"] == min(head["valid_until"], old["valid_until"], definition["valid_until"]))
    control = db.execute("SELECT * FROM investor_model_controls WHERE id=? AND workspace_id=? AND model_id=?", (receipt["control_id"], workspace, definition["model_id"])).fetchone()
    _check(control is not None and content_hash(dict(control)) == receipt["control_hash"] and control["created_at"] <= receipt["created_at"])
    _, preview, candidate_document = _preview_header(db, workspace, actor, receipt["preview_id"])
    previous = _base_source(db, workspace, actor, definition, old, at, stop_requested)
    candidate = _base_source(db, workspace, actor, definition, candidate_document, at, stop_requested)
    _preview_scope(db, workspace, definition, previous, candidate, at)
    actions = _audited(definition, candidate); carry = _carry_actions(prefix, actions)
    _check(content_hash(carry) == receipt["carry_hash"] and len(carry) == receipt["carry_count"])
    _check_unprocessed_history(definition, state, prefix, actions)
    _check(preview["proof"]["audited_projection_hash"] == content_hash(candidate["projection"]))
    context = {"receipt": receipt, "admission": admission, "ledger": prefix, "state": state, "candidate": candidate}
    _, root = _input(db, workspace, definition["model_id"], admission["input_id"], at)
    rebuilt_root = _bind_v5(db, workspace, definition, _base_source(db, workspace, actor, definition, audited_document(root), at, stop_requested), context, at)
    _check(rebuilt_root["document"] == root)
    rebuilt = _bind_v5(db, workspace, definition, _base_source(db, workspace, actor, definition, audited_document(document), at, stop_requested), context, at)
    _check(rebuilt["document"] == document)
    rebuilt["read_valid_until"] = min(rebuilt["read_valid_until"], previous["read_valid_until"], candidate["read_valid_until"], rebuilt_root["read_valid_until"], receipt["valid_until"])
    return rebuilt


def read_retained_monitor_history(db, workspace, actor, model_id, *, now=None, stop_requested=None):
    """Reprove every recorded source and state; never approve a changed event."""
    at = _clock(now)
    with transaction(db, immediate=False), _fact_validation_scope():
        _owner(db, workspace, actor); model, definition, reference = current_monitor_model(db, workspace, model_id, at)
        headers = db.execute("SELECT * FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence LIMIT 1001", (workspace, model_id)).fetchall()
        _check(0 < len(headers) <= 1000)
        previous, origin, first_projection, final_projection, ledger, bindings, protocols = None, None, None, None, {}, [], []
        expiry = read_deadline = definition["valid_until"]
        for sequence, header in enumerate(headers, 1):
            _stop(stop_requested)
            _check(header["sequence"] == sequence and header["previous_hash"] == (content_hash(previous) if previous else None)
                and header["created_at"] <= at < header["valid_until"]
                and not db.execute("SELECT 1 FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=?", (header["id"],)).fetchone())
            row, document = _input(db, workspace, model_id, header["input_id"], at)
            expiry = min(expiry, document["valid_until"]); _check(header["valid_until"] == expiry)
            source = _source(db, workspace, actor, definition, document, at, bindings, protocols, ledger, stop_requested)
            read_deadline = min(read_deadline, source["read_valid_until"])
            check_reference_listing_identity(reference["targets"], source["catalog"])
            verify_settings(db, workspace, definition, document["settings"], header["created_at"])
            stored = _payload(db, "investor_evidence_checkpoint_payloads", "checkpoint_id", header["id"], 4194304)
            funding = _funding_at(db, workspace, stored["funding_binding"], header["created_at"], at) if stored.get("schema_version") == "investor-evidence-model-checkpoint-v3" else None
            rebuilt = advance_evidence_model(definition, source["projection"], previous, header["created_at"], input_hash=row["content_hash"], planned_funding=funding["request"] if funding else None)
            _check(rebuilt["checkpoint"] == stored and content_hash(stored) == header["content_hash"]
                and stored["projection_hash"] == header["projection_hash"] == content_hash(source["projection"]))
            for action in source["projection"]["corporate_actions"]:
                _check(stored["processed_actions"].get(action["id"]) == content_hash(action))
                ledger.setdefault(action["id"], {"action": action, "input_id": row["id"], "input_hash": row["content_hash"]})
            _check({key: content_hash(value["action"]) for key, value in ledger.items()} == stored["processed_actions"])
            bindings.append({**dict(header), "input_hash": row["content_hash"]}); protocols.append(document["schema_version"])
            if origin is None: origin, first_projection = stored, source["projection"]
            previous, final_projection = stored, source["projection"]
        control = _latest(db, "investor_model_controls", model_id, "version DESC")
        _check(control is not None and control["created_at"] <= at)
        _stop(stop_requested)
        actions = [value["action"] for _, value in sorted(ledger.items())]
        proof = {"schema_version": "investor-retained-monitor-history-v1", "workspace_id": workspace, "actor_id": actor, "model_id": model_id,
            "model_hash": model["content_hash"], "control_hash": content_hash(dict(control)),
            "origin_checkpoint_id": bindings[0]["id"], "head_checkpoint_id": bindings[-1]["id"], "head_checkpoint_sequence": len(bindings),
            "checkpoint_chain_hash": content_hash(bindings), "original_actions_hash": content_hash(actions),
            "input_bindings": [{"checkpoint_id": row["id"], "sequence": row["sequence"], "checkpoint_hash": row["content_hash"],
                "input_id": row["input_id"], "input_hash": row["input_hash"], "input_protocol": protocol, "projection_hash": row["projection_hash"],
                "created_at": row["created_at"], "valid_until": row["valid_until"]} for row, protocol in zip(bindings, protocols)],
            "checked_at": at, "source_valid_until": min(expiry, read_deadline), "purpose": "recorded_history_comparison_only",
            "status": "original_history_replayed_not_recovered", "original_inputs_replayed": True, "original_states_replayed": True,
            "original_knowledge_replayed": True, "reference_source_current_at_check": True, "corrected_source_evidence_verified": False,
            "current_source_eligibility_restored": False, "economic_correction_approved": False, "checkpoint_created": False,
            "monitoring_resumed": False, "historical_observations_rewritten": False, "trading_permission": False,
            "provider_calls": 0, "database_writes": 0, "distribution": "private_owner_only_not_ai"}
        validate_contract(proof, SCHEMA)
        return {"definition": definition, "origin": origin, "head": previous, "origin_projection": first_projection,
            "head_projection": final_projection, "original_actions": actions, "proof": proof}
