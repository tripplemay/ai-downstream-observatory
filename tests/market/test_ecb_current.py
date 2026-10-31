"""Fictional reference legs; child protocol tests never contact a provider."""

import base64
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from tests.market.test_ecb_provider import xml
from worker.investor.data_evidence import validate_facts
from worker.market.providers import ecb_current as capture
from worker.market.providers.process import run_memory_process
from worker.orchestration.db import ROOT, WorkbenchError


AT = "2025-06-07T12:00:00.000Z"
NOW = datetime(2025, 6, 7, 12, tzinfo=timezone.utc)


def receipt(raw=None):
    raw = xml() if raw is None else raw
    return {"raw_base64": base64.b64encode(raw).decode(), "source_url": capture.ecb.URLS[capture.FEED],
        "started_at": AT, "completed_at": AT, "retrieved_at": AT, "http_status": 200,
        "headers": {"content-type": "application/xml", "content-length": str(len(raw))},
        "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0}


class CurrentFxDraftTests(unittest.TestCase):
    def build(self, raw=None, **kwargs):
        return capture.build_current_fx_draft(xml() if raw is None else raw,
            retrieved_at=kwargs.pop("retrieved_at", AT), currencies=kwargs.pop("currencies", ["USD", "HKD"]), **kwargs)

    def test_exact_existing_facts_and_explicit_reference_not_execution_semantics(self):
        value = self.build()
        for facts in value["facts"].values():
            validate_facts("fx", facts)
            self.assertNotIn("monitor_series", facts)
        row = value["facts"]["USD"]["rows"][0]
        self.assertEqual(row, {"observed_at": "2025-06-05T22:00:00.000Z",
            "assumed_available_at": "2025-06-06T22:00:00.000Z", "value": "6.4"})
        self.assertEqual(value["metadata"]["availability_status"], "available")
        self.assertEqual(value["metadata"]["freshness_status"], "not_assessed")
        self.assertEqual(value["metadata"]["rate_kind"], "reference_not_executable")
        self.assertEqual(value["metadata"]["publication_time_status"], "not_supplied")
        self.assertEqual(value["source_document"]["reference"], capture.ecb.URLS["hist_90d"])
        self.assertNotEqual(value["source_document"]["reference"], capture.ecb.HISTORY_URL)
        self.assertFalse(value["owner_reviewed"]); self.assertFalse(value["production_admitted"])

    def test_pending_whole_document_is_not_clipped_or_retimed(self):
        raw = xml([("2025-06-06", [("CNY", "8"), ("USD", "2")]),
            ("2025-06-05", [("CNY", "8"), ("USD", "4")])])
        value = self.build(raw, currencies=["USD"], retrieved_at="2025-06-06T17:00:00Z")
        self.assertEqual(value["metadata"]["availability_status"], "pending")
        self.assertEqual(value["metadata"]["not_before"], "2025-06-06T22:00:00.000Z")
        self.assertEqual(len(value["facts"]["USD"]["rows"]), 2)
        equal = self.build(raw, currencies=["USD"], retrieved_at=value["metadata"]["not_before"])
        self.assertEqual(equal["metadata"]["availability_status"], "available")

    def test_dst_midnights_are_local_calendar_boundaries_not_plus_24_hours(self):
        for day, observed, available in (("2025-03-30", "2025-03-29T23:00:00.000Z", "2025-03-30T22:00:00.000Z"),
            ("2025-10-26", "2025-10-25T22:00:00.000Z", "2025-10-26T23:00:00.000Z")):
            with self.subTest(day=day):
                value = self.build(xml([(day, [("CNY", "8"), ("USD", "2")])]), currencies=["USD"], retrieved_at="2025-10-28T00:00:00Z")
                row = value["facts"]["USD"]["rows"][0]
                self.assertEqual((row["observed_at"], row["assumed_available_at"]), (observed, available))

    def test_old_reference_is_not_certified_fresh_or_promoted_by_retrieval(self):
        value = self.build(retrieved_at="2025-07-07T00:00:00Z")
        self.assertEqual(value["facts"]["USD"]["rows"][0]["observed_at"], "2025-06-05T22:00:00.000Z")
        self.assertEqual(value["metadata"]["freshness_status"], "not_assessed")

    def test_invalid_or_missing_currency_and_bad_xml_rejected(self):
        for currencies in ([], ["EUR"], ["USD", "USD"], "USD", [True], ["USD", "HKD", "EUR"]):
            with self.subTest(currencies=currencies), self.assertRaises(WorkbenchError): self.build(currencies=currencies)
        for raw in (b"bad", b"<!DOCTYPE a><a/>", xml([("2025-06-06", [("CNY", "8")])])):
            with self.subTest(raw=raw), self.assertRaises(WorkbenchError): self.build(raw)


class CurrentFxCaptureTests(unittest.TestCase):
    def collect(self, encoded=None, runner=None, **changes):
        encoded = json.dumps(receipt()).encode() if encoded is None else encoded
        with patch.object(capture, "datetime") as clock, patch.object(capture, "run_memory_process", side_effect=runner) as process:
            clock.now.return_value = NOW
            process.return_value = encoded
            value = capture.collect_current_fx_draft(**{"currencies": ["USD", "HKD"], **changes})
        return value, process

    def test_capture_replays_original_xml_hash_and_never_approves(self):
        value, process = self.collect()
        self.assertEqual(value["raw"], xml())
        self.assertEqual(value["receipt"]["raw_sha256"], value["draft"]["metadata"]["raw_sha256"])
        self.assertFalse(value["draft"]["production_admitted"])
        self.assertNotIn("raw_base64", value["receipt"])
        process.assert_called_once()

    def test_fixed_private_child_has_no_credentials_database_proxy_clock_or_endpoint(self):
        seen = {}
        def runner(argv, **kwargs):
            seen.update(kwargs); seen["argv"] = argv
            directory = Path(kwargs["cwd"])
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual(list(directory.iterdir()), [])
            self.assertEqual(set(kwargs["environment"]), {"HOME", "TZ", "LANG", "LC_ALL", "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE"})
            self.assertEqual(kwargs["environment"]["HOME"], str(directory))
            return json.dumps(receipt()).encode()
        with patch.dict(os.environ, {"LONGBRIDGE_APP_SECRET": "fictional-secret", "HTTPS_PROXY": "http://fictional.invalid/"}):
            self.collect(runner=runner, timeout_seconds=7)
        self.assertFalse(Path(seen["cwd"]).exists())
        self.assertEqual(seen["argv"], [sys.executable, "-I", str(Path(capture.__file__).resolve()), "--download-child"])
        self.assertEqual(json.loads(seen["input_bytes"]), {"timeout_seconds": 7})
        self.assertEqual(seen["timeout"], 7)

    def test_bad_request_rejects_before_process(self):
        for change in ({"currencies": ["EUR"]}, {"timeout_seconds": True}, {"timeout_seconds": 31}, {"timeout_seconds": 0}):
            with self.subTest(change=change), patch.object(capture, "run_memory_process") as process:
                with self.assertRaises(WorkbenchError): capture.collect_current_fx_draft(**{"currencies": ["USD"], **change})
                process.assert_not_called()

    def test_closed_receipt_identity_clock_hash_header_and_type_checks(self):
        for change in ({"source_url": capture.ecb.HISTORY_URL}, {"raw_sha256": "0" * 64}, {"raw_bytes": True},
            {"raw_bytes": 1}, {"raw_base64": "!"}, {"redirects_followed": False}, {"redirects_followed": 1},
            {"http_status": 201}, {"started_at": "2025-06-07T11:59:59Z"}, {"completed_at": "2025-06-07T12:00:01Z"},
            {"retrieved_at": "2025-06-07T12:00:01Z"}, {"extra": True}, {"headers": {"content-type": "text/html"}},
            {"headers": {"content-type": "application/xml", "authorization": "fictional"}},
            {"headers": {"content-type": "application/xml", "date": "bad\nvalue"}},
            {"headers": {"content-type": "application/xml", "content-length": "1"}}):
            with self.subTest(change=change), self.assertRaises(WorkbenchError): self.collect(json.dumps({**receipt(), **change}).encode())

    def test_json_duplicates_nonfinite_empty_deep_and_size_rejected(self):
        good = json.dumps(receipt()).encode()
        for raw in (b"", b"[]", good.replace(b'"http_status": 200', b'"http_status":200,"http_status":200'),
            good.replace(b'"http_status": 200', b'"http_status":NaN'), b"x" * (capture.MAX_OUTPUT + 1),
            b'{"x":' + b"[" * 2000 + b"]" * 2000 + b"}"):
            with self.subTest(length=len(raw)), self.assertRaises(WorkbenchError): self.collect(raw)

    def test_hash_valid_non_xml_is_not_admitted(self):
        with self.assertRaises(WorkbenchError): self.collect(json.dumps(receipt(b"not xml")).encode())

    def test_failed_child_is_not_retried_and_temporary_home_is_removed(self):
        paths = []
        def runner(*args, **kwargs):
            paths.append(Path(kwargs["cwd"]))
            raise WorkbenchError("ECB_CURRENT_CALL_TIMEOUT")
        with self.assertRaisesRegex(WorkbenchError, "CALL_TIMEOUT"): self.collect(runner=runner)
        self.assertEqual(len(paths), 1); self.assertFalse(paths[0].exists())

    def test_actual_process_protocol_with_transport_stub(self):
        value = receipt(); value["raw"] = base64.b64decode(value.pop("raw_base64"))
        program = (f"import sys;sys.path.insert(0,{str(ROOT)!r});from worker.market.providers import ecb_current as m;"
            f"m.ecb.download_ecb_xml=lambda *a,**k:{value!r};m._download_child()")
        def runner(argv, **kwargs): return run_memory_process([sys.executable, "-I", "-c", program], **kwargs)
        result, _ = self.collect(runner=runner)
        self.assertEqual(result["raw"], xml())

    def test_kernel_deadline_is_enforced_for_stuck_child(self):
        def runner(argv, **kwargs): return run_memory_process([sys.executable, "-I", "-c", "import time;time.sleep(60)"], **kwargs)
        started = time.monotonic()
        with self.assertRaisesRegex(WorkbenchError, "CALL_TIMEOUT"): self.collect(runner=runner, timeout_seconds=1)
        self.assertLess(time.monotonic() - started, 5)

    def test_actual_child_error_categories_survive_without_diagnostic_text(self):
        for category, expected in (("NONPUBLIC_ADDRESS_FORBIDDEN", "NONPUBLIC_ADDRESS_FORBIDDEN"),
            ("DOWNLOAD_TIMEOUT", "DOWNLOAD_TIMEOUT"), ("fictional-sensitive-marker", "PROVIDER_CALL_FAILED")):
            program = (f"import sys;sys.path.insert(0,{str(ROOT)!r});from worker.market.providers import ecb_current as m;"
                f"m.ecb.download_ecb_xml=lambda *a,**k:(_ for _ in ()).throw(m.WorkbenchError({'ECB_' + category!r}));"
                "sys.argv=[m.__file__,'--download-child'];m._child_main()")
            def runner(argv, **kwargs): return run_memory_process([sys.executable, "-I", "-c", program], **kwargs)
            with self.subTest(category=category), self.assertRaisesRegex(WorkbenchError, "^ECB_CURRENT_" + expected + "$"):
                self.collect(runner=runner)

    def test_child_unknown_error_text_never_leaks_and_known_categories_survive(self):
        for code, expected in (("ECB_NONPUBLIC_ADDRESS_FORBIDDEN", capture._CHILD_ERRORS["NONPUBLIC_ADDRESS_FORBIDDEN"]),
            ("ECB_DOWNLOAD_TIMEOUT", capture._CHILD_ERRORS["DOWNLOAD_TIMEOUT"]), ("fictional-secret", 1)):
            with self.subTest(code=code), patch.object(capture.sys, "argv", [capture.__file__, "--download-child"]), \
                    patch.object(capture, "_download_child", side_effect=WorkbenchError(code)), \
                    patch.object(capture.sys, "stdout", io.StringIO()) as output, patch.object(capture.sys, "stderr", io.StringIO()) as diagnostic:
                with self.assertRaises(SystemExit) as result: capture._child_main()
                self.assertEqual(result.exception.code, expected)
                self.assertEqual(output.getvalue(), ""); self.assertEqual(diagnostic.getvalue(), "")

    def test_child_refuses_url_clock_credentials_or_feed_override(self):
        for extra in ("url", "now", "credentials", "feed"):
            value = {"timeout_seconds": 1, extra: "fictional"}
            with self.subTest(extra=extra), patch.object(capture.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(value).encode()))), \
                    patch.object(capture.ecb, "download_ecb_xml") as download:
                with self.assertRaises(WorkbenchError): capture._download_child()
                download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
