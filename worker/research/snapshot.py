"""Frozen research datasets, explicit provenance and point-in-time selection."""

from copy import deepcopy
from bisect import bisect_right
from decimal import Decimal
import json
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from worker.accounting import decimal, fact_decimal
from worker.accounting.decimal_math import financial
from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, content_hash, instant


def validate_dataset(dataset):
    validate_contract(dataset, "research-dataset.schema.json")
    assets = {asset["listing_id"]: asset for asset in dataset["assets"]}
    if len(assets) != len(dataset["assets"]):
        raise WorkbenchError("DUPLICATE_RESEARCH_ASSET")
    if dataset["mode"] == "historical_point_in_time" and not dataset["historical_archive_verified"]:
        raise WorkbenchError("UNVERIFIED_HISTORICAL_ARCHIVE")
    sessions = {}
    session_dates = set()
    market_zones = {"CN": "Asia/Shanghai", "HK": "Asia/Hong_Kong", "US": "America/New_York"}
    for session in dataset["sessions"]:
        close, available = instant(session["close_at"]), instant(session["available_at"])
        key = (session["market"], close)
        date_key = (session["market"], session["session_date"])
        local_date = close.astimezone(ZoneInfo(market_zones[session["market"]])).date().isoformat()
        if key in sessions or date_key in session_dates or available < close or local_date != session["session_date"]:
            raise WorkbenchError("INVALID_RESEARCH_CALENDAR")
        sessions[key] = session
        session_dates.add(date_key)
    if dataset["schema_version"] == "research-dataset-v2":
        by_date = {(row["market"], row["session_date"]): row for row in dataset["sessions"]}
        settlements = set()
        for row in dataset["settlements"]:
            key = row["market"], row["session_date"]
            session = by_date.get(key)
            if (key in settlements or session is None
                    or instant(row["settled_at"]) < instant(session["close_at"])
                    or instant(row["published_at"]) > instant(session["close_at"])
                    or (dataset["mode"] == "actual_replay"
                        and instant(row["ingested_at"]) > instant(session["close_at"]))):
                raise WorkbenchError("INVALID_RESEARCH_SETTLEMENT_CALENDAR")
            settlements.add(key)
        if settlements != session_dates:
            raise WorkbenchError("INCOMPLETE_RESEARCH_SETTLEMENT_CALENDAR")
    identities, ids = set(), set()
    for asset in dataset["assets"]:
        if fact_decimal(asset["quantity_step"]) <= 0:
            raise WorkbenchError("INVALID_RESEARCH_QUANTITY_STEP")
        if asset.get("tradable_until") and instant(asset["tradable_until"]) <= instant(asset["tradable_from"]):
            raise WorkbenchError("INVALID_ASSET_LIFECYCLE")
    for row in dataset["observations"]:
        fact_decimal(row["value"])
        if row["time_precision"] != "second":
            raise WorkbenchError("RESEARCH_REQUIRES_EXPLICIT_OBSERVATION_INSTANTS")
        observed = instant(row["observed_at"])
        if instant(row["ingested_at"]) < observed or row.get("published_at") and instant(row["published_at"]) < observed:
            raise WorkbenchError("INVALID_RESEARCH_OBSERVATION_CHRONOLOGY")
        identity = tuple(row.get(key) for key in ("source_id", "series_key", "metric", "observed_at", "price_basis", "revision_id"))
        if identity in identities or row["id"] in ids:
            raise WorkbenchError("DUPLICATE_RESEARCH_OBSERVATION")
        identities.add(identity)
        ids.add(row["id"])
        if dataset["mode"] == "synthetic" and row["provenance"] != "reconstructed":
            raise WorkbenchError("SYNTHETIC_OBSERVATION_NOT_LABELED")
        if dataset["mode"] in ("historical_point_in_time", "actual_replay") and row["provenance"] == "reconstructed":
            raise WorkbenchError("RECONSTRUCTED_DATA_CANNOT_BECOME_POINT_IN_TIME")
        if dataset["mode"] == "historical_point_in_time" and not row.get("published_at"):
            raise WorkbenchError("HISTORICAL_PUBLICATION_UNKNOWN")
        if row["metric"] == "close":
            asset = assets.get(row.get("listing_id"))
            if asset is None or row["unit"] != asset["currency"] or decimal(row["value"]) <= 0 or row["price_basis"] != "unadjusted":
                raise WorkbenchError("INVALID_RESEARCH_PRICE")
            if observed < instant(asset["tradable_from"]) or asset.get("tradable_until") and observed >= instant(asset["tradable_until"]):
                raise WorkbenchError("PRICE_OUTSIDE_ASSET_LIFECYCLE")
            if (asset["market"], observed) not in sessions:
                raise WorkbenchError("PRICE_NOT_ON_RESEARCH_CALENDAR")
        elif row["metric"] == "fx_cny_per_unit":
            if row["price_basis"] != "not_applicable" or row["unit"] != "CNY_per_unit_currency" or decimal(row["value"]) <= 0:
                raise WorkbenchError("INVALID_RESEARCH_FX")
        else:
            raise WorkbenchError("UNSUPPORTED_RESEARCH_OBSERVATION")
    action_ids = set()
    for action in dataset["actions"]:
        if action["id"] in action_ids or action["listing_id"] not in assets:
            raise WorkbenchError("INVALID_CORPORATE_ACTION_IDENTITY")
        action_ids.add(action["id"])
        if instant(action["published_at"]) > instant(action["at"]):
            raise WorkbenchError("CORPORATE_ACTION_NOT_KNOWN_AT_EVENT")
        if dataset["mode"] == "actual_replay" and instant(action["ingested_at"]) > instant(action["at"]):
            raise WorkbenchError("CORPORATE_ACTION_INGESTED_AFTER_EVENT")
        if action["type"] == "split":
            if set(action) - {"id", "listing_id", "type", "at", "published_at", "ingested_at", "source_evidence", "ratio"} or decimal(action.get("ratio", "0")) <= 0:
                raise WorkbenchError("INVALID_RESEARCH_SPLIT")
        else:
            if set(action) - {"id", "listing_id", "type", "at", "published_at", "ingested_at", "source_evidence", "gross_per_unit", "tax_per_unit", "pay_at"}:
                raise WorkbenchError("INVALID_RESEARCH_DIVIDEND")
            gross, tax = decimal(action.get("gross_per_unit", "-1")), decimal(action.get("tax_per_unit", "-1"))
            if gross < 0 or tax < 0 or tax > gross or not action.get("pay_at") or instant(action["pay_at"]) < instant(action["at"]):
                raise WorkbenchError("INVALID_RESEARCH_DIVIDEND")


