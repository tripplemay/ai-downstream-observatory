"""Immutable, as-of valuations derived from actual ledger facts and publications."""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
import json
from zoneinfo import ZoneInfo

from worker.accounting import CurrencyBalance, ValuedPosition, canonical, decimal, nav_cny
from worker.accounting.decimal_math import ZERO, financial
from worker.accounting.fact_quality import evaluate_fact_quality
from worker.orchestration.db import (
    WorkbenchError, canonical_json, content_hash, instant, new_id, stamp, transaction,
)
from .contracts import validate_contract
from .collection import source_verified


ASSET_ACCOUNTS = {
    "cash_settled": "settled_cash", "trade_receivable": "trade_receivables",
    "dividend_receivable": "dividend_receivables", "transfer_in_transit": "owned_transfers_in_transit",
    "trade_payable": "trade_payables", "other_liability": "other_liabilities",
    "dividend_tax_payable": "dividend_tax_payable",
}
IGNORED_ACCOUNTS = {"inventory_cost", "external_capital", "opening_equity", "income", "expense",
                    "fx_bridge", "cash_hold", "unclassified_income", "inventory_in_transit_cost",
                    "capital_valuation_adjustment"}
METHOD_VERSION = "decimal-nav-cny-v4"


@dataclass(frozen=True)
class PreparedValuation:
    portfolio_id: str
    ledger_revision: int
    market_heads: dict
    market_manifest: str
    method_version: str
    cutoff_at: str
    quality: str
    nav_cny: object
    known_partial_cny: str
    issues: tuple
    items: tuple


def _head(connection, portfolio_id):
    row = connection.execute("SELECT revision FROM ledger_heads WHERE portfolio_id=?", (portfolio_id,)).fetchone()
    if row is None:
        raise WorkbenchError("PORTFOLIO_NOT_FOUND")
    return row["revision"]


def _market_head(connection, scope):
    row = connection.execute("SELECT revision,manifest_hash FROM market_publications WHERE scope=?", (scope,)).fetchone()
    return dict(row) if row is not None else None


def _event_before(event, cutoff):
    if event["time_precision"] == "second":
        return instant(event["effective_at"]) <= cutoff, False
    local_day = cutoff.astimezone(ZoneInfo(event["source_timezone"])).date()
    event_day = date.fromisoformat(event["effective_at"])
    return event_day <= local_day, event_day == local_day


def _observed_instant(row):
    if row["time_precision"] == "second":
        return instant(row["observed_at"])
    local_end = datetime.combine(date.fromisoformat(row["observed_at"]) + timedelta(days=1), time.min,
                                 ZoneInfo(row["source_timezone"]))
    return instant(local_end)


def _session(row):
    if row["time_precision"] == "date":
        return row["observed_at"]
    return instant(row["observed_at"]).astimezone(ZoneInfo(row["source_timezone"])).date().isoformat()


def _choose_observation(rows, cutoff, known_at=None):
    known_at = cutoff if known_at is None else known_at
    eligible = []
    for row in rows:
        if (instant(row["ingested_at"]) <= known_at and _observed_instant(row) <= cutoff
                and (row["published_at"] is None or instant(row["published_at"]) <= known_at)):
            eligible.append(row)
    if not eligible:
        return None, "NO_POINT_IN_TIME_OBSERVATION"
    def order(row):
        return (_observed_instant(row), instant(row["published_at"] or row["ingested_at"]), instant(row["ingested_at"]))
    eligible.sort(key=order, reverse=True)
    best = eligible[0]
    ties = [row for row in eligible if order(row) == order(best)]
    if len({(row["value"], row["revision_id"], row["source_id"]) for row in ties}) > 1:
        return None, "AMBIGUOUS_OBSERVATION_REVISION"
    return best, None


