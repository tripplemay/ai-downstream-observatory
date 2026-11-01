"""Receipt-backed monitor input projection, not a quote or trading API.

Only reference metadata is handed to the separate admission/core path. Price
projections are rebuilt in memory; this module does not persist data, enqueue
jobs or enable a model. Automatic collection and real-source acceptance remain
separate requirements.
"""

from datetime import timedelta
from zoneinfo import ZoneInfo

from worker.accounting.decimal_math import canonical, decimal, financial
from worker.market.contracts import validate_contract
from worker.market.providers.longport import _MARKETS
from worker.orchestration.db import content_hash, instant, transaction
from .data_evidence import _assert, resolve_review
from .data_snapshot import build_dataset, build_monitor_dataset, build_audited_monitor_dataset
from .monitor import _cost_rates
from .precision import validate_time_precision
from .runtime import _milliseconds
from .source_inputs import _review_kind, _snapshot_ids, source_unavailable_reason


QUALIFICATION = "owner_reviewed_reconstructed"


def validate_monitor_data_document(document):
    _assert(type(document) is dict)
    schema = {"investor-monitor-data-input-v1": "investor-monitor-data-input.schema.json",
        "investor-monitor-data-input-v2": "investor-monitor-data-input-v2.schema.json",
        "investor-monitor-data-input-v3": "investor-monitor-data-input-v3.schema.json",
        "investor-monitor-data-input-v4": "investor-monitor-data-input-v4.schema.json"}.get(document.get("schema_version"))
    _assert(schema is not None)
    validate_contract(document, schema)


def check_reference_listing_identity(reference_targets, catalog):
    _assert({row["listing_id"] for row in reference_targets} == set(catalog), "INVESTOR_DATA_MONITOR_LISTING_SCOPE")
    for target in reference_targets:
        current = catalog[target["listing_id"]]
        _assert(target["symbol"] == current["provider_symbol"] and all(target[key] == current[key] for key in ("market", "currency")),
            "INVESTOR_DATA_MONITOR_IDENTITY_CHANGED")


def _time(value):
    return _milliseconds(value)


def _settings(value):
    _assert(type(value) is dict)
    validate_time_precision(value)
    validate_contract(value, "investor-monitor-data-input-v3.schema.json" if "cost_assumptions" in value else "investor-monitor-data-input.schema.json", fragment="$defs/settings")
    policy = value["policy"]
    _assert(0 <= decimal(policy["weight_band"]) <= 1 and decimal(policy["absolute_band_cny"]) >= 0)
    _cost_rates(policy["costs"])
    _assert(value["funding_intent"] is None or decimal(value["funding_intent"]["amount_cny"]) > 0)