@financial
def validate_parameters(parameters, dataset):
    validate_contract(parameters, "research-parameters.schema.json")
    assets = {asset["listing_id"] for asset in dataset["assets"]}
    if parameters.get("schema_version"):
        tolerance = parameters["tolerance"]
        if fact_decimal(tolerance["absolute_cny"]) < 0 or not 0 <= fact_decimal(tolerance["weight"]) <= 1:
            raise WorkbenchError("INVALID_RESEARCH_TARGET_TOLERANCE")
        if parameters["schema_version"] == "research-rotation-parameters-v1":
            if set(parameters["universe"]) - assets:
                raise WorkbenchError("INVALID_RESEARCH_UNIVERSE")
            if not 0 < fact_decimal(parameters["target_fraction"]) <= 1:
                raise WorkbenchError("INVALID_RESEARCH_TARGET_FRACTION")
            floor = parameters["momentum_floor"]
            if floor is not None and fact_decimal(floor) < -1:
                raise WorkbenchError("INVALID_RESEARCH_MOMENTUM_FLOOR")
            return
    weights = {key: fact_decimal(value) for key, value in parameters["weights"].items()}
    if set(weights) - assets or any(value < 0 for value in weights.values()) or not Decimal("0") < sum(weights.values()) <= 1:
        raise WorkbenchError("INVALID_RESEARCH_WEIGHTS")
    if not parameters.get("schema_version") and not 0 < fact_decimal(parameters["deployment_fraction"]) <= 1:
        raise WorkbenchError("INVALID_DEPLOYMENT_FRACTION")