@financial
def prepare_valuation(connection, portfolio_id, cutoff_at, rules, mode="as_known", now=None):
    validate_contract(rules, "valuation-rules.schema.json")
    if mode not in ("as_known", "restated"):
        raise WorkbenchError("INVALID_VALUATION_MODE")
    cutoff, current = instant(cutoff_at), instant(now)
    if cutoff > current:
        raise WorkbenchError("FUTURE_VALUATION_CUTOFF")
    known_at = current if mode == "restated" else cutoff
    scopes = set(rules["price_scope_by_market"].values())
    if rules.get("fx_scope"):
        scopes.add(rules["fx_scope"])
    with transaction(connection, immediate=False):
        revision = _head(connection, portfolio_id)
        accounts = {row["id"]: dict(row) for row in connection.execute("SELECT * FROM accounts WHERE portfolio_id=?", (portfolio_id,))}
        events = [dict(row) for row in connection.execute("SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=?", (portfolio_id, revision))]
        postings = [dict(row) for row in connection.execute("""SELECT p.* FROM postings p JOIN ledger_events e ON e.id=p.event_id
            WHERE e.portfolio_id=? AND e.ledger_revision<=?""", (portfolio_id, revision))]
        movements = [dict(row) for row in connection.execute("""SELECT p.*,l.market,l.currency AS listing_currency FROM position_movements p
            JOIN ledger_events e ON e.id=p.event_id JOIN listings l ON l.id=p.listing_id
            WHERE e.portfolio_id=? AND e.ledger_revision<=?""", (portfolio_id, revision))]
        transit_movements = [dict(row) for row in connection.execute("""SELECT p.*,l.market,l.currency AS listing_currency
            FROM security_transit_movements p JOIN ledger_events e ON e.id=p.event_id
            JOIN listings l ON l.id=p.listing_id WHERE e.portfolio_id=? AND e.ledger_revision<=?""", (portfolio_id, revision))]
        heads, publications, observations = {}, {}, {}
        for scope in sorted(scopes):
            heads[scope] = _market_head(connection, scope)
            row = connection.execute("""SELECT e.*,b.validation_json FROM market_publication_events e
                JOIN market_batches b ON b.id=e.batch_id WHERE e.scope=? AND e.published_at<=?
                ORDER BY e.revision DESC LIMIT 1""", (scope, stamp(known_at))).fetchone()
            publications[scope] = dict(row) if row is not None else None
            observations[scope] = [] if row is None else [dict(item) for item in connection.execute("""SELECT o.* FROM market_batch_members m
                JOIN market_observations o ON o.id=m.observation_id WHERE m.batch_id=?""", (row["batch_id"],))]
    issues, blocked, provisional = [], False, False
    if not rules["approved"]:
        issues.append("QUALITY_RULES_UNAPPROVED")
        blocked = True
    included = set()
    for event in events:
        if instant(event["recorded_at"]) > known_at:
            if mode == "restated" and _event_before(event, cutoff)[0]:
                issues.append("FUTURE_RECORDED_FACT_AT_VALUATION:" + event["id"])
                blocked = True
            continue
        eligible, uncertain = _event_before(event, cutoff)
        if eligible:
            included.add(event["id"])
            if uncertain:
                issues.append("DATE_ONLY_FACT_ON_CUTOFF_DAY:" + event["id"])
                provisional = True
    reversed_ids = {event["reversal_of"] for event in events if event["id"] in included and event.get("reversal_of")}
    if not any(event["id"] in included and event["id"] not in reversed_ids and event["event_type"] not in
               ("reversal", "corporate_action_notice", "corporate_action_resolution") for event in events):
        issues.append("PORTFOLIO_NOT_INITIALIZED_AT_CUTOFF")
        blocked = True
    fact_quality = evaluate_fact_quality(events, portfolio_id, revision, cutoff, known_at, mode)
    if fact_quality["nav_quality"] != "complete":
        issues.extend(fact_quality["issues"])
        blocked = blocked or fact_quality["nav_quality"] == "blocked"
        provisional = provisional or fact_quality["nav_quality"] == "provisional"
    balances, position_totals, listing_info = {}, {}, {}
    for row in postings:
        if row["event_id"] not in included:
            continue
        if row["account_id"] not in accounts:
            raise WorkbenchError("POSTING_PORTFOLIO_MISMATCH")
        name = row["ledger_account"]
        if name not in ASSET_ACCOUNTS:
            if name not in IGNORED_ACCOUNTS:
                issues.append("UNSUPPORTED_LEDGER_ACCOUNT:" + name)
                blocked = True
            continue
        key = (row["account_id"], row["currency"], name)
        balances[key] = balances.get(key, ZERO) + decimal(row["amount"])
    for row in movements:
        if row["event_id"] not in included:
            continue
        if row["account_id"] not in accounts or row["currency"] != row["listing_currency"]:
            raise WorkbenchError("POSITION_SCOPE_OR_CURRENCY_MISMATCH")
        key = (row["account_id"], row["listing_id"], row["currency"])
        position_totals[key] = position_totals.get(key, ZERO) + decimal(row["quantity"])
        listing_info[row["listing_id"]] = row
    transit_totals, transit_identity = {}, {}
    for row in transit_movements:
        if row["event_id"] not in included:
            continue
        identity = tuple(row[key] for key in ("source_account_id", "target_account_id", "listing_id", "currency"))
        transfer_id = row["transfer_event_id"]
        if (row["source_account_id"] not in accounts or row["target_account_id"] not in accounts
                or row["source_account_id"] == row["target_account_id"] or row["currency"] != row["listing_currency"]
                or (transfer_id in transit_identity and transit_identity[transfer_id] != identity)):
            raise WorkbenchError("SECURITY_TRANSIT_SCOPE_OR_CURRENCY_MISMATCH")
        transit_identity[transfer_id] = identity
        transit_totals[transfer_id] = transit_totals.get(transfer_id, ZERO) + decimal(row["quantity"])
        listing_info[row["listing_id"]] = row
    economic_positions = [(account, listing, currency, quantity, None, None)
                          for (account, listing, currency), quantity in position_totals.items()]
    economic_positions.extend((transit_identity[transfer_id][0], transit_identity[transfer_id][2],
        transit_identity[transfer_id][3], quantity, transfer_id, transit_identity[transfer_id][1])
        for transfer_id, quantity in transit_totals.items())
    economic_positions.sort(key=lambda row: (row[0], row[1], row[2], row[4] or ""))
    currencies = {currency for (_, currency, _), amount in balances.items() if amount != ZERO}
    currencies.update(currency for _, _, currency, quantity, _, _ in economic_positions if quantity != ZERO)
    fx = {"CNY": decimal("1")}
    fx_evidence, fx_quality = {}, {"CNY": "complete"}
    fx_scope = rules.get("fx_scope")

    def source_issue(scope):
        publication = publications.get(scope)
        if publication is None:
            return "MISSING_PUBLICATION:" + str(scope)
        plan = json.loads(publication["validation_json"])["plan"]
        if not source_verified(connection, publication["batch_id"], plan, known_at=known_at):
            code = "PROVIDER_EVIDENCE_INVALID" if plan.get("source_mode") == "provider_observed" else "SYNTHETIC_DATA_NOT_ACTUAL_VALUATION"
            return code + ":" + scope
        return None

    for currency in sorted(currencies - {"CNY"}):
        problem = source_issue(fx_scope)
        rows = [row for row in observations.get(fx_scope, [])
                if row["series_key"] == "FX:" + currency and row["metric"] == "fx_cny_per_unit" and row["price_basis"] == "not_applicable"]
        chosen, selection_problem = _choose_observation(rows, cutoff, known_at)
        if problem or selection_problem:
            issues.append((problem or selection_problem) + ":" + currency)
            blocked = True
            continue
        if chosen["unit"] != "CNY_per_unit_currency":
            issues.append("FX_UNIT_MISMATCH:" + currency)
            blocked = True
            continue
        fx_quality[currency] = "complete"
        if (cutoff - _observed_instant(chosen)).total_seconds() > rules["max_fx_age_seconds"]:
            issues.append("STALE_FX:" + currency)
            provisional = True
            fx_quality[currency] = "provisional"
        if chosen["provenance"] == "reconstructed":
            issues.append("RECONSTRUCTED_FX:" + currency)
            blocked = True
            continue
        fx[currency] = decimal(chosen["value"])
        fx_evidence[currency] = chosen
    prices, price_quality = {}, {}
    for listing_id in sorted({listing for _, listing, _, quantity, _, _ in economic_positions if quantity != ZERO}):
        info = listing_info[listing_id]
        scope = rules["price_scope_by_market"].get(info["market"])
        expected_session = rules["expected_sessions"].get(info["market"])
        if expected_session is None:
            issues.append("CALENDAR_SESSION_UNKNOWN:" + listing_id)
            blocked = True
        problem = source_issue(scope)
        rows = [row for row in observations.get(scope, [])
                if row["listing_id"] == listing_id and row["metric"] == "close" and row["price_basis"] == "unadjusted"]
        chosen, selection_problem = _choose_observation(rows, cutoff, known_at)
        if problem or selection_problem:
            issues.append((problem or selection_problem) + ":" + listing_id)
            blocked = True
            prices[listing_id] = None
            continue
        if chosen["source_id"] == "provider:longport:prices":
            from .references import price_calendar_session
            try:
                completed = price_calendar_session(connection, publications[scope]["batch_id"],
                                                   portfolio_id, listing_id, cutoff, known_at)
                if expected_session != completed:
                    raise WorkbenchError("PRICE_CALENDAR_RULE_MISMATCH")
            except WorkbenchError:
                issues.append("PRICE_CALENDAR_UNVERIFIED:" + listing_id)
                blocked = True
                prices[listing_id] = None
                continue
        if chosen["unit"] != info["listing_currency"]:
            issues.append("PRICE_CURRENCY_MISMATCH:" + listing_id)
            blocked = True
            prices[listing_id] = None
            continue
        price_quality[listing_id] = "complete"
        if _session(chosen) != expected_session:
            issues.append("SESSION_NOT_LATEST_COMPLETED:" + listing_id)
            provisional = True
            price_quality[listing_id] = "provisional"
        if chosen["provenance"] == "reconstructed":
            issues.append("RECONSTRUCTED_PRICE:" + listing_id)
            blocked = True
            prices[listing_id] = None
            continue
        if not rules["corporate_actions_complete"].get(listing_id, False):
            issues.append("CORPORATE_ACTIONS_UNCONFIRMED:" + listing_id)
            provisional = True
            price_quality[listing_id] = "provisional"
        prices[listing_id] = chosen
    items, currency_fields, aggregate_positions = [], {}, {}
    for (account_id, currency, name), amount in sorted(balances.items()):
        if amount == ZERO:
            continue
        converted = amount * fx[currency] if currency in fx else None
        items.append({"account_id": account_id, "listing_id": None, "item_type": name, "currency": currency,
                      "amount": canonical(amount), "fx_rate": canonical(fx[currency]) if currency in fx else None,
                      "value_cny": canonical(converted) if converted is not None else None,
                      "observed_at": fx_evidence.get(currency, {}).get("observed_at"),
                      "quality": fx_quality.get(currency, "blocked") if converted is not None else "blocked",
                      "evidence_json": canonical_json({"ledger_revision": revision, "fx_observation_id": fx_evidence.get(currency, {}).get("id")})})
        field = ASSET_ACCOUNTS[name]
        fields = currency_fields.setdefault(currency, {})
        economic = -amount if name in ("trade_payable", "other_liability") else amount
        fields[field] = fields.get(field, ZERO) + economic
    for account_id, listing_id, currency, quantity, transfer_id, target_account_id in economic_positions:
        if quantity == ZERO:
            continue
        evidence = {"quantity": canonical(quantity)}
        if transfer_id is not None:
            evidence.update(transfer_event_id=transfer_id, target_account_id=target_account_id)
        if quantity < ZERO:
            issues.append(("NEGATIVE_SECURITY_TRANSIT:" + transfer_id) if transfer_id else "NEGATIVE_POSITION:" + listing_id)
            blocked = True
            items.append({"account_id": account_id, "listing_id": listing_id, "item_type": "invalid_position",
                          "currency": currency, "amount": None, "fx_rate": None, "value_cny": None,
                          "observed_at": None, "quality": "blocked", "evidence_json": canonical_json(evidence)})
            continue
        price = prices.get(listing_id)
        amount = quantity * decimal(price["value"]) if price else None
        converted = amount * fx[currency] if amount is not None and currency in fx else None
        evidence.update(price_observation_id=price["id"] if price else None,
                        fx_observation_id=fx_evidence.get(currency, {}).get("id"))
        items.append({"account_id": account_id, "listing_id": listing_id,
                      "item_type": "security_in_transit_market_value" if transfer_id else "security_market_value",
                      "currency": currency, "amount": canonical(amount) if amount is not None else None,
                      "fx_rate": canonical(fx[currency]) if currency in fx else None,
                      "value_cny": canonical(converted) if converted is not None else None,
                      "observed_at": price["observed_at"] if price else None,
                      "quality": ("provisional" if "provisional" in (price_quality.get(listing_id), fx_quality.get(currency)) else "complete") if converted is not None else "blocked",
                      "evidence_json": canonical_json(evidence)})
        aggregate_positions[(listing_id, currency)] = aggregate_positions.get((listing_id, currency), ZERO) + quantity
    aggregate_balances = {}
    for currency, fields in currency_fields.items():
        for key, amount in fields.items():
            if ((key not in ("settled_cash", "dividend_tax_payable") and amount < ZERO)
                    or (key == "dividend_tax_payable" and amount > ZERO)):
                issues.append("INVALID_LEDGER_BALANCE:" + currency + ":" + key)
                blocked = True
        if all(key == "settled_cash" or (amount <= ZERO if key == "dividend_tax_payable" else amount >= ZERO)
               for key, amount in fields.items()):
            aggregate_balances[currency] = CurrencyBalance(**fields)
    positions = [ValuedPosition(listing_id, currency, quantity, prices[listing_id]["value"] if prices.get(listing_id) else None)
                 for (listing_id, currency), quantity in aggregate_positions.items()]
    quality = "blocked" if blocked else "provisional" if provisional else "complete"
    valuation = nav_cny(aggregate_balances, positions, fx, quality, sorted(set(issues)))
    manifest = {"schema_version": "valuation-input-v3", "mode": mode, "rules_hash": content_hash(rules),
                "ledger_fact_quality": fact_quality,
                "rules": rules, "publications": {scope: ({key: row[key] for key in ("scope", "revision", "batch_id", "manifest_hash", "published_at")} if row else None)
                                                for scope, row in publications.items()}}
    validate_contract(manifest, "valuation-input-v3.schema.json")
    return PreparedValuation(portfolio_id, revision, heads, canonical_json(manifest), METHOD_VERSION + ":" + mode,
                             stamp(cutoff), valuation.quality, canonical(valuation.nav_cny) if valuation.nav_cny is not None else None,
                             canonical(valuation.known_partial_cny), valuation.issues, tuple(items))