@financial
def project_monitor_data(definition, source, reviews, settings, created_at, *, cost_deadline=None, action_availability=None):
    from .model_contracts import validate_definition, definition_basis
    validate_definition(definition)
    validate_time_precision(definition)
    _settings(settings)
    _assert(definition["data_mode"] == "reconstructed" and source["dataset"]["mode"] == "reconstructed",
        "INVESTOR_DATA_OFFICIAL_CAPTURES_REQUIRED")
    _assert(definition["target_definition_hash"] == content_hash(definition_basis(definition)))
    _assert(instant(definition["created_at"]) <= instant(created_at) < instant(definition["valid_until"]), "INVESTOR_DATA_MODEL_NOT_CURRENT")
    targets = {row["listing_id"]: row for row in definition["targets"]}
    _assert(len(targets) == len(definition["targets"]) and sum((decimal(row["weight"]) for row in targets.values()), decimal("0")) == 1)
    _assert(all(decimal(row["weight"]) > 0 for row in targets.values()))
    _assert(set(targets) == set(source["catalog"]), "INVESTOR_DATA_MONITOR_LISTING_SCOPE")
    for identity, target in targets.items():
        _assert(all(target[key] == source["catalog"][identity][key] for key in ("market", "currency")), "INVESTOR_DATA_MONITOR_LISTING_SCOPE")
        if definition["schema_version"] == "investor-model-definition-v2":
            _assert(definition["fixed_policy"]["parameters"]["roles"][identity] == source["catalog"][identity]["role"], "INVESTOR_DATA_MONITOR_LISTING_SCOPE")
    at = instant(created_at)
    base_expiry = min(instant(source["valid_until"]), instant(definition["valid_until"]))
    calendars = {row["facts"]["market"]: row for row in reviews if row["source"]["kind"] == "calendar"}
    actions = {row["facts"]["listing_id"]: row for row in reviews if row["source"]["kind"] == "actions"}
    availability = None
    if action_availability is not None:
        from .monitor_action_knowledge import index_availability
        availability = index_availability(list(actions.values()), action_availability, created_at)
    fx_reviews = [row for row in reviews if row["source"]["kind"] == "fx"]
    _assert(len({row["facts"]["currency"] for row in fx_reviews}) == len(fx_reviews), "INVESTOR_DATA_MONITOR_FX_VERSIONS_CONFLICT")
    quotes, rates, coverage, events, gaps, deadlines = [], [], {}, [], [], [base_expiry]
    if cost_deadline is not None: deadlines.append(instant(cost_deadline))
    dataset = source["dataset"]
    for market in sorted({row["market"] for row in targets.values()}):
        reviewed = calendars[market]
        calendar = reviewed["facts"]
        local_day = at.astimezone(ZoneInfo(_MARKETS[market][0])).date().isoformat()
        if not calendar["range_start"] <= local_day <= calendar["range_end"]:
            gaps.append("MONITOR_CALENDAR_NOT_CURRENT_" + market)
        sessions = [row for row in calendar["days"] if row["kind"] != "closed"]
        complete = [row for row in sessions if instant(row["close_at"]) <= at]
        if not complete:
            gaps.append("MONITOR_EXPECTED_CLOSE_MISSING_" + market)
            continue
        expected = max(complete, key=lambda row: instant(row["close_at"]))
        following = [instant(row["close_at"]) for row in sessions if instant(row["close_at"]) > at]
        # The known calendar horizon itself expires at the next local midnight;
        # lack of a following session must not imply an indefinite holiday.
        horizon = instant(calendar["range_end"] + "T00:00:00Z").replace(tzinfo=ZoneInfo(_MARKETS[market][0])) + timedelta(days=1)
        market_expiry = min([base_expiry, horizon, *following])
        deadlines.append(market_expiry)
        for identity in sorted(key for key, row in targets.items() if row["market"] == market):
            observations = [row for row in dataset["observations"] if row.get("listing_id") == identity and row["metric"] == "close"]
            _assert(observations, "INVESTOR_DATA_MONITOR_PRICE_MISSING")
            quote = max(observations, key=lambda row: instant(row["observed_at"]))
            observed, known = instant(quote["observed_at"]), instant(quote["ingested_at"])
            _assert(observed <= known <= at)
            expiry = min(market_expiry, observed + timedelta(seconds=settings["max_quote_age_seconds"]))
            if quote["observed_at"] != expected["close_at"]:
                gaps.append("MONITOR_PRICE_NOT_CURRENT_" + market)
            if expiry <= at or expiry <= known:
                gaps.append("MONITOR_PRICE_EXPIRED_" + market)
                continue
            quotes.append({"listing_id": identity, "market": market, "currency": targets[identity]["currency"],
                "close": quote["value"], "price_basis": "unadjusted", "observed_at": _time(quote["observed_at"]),
                "known_at": quote["ingested_at"], "valid_until": _time(expiry), "expected_close_at": _time(expected["close_at"]),
                "calendar_hash": reviewed["review"]["content_hash"], "observation_hash": content_hash(quote)})
            deadlines.append(expiry)
        current = [row for row in quotes if row["market"] == market]
        if current:
            _assert(len({row["observed_at"] for row in current}) == 1, "INVESTOR_DATA_MONITOR_MARKET_CUTOFF_DIFFERS")
            cutoff = current[0]["observed_at"]
            from_times = [row["close_at"] for row in dataset["sessions"] if row["market"] == market]
            _assert(from_times)
            coverage[market] = {"from": _time(min(from_times, key=instant)), "to": cutoff, "complete": True}
    for currency in sorted({row["currency"] for row in targets.values()} - {"CNY"}):
        reviewed = next(row for row in fx_reviews if row["facts"]["currency"] == currency)
        rows = reviewed["facts"]["rows"]
        _assert(rows, "INVESTOR_DATA_MONITOR_FX_MISSING")
        rate = max(rows, key=lambda row: instant(row["observed_at"]))
        observed, known = instant(rate["observed_at"]), instant(reviewed["review"]["created_at"])
        _assert(observed <= known <= at)
        expiry = min(base_expiry, observed + timedelta(seconds=settings["policy"]["max_fx_age_seconds"]))
        if expiry <= at or expiry <= known:
            gaps.append("MONITOR_FX_EXPIRED_" + currency)
            continue
        rates.append({"currency": currency, "value": rate["value"], "unit": "CNY_per_unit_currency",
            "observed_at": _time(rate["observed_at"]), "known_at": reviewed["review"]["created_at"], "valid_until": _time(expiry),
            "observation_hash": content_hash({"review_id": reviewed["review"]["id"], "review_hash": reviewed["review"]["content_hash"], "rate": rate})})
        deadlines.append(expiry)
    for identity, review in sorted(actions.items()):
        market = targets[identity]["market"]
        if market not in coverage:
            continue
        facts, cutoff = review["facts"], instant(coverage[market]["to"])
        for event in facts["events"]:
            # Legacy projections retain their exact hashes. The separate v2
            # protocol keeps original audited availability across coverage rolls.
            known = review["review"]["created_at"] if availability is None else availability[(review["review"]["id"], event["id"])]["known_at"]
            common = {"listing_id": identity, "known_at": known}
            if instant(event["at"]) <= cutoff:
                if event["type"] == "split":
                    events.append({**common, "id": "split:" + event["id"], "kind": "split", "effective_at": _time(event["at"]), "ratio": event["ratio"]})
                else:
                    events.append({**common, "id": "ex:" + event["id"], "kind": "dividend_ex", "effective_at": _time(event["at"]),
                        "currency": targets[identity]["currency"], "net_per_unit": canonical(decimal(event["gross_per_unit"]) - decimal(event["tax_per_unit"])),
                        "entitlement_id": "entitlement:" + event["id"], "tax_assumption_hash": content_hash({"tax_assumption": facts["tax_assumption"], "tax_per_unit": event["tax_per_unit"]})})
            if event["type"] == "dividend" and instant(event["pay_at"]) <= cutoff:
                events.append({**common, "id": "pay:" + event["id"], "kind": "dividend_payment", "effective_at": _time(event["pay_at"]),
                    "currency": targets[identity]["currency"], "entitlement_id": "entitlement:" + event["id"], "ex_at": _time(event["at"])})
    _assert(len(events) <= 500 and len({row["id"] for row in events}) == len(events), "INVESTOR_DATA_MONITOR_ACTION_LIMIT")
    result = {"schema_version": "investor-monitor-data-projection-v1" if availability is None else "investor-monitor-data-projection-v2", "model_id": definition["model_id"], "source_qualification": QUALIFICATION,
        "quotes": sorted(quotes, key=lambda row: row["listing_id"]), "fx": rates, "corporate_action_coverage": coverage,
        "corporate_actions": sorted(events, key=lambda row: (row["effective_at"], row["kind"], row["id"])),
        "funding_intent": settings["funding_intent"], "policy": settings["policy"], "quality_gaps": sorted(set(gaps)),
        "created_at": created_at, "valid_until": _time(min(deadlines)), "live_advice_eligible": False}
    validate_contract(result, "investor-monitor-data-projection.schema.json" if availability is None else "investor-monitor-data-projection-v2.schema.json")
    return result


