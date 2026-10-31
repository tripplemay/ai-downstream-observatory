"""Fictional private files and IPC only; valid requests never reach a network."""

import base64
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from worker.market.providers import eodhd_capture as receiver
from worker.market.providers.eodhd_transport import VERSION as TRANSPORT_VERSION
from worker.market.providers.eodhd_actions import action_url
from worker.orchestration.db import WorkbenchError


TOKEN = "FICTIONAL-EODHD-CAPTURE-TOKEN-NOT-REAL"
AT = "2026-11-01T05:00:00.000Z"
OPTIONS = {"kind": "div", "symbol": "VT.US", "start_date": "2025-11-01", "end_date": "2026-10-31"}


def receipt(raw=b"[]"):
    return {"schema_version": TRANSPORT_VERSION, "raw_base64": base64.b64encode(raw).decode(),
        "url_without_credentials": action_url(**OPTIONS), "request": OPTIONS, "started_at": AT, "completed_at": AT,
        "retrieved_at": AT, "http_status": 200, "raw_sha256": sha256(raw).hexdigest(), "raw_bytes": len(raw),
        "redirects_followed": 0, "response_format": "utf8_json_identity", "credential_in_receipt": False}


class EodhdCaptureTests(unittest.TestCase):
    def collect(self, value=None, **changes):
        with patch.object(receiver, "datetime") as clock, patch.object(receiver, "read_private_token", return_value=TOKEN) as credentials, \
                patch.object(receiver, "run_memory_process", return_value=json.dumps(receipt() if value is None else value).encode()) as child:
            clock.now.return_value = datetime(2026, 11, 1, 5, tzinfo=timezone.utc)
            result = receiver.collect_eodhd_action_draft(**{**OPTIONS, "credentials_file": "/fictional/no-real-credentials.env", **changes})
        return result, child, credentials

    def test_private_file_mode_link_bounds_format_and_fixed_errors(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "fictional.env"
            path.write_text("# invented\nEODHD_API_TOKEN=" + TOKEN + "\n"); path.chmod(0o600)
            self.assertEqual(receiver.read_private_token(path), TOKEN)
            for mode in (0o644, 0o400, 0o666):
                path.chmod(mode)
                with self.assertRaisesRegex(WorkbenchError, "PRIVATE_CREDENTIAL_FILE_REQUIRED"):
                    receiver.read_private_token(path)
            path.chmod(0o600)
            link = Path(folder) / "link"; link.symlink_to(path)
            with self.assertRaises(WorkbenchError):
                receiver.read_private_token(link)
            link.unlink(); os.link(path, link)
            with self.assertRaises(WorkbenchError):
                receiver.read_private_token(path)
            link.unlink()
            for value in ("demo", "", "$(fictional-command)", TOKEN + "\nOTHER=not-allowed", "x" * 4097):
                path.write_text("EODHD_API_TOKEN=" + value)
                with self.assertRaisesRegex(WorkbenchError, "^EODHD_CAPTURE_PRIVATE_CREDENTIAL_FILE_REQUIRED$") as error:
                    receiver.read_private_token(path)
                self.assertNotIn(TOKEN, str(error.exception))
            path.unlink(); os.mkfifo(path, 0o600)
            with self.assertRaisesRegex(WorkbenchError, "PRIVATE_CREDENTIAL_FILE_REQUIRED"):
                receiver.read_private_token(path)

    def test_kernel_process_uses_secret_only_in_stdin_and_closed_environment(self):
        result, child, credentials = self.collect()
        credentials.assert_called_once_with("/fictional/no-real-credentials.env")
        arguments, options = child.call_args.args[0], child.call_args.kwargs
        self.assertEqual(arguments[-1], "--download-child")
        self.assertNotIn(TOKEN, json.dumps(arguments))
        self.assertNotIn(TOKEN, json.dumps(options["environment"]))
        self.assertEqual(set(options["environment"]), {"HOME", "TZ", "LANG", "LC_ALL", "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE"})
        self.assertEqual(json.loads(options["input_bytes"]), {**OPTIONS, "token": TOKEN, "timeout_seconds": 20})
        self.assertEqual((options["timeout"], options["max_input"], options["max_output"]), (20, 2048, receiver.MAX_OUTPUT))
        self.assertFalse(Path(options["cwd"]).exists())
        self.assertEqual(result["raw"], b"[]")
        self.assertNotIn(TOKEN, json.dumps({key: value for key, value in result.items() if key != "raw"}))
        self.assertTrue(result["draft"]["empty_is_not_absence_proof"])
        self.assertFalse(result["draft"]["research_admitted"])

    def test_invalid_range_target_timeout_precedes_private_credential_or_child_access(self):
        for changes in ({"symbol": "VTI.US"}, {"start_date": "2025-10-31"}, {"end_date": "2026-11-01"}, {"timeout_seconds": True}):
            with patch.object(receiver, "read_private_token") as credentials, patch.object(receiver, "run_memory_process") as child, self.assertRaises(WorkbenchError):
                receiver.collect_eodhd_action_draft(**{**OPTIONS, "credentials_file": "/fictional/no-real-credentials.env", **changes})
            credentials.assert_not_called(); child.assert_not_called()

    def test_corrupt_metadata_hashes_bytes_times_urls_types_and_unknown_authority_reject(self):
        changes = ({"raw_sha256": "0" * 64}, {"raw_bytes": True}, {"raw_bytes": 3}, {"raw_base64": "%%%"},
            {"http_status": True}, {"redirects_followed": True}, {"redirects_followed": 1}, {"credential_in_receipt": 0},
            {"url_without_credentials": "https://other.invalid/"}, {"started_at": "2026-11-01T04:00:00.000Z"},
            {"completed_at": "2026-11-01T06:00:00.000Z"}, {"retrieved_at": "2026-11-01T05:00:00.001Z"}, {"approved": True})
        for change in changes:
            with self.subTest(change=change), self.assertRaises(WorkbenchError):
                self.collect({**receipt(), **change})

    def test_resealed_credential_echo_and_malformed_json_still_reject(self):
        for raw in (TOKEN.encode(), b'[{"date":"2026-07-01","value":-1,"unadjustedValue":1,"currency":"USD"}]'):
            with self.assertRaises(WorkbenchError):
                self.collect(receipt(raw))
        with self.assertRaises(WorkbenchError):
            value = receipt(); value["request"] = {**OPTIONS, "token": TOKEN}
            self.collect(value)
        encoded_token = "".join("\\u%04x" % ord(char) for char in TOKEN)
        raw = ('[{"date":"2026-07-01","value":1,"unadjustedValue":1,"currency":"USD","period":"' + encoded_token + '"}]').encode()
        self.assertNotIn(TOKEN.encode(), raw)
        with self.assertRaises(WorkbenchError):
            self.collect(receipt(raw))

    def test_real_isolated_child_rejects_unknown_flags_and_target_before_network(self):
        for flags, value in ((["--unknown"], {}), (["--download-child"], {**OPTIONS, "symbol": "VTI.US", "token": TOKEN, "timeout_seconds": 1})):
            with tempfile.TemporaryDirectory() as folder:
                child = subprocess.run([sys.executable, "-I", str(Path(receiver.__file__).resolve()), *flags],
                    input=json.dumps(value).encode(), capture_output=True, timeout=10, cwd=folder,
                    env={"HOME": folder, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertNotEqual(child.returncode, 0)
            self.assertEqual((child.stdout, child.stderr), (b"", b""))


if __name__ == "__main__":
    unittest.main()
