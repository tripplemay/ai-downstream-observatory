from dataclasses import asdict, dataclass, is_dataclass
from bisect import bisect_left
from datetime import date, datetime, time, timedelta
from decimal import Decimal
import json
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.accounting import (
    DatedCashflow, NavPoint, TimedFlow, canonical, chain_returns,
    decimal, drawdown, exact_twr, modified_dietz, xirr,
)
from worker.accounting.decimal_math import ONE, ZERO, financial
from worker.accounting.fact_quality import evaluate_fact_quality
from worker.market.contracts import validate_contract
from worker.market.collection import reserved_source, verify_provider_capture
from worker.market.valuation import _choose_observation, _observed_instant
from worker.orchestration.db import WorkbenchError, canonical_json, content_hash, instant, stamp, transaction
from .flows import SECURITY_EXTERNAL_TYPES, in_period, resolve_flow

METHOD_VERSION = "snapshot-performance-cny-v5"


def _json(value):
    if is_dataclass(value):
        return _json(asdict(value))
    if isinstance(value, Decimal):
        return canonical(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json(item) for item in value]
    return value


def _event_time(event):
    if event["time_precision"] == "second":
        return instant(event["effective_at"])
    return datetime.combine(date.fromisoformat(event["effective_at"]) + timedelta(days=1), time.min,
                            ZoneInfo(event["source_timezone"]))


@dataclass(frozen=True)
class PreparedPerformance:
    portfolio_id: str
    ledger_revision: int
    market_heads: dict
    manifest: str
    period_start: str
    period_end: str
    quality: str
    method: str
    result: dict


def _market_head(connection, scope):
    row = connection.execute("SELECT revision,manifest_hash FROM market_publications WHERE scope=?", (scope,)).fetchone()
    return dict(row) if row else None