def validate_plan(plan, dataset):
    validate_contract(plan, "research-plan.schema.json")
    version = plan["schema_version"].removeprefix("research-plan-")
    if dataset["schema_version"] != "research-dataset-" + version:
        raise WorkbenchError("RESEARCH_PLAN_DATASET_VERSION_MISMATCH")
    try:
        ZoneInfo(plan["evaluation_timezone"])
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise WorkbenchError("INVALID_RESEARCH_EVALUATION_TIMEZONE") from exc
    previous = None
    for phase in ("train", "validation", "holdout"):
        window = plan["windows"][phase]
        start, end = instant(window["start"]), instant(window["end"])
        if start >= end or previous is not None and start <= previous:
            raise WorkbenchError("OVERLAPPING_OR_INVALID_RESEARCH_WINDOWS")
        previous = end
    decisions = [instant(value) for value in plan["decision_times"]]
    if decisions != sorted(set(decisions)):
        raise WorkbenchError("DECISIONS_MUST_BE_UNIQUE_AND_SORTED")
    # This close-only engine has no separate real-time fill confirmation feed.
    # Do not let an ex-post fill alter cash visible to a decision before its
    # closing observation becomes available, including another market's close.
    blackout = []
    for close, available in sorted((instant(row["close_at"]), instant(row["available_at"])) for row in dataset["sessions"]):
        if close == available:
            continue
        if blackout and close <= blackout[-1][1]:
            blackout[-1] = (blackout[-1][0], max(available, blackout[-1][1]))
        else:
            blackout.append((close, available))
    starts = [window[0] for window in blackout]
    for decision in decisions:
        index = bisect_right(starts, decision) - 1
        if index >= 0 and decision < blackout[index][1]:
            raise WorkbenchError("DECISION_INSIDE_UNOBSERVED_CLOSE_WINDOW")
    if fact_decimal(plan["initial_capital_cny"]) <= 0:
        raise WorkbenchError("INVALID_INITIAL_RESEARCH_CAPITAL")
    for flow in plan["contributions"]:
        if fact_decimal(flow["amount_cny"]) <= 0:
            raise WorkbenchError("RESEARCH_CONTRIBUTIONS_MUST_BE_POSITIVE")
    for name in ("commission_bps", "minimum_fee_cny", "slippage_bps", "fx_bps"):
        if fact_decimal(plan["execution"][name]) < 0:
            raise WorkbenchError("NEGATIVE_EXECUTION_COST")
    if version == "v2" and fact_decimal(plan["execution"]["slippage_bps"]) >= 10000:
        raise WorkbenchError("INVALID_RESEARCH_SELL_SLIPPAGE")
    if fact_decimal(plan["execution"]["cash_quantum"]) <= 0:
        raise WorkbenchError("INVALID_CASH_QUANTUM")
    candidates = set()
    for candidate in plan["parameter_candidates"]:
        validate_parameters(candidate, dataset)
        digest = content_hash(candidate)
        if digest in candidates:
            raise WorkbenchError("DUPLICATE_PARAMETER_CANDIDATE")
        candidates.add(digest)
    validate_parameters(plan["benchmark"], dataset)


