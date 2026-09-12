"""Frozen pre-index lookup oracle; intentionally slow and test-only."""

from decimal import Decimal

from worker.accounting import decimal
from worker.orchestration.db import WorkbenchError, instant


class ReferenceMarketView:
    def __init__(self, dataset, fx_age_seconds):
        self.dataset = dataset
        self.assets = {row["listing_id"]: row for row in dataset["assets"]}
        self.sessions = sorted(dataset["sessions"], key=lambda row: instant(row["close_at"]))
        self.fx_age_seconds = fx_age_seconds
        self.rows = {}
        for row in dataset["observations"]:
            key = (row.get("listing_id"), row["metric"]) if row["metric"] == "close" else (row["series_key"], row["metric"])
            self.rows.setdefault(key, []).append(row)

    def available(self, row):
        times = [instant(row["observed_at"])]
        if row.get("published_at"):
            times.append(instant(row["published_at"]))
        if self.dataset["mode"] == "actual_replay":
            times.append(instant(row["ingested_at"]))
        return max(times)

    def price(self, listing_id, at, decision=False, exact_at=None):
        asset = self.assets[listing_id]
        rows = [row for row in self.rows.get((listing_id, "close"), []) if row["price_basis"] == "unadjusted"
                and instant(row["observed_at"]) <= at]
        if exact_at is not None:
            rows = [row for row in rows if instant(row["observed_at"]) == exact_at]
        candidates = []
        for row in rows:
            session = next(item for item in self.sessions if item["market"] == asset["market"] and instant(item["close_at"]) == instant(row["observed_at"]))
            known_by = at if decision else instant(session["available_at"])
            if self.available(row) <= known_by and (not decision or instant(session["available_at"]) <= at):
                candidates.append(row)
        if not candidates:
            raise WorkbenchError("RESEARCH_PRICE_UNAVAILABLE:" + listing_id)
        candidates.sort(key=lambda row: (instant(row["observed_at"]), self.available(row)), reverse=True)
        row = candidates[0]
        latest = [session for session in self.sessions if session["market"] == asset["market"]
                  and instant(session["available_at"] if decision else session["close_at"]) <= at]
        if latest and instant(row["observed_at"]) != instant(latest[-1]["close_at"]):
            raise WorkbenchError("MISSING_REQUIRED_RESEARCH_SESSION:" + listing_id)
        ties = [candidate for candidate in candidates if instant(candidate["observed_at"]) == instant(row["observed_at"]) and self.available(candidate) == self.available(row)]
        if len({(candidate["value"], candidate["revision_id"]) for candidate in ties}) > 1:
            raise WorkbenchError("AMBIGUOUS_RESEARCH_PRICE_REVISION")
        return decimal(row["value"]), row["id"]

    def fx(self, currency, at):
        if currency == "CNY":
            return Decimal("1"), None
        rows = [row for row in self.rows.get(("FX:" + currency, "fx_cny_per_unit"), []) if self.available(row) <= at]
        if not rows:
            raise WorkbenchError("RESEARCH_FX_UNAVAILABLE:" + currency)
        row = max(rows, key=lambda row: (instant(row["observed_at"]), self.available(row)))
        ties = [candidate for candidate in rows if instant(candidate["observed_at"]) == instant(row["observed_at"])
                and self.available(candidate) == self.available(row)]
        if len({(candidate["value"], candidate["revision_id"]) for candidate in ties}) > 1:
            raise WorkbenchError("AMBIGUOUS_RESEARCH_FX_REVISION")
        if (at - instant(row["observed_at"])).total_seconds() > self.fx_age_seconds:
            raise WorkbenchError("STALE_RESEARCH_FX:" + currency)
        return decimal(row["value"]), row["id"]

    def next_session(self, listing_id, decision_at, end_at):
        asset = self.assets[listing_id]
        sessions = [row for row in self.sessions if row["market"] == asset["market"] and row["trade_allowed"]
                    and decision_at < instant(row["close_at"]) <= end_at]
        if not sessions:
            return None
        at = instant(sessions[0]["close_at"])
        if at < instant(asset["tradable_from"]) or asset.get("tradable_until") and at >= instant(asset["tradable_until"]):
            raise WorkbenchError("ASSET_NOT_HISTORICALLY_TRADABLE:" + listing_id)
        return at