def _market_context(connection, snapshots):
    manifests = []
    for row in snapshots:
        try:
            value = json.loads(row["market_manifest"])
        except (ValueError, TypeError):
            value = None
        manifests.append(value if isinstance(value, dict) else {})
    evidence, heads, series, issues = [], {}, {}, []
    for snapshot, manifest in zip(snapshots, manifests):
        used = {}
        rules = manifest.get("rules")
        try:
            validate_contract(rules, "valuation-rules.schema.json")
            validate_contract(manifest, "valuation-input-v3.schema.json")
            rules_valid = True
        except WorkbenchError:
            rules_valid = False
        if (manifest.get("schema_version") != "valuation-input-v3" or not rules_valid
                or manifest.get("rules_hash") != content_hash(rules) or not isinstance(manifest.get("publications"), dict)):
            issues.append("VALUATION_INPUT_MANIFEST_INVALID:" + snapshot["id"])
            manifest = {**manifest, "rules": {}, "publications": {}}
            manifests[len(evidence)] = manifest
            rules = {}
        if rules.get("approved") is not True:
            issues.append("VALUATION_QUALITY_RULES_UNAPPROVED:" + snapshot["id"])
        items = connection.execute("SELECT * FROM valuation_items WHERE run_id=?", (snapshot["id"],)).fetchall()
        if not items and snapshot["nav_cny"] is not None and decimal(snapshot["nav_cny"]) != ZERO:
            issues.append("VALUATION_ITEMS_MISSING:" + snapshot["id"])
        for item in items:
            try:
                refs = json.loads(item["evidence_json"])
            except (ValueError, TypeError):
                refs = None
            if not isinstance(refs, dict):
                issues.append("VALUATION_MARKET_EVIDENCE_INVALID:" + snapshot["id"])
                continue
            for kind in ("price", "fx"):
                observation_id = refs.get(kind + "_observation_id")
                if observation_id is None:
                    if (kind == "price" and item["item_type"] in ("security_market_value", "security_in_transit_market_value")) or (kind == "fx" and item["currency"] != "CNY"):
                        issues.append("VALUATION_MARKET_EVIDENCE_MISSING:" + snapshot["id"])
                    continue
                if not isinstance(observation_id, str):
                    issues.append("VALUATION_MARKET_EVIDENCE_INVALID:" + snapshot["id"])
                    continue
                row = connection.execute("SELECT * FROM market_observations WHERE id=?", (observation_id,)).fetchone()
                if row is None:
                    issues.append("VALUATION_MARKET_EVIDENCE_MISSING:" + snapshot["id"])
                    continue
                observation = dict(row)
                if kind == "price":
                    listing = connection.execute("SELECT market,currency FROM listings WHERE id=?", (observation["listing_id"],)).fetchone()
                    scope = rules.get("price_scope_by_market", {}).get(listing["market"]) if listing else None
                    correct_metric = (observation["metric"] == "close" and observation["price_basis"] == "unadjusted"
                                      and observation["listing_id"] == item["listing_id"] and listing is not None
                                      and listing["currency"] == item["currency"] and observation["unit"] == item["currency"])
                else:
                    scope = rules.get("fx_scope")
                    correct_metric = (observation["metric"] == "fx_cny_per_unit" and observation["price_basis"] == "not_applicable"
                                      and observation["series_key"] == "FX:" + item["currency"] and observation["listing_id"] is None
                                      and observation["unit"] == "CNY_per_unit_currency")
                publication = manifest.get("publications", {}).get(scope)
                if (not isinstance(publication, dict) or not isinstance(publication.get("batch_id"), str)
                        or type(publication.get("revision")) is not int or publication["revision"] < 1):
                    issues.append("VALUATION_MARKET_EVIDENCE_INVALID:" + snapshot["id"])
                    continue
                member = connection.execute("SELECT 1 FROM market_batch_members WHERE batch_id=? AND observation_id=?",
                                            (publication["batch_id"], observation_id)).fetchone() if publication else None
                history = connection.execute("SELECT * FROM market_publication_events WHERE scope=? AND revision=?",
                                             (scope, publication["revision"])).fetchone() if publication else None
                bound = (history is not None and publication.get("scope") == scope and all(
                    history[key] == publication.get(key) for key in ("batch_id", "manifest_hash", "published_at")))
                batch = connection.execute("SELECT source_id,scope,validation_json FROM market_batches WHERE id=?", (publication["batch_id"],)).fetchone()
                plan = {}
                try:
                    plan = json.loads(batch["validation_json"])["plan"] if batch else {}
                except (ValueError, KeyError, TypeError):
                    bound = False
                try:
                    cutoff = instant(snapshot["cutoff_at"])
                    known_at = instant(manifest["ledger_fact_quality"]["knowledge_at"]) if manifest.get("mode") == "restated" else cutoff
                    if plan.get("source_mode") == "provider_observed" or reserved_source(plan) or (batch and reserved_source(dict(batch))):
                        verify_provider_capture(connection, publication["batch_id"], known_at=known_at)
                    chosen, problem = _choose_observation([observation], cutoff, known_at)
                    eligible = chosen is not None and not problem and instant(publication["published_at"]) <= known_at
                    if kind == "price" and observation["source_id"] == "provider:longport:prices":
                        from worker.market.references import price_calendar_session
                        session = price_calendar_session(connection, publication["batch_id"], snapshot["portfolio_id"],
                                                         observation["listing_id"], cutoff, known_at)
                        eligible = (eligible and observation["observed_at"] == session
                                    and rules.get("expected_sessions", {}).get(listing["market"]) == session)
                except (KeyError, ValueError, TypeError, WorkbenchError):
                    eligible = False
                if not scope or not correct_metric or member is None or not bound or not eligible:
                    issues.append("VALUATION_MARKET_EVIDENCE_INVALID:" + snapshot["id"])
                    continue
                used[(scope, observation_id)] = {"scope": scope, "observation": observation}
                if scope not in heads:
                    heads[scope] = _market_head(connection, scope)
        evidence.append(list(used.values()))
    # Load only consumed series, not every observation in a potentially large batch.
    for index, left_evidence in enumerate(evidence[:-1]):
        if manifests[index].get("mode") != "as_known":
            continue
        right_publications = manifests[index + 1].get("publications", {})
        for item in left_evidence:
            publication = right_publications.get(item["scope"])
            if not isinstance(publication, dict) or type(publication.get("revision")) is not int:
                issues.append("PERFORMANCE_MARKET_CHAIN_GAP:" + item["scope"])
                continue
            observation = item["observation"]
            left_publication = manifests[index]["publications"][item["scope"]]
            if publication["revision"] < left_publication["revision"]:
                issues.append("PERFORMANCE_MARKET_PUBLICATION_ORDER:" + item["scope"])
            key = (index, item["scope"], observation["series_key"], observation["metric"], observation["price_basis"])
            if key not in series:
                # A correction may be published in an intermediate batch, then omitted
                # from a later latest-session batch. Omission does not undo the correction.
                series[key] = [dict(row) for row in connection.execute("""SELECT DISTINCT o.* FROM market_observations o
                    JOIN market_batch_members m ON m.observation_id=o.id
                    JOIN market_publication_events e ON e.batch_id=m.batch_id
                    WHERE e.scope=? AND e.revision>? AND e.revision<=? AND e.published_at<=?
                    AND o.series_key=? AND o.metric=? AND o.price_basis=?""",
                    (item["scope"], left_publication["revision"], publication["revision"], snapshots[index + 1]["cutoff_at"],
                     observation["series_key"], observation["metric"], observation["price_basis"]))]
    return manifests, evidence, heads, series, issues


