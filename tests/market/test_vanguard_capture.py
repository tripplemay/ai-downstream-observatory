"""Invented bytes and a network-free child exercise the actual process boundary."""

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

from tests.market.test_vanguard_distributions import archive
from worker.market.providers import vanguard_capture as capture
from worker.market.providers.process import run_memory_process
from worker.orchestration.db import ROOT, WorkbenchError


AT = "2025-05-02T12:00:00.000Z"
NOW = datetime(2025, 5, 2, 12, tzinfo=timezone.utc)


def receipt(raw=None):
    raw = archive() if raw is None else raw
    return {"schema_version": capture.TRANSPORT_VERSION, "raw_base64": base64.b64encode(raw).decode(),
        "source_url": capture.distribution_url("9998", False), "request": {"fund_id": "9998", "has_distribution_yield": False},
        "started_at": AT, "completed_at": AT, "retrieved_at": AT, "http_status": 200,
        "headers": {"content-type": "application/json", "content-length": str(len(raw))},
        "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw), "redirects_followed": 0}


class VanguardCaptureTests(unittest.TestCase):
    def collect(self, encoded=None, runner=None, **changes):
        options = {"fund_id": "9998", "has_distribution_yield": False, "start_date": "2025-01-01",
            "end_date": "2025-04-30", **changes}
        encoded = json.dumps(receipt()).encode() if encoded is None else encoded
        with patch.object(capture, "datetime") as clock, patch.object(capture, "run_memory_process", side_effect=runner) as process:
            clock.now.return_value = NOW
            process.return_value = encoded
            result = capture.collect_vanguard_distribution_draft(**options)
        return result, process

    def test_capture_independently_replays_bytes_and_remains_an_unapproved_draft(self):
        result, process = self.collect()
        self.assertEqual(result["raw"], archive())
        self.assertEqual(result["receipt"]["raw_sha256"], result["draft"]["source"]["raw_sha256"])
        self.assertNotIn("raw_base64", result["receipt"])
        self.assertEqual(result["draft"]["records"][0]["distribution_amount"], "0.123456789123456789")
        self.assertFalse(result["draft"]["owner_reviewed"]); self.assertFalse(result["draft"]["research_admitted"])
        process.assert_called_once()

    def test_private_empty_environment_fixed_program_budget_and_cleanup(self):
        observed = {}
        def runner(argv, **kwargs):
            observed.update(kwargs); observed["argv"] = argv
            directory = Path(kwargs["cwd"])
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            self.assertEqual(list(directory.iterdir()), [])
            self.assertEqual(set(kwargs["environment"]), {"HOME", "TZ", "LANG", "LC_ALL", "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE"})
            self.assertEqual(kwargs["environment"]["HOME"], str(directory))
            return json.dumps(receipt()).encode()
        with patch.dict(os.environ, {"LONGBRIDGE_APP_SECRET": "fictional-must-not-inherit", "WORKBENCH_SESSION_SECRET": "fictional-must-not-inherit"}):
            self.collect(runner=runner, timeout_seconds=7)
        self.assertFalse(Path(observed["cwd"]).exists())
        self.assertEqual(observed["argv"][:2], [sys.executable, "-I"])
        self.assertEqual(Path(observed["argv"][2]), Path(capture.__file__).resolve())
        self.assertEqual(observed["argv"][3:], ["--download-child"])
        self.assertEqual(observed["timeout"], 7)
        self.assertEqual(observed["max_input"], 1024)
        self.assertEqual(json.loads(observed["input_bytes"]), {"fund_id": "9998", "has_distribution_yield": False, "timeout_seconds": 7})

    def test_invalid_requests_are_rejected_before_process_or_network(self):
        for changes in ({"fund_id": "../x"}, {"has_distribution_yield": 1}, {"timeout_seconds": 31},
            {"timeout_seconds": True}, {"end_date": "2025-05-03"}, {"start_date": "2025-06-01"}, {"start_date": "2010-01-01"}):
            with self.subTest(changes=changes), patch.object(capture, "run_memory_process") as process, patch.object(capture, "datetime") as clock:
                clock.now.return_value = NOW
                with self.assertRaises(WorkbenchError):
                    capture.collect_vanguard_distribution_draft(**{"fund_id": "9998", "has_distribution_yield": False,
                        "start_date": "2025-01-01", "end_date": "2025-04-30", **changes})
                process.assert_not_called()

    def test_forged_receipt_identity_clock_hash_length_headers_and_extra_fields_reject(self):
        changes = [{"source_url": "https://other.invalid/"}, {"request": {"fund_id": "9999", "has_distribution_yield": False}},
            {"request": {"fund_id": "9998", "has_distribution_yield": 0}}, {"raw_sha256": "0" * 64},
            {"raw_bytes": True}, {"raw_bytes": 1}, {"raw_base64": "!bad!"}, {"redirects_followed": False},
            {"redirects_followed": 1}, {"http_status": 201}, {"started_at": "2025-05-02T11:59:59.999Z"},
            {"completed_at": "2025-05-02T12:00:00.001Z"}, {"retrieved_at": "2025-05-02T12:00:01.000Z"},
            {"started_at": "2025-05-02T12:00:00+00:00"}, {"schema_version": "invented-other-version"},
            {"headers": {"content-type": "text/html"}}, {"headers": {"content-type": "application/json", "authorization": "not-allowed"}},
            {"headers": {"content-type": "application/json", "etag": "value\nsecret"}},
            {"headers": {"content-type": "application/json", "content-length": "1"}}, {"extra": True}]
        for change in changes:
            value = {**receipt(), **change}
            with self.subTest(change=change), self.assertRaises(WorkbenchError): self.collect(json.dumps(value).encode())

    def test_duplicate_keys_nonfinite_deep_or_oversize_child_output_cannot_bypass(self):
        good = json.dumps(receipt()).encode()
        duplicate = good.replace(b'"http_status": 200', b'"http_status":200,"http_status":200')
        for encoded in (b"", b"[]", duplicate, good.replace(b'"http_status": 200', b'"http_status":NaN'),
            b"x" * (capture.MAX_OUTPUT + 1), b'{"x":' + b"[" * 2000 + b"]" * 2000 + b"}"):
            with self.subTest(length=len(encoded)), self.assertRaises(WorkbenchError): self.collect(encoded)

    def test_valid_receipt_does_not_bypass_the_independent_body_parser(self):
        for raw in (b"[]", b"{}", b'["invalid"]'):
            with self.subTest(raw=raw), self.assertRaises(WorkbenchError): self.collect(json.dumps(receipt(raw)).encode())

    def test_failure_cleans_owned_temporary_directory_and_never_retries(self):
        paths = []
        def runner(*args, **kwargs):
            paths.append(Path(kwargs["cwd"]))
            raise WorkbenchError("VANGUARD_CAPTURE_CALL_TIMEOUT")
        with self.assertRaisesRegex(WorkbenchError, "CALL_TIMEOUT"): self.collect(runner=runner)
        self.assertEqual(len(paths), 1); self.assertFalse(paths[0].exists())

    def test_actual_isolated_process_framing_with_stubbed_transport_and_no_network(self):
        value = receipt()
        value["raw"] = base64.b64decode(value.pop("raw_base64"))
        program = f"import sys;sys.path.insert(0,{str(ROOT)!r});from worker.market.providers import vanguard_capture as m;m.download_vanguard_distributions=lambda **kwargs:{value!r};m._download_child()"
        def runner(argv, **kwargs):
            return run_memory_process([sys.executable, "-I", "-c", program], **kwargs)
        result, _ = self.collect(runner=runner)
        self.assertEqual(result["raw"], archive()); self.assertFalse(result["draft"]["research_admitted"])

    def test_actual_kernel_deadline_covers_a_stuck_child_without_network(self):
        def runner(argv, **kwargs):
            return run_memory_process([sys.executable, "-I", "-c", "import time;time.sleep(60)"], **kwargs)
        started = time.monotonic()
        with self.assertRaisesRegex(WorkbenchError, "CALL_TIMEOUT"): self.collect(runner=runner, timeout_seconds=1)
        self.assertLess(time.monotonic() - started, 5)

    def test_child_protocol_rejects_extra_url_clock_or_credentials_before_transport(self):
        for extra in ("url", "clock", "credentials"):
            value = {"fund_id": "9998", "has_distribution_yield": False, "timeout_seconds": 1, extra: "not-allowed"}
            with self.subTest(extra=extra), patch.object(capture.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(json.dumps(value).encode()))), patch.object(capture, "download_vanguard_distributions") as download:
                with self.assertRaises(WorkbenchError): capture._download_child()
                download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
