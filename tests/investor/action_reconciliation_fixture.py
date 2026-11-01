"""Invented bytes and mocked transports only, never live data or credentials."""

from hashlib import sha256
from unittest.mock import patch

from tests.investor import test_eodhd_sources as eod
from tests.investor.test_issuer_sources import Collector as IssuerCollector, policy as issuer_policy
from tests.market.test_eodhd_actions import archive as div_archive, dividend
from tests.market.test_vanguard_distributions import archive, row
from worker.investor import data_evidence, eodhd_sources, issuer_sources
from worker.market.providers.eodhd_actions import action_url, parse_eodhd_actions
from worker.orchestration.jobs import run_one


AT = eod.AT
REGISTER = eod.REGISTER


class ActionCollector:
    def __init__(self):
        self.calls = 0

    def __call__(self, **options):
        self.calls += 1
        parameters = {key:options[key] for key in ('kind','symbol','start_date','end_date')}
        raw = b'[]' if parameters['kind'] == 'splits' else div_archive(dividend('987.123',
            date='2026-09-25', declarationDate='2026-09-20', recordDate='2026-09-25', paymentDate='2026-09-30'))
        receipt = {'schema_version':eod.TRANSPORT_VERSION,'url_without_credentials':action_url(**parameters),
            'request':parameters,'started_at':AT,'completed_at':AT,'retrieved_at':AT,'http_status':200,
            'raw_sha256':sha256(raw).hexdigest(),'raw_bytes':len(raw),'redirects_followed':0,
            'response_format':'utf8_json_identity','credential_in_receipt':False}
        return {'schema_version':eodhd_sources.receiver.VERSION,'raw':raw,'receipt':receipt,
            'draft':parse_eodhd_actions(raw,**parameters,retrieved_at=AT)}


def create(db, *, official=False):
    members = {}
    for index, (symbol, fund) in enumerate((('VT.US','3141'),('BND.US','0928'))):
        source = data_evidence.store_source(db,'w','synthetic-investor','listing',{
            'title':'Fictional identity '+symbol,'reference':'synthetic://identity/'+fund,
            'excerpt':'Invented mapping, not actual issuer identity certification'},now=REGISTER)
        review = data_evidence.review_source(db,'w','synthetic-investor',source['id'],'approved',{
            'listing_id':'synthetic-'+fund,'provider_symbol':symbol,'market':'US','currency':'USD','quantity_step':'1',
            'tradable_from':'2020-01-01T00:00:00Z','tradable_until':None,'product_type':'ETF','leveraged':False,'inverse':False,
            'role':'growth','fee_rate':'0.001','fee_as_of':'2026-01-01','economic_exposure':'Fictional exposure',
            'historical_universe_basis':'retrospectively_selected_not_survivorship_free'},
            'Fictional test only','2027-01-01T00:00:00.000Z',now=REGISTER)
        authority = issuer_sources.register_authority(db,'w','synthetic-investor',issuer_policy(fund_id=fund),now=REGISTER)
        issuer_sources.set_authority_enabled(db,'w','synthetic-investor',authority['id'],True,now=REGISTER)
        collector = IssuerCollector(at=AT,raw=archive(row('987.1234',exDividendDate='2026-09-25',
            recordDate='2026-09-25',payableDate='2026-09-30')))
        original_ms, original_clock, original_instant = issuer_sources._milliseconds, issuer_sources._clock, issuer_sources.instant
        with patch.object(issuer_sources.receiver,'collect_vanguard_distribution_draft',side_effect=collector), \
                patch.object(issuer_sources,'_milliseconds',side_effect=lambda value=None:original_ms(AT if value is None else value)), \
                patch.object(issuer_sources,'_clock',side_effect=lambda value=None:original_clock(AT if value is None else value)), \
                patch.object(issuer_sources,'instant',side_effect=lambda value=None:original_instant(AT if value is None else value)):
            captured = issuer_sources.collect_issuer_draft(db,'w','synthetic-investor',authority['id'],str(index+1)*32,
                '2025-11-02','2026-11-01',now=None if official else AT,test_collector=None if official else collector)
        members[symbol] = {'listing_review_id':review['id'],'listing_source_id':source['id'],
            'issuer_authority_id':authority['id'],'issuer_capture_id':captured['capture_id']}
    authority = eodhd_sources.register_authority(db,'w','synthetic-investor',eod.policy(),now=REGISTER)
    eodhd_sources.set_authority_enabled(db,'w','synthetic-investor',authority['id'],True,now=REGISTER)
    collector = ActionCollector()
    with patch.dict('os.environ',{'WORKBENCH_EODHD_ENABLED':'1'}), \
            patch.object(eodhd_sources.receiver,'collect_eodhd_action_draft',side_effect=collector):
        jobs = eodhd_sources.discover_eodhd_requests(db,now=AT)
        assert len(jobs) == 4
        for unused in jobs:
            finished = run_one(db,'fictional-source-comparison',lambda job,lease:eodhd_sources.prepare_eodhd_capture(db,job,lease,
                clock=lambda:AT,test_collector=None if official else collector),job_type=eodhd_sources.JOB_TYPE,
                lease_seconds=180,clock=lambda:AT)
            assert finished['status'] == 'succeeded'
        for request in db.execute('SELECT r.*,c.id capture_id FROM investor_eodhd_requests r JOIN investor_eodhd_captures c ON c.request_id=r.id'):
            members[request['symbol']]['dividend_capture_id' if request['kind']=='div' else 'split_capture_id'] = request['capture_id']
            members[request['symbol']]['eodhd_authority_id'] = authority['id']
    assert collector.calls == 4
    return members


def contract_document():
    import unittest
    from tests.investor.test_runtime import InvestorRuntimeTests
    from worker.investor.action_reconciliation import check_action_crosscheck
    case = unittest.TestCase()
    try:
        InvestorRuntimeTests.setUp(case)
        member = create(case.db)['VT.US']
        return check_action_crosscheck(case.db,'w','synthetic-investor',
            *(member[key] for key in ('listing_review_id','issuer_capture_id','dividend_capture_id','split_capture_id')),
            now=AT,allow_synthetic=True)
    finally:
        case.doCleanups()


if __name__ == '__main__':
    import json
    print(json.dumps(contract_document()))
