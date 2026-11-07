"""One further retained close, with normal audited source maintenance, offline."""

from copy import deepcopy
from datetime import timedelta
from unittest.mock import patch

from tests.investor import epoch_source_fixture as first, epoch_registration_fixture as registration
from worker.investor import data_evidence, managed_actions
from worker.orchestration.db import instant
from worker.market.contracts import contract_validation_scope


NOW = "2026-10-21T10:00:03.000Z"
SERIES = {"authority_id": "fictional-epoch-continuation-fx", "revision_policy": "append_only_no_restatements"}


# Keep existing pure-shape limits, and discard the scope before test mutations.
@contract_validation_scope()
def create(db, path):
    reviewed = data_evidence.review_source
    def explicit_fictional_facts(connection, workspace, actor, source_id, decision, facts, reason, valid_until, **kwargs):
        kind = connection.execute("SELECT kind FROM investor_data_sources WHERE id=?", (source_id,)).fetchone()[0]
        facts = deepcopy(facts)
        if kind == "fx": facts["monitor_series"] = deepcopy(SERIES)
        if kind == "calendar":
            day = first.current.actions.datetime.fromisoformat(facts["range_end"]).date() + timedelta(days=1)
            end = first.current.actions.datetime.fromisoformat("2026-10-23").date()
            while day <= end:
                facts["days"].append({"date": day.isoformat(), "kind": "full", "close_at": first.current.actions.day_at(day, 16),
                    "available_at": first.current.actions.stamp(instant(first.current.actions.day_at(day, 16)) + timedelta(minutes=1)),
                    "settled_at": first.current.actions.day_at(day + timedelta(days=1), 17),
                    "settlement_rule_known_at": kwargs["now"]})
                day += timedelta(days=1)
            facts["range_end"] = end.isoformat()
        return reviewed(connection, workspace, actor, source_id, decision, facts, reason, valid_until, **kwargs)
    with patch.object(data_evidence, "review_source", side_effect=explicit_fictional_facts):
        return registration.register(db, first.create(db, path))


def next_sources(db, saved, *, at=NOW):
    current = first.current
    dates = current.timeline(first.AT)
    issuer = db.execute("SELECT id FROM investor_issuer_authorities WHERE workspace_id='w'").fetchone()[0]
    current.actions.collect(db, dates, issuer, at, updated=True, gross="5.32109")
    publications = managed_actions.publish_current_actions(db, now=at)
    assert len(publications) == 1 and publications[0]["status"] == "published", publications
    original = saved["preview"]["input"]["segments"][0]["snapshot"]
    captures = [data_evidence.resolve_capture(db, "w", ref["capture_id"], now=at) for ref in original["capture_refs"]]
    listing_ids = sorted({row["binding"]["listing"]["review"]["id"] for row in captures})
    listings = [dict(db.execute("SELECT * FROM investor_data_reviews WHERE id=?", (identifier,)).fetchone()) for identifier in listing_ids]
    day = instant(at).astimezone(current.actions.ZONE).date() - timedelta(days=1)
    current.prices(db, {"rights": captures[0]["binding"]["rights"]["review"], "listings": listings}, captures[0]["binding"]["calendar"]["review"], day, at)
    prior = next(data_evidence.resolve_review(db, "w", ref["review_id"], "fx", now=at) for ref in original["review_refs"]
        if db.execute("SELECT kind FROM investor_data_sources WHERE id=?", (ref["source_id"],)).fetchone()[0] == "fx")
    observed = current.actions.day_at(day, 15)
    return current.reviewed(db, "fx", {"currency": "USD", "unit": "CNY_per_unit_currency", "monitor_series": deepcopy(SERIES), "rows": [*prior["facts"]["rows"],
        {"observed_at": observed, "assumed_available_at": current.actions.stamp(instant(observed) + timedelta(minutes=1)), "value": "1.31"}]},
        at, saved["preview"]["epoch_definition"]["valid_until"], "epoch-continuation-fx")
