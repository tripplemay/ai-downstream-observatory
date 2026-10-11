"""Invented evidence and mocked HTTPS only; no real model or market calls."""

from copy import deepcopy
from contextlib import redirect_stderr
from email.message import Message
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from worker.orchestration.db import WorkbenchError, canonical_json
from worker.research import ai_gateway as gateway


def review(context=None):
    context = context or gateway.synthetic_probe_context()
    return {"schema_version": "ai-research-review-v1",
        "facts": [{key: row[key] for key in ("evidence_id", "metric", "value", "as_of")} for row in context["evidence"]],
        "inferences": [{"text": "Invented example: avoid unsupported turnover.", "evidence_ids": [context["evidence"][0]["evidence_id"]]}],
        "supporting_evidence": [context["evidence"][0]["evidence_id"]], "counter_evidence": [],
        "risks": ["Synthetic software test only"], "recommendation": "maintain_research", "reason": "No real research evidence",
        "unknowns": ["Actual data unavailable"], "invalidation_conditions": ["New admitted evidence"]}


def config():
    return {"schema_version": gateway.VERSION, "base_url": "https://gateway.invalid/v1", "api_key": "fictional-key-only",
        "model": "fictional-model", "max_output_tokens": 1024}


class Response:
    status = 200

    def __init__(self, body=None, content_type="application/json"):
        self.body = body if isinstance(body, bytes) else canonical_json(body or {
            "model": "fictional-model", "choices": [{"index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": canonical_json(review())}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}}).encode()
        self.headers = Message(); self.headers["Content-Type"] = content_type
        self.read_limits = []

    def read(self, limit):
        self.read_limits.append(limit)
        return self.body[:limit]

    def __enter__(self): return self
    def __exit__(self, *_): pass


