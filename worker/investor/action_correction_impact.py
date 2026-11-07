"""Source-bound hypothetical correction economics; no approval, job or publication."""

from copy import deepcopy
from decimal import Decimal, localcontext

from worker.accounting import fact_decimal
from worker.accounting.decimal_math import canonical
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, transaction
from . import action_review_workflow as review, managed_actions as managed
from .action_review_draft import _prepare_action_review_draft
from .action_restatement_kernel import compare_action_restatement
from .data_evidence import _fact_validation_scope, _owner, validate_facts
from .model_runtime import _clock
from .retained_monitor_history import read_retained_monitor_history
from .reviewed_actions import _fact_events


SCHEMA = "investor-action-correction-impact.schema.json"
KINDS = ("issuer", "dividends", "splits")


def _check(value, code):
    if not value: raise WorkbenchError("ACTION_CORRECTION_" + code)


def _day(value):
    return instant(value).astimezone(managed.ZONE).date().isoformat()


def _ledger(facts, cutoff, known_at):
    result = []
    for event in facts["events"]:
        common = {"listing_id": facts["listing_id"], "known_at": known_at}
        if instant(event["at"]) <= instant(cutoff):
            if event["type"] == "split":
                result.append({**common, "id": "split:" + event["id"], "kind": "split", "effective_at": _clock(event["at"]), "ratio": event["ratio"]})
            else:
                result.append({**common, "id": "ex:" + event["id"], "kind": "dividend_ex", "effective_at": _clock(event["at"]),
                    "currency": "USD", "net_per_unit": canonical(Decimal(event["gross_per_unit"]) - Decimal(event["tax_per_unit"])),
                    "entitlement_id": "entitlement:" + event["id"],
                    "tax_assumption_hash": content_hash({"tax_assumption": facts["tax_assumption"], "tax_per_unit": event["tax_per_unit"]})})
        if event["type"] == "dividend" and instant(event["pay_at"]) <= instant(cutoff):
            result.append({**common, "id": "pay:" + event["id"], "kind": "dividend_payment", "effective_at": _clock(event["pay_at"]),
                "currency": "USD", "entitlement_id": "entitlement:" + event["id"], "ex_at": _clock(event["at"])})
    return result


def _candidate(prior, changes, current, decisions, digest, at):
    historical = {row["date"]: row for row in changes if row["disposition"] == "historical_correction"}
    _check(len(historical) > 0 and len(decisions) == len(historical)
        and {row["date"] for row in decisions} == set(historical), "DECISIONS_DIFFER")
    facts = deepcopy(prior); changed_days = set()
    for decision in decisions:
        day, choice = decision["date"], decision["choice"]
        _check(decision["reason"].strip(), "REASON_REQUIRED")
        # A source leaving its rolling window is not evidence of cancellation.
        _check(not historical[day]["outside_common_coverage"] and all(
            snapshot[kind]["source"]["range_start"] <= day <= snapshot[kind]["source"]["range_end"]
            for snapshot in (current,) for kind in KINDS), "SOURCE_COVERAGE_GAP")
        if choice == "retain": continue
        changed_days.add(day)
        facts["events"] = [row for row in facts["events"] if _day(row["at"]) != day]
        issuer = [row for row in current["issuer"]["records"] if row["ex_date"] == day]
        dividends = [row for row in current["dividends"]["records"] if row["date"] == day]
        splits = [row for row in current["splits"]["records"] if row["date"] == day]
        if choice == "cancel":
            _check(not issuer and not dividends and not splits, "CANCELLATION_NOT_REPORTED")
            continue
        codes = [row["issuer_type_code"] for row in issuer]
        _check(len(set(codes)) == len(codes) and set(codes) <= {"INC", "CGLT", "CGST"}
            and len(splits) <= 1 and all(row["reported_currency"] == "USD" for row in dividends), "SOURCE_REQUIRES_REVIEW")
        expected = ({"dividend"} if issuer else set()) | ({"split"} if splits else set())
        answers = decision["events"]
        _check(expected and len(answers) == len(expected) and {row["type"] for row in answers} == expected, "EVENT_ANSWERS_DIFFER")
        for answer in answers:
            _check(_day(answer["at"]) == day, "EVENT_DATE_DIFFERS")
            identity = "correction-hypothesis:" + content_hash({"request_hash": digest, "date": day, "type": answer["type"]})
            event = {"id": identity, "listing_id": facts["listing_id"], "type": answer["type"], "at": answer["at"],
                "published_at": at, "source_evidence": "unapproved-correction-hypothesis:" + digest}
            if answer["type"] == "dividend":
                gross = sum((Decimal(row["distribution_amount"]) for row in issuer), Decimal(0))
                fact_decimal(answer["tax_per_unit"]); fact_decimal(canonical(gross))
                _check(len({row["pay_date"] for row in issuer}) == 1 and _day(answer["pay_at"]) == issuer[0]["pay_date"], "PAYMENT_DATE_DIFFERS")
                event.update(gross_per_unit=canonical(gross), tax_per_unit=answer["tax_per_unit"], pay_at=answer["pay_at"])
            else:
                ratio = Decimal(splits[0]["numerator"]) / Decimal(splits[0]["denominator"])
                _check(ratio * Decimal(splits[0]["denominator"]) == Decimal(splits[0]["numerator"]), "SPLIT_RATIO_NOT_EXACT")
                event["ratio"] = canonical(ratio); fact_decimal(event["ratio"])
            facts["events"].append(event)
    facts["events"].sort(key=lambda row: (instant(row["at"]), row["type"], row["id"]))
    validate_facts("actions", facts); _fact_events(facts)
    return facts, changed_days


