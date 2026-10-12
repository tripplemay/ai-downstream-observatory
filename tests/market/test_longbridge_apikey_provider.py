"""Synthetic API credentials and SDK projections only; no live provider calls."""

from contextlib import redirect_stderr, redirect_stdout
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from worker.market import __main__ as cli
from worker.market.providers import credentials, longbridge_apikey as provider, longport, process
from worker.orchestration.db import WorkbenchError
from tests.market.test_longport_provider import candles


SECRETS = {"LONGBRIDGE_APP_KEY": "fixture-only-key", "LONGBRIDGE_APP_SECRET": "fixture-only-secret",
           "LONGBRIDGE_ACCESS_TOKEN": "fixture-only-token"}
SDK_SECRETS = {"app_key": "fixture-only-key", "app_secret": "fixture-only-secret", "access_token": "fixture-only-token"}
REQUEST = {"symbol": "SYNTH.US", "currency": "USD", "start_date": "2025-06-05", "end_date": "2025-06-06",
           "expected_dates": ["2025-06-05", "2025-06-06"]}


def file_bytes(values=SECRETS):
    return "".join(name + "=" + value + "\n" for name, value in values.items()).encode()


class PrivateFixture(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.file = self.directory / "credentials.env"
        self.write_file(file_bytes())

    def write_file(self, body):
        self.file.write_bytes(body)
        self.file.chmod(0o600)


class CredentialTests(PrivateFixture):
    def test_both_complete_namespaces_normalize_without_environment_mutation(self):
        for prefix in ("LONGBRIDGE_", "LONGPORT_"):
            values = {prefix + name.removeprefix("LONGBRIDGE_"): value for name, value in SECRETS.items()}
            values["HTTPS_PROXY"] = "ignored-fixture"
            before = dict(values)
            self.assertEqual(credentials.credentials_from_environment(values), SDK_SECRETS)
            self.assertEqual(values, before)
            with patch.dict(os.environ, values, clear=True):
                self.assertEqual(longport._credentials(), SDK_SECRETS)

    def test_missing_partial_mixed_and_duplicate_namespaces_do_not_combine(self):
        partial = {"LONGBRIDGE_APP_KEY": "fixture-only-key"}
        mixed = {**partial, "LONGPORT_APP_SECRET": "fixture-only-secret", "LONGPORT_ACCESS_TOKEN": "fixture-only-token"}
        both = {**SECRETS, **{name.replace("LONGBRIDGE_", "LONGPORT_"): value for name, value in SECRETS.items()}}
        for values, code in (({}, "REQUIRED"), (partial, "REQUIRED"), (mixed, "NAMESPACE_CONFLICT"),
                             (both, "NAMESPACE_CONFLICT")):
            with self.subTest(code=code), self.assertRaisesRegex(WorkbenchError, code) as caught:
                credentials.credentials_from_environment(values)
            self.assertNotIn("fixture-only", str(caught.exception))

    def test_invalid_values_rejected_without_echo_or_unicode_exceptions(self):
        for value in (None, True, "", " ", "fixture-only-token\n", "fixture token", "\x00", "\ud800", "x" * 8193):
            with self.subTest(type=type(value).__name__), self.assertRaisesRegex(WorkbenchError, "CREDENTIALS_INVALID"):
                credentials.credentials_from_environment({**SECRETS, "LONGBRIDGE_ACCESS_TOKEN": value})

    def test_private_file_reads_only_explicit_complete_credentials(self):
        self.write_file(b"# synthetic credentials\r\n\r\n" + file_bytes().replace(b"\n", b"\r\n"))
        with patch.dict(os.environ, {"LONGPORT_APP_KEY": "ignored-env"}, clear=True):
            self.assertEqual(credentials.read_private_credentials_file(str(self.file)), SDK_SECRETS)
            self.assertEqual(dict(os.environ), {"LONGPORT_APP_KEY": "ignored-env"})
        old = {name.replace("LONGBRIDGE_", "LONGPORT_"): value for name, value in SECRETS.items()}
        self.write_file(file_bytes(old))
        self.assertEqual(credentials.read_private_credentials_file(str(self.file)), SDK_SECRETS)

    def test_group_world_readable_wrong_owner_links_fifo_directory_relative_missing_rejected(self):
        for mode in (0o644, 0o640, 0o601, 0o620):
            self.file.chmod(mode)
            with self.subTest(mode=mode), self.assertRaisesRegex(WorkbenchError, "PRIVATE_CREDENTIALS_FILE_REQUIRED"):
                credentials.read_private_credentials_file(str(self.file))
        self.file.chmod(0o600)
        with patch.object(credentials.os, "geteuid", return_value=self.file.stat().st_uid + 1):
            with self.assertRaisesRegex(WorkbenchError, "PRIVATE_CREDENTIALS_FILE_REQUIRED"):
                credentials.read_private_credentials_file(str(self.file))
        link = self.directory / "linked"
        link.symlink_to(self.file)
        fifo = self.directory / "fifo"
        os.mkfifo(fifo, 0o600)
        for value in (str(link), str(fifo), str(self.directory), "credentials.env", str(self.directory / "absent")):
            with self.subTest(value=value), self.assertRaisesRegex(WorkbenchError, "PRIVATE_CREDENTIALS_FILE_REQUIRED") as caught:
                credentials.read_private_credentials_file(value)
            self.assertNotIn(value, str(caught.exception))
        os.link(self.file, self.directory / "hard-link")
        with self.assertRaisesRegex(WorkbenchError, "PRIVATE_CREDENTIALS_FILE_REQUIRED"):
            credentials.read_private_credentials_file(str(self.file))

    def test_file_bounds_encoding_duplicates_unknown_keys_and_shell_format_rejected(self):
        cases = (b"", b"x" * (credentials.MAX_CREDENTIAL_FILE_BYTES + 1), b"\xff", b"export " + file_bytes(),
                 file_bytes() + b"LONGBRIDGE_APP_KEY=fixture-duplicate\n",
                 file_bytes() + b"LONGBRIDGE_HTTP_URL=https://synthetic.invalid\n",
                 file_bytes() + b"synthetic-private-diagnostic\n",
                 file_bytes({**SECRETS, "LONGBRIDGE_ACCESS_TOKEN": "'fixture with spaces'"}),
                 file_bytes({**SECRETS, "LONGBRIDGE_ACCESS_TOKEN": "fixture\vtoken"}))
        for body in cases:
            self.write_file(body)
            with self.subTest(length=len(body)), self.assertRaises(WorkbenchError) as caught:
                credentials.read_private_credentials_file(str(self.file))
            self.assertNotIn("fixture", str(caught.exception))
            self.assertNotIn("synthetic-private-diagnostic", str(caught.exception))

    def test_file_is_parsed_as_data_never_sourced(self):
        secret = "$(printf_fixture_only)"
        self.write_file(file_bytes({**SECRETS, "LONGBRIDGE_APP_SECRET": secret}))
        with patch.object(subprocess, "Popen", side_effect=AssertionError("NO_SHELL")):
            result = credentials.read_private_credentials_file(str(self.file))
        self.assertEqual(result["app_secret"], secret)


class InspectionTests(PrivateFixture):
    def inspect(self, **changes):
        return provider.inspect_longbridge_apikey(credentials_file=str(self.file), **{**REQUEST, **changes})

    def projection(self, argv, **kwargs):
        self.assertEqual(argv, [sys.executable, "-I", str(Path(longport.__file__).resolve()), "--sdk-child"])
        self.assertNotIn("fixture-only", repr(argv))
        self.assertNotIn(str(self.file), repr(argv))
        self.assertEqual(set(kwargs["environment"]), {"TZ", "HOME", "LANG", "LC_ALL", "PYTHONUTF8"})
        self.assertEqual(kwargs["environment"]["TZ"], "UTC")
        cwd = Path(kwargs["cwd"])
        self.assertEqual(kwargs["environment"]["HOME"], str(cwd))
        self.assertEqual(cwd.stat().st_mode & 0o777, 0o700)
        self.assertEqual([path.name for path in cwd.iterdir()], [".env"])
        self.assertEqual((cwd / ".env").read_bytes(), b"")
        self.assertEqual((cwd / ".env").stat().st_mode & 0o777, 0o600)
        self.runtime_directory = cwd
        body = json.loads(kwargs["input_bytes"])
        self.assertEqual(set(body), {"request", "credentials"})
        self.assertEqual(body["credentials"], SDK_SECRETS)
        self.assertEqual(body["request"]["mapping"], {"listing_id": "inspection:SYNTH.US",
                                                      "provider_symbol": "SYNTH.US", "currency": "USD", "market": "US"})
        return longport._normalize(candles(), request=body["request"], sdk_version=longport.SDK_VERSION,
                                   call_started_at=longport.stamp(), call_returned_at=longport.stamp(),
                                   datetime_basis="runtime_utc_from_unix_timestamp",
                                   collector_runtime="isolated_official_sdk")["projection_bytes"]

    def test_fixed_child_stdin_isolated_environment_canonical_replay_metadata_only(self):
        with patch.object(longport, "_load_sdk"), patch.object(provider, "run_memory_process", side_effect=self.projection) as runner:
            result = self.inspect()
        runner.assert_called_once()
        self.assertFalse(self.runtime_directory.exists())
        self.assertEqual(result["auth_mode"], "apikey")
        self.assertEqual(result["status"], "sample_read_ok")
        self.assertEqual(result["candle_count"], 2)
        self.assertEqual(result["market_dates"], REQUEST["expected_dates"])
        for key in ("production_ready", "workbench_database_accessed", "market_values_output",
                    "market_values_persisted_by_adapter", "account_data_accessed", "trade_commands_executed",
                    "calendar_verified", "identity_verified", "data_use_license_verified",
                    "total_return_verified", "company_actions_verified", "access_token_refreshed"):
            self.assertFalse(result[key])
        self.assertNotIn("fixture-only", json.dumps(result))
        self.assertNotIn("value", result)
        self.assertNotIn("records", result)

    def test_invalid_symbol_currency_window_dates_prevent_file_or_process_access(self):
        changes = ({"symbol": "--execute"}, {"symbol": "SYNTH.US;trade"}, {"currency": "CNY"},
                   {"expected_dates": []}, {"end_date": "9999-01-01"}, {"start_date": "2025-05-01"},
                   {"diagnose": 1}, {"diagnose": "true"})
        for change in changes:
            with self.subTest(change=change), patch.object(provider, "read_private_credentials_file") as read, \
                    patch.object(provider, "run_memory_process") as runner:
                with self.assertRaises(WorkbenchError):
                    self.inspect(**change)
                read.assert_not_called()
                runner.assert_not_called()

    def test_diagnostic_mode_is_explicit_and_success_metadata_unchanged(self):
        def response(argv, **kwargs):
            self.assertEqual(argv[-1], "--sdk-diagnostic-child")
            self.assertEqual(kwargs.pop("exit_error_codes"), longport.DIAGNOSTIC_EXIT_CODES)
            return self.projection([*argv[:-1], "--sdk-child"], **kwargs)

        with patch.object(longport, "_load_sdk"), patch.object(provider, "run_memory_process", side_effect=response):
            result = self.inspect(diagnose=True)
        self.assertEqual(result["status"], "sample_read_ok")
        self.assertFalse(result["production_ready"])
        self.assertNotIn("fixture", json.dumps(result))

    def test_cli_diagnose_flag_is_not_an_sdk_or_endpoint_override(self):
        args = ["inspect-longbridge-apikey", "--credentials-file", str(self.file), "--symbol", REQUEST["symbol"],
                "--currency", REQUEST["currency"], "--start", REQUEST["start_date"], "--end", REQUEST["end_date"],
                "--expected-date", REQUEST["expected_dates"][0], "--diagnose"]
        out, err = io.StringIO(), io.StringIO()
        with patch.object(provider, "inspect_longbridge_apikey", side_effect=WorkbenchError("LONGPORT_HISTORY_REQUEST_FAILED")) as inspect, \
                redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(cli.main(args), 1)
        self.assertIs(inspect.call_args.kwargs["diagnose"], True)
        self.assertEqual(json.loads(err.getvalue()), {"error": "LONGPORT_HISTORY_REQUEST_FAILED"})
        self.assertEqual(out.getvalue(), "")

    def test_missing_credentials_or_unapproved_sdk_prevent_process(self):
        self.file.unlink()
        with patch.object(provider, "run_memory_process") as runner:
            with self.assertRaisesRegex(WorkbenchError, "PRIVATE_CREDENTIALS_FILE_REQUIRED"):
                self.inspect()
            runner.assert_not_called()
        self.write_file(file_bytes())
        with patch.object(longport, "_load_sdk", side_effect=RuntimeError("fixture-private-token")), \
                patch.object(provider, "run_memory_process") as runner:
            with self.assertRaisesRegex(WorkbenchError, "^LONGPORT_SDK_RUNTIME_NOT_CONFIGURED$"):
                self.inspect()
            runner.assert_not_called()

    def test_explicit_environment_source_no_file_or_implicit_fallback(self):
        with patch.dict(os.environ, SECRETS, clear=True), patch.object(provider, "read_private_credentials_file") as read, \
                patch.object(longport, "_load_sdk"), patch.object(provider, "run_memory_process", side_effect=self.projection):
            result = provider.inspect_longbridge_apikey(credentials_env=True, **REQUEST)
            self.assertEqual(result["status"], "sample_read_ok")
            read.assert_not_called()
        with patch.dict(os.environ, SECRETS, clear=True), patch.object(provider, "run_memory_process") as runner:
            for source in ({}, {"credentials_env": True, "credentials_file": str(self.file)}, {"credentials_env": 1}):
                with self.subTest(source=source), self.assertRaisesRegex(WorkbenchError, "CREDENTIAL_SOURCE_REQUIRED"):
                    provider.inspect_longbridge_apikey(**REQUEST, **source)
            runner.assert_not_called()
        with patch.dict(os.environ, {}, clear=True), patch.object(provider, "read_private_credentials_file") as read:
            with self.assertRaisesRegex(WorkbenchError, "CREDENTIALS_REQUIRED"):
                provider.inspect_longbridge_apikey(credentials_env=True, **REQUEST)
            read.assert_not_called()

    def test_bad_child_projection_and_spoofed_scope_clock_source_fail_closed(self):
        for alter in (None, "request", "source", "clock", "extra", "missing"):
            def response(argv, **kwargs):
                raw = self.projection(argv, **kwargs)
                if alter is None:
                    return b"fixture-private-token: not json"
                data = json.loads(raw)
                if alter == "request":
                    data["request"]["mapping"]["listing_id"] = "other"
                elif alter == "source":
                    data["source"]["calendar_verified_by_adapter"] = True
                elif alter == "clock":
                    data["source"]["call_started_at"] = "2000-01-01T00:00:00Z"
                elif alter == "extra":
                    data["fixture-private-token"] = True
                else:
                    data["candlesticks"].pop()
                return longport.canonical_json(data).encode()
            with self.subTest(alter=alter), patch.object(longport, "_load_sdk"), \
                    patch.object(provider, "run_memory_process", side_effect=response):
                with self.assertRaisesRegex(WorkbenchError, "^LONGPORT_CHILD_RESPONSE_INVALID$"):
                    self.inspect()
                self.assertFalse(self.runtime_directory.exists())

    def test_real_memory_transport_receives_credentials_stdin_not_argv_or_env(self):
        original_popen = subprocess.Popen
        observed = []
        script = """import json, os, pathlib, sys
assert pathlib.Path('.env').read_bytes() == b''
assert set(os.environ) <= {'TZ','HOME','LANG','LC_ALL','PYTHONUTF8','__CF_USER_TEXT_ENCODING','LC_CTYPE'}
assert 'fixture-only' not in repr(sys.argv)
body = json.load(sys.stdin)
assert body['credentials'] == %r
sys.path.insert(0, %r)
from worker.market.providers import longport as p
from tests.market.test_longport_provider import candles
result = p._normalize(candles(), request=body['request'], sdk_version=p.SDK_VERSION,
    call_started_at=p.stamp(), call_returned_at=p.stamp(),
    datetime_basis='runtime_utc_from_unix_timestamp', collector_runtime='isolated_official_sdk')
sys.stdout.buffer.write(result['projection_bytes'])
""" % (SDK_SECRETS, str(Path(longport.__file__).resolve().parents[3]))

        def launch(argv, **kwargs):
            self.assertEqual(set(kwargs["env"]), {"TZ", "HOME", "LANG", "LC_ALL", "PYTHONUTF8"})
            self.assertIs(kwargs["stdout"], subprocess.PIPE)
            self.assertIs(kwargs["stderr"], subprocess.PIPE)
            self.assertIs(kwargs["stdin"], subprocess.PIPE)
            self.assertNotIn("fixture-only", repr(argv))
            child = original_popen(process.child_argv([sys.executable, "-I", "-c", script], 30), **kwargs)
            observed.append((child, Path(kwargs["cwd"])))
            return child

        with patch.object(longport, "_load_sdk"), patch.object(process.subprocess, "Popen", side_effect=launch):
            result = self.inspect()
        self.assertEqual(result["candle_count"], 2)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0][0].returncode, 0)
        self.assertFalse(observed[0][1].exists())

    def test_cli_no_database_price_output_and_unexpected_error_is_redacted(self):
        args = ["inspect-longbridge-apikey", "--credentials-file", str(self.file), "--symbol", REQUEST["symbol"],
                "--currency", REQUEST["currency"], "--start", REQUEST["start_date"], "--end", REQUEST["end_date"],
                "--expected-date", REQUEST["expected_dates"][0], "--expected-date", REQUEST["expected_dates"][1]]
        with patch.object(cli, "open_database", side_effect=AssertionError("DATABASE_OPENED")) as opened:
            out, err = io.StringIO(), io.StringIO()
            with patch.object(longport, "_load_sdk"), patch.object(provider, "run_memory_process", side_effect=self.projection), \
                    redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(cli.main(args), 0)
            self.assertEqual(json.loads(out.getvalue())["status"], "sample_read_ok")
            self.assertEqual(err.getvalue(), "")
            out, err = io.StringIO(), io.StringIO()
            with patch.object(provider, "inspect_longbridge_apikey", side_effect=OSError("fixture-private-token")), \
                    redirect_stdout(out), redirect_stderr(err):
                self.assertEqual(cli.main(args), 1)
            self.assertEqual(out.getvalue(), "")
            self.assertEqual(json.loads(err.getvalue()), {"error": "LONGPORT_INSPECTION_FAILED"})
            opened.assert_not_called()