def _market_issues(mode, times, manifests, evidence, heads, series):
    issues = []
    sources = {}
    for used in evidence:
        for item in used:
            observation = item["observation"]
            key = (observation["series_key"], observation["metric"], observation["price_basis"])
            if key in sources and sources[key] != item["scope"]:
                issues.append("INCOMPATIBLE_VALUATION_MARKET_SOURCES:" + observation["series_key"])
            sources[key] = item["scope"]
    if mode == "restated":
        for manifest, used in zip(manifests, evidence):
            for scope in {item["scope"] for item in used}:
                publication = manifest["publications"][scope]
                if {key: publication[key] for key in ("revision", "manifest_hash")} != heads[scope]:
                    issues.append("STALE_RESTATED_MARKET_INPUT:" + scope)
    else:
        for index, used in enumerate(evidence[:-1]):
            for item in used:
                original, scope = item["observation"], item["scope"]
                publication = manifests[index + 1].get("publications", {}).get(scope)
                if not isinstance(publication, dict) or type(publication.get("revision")) is not int:
                    continue
                key = (index, scope, original["series_key"], original["metric"], original["price_basis"])
                candidates = [row for row in series[key] if _observed_instant(row) >= _observed_instant(original)]
                # Retain the left quote if the next batch contains only the new session.
                chosen, problem = _choose_observation([original, *candidates], times[index], times[index + 1])
                if problem:
                    issues.append("AMBIGUOUS_PERFORMANCE_MARKET_REVISION:" + original["series_key"])
                elif decimal(chosen["value"]) != decimal(original["value"]):
                    issues.append("MARKET_KNOWLEDGE_CHANGED_RESTATE_REQUIRED:" + original["series_key"])
    return issues