def build_monitor_data(db, workspace_id, definition, windows, settings, *, now=None, snapshot_at=None, audited_action_knowledge=False):
    from .monitor_costs import verify_settings
    checked = _milliseconds(now)
    frozen = checked if snapshot_at is None else _milliseconds(snapshot_at)
    _assert(type(windows) is list and 1 <= len(windows) <= 3)
    _assert(type(audited_action_knowledge) is bool)
    segments, catalogs, reviews, markets, observations, sessions = [], {}, {}, set(), {}, []
    with transaction(db, immediate=False):
        cost_deadline = verify_settings(db, workspace_id, definition, settings, frozen)
        for window in windows:
            legacy = {"capture_ids", "action_review_ids", "fx_review_ids", "start_date", "end_date"}
            _assert(type(window) is dict and set(window) in (legacy, legacy | {"confirmed_capture_ids"}))
            confirmed = "confirmed_capture_ids" in window
            args = (db, workspace_id, window["capture_ids"])
            args += ((window["confirmed_capture_ids"],) if confirmed else ()) + (window["action_review_ids"], window["fx_review_ids"], window["start_date"], window["end_date"])
            if audited_action_knowledge:
                source = build_audited_monitor_dataset(db, workspace_id, window["capture_ids"], window.get("confirmed_capture_ids", []),
                    window["action_review_ids"], window["fx_review_ids"], window["start_date"], window["end_date"], now=checked, snapshot_at=frozen)
            else:
                source = (build_monitor_dataset if confirmed else build_dataset)(*args, now=checked, snapshot_at=frozen)
            _assert(source["dataset"]["mode"] == "reconstructed", "INVESTOR_DATA_OFFICIAL_CAPTURES_REQUIRED")
            source_markets = {row["market"] for row in source["catalog"].values()}
            _assert(len(source_markets) == 1 and not source_markets & markets, "INVESTOR_DATA_MONITOR_MARKET_WINDOWS")
            markets.update(source_markets)
            _assert(not set(catalogs) & set(source["catalog"]), "INVESTOR_DATA_MONITOR_LISTING_SCOPE")
            catalogs.update(source["catalog"])
            for ref in source["manifest"]["review_refs"]:
                reviews[ref["review_id"]] = resolve_review(db, workspace_id, ref["review_id"], _review_kind(db, workspace_id, ref["review_id"]), now=checked)
            for observation in source["dataset"]["observations"]:
                prior = observations.get(observation["id"])
                _assert(prior is None or prior == observation, "INVESTOR_DATA_MONITOR_OBSERVATION_CONFLICT")
                observations[observation["id"]] = observation
            sessions.extend(source["dataset"]["sessions"])
            segments.append({"snapshot": source["manifest"], "dataset_hash": source["dataset_hash"], "catalog_hash": content_hash(source["catalog"]), "valid_until": source["valid_until"]})
        merged = {"dataset": {"mode": "reconstructed", "observations": list(observations.values()), "sessions": sessions},
            "catalog": catalogs, "valid_until": min(row["valid_until"] for row in segments)}
        refs = [ref for segment in segments for ref in segment["snapshot"].get("action_availability_refs", [])] if audited_action_knowledge else None
        projection = project_monitor_data(definition, merged, list(reviews.values()), settings, frozen, cost_deadline=cost_deadline, action_availability=refs)
    version = "investor-monitor-data-input-v2" if any(row["snapshot"]["schema_version"] == "investor-monitor-price-snapshot-v1" for row in segments) else "investor-monitor-data-input-v1"
    if "cost_assumptions" in settings: version = "investor-monitor-data-input-v3"
    if audited_action_knowledge: version = "investor-monitor-data-input-v4"
    document = {"schema_version": version, "workspace_id": workspace_id, "model_id": definition["model_id"],
        "target_definition_hash": definition["target_definition_hash"], "source_qualification": QUALIFICATION,
        "segments": [{key: row[key] for key in ("snapshot", "dataset_hash", "catalog_hash")} for row in sorted(segments, key=lambda row: row["snapshot"]["capture_refs"][0]["capture_id"])],
        "settings": settings, "projection_hash": content_hash(projection), "created_at": frozen, "valid_until": merged["valid_until"], "live_advice_eligible": False}
    validate_monitor_data_document(document)
    return {"document": document, "projection": projection, "catalog": catalogs, "content_hash": content_hash(document)}


