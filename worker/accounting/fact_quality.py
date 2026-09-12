"""Pure, replayable dividend and corporate-action quality evidence."""

from datetime import date, datetime, time, timedelta, timezone
from hashlib import sha256
import json
from zoneinfo import ZoneInfo

from .decimal_math import ZERO, canonical, decimal, financial


DIVIDEND_ROOTS = {"dividend", "dividend_accrual", "dividend_net"}
DIVIDEND_CHILDREN = {"dividend_payment", "dividend_breakdown", "dividend_tax_assessment", "dividend_tax_payment"}
QUALITY_TYPES = DIVIDEND_ROOTS | DIVIDEND_CHILDREN | {"corporate_action_notice", "corporate_action_resolution"}
SUPPORT_TYPES = {"opening_position", "buy", "sell", "settlement", "dividend_accrual", "dividend",
                 "dividend_net", "dividend_payment", "dividend_breakdown", "dividend_tax_assessment",
                 "dividend_tax_payment", "fee", "split", "security_in", "security_out",
                 "security_transfer_out", "security_transfer_in", "security_transfer_return"}
RANK = {"complete": 0, "provisional": 1, "blocked": 2}
QUALITIES = ("nav_quality", "performance_quality", "attribution_quality")


def _hash(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                             allow_nan=False).encode()).hexdigest()