def persist_valuation(connection, prepared, now=None):
    if prepared.method_version not in (METHOD_VERSION + ":as_known", METHOD_VERSION + ":restated"):
        raise WorkbenchError("VALUATION_METHOD_SUPERSEDED")
    with transaction(connection):
        if _head(connection, prepared.portfolio_id) != prepared.ledger_revision:
            raise WorkbenchError("STALE_LEDGER_REVISION")
        try:
            manifest = json.loads(prepared.market_manifest)
            validate_contract(manifest, "valuation-input-v3.schema.json")
            proof = manifest["ledger_fact_quality"]
            events = [dict(row) for row in connection.execute(
                "SELECT * FROM ledger_events WHERE portfolio_id=? AND ledger_revision<=?",
                (prepared.portfolio_id, prepared.ledger_revision))]
            if (manifest["rules_hash"] != content_hash(manifest["rules"])
                    or manifest["mode"] != prepared.method_version.rsplit(":", 1)[1]
                    or instant(proof["knowledge_at"]) < instant(prepared.cutoff_at)
                    or instant(proof["knowledge_at"]) > instant(now)
                    or proof != evaluate_fact_quality(events, prepared.portfolio_id, prepared.ledger_revision,
                        prepared.cutoff_at, proof["knowledge_at"], manifest["mode"])
                    or (proof["nav_quality"] != "complete" and prepared.quality == "complete")):
                raise ValueError("invalid")
        except (ValueError, TypeError, KeyError) as exc:
            raise WorkbenchError("VALUATION_FACT_QUALITY_INVALID") from exc
        if any(_market_head(connection, scope) != expected for scope, expected in prepared.market_heads.items()):
            raise WorkbenchError("STALE_MARKET_PUBLICATION")
        key = (prepared.portfolio_id, prepared.ledger_revision, prepared.market_manifest, prepared.method_version, prepared.cutoff_at)
        existing = connection.execute("""SELECT * FROM valuation_runs WHERE portfolio_id=? AND ledger_revision=?
            AND market_manifest=? AND method_version=? AND cutoff_at=?""", key).fetchone()
        if existing:
            return dict(existing)
        run_id = new_id("valuation")
        issues = {"codes": list(prepared.issues), "known_partial_cny": prepared.known_partial_cny,
                  "complete_nav_available": prepared.nav_cny is not None}
        connection.execute("""INSERT INTO valuation_runs
            (id,portfolio_id,ledger_revision,market_manifest,method_version,cutoff_at,quality,nav_cny,issues_json,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""",
                           (run_id, *key[:4], key[4], prepared.quality, prepared.nav_cny, canonical_json(issues), stamp(now)))
        for item in prepared.items:
            fields = tuple(item)
            connection.execute("INSERT INTO valuation_items(id,run_id," + ",".join(fields) + ") VALUES(?,? ," + ",".join("?" for _ in fields) + ")",
                               (new_id("valuation-item"), run_id, *(item[field] for field in fields)))
        return dict(connection.execute("SELECT * FROM valuation_runs WHERE id=?", (run_id,)).fetchone())


def value_portfolio(connection, portfolio_id, cutoff_at, rules, mode="as_known", now=None):
    prepared = prepare_valuation(connection, portfolio_id, cutoff_at, rules, mode, now)
    return persist_valuation(connection, prepared, now)
