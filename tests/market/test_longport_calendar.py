"""Fictional calendar projections and mocked transport, no network or credentials."""

import json
import unittest
from unittest.mock import patch

from worker.market.providers import longport_calendar as calendar
from worker.orchestration.db import WorkbenchError


NOW = "2026-10-12T12:00:00Z"


class CalendarTests(unittest.TestCase):
    def request(self):
        return calendar.calendar_request("CN", "2026-09-01", "2026-09-30", NOW)

    def projection(self):
        return {"request": self.request(), "sdk_version": "4.3.7", "call_started_at": NOW, "call_returned_at": NOW,
            "trading_days": ["2026-09-02", "2026-09-01"], "half_trading_days": ["2026-09-02"]}

    def test_unsupported_historical_window_is_rejected_before_secret_read_or_sdk(self):
        with patch.object(calendar, "stamp", return_value=NOW), \
                patch.object(calendar.longport, "read_private_credentials_file") as read, \
                patch.object(calendar.longport, "_load_sdk") as sdk, patch.object(calendar, "run_memory_process") as transport:
            with self.assertRaisesRegex(WorkbenchError, "OUTSIDE_DOCUMENTED_RECENT_WINDOW"):
                calendar.collect_recent_calendar(market="CN", start_date="2021-10-01", end_date="2021-10-31", credentials_file="/private/not-read.env")
        read.assert_not_called(); sdk.assert_not_called(); transport.assert_not_called()

    def test_local_date_boundary_not_utc_date_and_conservative_year_range(self):
        calendar.calendar_request("CN", "2026-10-13", "2026-10-13", "2026-10-12T17:00:00Z")
        with self.assertRaises(WorkbenchError):
            calendar.calendar_request("US", "2026-10-13", "2026-10-13", "2026-10-12T17:00:00Z")
        calendar.calendar_request("CN", "2025-10-12", "2025-10-12", NOW)
        with self.assertRaises(WorkbenchError): calendar.calendar_request("CN", "2025-10-11", "2025-10-11", NOW)

    def test_long_future_invalid_or_wrong_market_dates_reject(self):
        for market,start,end in (("CN","2026-08-30","2026-09-30"), ("CN","2026-10-13","2026-10-13"),
            ("EU","2026-09-01","2026-09-30"), ("CN","2026-09-30","2026-09-01"), ("CN","20260901","2026-09-30")):
            with self.subTest(market=market,start=start), self.assertRaises(WorkbenchError):
                calendar.calendar_request(market,start,end,NOW)

    def test_half_day_precedence_but_no_default_closed_or_settlement_approval(self):
        result=calendar.normalize_calendar(self.projection(),request=self.request(),before=NOW,after=NOW)
        self.assertEqual(result['records'],[{'date':'2026-09-01','kind':'full'},{'date':'2026-09-02','kind':'half'}])
        for key in ('absent_dates_are_verified_closed','settlement_calendar_verified','owner_reviewed','research_admitted','historical_calendar_verified'):
            self.assertFalse(result[key])
        self.assertNotIn('2026-09-03',json.dumps(result['records']))

    def test_empty_projection_is_not_certified_full_month_closure(self):
        value=self.projection();value['trading_days']=[];value['half_trading_days']=[]
        result=calendar.normalize_calendar(value,request=self.request(),before=NOW,after=NOW)
        self.assertEqual(result['records'],[]);self.assertFalse(result['absent_dates_are_verified_closed'])

    def test_duplicate_outside_dates_wrong_sdk_clock_or_request_fail(self):
        for key,value in (('trading_days',['2026-09-01','2026-09-01']),('half_trading_days',['2026-10-01']),
            ('trading_days',[True]),('sdk_version','5.2.0'),('call_returned_at','2026-10-12T11:59:59Z'),('request',{})):
            document=self.projection();document[key]=value
            with self.subTest(key=key),self.assertRaises(WorkbenchError):
                calendar.normalize_calendar(document,request=self.request(),before=NOW,after=NOW)

    def test_duplicate_or_nonfinite_json_reject_without_echo(self):
        for raw in (b'{"x":1,"x":2}',b'{"x":NaN}',b'x'*65537):
            with self.assertRaisesRegex(WorkbenchError,'^LONGPORT_CALENDAR_INVALID$'): calendar._object(raw)

    def test_native_transport_protocol_only_projects_calendar_and_no_credentials_output(self):
        credentials={'app_key':'fictional-key','app_secret':'fictional-secret','access_token':'fictional-token'}
        with patch.object(calendar,'stamp',return_value=NOW), \
                patch.object(calendar.longport,'read_private_credentials_file',return_value=credentials), \
                patch.object(calendar.longport,'_load_sdk'), \
                patch.object(calendar,'run_memory_process',return_value=json.dumps(self.projection()).encode()) as run:
            result=calendar.collect_recent_calendar(market='CN',start_date='2026-09-01',end_date='2026-09-30',credentials_file='/private/fictional.env')
        self.assertEqual(run.call_args.kwargs['environment']['TZ'],'UTC')
        self.assertEqual(run.call_args.kwargs['max_output'],65536)
        self.assertEqual(run.call_args.args[0][1],'-I')
        self.assertNotIn('fictional-secret',json.dumps(result));self.assertFalse(result['research_admitted'])


if __name__ == '__main__': unittest.main()