def snapshot_from_publications(connection, metadata, publication_refs, portfolio_id=None):
    """No mutable latest lookup: exact publication manifests and members only."""
    snapshot = deepcopy(metadata)
    if "observations" in snapshot or "publication_refs" in snapshot:
        raise WorkbenchError("SNAPSHOT_METADATA_CANNOT_SUPPLY_OBSERVATIONS")
    observations = {}
    for ref in publication_refs:
        row = connection.execute("SELECT * FROM market_publication_events WHERE scope=? AND revision=?",
                                 (ref["scope"], ref["revision"])).fetchone()
        if row is None or row["batch_id"] != ref["batch_id"] or row["manifest_hash"] != ref["manifest_hash"]:
            raise WorkbenchError("RESEARCH_PUBLICATION_HASH_MISMATCH")
        from worker.market.collection import reserved_source, verify_provider_capture
        batch = connection.execute("SELECT source_id,scope,validation_json FROM market_batches WHERE id=?", (ref["batch_id"],)).fetchone()
        plan = json.loads(batch["validation_json"])["plan"]
        if plan.get("source_mode") == "provider_observed" or reserved_source(plan) or reserved_source(dict(batch)):
            verify_provider_capture(connection, ref["batch_id"])
        if batch["source_id"] == "provider:longport:prices":
            owner = connection.execute("""SELECT c.portfolio_id FROM market_sdk_captures s
                JOIN command_requests c ON c.id=s.command_request_id WHERE s.batch_id=?""", (ref["batch_id"],)).fetchone()
            if portfolio_id is None or owner is None or owner["portfolio_id"] != portfolio_id:
                raise WorkbenchError("RESEARCH_PRIVATE_SOURCE_OUT_OF_SCOPE")
        for value in connection.execute("""SELECT o.* FROM market_batch_members m
            JOIN market_observations o ON o.id=m.observation_id WHERE m.batch_id=?""", (ref["batch_id"],)):
            observation = {key: value[key] for key in value.keys() if value[key] is not None}
            observations[observation["id"]] = observation
    snapshot["observations"] = sorted(observations.values(), key=lambda row: row["id"])
    snapshot["publication_refs"] = deepcopy(publication_refs)
    validate_dataset(snapshot)
    return snapshot


def _visibility_index(entries):
    times, values, best_rank = [], [], None
    for visible, rank, value in sorted(entries, key=lambda item: item[0]):
        if best_rank is not None and rank <= best_rank:
            continue
        best_rank = rank
        if times and times[-1] == visible:
            values[-1] = value
        else:
            times.append(visible)
            values.append(value)
    return times, values


def _lookup(index, cutoff):
    offset = bisect_right(index[0], cutoff) - 1
    return index[1][offset] if offset >= 0 else None