class GatewayTests(unittest.TestCase):
    def test_private_configuration_and_explicit_request_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "gateway.json"
            file.write_text(canonical_json(config())); file.chmod(0o600)
            self.assertEqual(gateway._read_config(file), config())
            for mode in (0o644, 0o700):
                file.chmod(mode)
                with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_CONFIG_INVALID$"): gateway._read_config(file)
            file.chmod(0o600)
            link = Path(directory) / "link.json"; link.symlink_to(file)
            with self.assertRaisesRegex(WorkbenchError, "CONFIG_INVALID"): gateway._read_config(link)
            for change in (lambda data: data.update(base_url="http://gateway.invalid/v1"),
                           lambda data: data.update(base_url="https://secret@gateway.invalid/v1"),
                           lambda data: data.update(base_url="https://gateway.invalid/v1?secret=x"),
                           lambda data: data.update(api_key="fictional\nkey"),
                           lambda data: data.update(max_output_tokens=True), lambda data: data.update(max_output_tokens=2049),
                           lambda data: data.update(extra="not allowed")):
                data = config(); change(data); file.write_text(canonical_json(data))
                with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_CONFIG_INVALID$"): gateway._read_config(file)

    def test_duplicate_configuration_keys_and_nonfinite_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "gateway.json"
            for raw in ('{"api_key":"a","api_key":"b"}', '{"max_output_tokens":NaN}', "[]", "x" * (gateway.MAX_CONFIG + 1)):
                file.write_text(raw); file.chmod(0o600)
                with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_CONFIG_INVALID$"): gateway._read_config(file)

    def test_one_https_request_no_tools_no_stream_no_proxy_or_retry(self):
        response = Response()
        with patch.object(gateway.urllib.request, "build_opener") as factory:
            factory.return_value.open.return_value = response
            result = gateway._http_once(gateway.synthetic_probe_context(), config())
        factory.return_value.open.assert_called_once()
        req = factory.return_value.open.call_args.args[0]
        body = json.loads(req.data)
        self.assertEqual(req.full_url, "https://gateway.invalid/v1/chat/completions")
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual((body["stream"], body["n"], body["store"], body["max_tokens"]), (False, 1, False, 1024))
        self.assertNotIn("tools", body); self.assertNotIn("functions", body)
        self.assertEqual(factory.call_args.args[0].proxies, {})
        self.assertEqual(response.read_limits, [gateway.MAX_RESPONSE + 1])
        self.assertEqual(result["usage"]["total_tokens"], 30)

    def test_status_failures_never_read_or_disclose_error_body(self):
        for status, code in ((401, "AUTHENTICATION_FAILED"), (403, "PERMISSION_DENIED"), (429, "RATE_LIMITED"), (500, "HTTP_FAILED")):
            with self.subTest(status=status):
                body = io.BytesIO(b"fictional-private-value")
                with patch.object(gateway.urllib.request, "build_opener") as factory:
                    factory.return_value.open.side_effect = urllib.error.HTTPError("https://secret.invalid", status, "private", {}, body)
                    with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_" + code + "$"): gateway._http_once({}, config())
                    factory.return_value.open.assert_called_once()
                self.assertTrue(body.closed)

    def test_redirect_and_timeout_are_fixed_errors(self):
        with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_REDIRECT_REJECTED$"):
            gateway._NoRedirect().redirect_request(None, None, 302, "private", {}, "https://another.invalid")
        for error in (TimeoutError("private"), urllib.error.URLError(TimeoutError("private"))):
            with patch.object(gateway.urllib.request, "build_opener") as factory:
                factory.return_value.open.side_effect = error
                with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_TIMEOUT$"): gateway._http_once({}, config())

    def test_truncated_tool_refusal_multiple_and_malformed_responses_rejected(self):
        good = json.loads(Response().body)
        changes = [(lambda data: data["choices"][0].update(finish_reason="length"), "TRUNCATED"),
            (lambda data: data["choices"].append(deepcopy(data["choices"][0])), "CHOICES_INVALID"),
            (lambda data: data["choices"][0].update(index=True), "CHOICES_INVALID"),
            (lambda data: data["choices"][0]["message"].update(tool_calls=[{"name": "trade"}]), "CONTENT_INVALID"),
            (lambda data: data["choices"][0]["message"].update(refusal="cannot answer"), "CONTENT_INVALID"),
            (lambda data: data["choices"][0]["message"].update(content=None), "CONTENT_INVALID"),
            (lambda data: data["choices"][0]["message"].update(content=config()["api_key"]), "CONTENT_INVALID"),
            (lambda data: data["usage"].update(total_tokens=31), "USAGE_INVALID")]
        responses = [(Response(b'{"choices":[],"choices":[]}'), "JSON_INVALID"), (Response(b"{}", "text/html"), "HEADERS_INVALID"),
                     (Response(b"x" * (gateway.MAX_RESPONSE + 1)), "SIZE_INVALID")]
        for change, code in changes:
            data = deepcopy(good); change(data); responses.append((Response(data), code))
        for response, code in responses:
            with patch.object(gateway.urllib.request, "build_opener") as factory:
                factory.return_value.open.return_value = response
                with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_RESPONSE_" + code + "$"): gateway._http_once({}, config())

    def test_parent_exact_evidence_and_unknown_text_errors_are_redacted(self):
        context = gateway.synthetic_probe_context()
        valid = review(context)
        for output in (canonical_json(valid), "```json\n" + canonical_json(valid) + "\n```",
                       '{"schema_version":"ai-research-review-v1","reason":"fictional-private-value"}'):
            payload = {"raw_output": output, "reported_model": "fictional-model", "usage": None}
            with patch.object(gateway, "run_memory_process", return_value=canonical_json(payload).encode()) as transport:
                if output == canonical_json(valid):
                    result = gateway._review_once(context, "/private/fictional.json")
                    self.assertEqual(result["review"], valid)
                else:
                    with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_OUTPUT_INVALID$"): gateway._review_once(context, "/private/fictional.json")
                self.assertEqual(transport.call_args.kwargs["timeout"], 30)
                self.assertNotIn("fictional-key-only", repr(transport.call_args))
                self.assertNotIn("PATH", transport.call_args.kwargs["environment"])
        altered = review(context); altered["facts"][0]["value"] = "0.0150"
        payload = {"raw_output": canonical_json(altered), "reported_model": "fictional-model", "usage": None}
        with patch.object(gateway, "run_memory_process", return_value=canonical_json(payload).encode()):
            with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_OUTPUT_INVALID$"): gateway._review_once(context, "/private/fictional.json")

    def test_child_rejects_caller_context_before_credentials_or_network(self):
        for data in ({"data_mode": "synthetic", "account": "fictional-private"},
                     {**gateway.synthetic_probe_context(), "budget_cny": "123"}):
            completed = subprocess.run([sys.executable, "-I", str(Path(gateway.__file__).resolve()), "--gateway-child", "/does-not-exist"],
                input=canonical_json(data).encode(), capture_output=True, timeout=10, env={"PYTHONUTF8": "1"})
            self.assertEqual(completed.returncode, 41)
            self.assertEqual(completed.stdout, b""); self.assertEqual(completed.stderr, b"")

    def test_unknown_internal_error_never_uses_prefix_as_a_log_permission(self):
        output = io.StringIO()
        with patch.object(gateway, "probe_gateway", side_effect=WorkbenchError("AI_GATEWAY_fictional-private-value")), redirect_stderr(output):
            self.assertEqual(gateway.main(["--config-file", "/private/fictional.json"]), 1)
        self.assertEqual(json.loads(output.getvalue()), {"error": "AI_GATEWAY_FAILED"})

    def test_finish_reason_labels_are_fixed_and_never_echo_arbitrary_values(self):
        for finish, code in (("length", "TRUNCATED"), ("tool_calls", "TOOL_REQUESTED"),
                             ("function_call", "TOOL_REQUESTED"), ("content_filter", "REFUSED"),
                             (None, "NOT_COMPLETED"), ([], "NOT_COMPLETED"), ("fictional-private-value", "NOT_COMPLETED")):
            data = json.loads(Response().body); data["choices"][0]["finish_reason"] = finish
            with patch.object(gateway.urllib.request, "build_opener") as factory:
                factory.return_value.open.return_value = Response(data)
                with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_RESPONSE_" + code + "$"):
                    gateway._http_once(gateway.synthetic_probe_context(), config())

    def test_explicit_v2_profile_requires_recognized_model_and_no_arbitrary_parameters(self):
        valid = {**config(), "schema_version": gateway.CONFIG_V2, "model": "deepseek-v4-flash",
                 "request_profile": gateway.NONTHINKING_PROFILE}
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "gateway.json"; file.write_text(canonical_json(valid)); file.chmod(0o600)
            self.assertEqual(gateway._read_config(file), valid)
            for change in (lambda data: data.update(schema_version=gateway.VERSION),
                           lambda data: data.update(model="fictional-other-model"),
                           lambda data: data.update(request_profile="arbitrary_parameters"),
                           lambda data: data.update(thinking={"type": "enabled"}),
                           lambda data: data.pop("request_profile")):
                data = deepcopy(valid); change(data); file.write_text(canonical_json(data))
                with self.assertRaisesRegex(WorkbenchError, "^AI_GATEWAY_CONFIG_INVALID$"):
                    gateway._read_config(file)

    def test_explicit_nonthinking_changes_only_the_thinking_request_field(self):
        legacy = {**config(), "model": "deepseek-v4-flash"}
        explicit = {**legacy, "schema_version": gateway.CONFIG_V2, "request_profile": gateway.NONTHINKING_PROFILE}
        requests = []
        for settings in (legacy, explicit):
            with patch.object(gateway.urllib.request, "build_opener") as factory:
                factory.return_value.open.return_value = Response()
                gateway._http_once(gateway.synthetic_probe_context(), settings)
                factory.return_value.open.assert_called_once()
                requests.append(json.loads(factory.return_value.open.call_args.args[0].data))
        self.assertNotIn("thinking", requests[0])
        self.assertEqual(requests[1].pop("thinking"), {"type": "disabled"})
        self.assertEqual(requests[0], requests[1])


if __name__ == "__main__":
    unittest.main()