@unittest.skipUnless(os.name == "posix", "POSIX worker runtime required")
class MemoryTransportTests(PrivateFixture):
    def run_script(self, script, **kwargs):
        return process.run_memory_process([sys.executable, "-I", "-c", script],
                                          cwd=str(self.directory), environment={"TZ": "UTC"},
                                          error=lambda code: WorkbenchError("FIXTURE_" + code), **kwargs)

    def test_full_input_is_written_with_concurrent_stdout_and_stderr_draining(self):
        body = b"fixture-only-stdin" * 3500
        script = ("import os,sys,hashlib;os.write(1,b'x'*65536);os.write(2,b'y'*8192);"
                  "body=sys.stdin.buffer.read();sys.stdout.write(hashlib.sha256(body).hexdigest())")
        result = self.run_script(script, input_bytes=body)
        self.assertEqual(result, b"x" * 65536 + sha256(body).hexdigest().encode())

    def test_empty_input_and_disabled_input_are_eof(self):
        for value in (None, b""):
            with self.subTest(value=value):
                self.assertEqual(self.run_script("import sys;print(len(sys.stdin.buffer.read()))", input_bytes=value), b"0\n")

    def test_input_bounds_and_invalid_timeout_prevent_spawn(self):
        with patch.object(process.subprocess, "Popen") as spawn:
            for value in ("fixture-only-token", b"x" * 65537):
                with self.assertRaisesRegex(WorkbenchError, "PROCESS_INPUT_LIMIT"):
                    self.run_script("", input_bytes=value)
            for value in (0, -1, 31, True, "1", float("nan"), float("inf")):
                with self.assertRaisesRegex(WorkbenchError, "CALL_TIMEOUT_INVALID"):
                    self.run_script("", timeout=value)
            spawn.assert_not_called()

    def test_fixed_exit_mapping_precedes_stderr_and_default_behavior_is_unchanged(self):
        script = "import sys;sys.stderr.write('fixture-private-token: 401');sys.exit(40)"
        for mapping, name in ((None, "AUTHENTICATION_FAILED"), ({40: "HISTORY_REQUEST_FAILED"}, "HISTORY_REQUEST_FAILED"),
                              ({41: "HISTORY_PERMISSION_DENIED"}, "AUTHENTICATION_FAILED")):
            with self.subTest(mapping=mapping), self.assertRaisesRegex(WorkbenchError, "^FIXTURE_" + name + "$") as caught:
                self.run_script(script, exit_error_codes=mapping)
            self.assertNotIn("fixture-private-token", str(caught.exception))
        self.assertEqual(self.run_script("print('ok')", exit_error_codes={40: "HISTORY_REQUEST_FAILED"}), b"ok\n")

    def test_invalid_exit_mapping_prevents_spawn(self):
        cases = ([], {True: "X"}, {1: "X"}, {-14: "X"}, {126: "X"}, {40: "private token"},
                 {40: "X\n"}, {40: "X" * 81}, {40: None}, {str(40): "X"}, {40: "\u00c9"},
                 {code: "X" for code in range(2, 67)})
        with patch.object(process.subprocess, "Popen") as spawn:
            for mapping in cases:
                with self.subTest(mapping=mapping), self.assertRaisesRegex(WorkbenchError, "PROCESS_EXIT_MAPPING_INVALID"):
                    self.run_script("", exit_error_codes=mapping)
            spawn.assert_not_called()

    def test_diagnostic_mapping_does_not_override_deadline_or_output_bounds(self):
        mapping = {40: "HISTORY_REQUEST_FAILED"}
        with self.assertRaisesRegex(WorkbenchError, "CALL_TIMEOUT"):
            self.run_script("import time;time.sleep(5)", timeout=0.15, exit_error_codes=mapping)
        with self.assertRaisesRegex(WorkbenchError, "PROCESS_OUTPUT_LIMIT"):
            self.run_script("import sys;sys.stderr.write('x'*20);sys.exit(40)", max_diagnostic=10, exit_error_codes=mapping)

    def test_unread_stdin_is_bounded_and_kernel_timer_survives_exec(self):
        started = time.monotonic()
        with self.assertRaisesRegex(WorkbenchError, "CALL_TIMEOUT"):
            self.run_script("import time;time.sleep(10)", input_bytes=b"x" * 65536, timeout=0.15)
        self.assertLess(time.monotonic() - started, 3)
        result = subprocess.run(process.child_argv([sys.executable, "-I", "-c", "import time;time.sleep(10)"], 0.15),
                                capture_output=True, timeout=3)
        self.assertEqual(result.returncode, -signal.SIGALRM)

    def test_interruption_kills_credential_bearing_process_and_closes_pipes(self):
        original = subprocess.Popen
        observed = []

        def launch(*args, **kwargs):
            child = original(*args, **kwargs)
            observed.append(child)
            return child

        with patch.object(process.subprocess, "Popen", side_effect=launch), \
                patch.object(process.selectors.DefaultSelector, "select", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.run_script("import time;time.sleep(10)", input_bytes=b"fixture-only-token")
        self.assertEqual(len(observed), 1)
        self.assertIsNotNone(observed[0].poll())
        for pipe in (observed[0].stdin, observed[0].stdout, observed[0].stderr):
            self.assertTrue(pipe.closed)


if __name__ == "__main__":
    unittest.main()