class MarketView:
    """Indexes a frozen dataset without changing PIT or revision selection."""

    def __init__(self, dataset, fx_age_seconds):
        self.dataset = dataset
        self.assets = {row["listing_id"]: row for row in dataset["assets"]}
        self.sessions = sorted(dataset["sessions"], key=lambda row: instant(row["close_at"]))
        self.fx_age_seconds = fx_age_seconds
        self.rows, self._price_groups, self._prices, self._fx = {}, {}, {}, {}
        self._session_by_close, calendars = {}, {}
        for row in self.sessions:
            close, available = instant(row["close_at"]), instant(row["available_at"])
            self._session_by_close[(row["market"], close)] = (available, row)
            calendars.setdefault(row["market"], []).append((close, available, row["trade_allowed"]))
        self._calendars, self._trading_times = {}, {}
        for market, rows in calendars.items():
            closes = [row[0] for row in rows]
            known = _visibility_index((available, close, close) for close, available, _ in rows)
            self._calendars[market] = ((closes, closes), known)
            self._trading_times[market] = [close for close, _, allowed in rows if allowed]
        self._lifecycles = {key: (instant(asset["tradable_from"]), instant(asset["tradable_until"]) if asset.get("tradable_until") else None)
                            for key, asset in self.assets.items()}
        grouped = {}
        for row in dataset["observations"]:
            key = (row.get("listing_id"), row["metric"]) if row["metric"] == "close" else (row["series_key"], row["metric"])
            self.rows.setdefault(key, []).append(row)
            if row["metric"] == "close" and row["price_basis"] != "unadjusted":
                continue
            observed, available = instant(row["observed_at"]), self.available(row)
            grouped.setdefault(key, {}).setdefault(observed, {}).setdefault(available, []).append(row)
        for key, observations in grouped.items():
            historical_times, historical_values, visible, exact = [], [], [], {}
            for observed, revisions in sorted(observations.items()):
                times, values = [], []
                session_available = self._session_by_close[(self.assets[key[0]]["market"], observed)][0] if key[1] == "close" else None
                for available, rows in sorted(revisions.items()):
                    # Equal rank keeps the first input row, just as stable sort
                    # and max did; conflicting tied revisions remain blocked.
                    ambiguous = len({(row["value"], row["revision_id"]) for row in rows}) > 1
                    selected = (decimal(rows[0]["value"]), rows[0]["id"], observed, ambiguous)
                    times.append(available)
                    values.append(selected)
                    visible.append((max(available, session_available) if session_available is not None else available,
                                    (observed, available), selected))
                exact[observed] = (times, values)
                if session_available is not None:
                    selected = _lookup(exact[observed], session_available)
                    if selected is not None:
                        historical_times.append(observed)
                        historical_values.append(selected)
            if key[1] == "close":
                self._price_groups[key[0]] = exact
                self._prices[key[0]] = ((historical_times, historical_values), _visibility_index(visible))
            else:
                self._fx[key[0]] = _visibility_index(visible)

    def available(self, row):
        times = [instant(row["observed_at"])]
        if row.get("published_at"):
            times.append(instant(row["published_at"]))
        if self.dataset["mode"] == "actual_replay":
            times.append(instant(row["ingested_at"]))
        return max(times)

    def price(self, listing_id, at, decision=False, exact_at=None):
        asset = self.assets[listing_id]
        selected = None
        if exact_at is not None:
            group = self._price_groups.get(listing_id, {}).get(exact_at)
            if group is not None and exact_at <= at:
                available = self._session_by_close[(asset["market"], exact_at)][0]
                if not decision or available <= at:
                    selected = _lookup(group, at if decision else available)
        else:
            indexes = self._prices.get(listing_id)
            if indexes is not None:
                selected = _lookup(indexes[1 if decision else 0], at)
        if selected is None:
            raise WorkbenchError("RESEARCH_PRICE_UNAVAILABLE:" + listing_id)
        calendar = self._calendars.get(asset["market"])
        latest = _lookup(calendar[1 if decision else 0], at) if calendar is not None else None
        if latest is not None and selected[2] != latest:
            raise WorkbenchError("MISSING_REQUIRED_RESEARCH_SESSION:" + listing_id)
        if selected[3]:
            raise WorkbenchError("AMBIGUOUS_RESEARCH_PRICE_REVISION")
        return selected[0], selected[1]

    def fx(self, currency, at):
        if currency == "CNY":
            return Decimal("1"), None
        index = self._fx.get("FX:" + currency)
        selected = _lookup(index, at) if index is not None else None
        if selected is None:
            raise WorkbenchError("RESEARCH_FX_UNAVAILABLE:" + currency)
        if selected[3]:
            raise WorkbenchError("AMBIGUOUS_RESEARCH_FX_REVISION")
        if (at - selected[2]).total_seconds() > self.fx_age_seconds:
            raise WorkbenchError("STALE_RESEARCH_FX:" + currency)
        return selected[0], selected[1]

    def next_session(self, listing_id, decision_at, end_at):
        asset = self.assets[listing_id]
        times = self._trading_times.get(asset["market"], [])
        index = bisect_right(times, decision_at)
        if index == len(times) or times[index] > end_at:
            return None
        at = times[index]
        start, end = self._lifecycles[listing_id]
        if at < start or end is not None and at >= end:
            raise WorkbenchError("ASSET_NOT_HISTORICALLY_TRADABLE:" + listing_id)
        return at