@financial
def prepare_performance(connection, portfolio_id, payload, now=None):
    validate_contract(payload, "performance-command.schema.json")
    now = instant(now)
    try:
        evaluation_zone = ZoneInfo(payload["evaluation_timezone"])
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise WorkbenchError("INVALID_EVALUATION_TIMEZONE") from exc
    with transaction(connection, immediate=False):
        head = connection.execute("SELECT revision FROM ledger_heads WHERE portfolio_id=?", (portfolio_id,)).fetchone()
        if head is None:
            raise WorkbenchError("PORTFOLIO_NOT_FOUND")
        revision = head["revision"]
        snapshots = []
        for valuation_id in payload["valuation_ids"]:
            row = connection.execute("SELECT * FROM valuation_runs WHERE id=? AND portfolio_id=?", (valuation_id, portfolio_id)).fetchone()
            if row is None:
                raise WorkbenchError("VALUATION_OUT_OF_SCOPE")
            if row["ledger_revision"] != revision:
                raise WorkbenchError("STALE_PERFORMANCE_INPUT")
            snapshots.append(dict(row))
        events = [dict(row) for row in connection.execute("SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=?", (portfolio_id, revision))]
        capital = [dict(row) for row in connection.execute("""SELECT p.* FROM postings p JOIN ledger_events e ON e.id=p.event_id
            WHERE e.portfolio_id=? AND e.ledger_revision<=? AND p.ledger_account IN ('external_capital','opening_equity')""", (portfolio_id, revision))]
        manifests, market_evidence, market_heads, market_series, market_issues = _market_context(connection, snapshots)
    times = [instant(row["cutoff_at"]) for row in snapshots]
    if any(right <= left for left, right in zip(times, times[1:])):
        raise WorkbenchError("SNAPSHOTS_NOT_CHRONOLOGICAL")
    if times[-1] > instant(now):
        raise WorkbenchError("FUTURE_PERFORMANCE_CUTOFF")
    modes = {manifest.get("mode") for manifest in manifests}
    methods = {row["method_version"] for row in snapshots}
    if len(modes) != 1 or not modes <= {"as_known", "restated"} or len(methods) != 1:
        raise WorkbenchError("INCOMPATIBLE_PERFORMANCE_INPUTS")
    mode = next(iter(modes))
    if next(iter(methods)) != "decimal-nav-cny-v4:" + mode:
        raise WorkbenchError("UNSUPPORTED_VALUATION_METHOD")
    issues = market_issues + _market_issues(mode, times, manifests, market_evidence, market_heads, market_series)
    fact_qualities = []
    for snapshot, manifest, cutoff in zip(snapshots, manifests, times):
        original = manifest.get("ledger_fact_quality")
        try:
            validate_contract(original, "ledger-fact-quality.schema.json")
            if (instant(original["knowledge_at"]) > instant(snapshot["created_at"])
                    or instant(original["knowledge_at"]) < cutoff
                    or original != evaluate_fact_quality(events, portfolio_id, revision, cutoff,
                                                         original["knowledge_at"], mode)):
                raise ValueError("invalid")
        except (ValueError, TypeError, KeyError):
            issues.append("VALUATION_FACT_QUALITY_INVALID:" + snapshot["id"])
        fact_qualities.append(evaluate_fact_quality(events, portfolio_id, revision, cutoff, now, mode))
    period_fact_quality = evaluate_fact_quality(events, portfolio_id, revision, times[-1], now, mode, period_start=times[0])
    if any(proof["performance_quality"] != "complete" for proof in [*fact_qualities, period_fact_quality]):
        issues.append("INCOMPLETE_LEDGER_FACT_QUALITY")
        issues.extend(issue for proof in [*fact_qualities, period_fact_quality]
                      if proof["performance_quality"] != "complete" for issue in proof["issues"])
    attribution_quality = max((proof["attribution_quality"] for proof in [*fact_qualities, period_fact_quality]),
                              key={"complete": 0, "provisional": 1, "blocked": 2}.__getitem__)
    quality_result = {"ledger_fact_quality": fact_qualities, "period_fact_quality": period_fact_quality,
                      "attribution_quality": attribution_quality}
    assumptions = set()
    if any(row["quality"] != "complete" or row["nav_cny"] is None for row in snapshots):
        issues.append("INCOMPLETE_VALUATION_CHAIN")
    visible = [event for event in events if mode == "restated" or instant(event["recorded_at"]) <= times[-1]]
    reversed_ids = {event["reversal_of"] for event in visible if event["reversal_of"]}
    active = {event["id"]: event for event in visible if event["event_type"] != "reversal" and event["id"] not in reversed_ids}
    external_counts = {}
    for posting in capital:
        if posting["ledger_account"] == "external_capital":
            external_counts[posting["event_id"]] = external_counts.get(posting["event_id"], 0) + 1
    for event in active.values():
        if (event["event_type"] in SECURITY_EXTERNAL_TYPES
                and in_period(event, {"currency": "CNY"}, times[0], times[-1])
                and external_counts.get(event["id"], 0) != 1):
            issues.append("SECURITY_FLOW_POSTING_COVERAGE_INVALID:" + event["id"])
        # An unknown/zero-cost position opening has no opening-equity posting.
        if event["event_type"] in ("opening_cash", "opening_position") and times[0] < _event_time(event) <= times[-1]:
            issues.append("OPENING_SNAPSHOT_INSIDE_PERFORMANCE_PERIOD")
    if mode == "as_known":
        # A late historical correction is a restatement, not return earned today.
        for event in visible:
            recorded = instant(event["recorded_at"])
            interval_end = bisect_left(times, recorded)
            if 0 < interval_end < len(times) and _event_time(event) <= times[interval_end - 1]:
                issues.append("KNOWLEDGE_SET_CHANGED_RESTATE_REQUIRED")
    flows, flow_evidence, selected = [], [], []
    for posting in capital:
        event = active.get(posting["event_id"])
        if event is None:
            continue
        at = _event_time(event)
        if event["time_precision"] == "date":
            local_day = date.fromisoformat(event["effective_at"])
            day_start = datetime.combine(local_day, time.min, ZoneInfo(event["source_timezone"]))
            boundary_index = bisect_left(times, day_start)
            if boundary_index < len(times) and times[boundary_index] < at:
                issues.append("DATE_ONLY_FLOW_CROSSES_SNAPSHOT_BOUNDARY")
        if not in_period(event, posting, times[0], times[-1]):
            continue
        if posting["ledger_account"] == "opening_equity":
            issues.append("OPENING_SNAPSHOT_INSIDE_PERFORMANCE_PERIOD")
            continue
        if event["time_precision"] == "date" and posting["currency"] == "CNY" and event["event_type"] not in SECURITY_EXTERNAL_TYPES:
            assumptions.add("date_only_source_timezone_eod_assumption")
        selected.append((event, posting))
    with transaction(connection, immediate=False):
        if connection.execute("SELECT revision FROM ledger_heads WHERE portfolio_id=?", (portfolio_id,)).fetchone()[0] != revision:
            raise WorkbenchError("STALE_PERFORMANCE_INPUT")
        if any(_market_head(connection, scope) != expected for scope, expected in market_heads.items()):
            raise WorkbenchError("STALE_PERFORMANCE_MARKET_INPUT")
        for event, posting in sorted(selected, key=lambda pair: (_event_time(pair[0]), pair[1]["id"])):
            evidence, heads = resolve_flow(connection, portfolio_id, event, posting, mode,
                payload.get("flow_fx_rules"), evaluation_zone, times[-1], now)
            flow_evidence.append(evidence)
            market_heads.update(heads)
            issues.extend(evidence["issues"])
            if evidence["quality"] == "complete":
                flows.append((instant(evidence["flow_time"]), decimal(evidence["amount_cny"]),
                              posting["id"], date.fromisoformat(evidence["evaluation_date"])))
            for used in market_evidence:
                for item in used:
                    if (posting["currency"] != "CNY" and payload.get("flow_fx_rules")
                            and item["observation"]["series_key"] == "FX:" + posting["currency"]
                            and item["scope"] != payload["flow_fx_rules"]["fx_scope"]):
                        issues.append("INCOMPATIBLE_FLOW_FX_SOURCE:" + posting["currency"])
    manifest_version = "performance-input-v6" if any(item["schema_version"] == "flow-fx-evidence-v3" for item in flow_evidence) else "performance-input-v5"
    manifest_value = {"schema_version": manifest_version, "mode": mode,
        "ledger_revision": revision, "evaluation_timezone": payload["evaluation_timezone"],
        "market_heads": market_heads,
        "valuations": [{"id": row["id"], "content_hash": content_hash(row)} for row in snapshots],
        "flow_fx_rules": payload.get("flow_fx_rules"),
        "flow_fx_rules_hash": content_hash(payload["flow_fx_rules"]) if payload.get("flow_fx_rules") else None,
        "external_flow_evidence": flow_evidence, "ledger_fact_quality": fact_qualities,
        "period_fact_quality": period_fact_quality}
    validate_contract(manifest_value, manifest_version + ".schema.json")
    manifest = canonical_json(manifest_value)
    flows.sort(key=lambda row: (row[0], row[2]))
    if issues:
        result = {"return": None, "xirr": {"rate": None, "status": "incomplete_inputs"},
            "net_profit_cny": None, "external_flow_cny": None, "drawdown": None, "curve": [], "intervals": [],
            "issues": sorted(set(issues)), "assumptions": sorted(assumptions), "mode": mode,
            "external_flow_evidence": flow_evidence, **quality_result}
        return PreparedPerformance(portfolio_id, revision, market_heads, manifest, stamp(times[0]), stamp(times[-1]), "blocked", "unavailable", result)
    navs = [decimal(row["nav_cny"]) for row in snapshots]
    intervals, returns = [], []
    factor = ONE
    curve = [{"at": stamp(times[0]), "unit_nav": "1", "quality": "complete"}]
    points = [NavPoint(times[0], ONE)]
    estimated = False
    grouped_flows = [[] for _ in range(len(times) - 1)]
    for at, amount, _, _ in flows:
        grouped_flows[bisect_left(times, at) - 1].append(TimedFlow(at, amount))
    for index, (left, right) in enumerate(zip(times, times[1:])):
        interval_flows = grouped_flows[index]
        if interval_flows:
            value = modified_dietz(left, right, navs[index], navs[index + 1], interval_flows)
            estimated = True
        else:
            value = exact_twr(left, right, navs[index], navs[index + 1])
        returns.append(value)
        intervals.append({"from": stamp(left), "to": stamp(right), **_json(value)})
        if value.value is None or factor is None:
            factor = None
        else:
            factor *= ONE + value.value
        quality = "blocked" if factor is None else "complete"
        curve.append({"at": stamp(right), "unit_nav": None if factor is None else canonical(factor), "quality": quality})
        points.append(NavPoint(right, factor, quality))
    linked = chain_returns(returns)
    external = sum((amount for _, amount, _, _ in flows), ZERO)
    investor_flows = [DatedCashflow(times[0].astimezone(evaluation_zone).date(), -navs[0])]
    investor_flows.extend(DatedCashflow(flow_date, -amount) for _, amount, _, flow_date in flows)
    investor_flows.append(DatedCashflow(times[-1].astimezone(evaluation_zone).date(), navs[-1]))
    if estimated:
        assumptions.add("interval_flow_valuation_unavailable_modified_dietz")
    assumptions.add("drawdown_measured_at_supplied_snapshots_only")
    result = {"return": _json(linked), "xirr": _json(xirr(investor_flows)),
        "net_profit_cny": canonical(navs[-1] - navs[0] - external), "external_flow_cny": canonical(external),
        "drawdown": _json(drawdown(points, estimated=estimated)), "curve": curve, "intervals": intervals,
        "issues": [], "assumptions": sorted(assumptions), "mode": mode,
        "external_flow_evidence": flow_evidence, **quality_result}
    method = "mixed_estimate" if estimated and any(value.method == "exact_twr" for value in returns) else "modified_dietz_estimate" if estimated else "exact_twr"
    quality = "blocked" if linked.value is None else "provisional" if estimated else "complete"
    return PreparedPerformance(portfolio_id, revision, market_heads, manifest, stamp(times[0]), stamp(times[-1]), quality, method, result)