def compare_action_correction_impact(db, workspace, actor, request, *, now=None, stop_requested=None):
    """Full source/history/math replay for a future worker, never inline HTTP GET."""
    return _prepare_action_correction_impact(db, workspace, actor, request, now=now, stop_requested=stop_requested)["result"]


def _prepare_action_correction_impact(db, workspace, actor, request, *, now=None, stop_requested=None):
    """Internal replay bundle; not an approved source or a public admission object."""
    _owner(db, workspace, actor); validate_contract(request, SCHEMA)
    _check(type(request["expected_revision"]) is int, "REVISION_INVALID")
    request = deepcopy(request); at = _clock(now); digest = content_hash(request)
    _check(len(canonical_json(request).encode()) <= 524288, "REQUEST_LIMIT")
    with transaction(db, immediate=False), _fact_validation_scope(), localcontext() as decimals:
        decimals.prec = 128; managed._stopped(db, stop_requested)
        _, witness = review._preview_header(db, workspace, actor, request["preview_id"])
        review._revision(db, workspace, actor, request["expected_revision"])
        _check(request["expected_revision"] == witness["workspace_revision"], "VERSION_CHANGED")
        _check(witness["created_at"] <= at < witness["valid_until"], "PREVIEW_EXPIRED")
        draft, context = _prepare_action_review_draft(db, workspace, actor, witness["authority_id"], now=at)
        review._check_context(db, workspace, actor, draft, context, at)
        _check(draft["draft_basis_hash"] == witness["draft_basis_hash"], "SOURCE_CHANGED")
        leaves = db.execute("""SELECT a.id FROM investor_action_authorities a WHERE a.workspace_id=? AND json_extract(a.document_json,'$.provider_symbol')=?
          AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations c WHERE c.previous_authority_id=a.id) LIMIT 2""",
            (workspace, context["policy"]["provider_symbol"])).fetchall()
        _check(len(leaves) == 1 and leaves[0]["id"] == witness["authority_id"], "SCOPE_CHANGED")
        _check(draft["status"] == "historical_correction_required", "HISTORICAL_CHANGE_REQUIRED")
        history = read_retained_monitor_history(db, workspace, actor, request["model_id"], now=at, stop_requested=stop_requested)
        listing = context["policy"]["listing_id"]
        target = [row for row in history["definition"]["targets"] if row["listing_id"] == listing]
        _check(len(target) == 1 and target[0]["market"] == "US" and target[0]["currency"] == "USD", "MODEL_SCOPE_DIFFERS")
        prior = context["prior"]["facts"]
        for row in draft["changes"]:
            if row["disposition"] == "historical_correction":
                _check(all(context["previous"][kind]["source"]["range_start"] <= row["date"] <= context["previous"][kind]["source"]["range_end"] for kind in KINDS), "SOURCE_COVERAGE_GAP")
        facts, changed_days = _candidate(prior, draft["changes"], context["current"], request["decisions"], digest, at)
        cutoff = history["head"]["market_cutoffs"]["US"]
        affected = lambda row: row["listing_id"] == listing and _day(row["ex_at"] if row["kind"] == "dividend_payment" else row["effective_at"]) in changed_days
        actual = [row for row in history["original_actions"] if affected(row)]
        expected = [row for row in _ledger(prior, cutoff, at) if affected(row)]
        economics = lambda rows: sorted(({key: value for key, value in row.items() if key != "known_at"} for row in rows), key=lambda row: row["id"])
        _check(economics(actual) == economics(expected), "ORIGINAL_ACTION_BASIS_DIFFERS")
        corrected = [deepcopy(row) for row in history["original_actions"] if not affected(row)]
        corrected.extend(row for row in _ledger(facts, cutoff, at) if affected(row))
        corrected.sort(key=lambda row: row["id"])
        value = {"schema_version": "investor-action-restatement-kernel-input-v1", **{key: history[key] for key in (
            "definition", "origin", "head", "origin_projection", "head_projection", "original_actions")},
            "corrected_actions": corrected, "corrected_coverage": deepcopy(history["head_projection"]["corporate_action_coverage"]), "checked_at": at}
        for market, coverage in value["corrected_coverage"].items():
            _check(instant(coverage["from"]) <= instant(history["origin"]["initialized_at"][market]), "ORIGINAL_COVERAGE_GAP")
        comparison = compare_action_restatement(value); managed._stopped(db, stop_requested)
        result = {"schema_version": "investor-action-correction-impact-result-v1", "workspace_id": workspace, "workspace_revision": request["expected_revision"],
            "model_id": request["model_id"], "preview_id": request["preview_id"], "request_hash": digest, "draft_basis_hash": witness["draft_basis_hash"],
            "checked_at": at, "valid_until": min(witness["valid_until"], history["proof"]["source_valid_until"], context["maximum_valid_until"], managed._deadline(at, context["policy"]), key=instant),
            "knowledge_not_before": at, "original_history": history["proof"], "source_changes_hash": content_hash(draft["changes"]),
            "prior_facts_hash": content_hash(prior), "hypothetical_events": facts["events"], "tax_assumption_hash": content_hash({"tax_assumption": facts["tax_assumption"]}),
            "kernel_input_hash": content_hash(value), "comparison": comparison,
            "ignored_new_report_dates": sorted({row["date"] for row in draft["changes"] if row["disposition"] == "new_report"}),
            "coverage_basis": "original_reported_coverage_plus_explicit_hypotheses_not_new_admission", "status": "hypothetical_impact_only_not_correction_consent",
            "visibility": "private_owner_only_not_ai", **{key: False for key in ("economic_correction_approved", "source_evidence_verified", "checkpoint_created",
                "monitoring_resumed", "historical_observations_rewritten", "trading_permission")}, "provider_calls": 0, "database_writes": 0}
        _check(at < result["valid_until"], "PREVIEW_EXPIRED"); validate_contract(result, SCHEMA, fragment="$defs/result")
        _check(len(canonical_json(result).encode()) <= 4194304, "RESULT_LIMIT")
        return {"result": result, "facts": facts, "history": history, "context": context, "draft": draft,
            "kernel_input": value, "changed_days": changed_days}