def resolve_monitor_data(db, workspace_id, definition, document, *, now=None, evaluated_at=None):
    from .monitor_costs import verify_settings
    validate_monitor_data_document(document)
    checked = _milliseconds(now)
    evaluated = checked if evaluated_at is None else _milliseconds(evaluated_at)
    _assert(document["created_at"] <= evaluated <= checked)
    _assert(document["workspace_id"] == workspace_id and document["model_id"] == definition["model_id"]
        and document["target_definition_hash"] == definition["target_definition_hash"] and document["created_at"] <= checked)
    if "cost_assumptions" in document["settings"]:
        try: verify_settings(db, workspace_id, definition, document["settings"], document["created_at"])
        except ValueError:
            return {"document": document, "projection": None, "unavailable_reason": "MONITOR_COST_ASSUMPTIONS_UNAVAILABLE"}
    with transaction(db, immediate=False):
        windows = []
        for segment in document["segments"]:
            manifest = segment["snapshot"]
            _assert(manifest["workspace_id"] == workspace_id and manifest["created_at"] == document["created_at"] and manifest["mode"] == "reconstructed")
            reason = source_unavailable_reason(db, workspace_id, {"snapshot": manifest, "valid_until": document["valid_until"]}, checked)
            if reason:
                return {"document": document, "projection": None, "unavailable_reason": reason}
            confirmed = manifest["schema_version"] in ("investor-monitor-price-snapshot-v1", "investor-monitor-source-snapshot-v2")
            window = {"capture_ids": [row["capture_id"] for row in manifest["capture_refs"] if not confirmed or row["kind"] == "historical_sdk"],
                "action_review_ids": _snapshot_ids(db, workspace_id, manifest, "actions"), "fx_review_ids": _snapshot_ids(db, workspace_id, manifest, "fx"),
                "start_date": manifest["range_start"], "end_date": manifest["range_end"]}
            if confirmed:
                window["confirmed_capture_ids"] = [row["capture_id"] for row in manifest["capture_refs"] if row["kind"] == "confirmed_sdk"]
            windows.append(window)
        result = build_monitor_data(db, workspace_id, definition, windows, document["settings"], now=checked, snapshot_at=document["created_at"],
            audited_action_knowledge=document["schema_version"] == "investor-monitor-data-input-v4")
    _assert(result["document"] == document)
    if result["projection"]["valid_until"] <= evaluated:
        return {"document": document, "projection": None, "unavailable_reason": "MONITOR_DATA_PROJECTION_EXPIRED"}
    return {**result, "unavailable_reason": None}