def persist_performance(connection, prepared, now=None):
    try:
        manifest = json.loads(prepared.manifest)
        version = manifest.get("schema_version")
        if version not in ("performance-input-v5", "performance-input-v6"):
            raise WorkbenchError("PERFORMANCE_INPUT_MANIFEST_INVALID")
        validate_contract(manifest, version + ".schema.json")
    except (WorkbenchError, ValueError, TypeError) as exc:
        raise WorkbenchError("PERFORMANCE_INPUT_MANIFEST_INVALID") from exc
    if (manifest["ledger_revision"] != prepared.ledger_revision or manifest["market_heads"] != prepared.market_heads
            or manifest["external_flow_evidence"] != prepared.result.get("external_flow_evidence")
            or manifest["ledger_fact_quality"] != prepared.result.get("ledger_fact_quality")
            or manifest["period_fact_quality"] != prepared.result.get("period_fact_quality")):
        raise WorkbenchError("PERFORMANCE_INPUT_MANIFEST_INVALID")
    proofs = [*manifest["ledger_fact_quality"], manifest["period_fact_quality"]]
    attribution = max((proof["attribution_quality"] for proof in proofs),
                      key={"complete": 0, "provisional": 1, "blocked": 2}.__getitem__)
    if (len(manifest["ledger_fact_quality"]) != len(manifest["valuations"])
            or prepared.result.get("attribution_quality") != attribution
            or (any(proof["performance_quality"] != "complete" for proof in proofs)
                and (prepared.quality != "blocked" or prepared.result.get("return") is not None))):
        raise WorkbenchError("PERFORMANCE_FACT_QUALITY_INVALID")
    rules_hash = content_hash(manifest["flow_fx_rules"]) if manifest["flow_fx_rules"] is not None else None
    if manifest["flow_fx_rules_hash"] != rules_hash:
        raise WorkbenchError("PERFORMANCE_INPUT_MANIFEST_INVALID")
    for evidence in manifest["external_flow_evidence"]:
        if evidence["binding_id"] != content_hash({key: value for key, value in evidence.items() if key != "binding_id"}):
            raise WorkbenchError("PERFORMANCE_INPUT_MANIFEST_INVALID")
        if (evidence["portfolio_id"] != prepared.portfolio_id or evidence["mode"] != manifest["mode"]
                or evidence["rules_hash"] != (rules_hash if evidence["currency"] != "CNY" else None)):
            raise WorkbenchError("PERFORMANCE_INPUT_MANIFEST_INVALID")
        if evidence["knowledge_at"] and instant(evidence["knowledge_at"]) > instant(now):
            raise WorkbenchError("PERFORMANCE_KNOWLEDGE_AFTER_PERSIST_TIME")
    method_version = "snapshot-performance-cny-v6" if version == "performance-input-v6" else METHOD_VERSION
    run_id = "performance:" + content_hash({"portfolio_id": prepared.portfolio_id, "manifest": prepared.manifest, "method_version": method_version})
    with transaction(connection):
        head = connection.execute("SELECT revision FROM ledger_heads WHERE portfolio_id=?", (prepared.portfolio_id,)).fetchone()
        if head is None or head["revision"] != prepared.ledger_revision:
            raise WorkbenchError("STALE_PERFORMANCE_INPUT")
        events = [dict(row) for row in connection.execute("SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=?",
                                                        (prepared.portfolio_id, prepared.ledger_revision))]
        snapshot_times = []
        for reference, proof in zip(manifest["valuations"], manifest["ledger_fact_quality"]):
            snapshot = connection.execute("SELECT * FROM valuation_runs WHERE id=? AND portfolio_id=?",
                                          (reference["id"], prepared.portfolio_id)).fetchone()
            if (snapshot is None or content_hash(dict(snapshot)) != reference["content_hash"]
                    or snapshot["ledger_revision"] != prepared.ledger_revision
                    or instant(proof["cutoff_at"]) != instant(snapshot["cutoff_at"]) or proof["period_start"] is not None):
                raise WorkbenchError("PERFORMANCE_FACT_QUALITY_INVALID")
            snapshot_times.append(instant(snapshot["cutoff_at"]))
        period = manifest["period_fact_quality"]
        if (not snapshot_times or instant(prepared.period_start) != snapshot_times[0]
                or instant(prepared.period_end) != snapshot_times[-1]
                or period["period_start"] is None or instant(period["period_start"]) != snapshot_times[0]
                or instant(period["cutoff_at"]) != snapshot_times[-1]):
            raise WorkbenchError("PERFORMANCE_FACT_QUALITY_INVALID")
        for proof in [*manifest["ledger_fact_quality"], manifest["period_fact_quality"]]:
            if (instant(proof["knowledge_at"]) > instant(now) or instant(proof["knowledge_at"]) < instant(proof["cutoff_at"])
                    or proof != evaluate_fact_quality(events, prepared.portfolio_id, prepared.ledger_revision,
                        proof["cutoff_at"], proof["knowledge_at"], manifest["mode"], proof["period_start"])):
                raise WorkbenchError("PERFORMANCE_FACT_QUALITY_INVALID")
        if any(_market_head(connection, scope) != expected for scope, expected in prepared.market_heads.items()):
            raise WorkbenchError("STALE_PERFORMANCE_MARKET_INPUT")
        existing = connection.execute("SELECT * FROM performance_runs WHERE id=?", (run_id,)).fetchone()
        if existing:
            return dict(existing)
        connection.execute("""INSERT INTO performance_runs(id,portfolio_id,ledger_revision,market_manifest,method_version,
            period_start,period_end,quality,method,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (run_id, prepared.portfolio_id, prepared.ledger_revision, prepared.manifest, method_version,
             prepared.period_start, prepared.period_end, prepared.quality, prepared.method, canonical_json(prepared.result), stamp(now)))
        return dict(connection.execute("SELECT * FROM performance_runs WHERE id=?", (run_id,)).fetchone())
