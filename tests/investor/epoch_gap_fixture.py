"""Retained intermediate closes during a fictional stopped-core interval."""

from copy import deepcopy
from datetime import datetime,timedelta
from decimal import Decimal
import json
from unittest.mock import patch

from tests.investor import epoch_continuation_source_fixture as fixture
from tests.investor.epoch_source_fixture import current
from worker.investor import data_evidence
from worker.market.providers import longport
from worker.orchestration.db import instant

NOW = "2026-10-22T10:00:03.000Z"


def inputs(db,saved):
    snapshot = saved["preview"]["input"]["segments"][0]["snapshot"]
    captures = [data_evidence.resolve_capture(db,"w",r["capture_id"],now=NOW) for r in snapshot["capture_refs"]]
    ids = sorted({r["binding"]["listing"]["review"]["id"] for r in captures})
    return captures[0]["binding"]["rights"]["review"],[dict(db.execute("SELECT * FROM investor_data_reviews WHERE id=?",(i,)).fetchone()) for i in ids],captures[0]["binding"]["calendar"]["review"]


def add_prices(db,saved,days,*,delta="0"):
    rights,listings,calendar = inputs(db,saved);ids = []
    for index,listing in enumerate(listings):
        facts = json.loads(listing["document_json"])["facts"]
        mapping = {k:facts[k] for k in ("listing_id","provider_symbol","market","currency")}
        request = longport._request(mapping,min(days),max(days),days)
        price = Decimal("10" if index==0 else "20") + Decimal(delta)
        candles = [{"timestamp":datetime.fromisoformat(d).replace(tzinfo=current.actions.ZONE),"open":price,"high":price,"low":price,"close":price,
            "volume":1000,"turnover":price*1000,"trade_session":0} for d in days]
        result = longport._normalize(candles,request=request,sdk_version=longport.SDK_VERSION,call_started_at=NOW,call_returned_at=NOW,
            datetime_basis="runtime_utc_from_unix_timestamp",collector_runtime="isolated_official_sdk")
        millis,parse = data_evidence._milliseconds,data_evidence.instant
        with patch.object(longport,"_collect_isolated",return_value=result), \
                patch.object(data_evidence,"_milliseconds",side_effect=lambda value=None:millis(NOW if value is None else value)), \
                patch.object(data_evidence,"instant",side_effect=lambda value=None:parse(NOW if value is None else value)):
            captured = data_evidence.collect_prices(db,"w","owner",rights["id"],listing["id"],calendar["id"],min(days),max(days))
        ids.append(captured["id"])
    return ids


def create(db,path):
    reviewed = current.reviewed
    def fictional_bond_coverage(connection,kind,facts,*args,**kwargs):
        facts = deepcopy(facts)
        if kind=="actions" and facts["listing_id"]=="synthetic-0928":facts["range_end"]="2026-10-23"
        return reviewed(connection,kind,facts,*args,**kwargs)
    with patch.object(current,"reviewed",side_effect=fictional_bond_coverage):saved = fixture.create(db,path)
    fixture.next_sources(db,saved,at=NOW)
    intermediate = add_prices(db,saved,["2026-10-20"])
    snapshot = saved["preview"]["input"]["segments"][0]["snapshot"]
    prior = next(data_evidence.resolve_review(db,"w",r["review_id"],"fx",now=NOW) for r in snapshot["review_refs"]
        if db.execute("SELECT kind FROM investor_data_sources WHERE id=?",(r["source_id"],)).fetchone()[0]=="fx")
    rows = deepcopy(prior["facts"]["rows"])
    for day in ("2026-10-20","2026-10-21"):
        observed = current.actions.day_at(datetime.fromisoformat(day).date(),15)
        rows.append({"observed_at":observed,"assumed_available_at":current.actions.stamp(instant(observed)+timedelta(minutes=1)),"value":"1.31"})
    current.reviewed(db,"fx",{"currency":"USD","unit":"CNY_per_unit_currency","monitor_series":deepcopy(fixture.SERIES),"rows":rows},
        NOW,saved["preview"]["epoch_definition"]["valid_until"],"epoch-gap-explicit-fx-series")
    return {"saved":saved,"intermediate_capture_ids":intermediate,"now":NOW}