def _instant(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise ValueError("FACT_QUALITY_TIMEZONE_REQUIRED")
    return value.astimezone(timezone.utc)


def _stamp(value):
    return _instant(value).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _fact(event):
    return json.loads(event["payload_json"])["fact"]


def _time(event, date_end=False):
    if event["time_precision"] == "second":
        return _instant(event["effective_at"])
    day = date.fromisoformat(event["effective_at"])
    end = date_end or event["event_type"] == "corporate_action_resolution"
    return datetime.combine(day + timedelta(days=int(end)), time.min, ZoneInfo(event["source_timezone"])).astimezone(timezone.utc)


def _worst(values):
    return max(values, key=RANK.__getitem__, default="complete")


def _event_time(event, by_id, interval=False):
    original = by_id.get(event.get("reversal_of"))
    if original:
        event = {**event, "event_type": original["event_type"]}
    return _time(event, date_end=interval and event["event_type"] != "corporate_action_notice")


def _scope(event, fact):
    return {"account_id": event["account_id"], "listing_id": fact.get("listing_id"), "currency": fact["currency"]}


def _same_scope(root, root_fact, child, child_fact):
    return (root["portfolio_id"] == child["portfolio_id"] and root["account_id"] == child["account_id"]
            and root_fact["currency"] == child_fact.get("currency"))


def _valid_source(event):
    try:
        payload = json.loads(event["payload_json"])
        if event["event_type"] == "reversal":
            return _hash(payload) == event["payload_hash"] and payload.get("original_event_id") == event["reversal_of"]
        fact = payload["fact"]
        semantic = {key: value for key, value in payload.items() if key not in ("expected_revision", "idempotency_key")}
        return (_hash(semantic) == event["payload_hash"] and fact["type"] == event["event_type"]
                and fact["account_id"] == event["account_id"] and payload["portfolio_id"] == event["portfolio_id"]
                and all(payload.get(key) == event.get(key) for key in
                        ("effective_at", "time_precision", "source_timezone", "source_id", "source_event_id")))
    except (ValueError, TypeError, KeyError):
        return False


def _listing(event, active, seen=None):
    seen = set() if seen is None else seen
    if event["id"] in seen:
        return None
    seen.add(event["id"])
    fact = _fact(event)
    if fact.get("listing_id"):
        return fact["listing_id"]
    parent = active.get(fact.get("related_event_id"))
    return _listing(parent, active, seen) if parent else None


@financial
def dividend_obligation(gross, recognized_tax, cash_received):
    gross, tax, cash = decimal(gross), decimal(recognized_tax), decimal(cash_received)
    if gross < ZERO or tax < ZERO or tax > gross or cash < ZERO or cash > gross:
        raise ValueError("INVALID_DIVIDEND_BALANCE")
    net = gross - tax - cash
    return max(net, ZERO), min(net, ZERO)


@financial
def _point(events, portfolio_id, ledger_revision, cutoff, known_at, mode, interval=False):
    by_id = {event["id"]: event for event in events}
    visible = [event for event in events if event["portfolio_id"] == portfolio_id
               and event["ledger_revision"] <= ledger_revision and _instant(event["recorded_at"]) <= known_at
               and _event_time(event, by_id, interval) <= cutoff]
    reversed_ids = {event["reversal_of"] for event in visible if event.get("reversal_of")}
    active = {event["id"]: event for event in visible if event["event_type"] != "reversal" and event["id"] not in reversed_ids}
    relevant = {event["id"] for event in visible if event["event_type"] in QUALITY_TYPES}
    relevant.update(event["id"] for event in visible if event.get("reversal_of") in relevant)
    hashes = {event["id"]: _hash(event) for event in visible if event["id"] in relevant}
    global_issues, dividends, actions = [], [], []
    for event in visible:
        if event["id"] in relevant and not _valid_source(event):
            global_issues.append("FACT_QUALITY_SOURCE_INVALID:" + event["id"])

    def dependency_valid(identity):
        seen = set()
        while identity:
            if identity in seen:
                return False
            seen.add(identity)
            node = next((event for event in visible if event["id"] == identity), None)
            if node:
                hashes[identity] = _hash(node)
            for reverse in visible:
                if reverse.get("reversal_of") == identity:
                    hashes[reverse["id"]] = _hash(reverse)
                    if not _valid_source(reverse):
                        global_issues.append("FACT_QUALITY_SOURCE_INVALID:" + reverse["id"])
            if node is None or not _valid_source(node):
                if node:
                    global_issues.append("FACT_QUALITY_SOURCE_INVALID:" + identity)
                return False
            if identity not in active:
                return False
            identity = _fact(node).get("related_event_id")
        return True
    children = {}
    for event in active.values():
        if event["event_type"] in DIVIDEND_CHILDREN | {"corporate_action_resolution"}:
            try:
                parent = _fact(event)["related_event_id"]
                children.setdefault(parent, []).append(event)
                valid_roots = DIVIDEND_ROOTS if event["event_type"] in DIVIDEND_CHILDREN else {"corporate_action_notice"}
                if parent not in active or active[parent]["event_type"] not in valid_roots:
                    global_issues.append("FACT_QUALITY_ORPHAN_CHILD:" + event["id"])
            except (ValueError, TypeError, KeyError):
                global_issues.append("FACT_QUALITY_SOURCE_INVALID:" + event["id"])
    for root in sorted(active.values(), key=lambda event: event["id"]):
        if root["event_type"] not in DIVIDEND_ROOTS | {"corporate_action_notice"}:
            continue
        try:
            fact = _fact(root)
            scope = _scope(root, fact)
        except (ValueError, TypeError, KeyError):
            global_issues.append("FACT_QUALITY_SOURCE_INVALID:" + root["id"])
            continue
        linked = sorted(children.get(root["id"], []), key=lambda event: (_time(event), event["ledger_revision"], event["id"]))
        issues = []
        if root["event_type"] == "corporate_action_notice":
            resolution = linked[-1] if len(linked) == 1 else None
            supported, valid = [], resolution is not None
            if resolution:
                resolved = _fact(resolution)
                valid = _same_scope(root, fact, resolution, resolved)
                supported = resolved.get("supporting_event_ids", [])
                valid = valid and len(supported) == len(set(supported))
                if resolved.get("resolution") == "not_applicable":
                    valid = valid and not supported
                elif resolved.get("resolution") == "recorded":
                    valid = valid and bool(supported)
                    matched_listing = not fact.get("listing_id")
                    for identity in supported:
                        support = active.get(identity)
                        dependency_ok = dependency_valid(identity)
                        if (not dependency_ok or support is None or support["event_type"] not in SUPPORT_TYPES
                                or not _same_scope(root, fact, support, _fact(support))):
                            valid = False
                        elif _listing(support, active) == fact.get("listing_id"):
                            matched_listing = True
                    valid = valid and matched_listing
                else:
                    valid = False
            if not valid:
                issues.append("CORPORATE_ACTION_UNRESOLVED:" + root["id"])
                if linked:
                    issues.append("CORPORATE_ACTION_RESOLUTION_INVALID:" + root["id"])
            actions.append({"event_id": root["id"], **scope, "action_kind": fact["action_kind"],
                            "resolution_event_id": resolution["id"] if resolution else None,
                            "resolution": _fact(resolution).get("resolution") if resolution else None,
                            "supporting_event_ids": sorted(supported), "status": "resolved" if valid else "unresolved", "issues": sorted(set(issues))})
            continue
        gross, tax, cash = None, None, ZERO
        tax_status, net_status = "unknown", fact.get("net_status")
        assessment_id = breakdown_id = None
        assessment_confirmed = False
        try:
            if root["event_type"] == "dividend_net":
                cash = decimal(fact["amount"])
                if cash < ZERO or net_status not in ("final", "provisional"):
                    raise ValueError("invalid_net")
            else:
                gross = decimal(fact["amount"])
                tax_status = fact.get("tax_status", "confirmed" if "tax" in fact else "unknown")
                if tax_status not in ("unknown", "estimated", "confirmed") or (tax_status == "unknown" and "tax" in fact):
                    raise ValueError("invalid_tax_status")
                tax = decimal(fact["tax"]) if tax_status != "unknown" else None
                if root["event_type"] == "dividend":
                    cash = gross - (tax if tax is not None else ZERO)
            for child in linked:
                value = _fact(child)
                if not _same_scope(root, fact, child, value):
                    raise ValueError("scope")
                kind = child["event_type"]
                if kind == "dividend_breakdown":
                    if root["event_type"] != "dividend_net" or breakdown_id is not None:
                        raise ValueError("breakdown")
                    gross, tax = decimal(value["gross_amount"]), decimal(value["tax"])
                    if gross - tax != decimal(fact["amount"]):
                        raise ValueError("breakdown")
                    tax_status, breakdown_id = "confirmed", child["id"]
                elif kind == "dividend_tax_assessment":
                    if gross is None or value.get("tax_status") not in ("estimated", "confirmed"):
                        raise ValueError("assessment_without_gross")
                    tax, tax_status, assessment_id = decimal(value["tax"]), value["tax_status"], child["id"]
                    assessment_confirmed = tax_status == "confirmed"
                elif kind == "dividend_payment":
                    if gross is None or decimal(value["amount"]) < ZERO:
                        raise ValueError("invalid_payment")
                    cash += decimal(value["amount"])
                elif kind == "dividend_tax_payment":
                    amount = decimal(value["amount"])
                    if gross is None or amount < ZERO:
                        raise ValueError("invalid_tax_payment")
                    _, payable = dividend_obligation(gross, tax if tax is not None else ZERO, cash)
                    if amount > -payable:
                        raise ValueError("tax_payment_exceeds_payable")
                    cash -= amount
                if gross is not None:
                    dividend_obligation(gross, tax if tax is not None else ZERO, cash)
            receivable, payable = dividend_obligation(gross, tax if tax is not None else ZERO, cash) if gross is not None else (ZERO, ZERO)
        except (ValueError, TypeError, KeyError):
            issues.append("DIVIDEND_STATE_INVALID:" + root["id"])
            receivable = payable = ZERO
        nav_quality = "blocked" if issues else "complete"
        attribution = nav_quality
        if nav_quality != "blocked":
            if root["event_type"] == "dividend_net" and breakdown_id is None:
                attribution = "provisional"
                issues.append("DIVIDEND_BREAKDOWN_UNCONFIRMED:" + root["id"])
            if ((root["event_type"] == "dividend_net" and net_status != "final" and not assessment_confirmed)
                    or (gross is not None and tax_status != "confirmed")):
                nav_quality = attribution = "provisional"
                issues.append("DIVIDEND_TAX_UNCONFIRMED:" + root["id"])
            if not interval and any(event["time_precision"] == "date" and _time(event) <= cutoff < _time(event, date_end=True)
                   for event in [root, *linked]):
                nav_quality = attribution = "provisional"
                issues.append("DATE_ONLY_DIVIDEND_ON_CUTOFF_DAY:" + root["id"])
        dividends.append({"event_id": root["id"], **scope,
            "gross_amount": canonical(gross) if gross is not None else None,
            "recognized_tax": canonical(tax) if tax is not None else None, "tax_status": tax_status,
            "net_status": net_status, "cash_received": canonical(cash), "receivable": canonical(receivable),
            "tax_payable": canonical(payable), "assessment_event_id": assessment_id, "breakdown_event_id": breakdown_id,
            "child_event_ids": sorted(event["id"] for event in linked), "nav_quality": nav_quality,
            "performance_quality": nav_quality, "attribution_quality": attribution, "issues": sorted(set(issues))})
    evidence = {"schema_version": "ledger-fact-quality-v1", "portfolio_id": portfolio_id,
                "ledger_revision": ledger_revision, "cutoff_at": _stamp(cutoff), "mode": mode,
                "knowledge_at": _stamp(known_at), "period_start": None,
                "dividends": dividends, "corporate_actions": actions, "event_hashes": dict(sorted(hashes.items()))}
    for quality in QUALITIES:
        evidence[quality] = _worst([item[quality] for item in dividends]
                                  + ["blocked" for item in actions if item["status"] != "resolved"]
                                  + (["blocked"] if global_issues else []))
    evidence["issues"] = sorted(set(global_issues + [issue for item in dividends + actions for issue in item["issues"]]))
    return evidence


def evaluate_fact_quality(events, portfolio_id, ledger_revision, cutoff_at, knowledge_at, mode="as_known", period_start=None):
    """Period evidence retains end state but reports worst quality across the interval."""
    if mode not in ("as_known", "restated"):
        raise ValueError("INVALID_FACT_QUALITY_MODE")
    cutoff = _instant(cutoff_at)
    known = cutoff if mode == "as_known" else _instant(knowledge_at)
    evidence = _point(events, portfolio_id, ledger_revision, cutoff, known, mode, interval=period_start is not None)
    if period_start is not None:
        start = _instant(period_start)
        if start > cutoff:
            raise ValueError("INVALID_FACT_QUALITY_PERIOD")
        boundaries = {start}
        by_id = {event["id"]: event for event in events}
        quality_ids = {event["id"] for event in events if event["event_type"] in QUALITY_TYPES}
        for event in events:
            if (event["portfolio_id"] != portfolio_id or event["ledger_revision"] > ledger_revision
                    or (event["id"] not in quality_ids and event.get("reversal_of") not in quality_ids)):
                continue
            at = _event_time(event, by_id, interval=True)
            if start < at < cutoff:
                boundaries.add(at)
            recorded = _instant(event["recorded_at"])
            if mode == "as_known" and start < recorded < cutoff:
                boundaries.add(recorded)
        for boundary in sorted(boundaries):
            point = _point(events, portfolio_id, ledger_revision, boundary,
                           boundary if mode == "as_known" else known, mode, interval=True)
            for quality in QUALITIES:
                evidence[quality] = _worst([evidence[quality], point[quality]])
            evidence["issues"] = sorted(set(evidence["issues"] + point["issues"]))
            evidence["event_hashes"].update(point["event_hashes"])
        evidence["period_start"] = _stamp(start)
    evidence["event_hashes"] = dict(sorted(evidence["event_hashes"].items()))
    if any(item["tax_status"] not in ("unknown", "estimated", "confirmed")
           or item["net_status"] not in (None, "provisional", "final") for item in evidence["dividends"]):
        raise ValueError("FACT_QUALITY_EVIDENCE_INVALID")
    if any(item["resolution"] not in (None, "not_applicable", "recorded")
           or item["action_kind"] not in ("dividend_entitlement", "merger", "liquidation", "return_of_capital", "other")
           for item in evidence["corporate_actions"]):
        raise ValueError("FACT_QUALITY_EVIDENCE_INVALID")
    evidence["binding_id"] = _hash(evidence)
    return evidence
