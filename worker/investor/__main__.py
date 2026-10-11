"""Bounded stdin/stdout arithmetic interface; never opens a DB or broker API."""

import argparse
import json
import re
import sys

from worker.market.contracts import validate_contract
from worker.orchestration.db import WorkbenchError, canonical_json
from .monitor import assess_model
from .strategy import research_reference


MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024


def parse_request(raw, contract="investor-kernel-request.schema.json"):
    if len(raw) > MAX_INPUT_BYTES:
        raise WorkbenchError("INVESTOR_KERNEL_INPUT_TOO_LARGE")

    def pairs(rows):
        result = {}
        for key, value in rows:
            if key in result:
                raise WorkbenchError("INVESTOR_KERNEL_DUPLICATE_JSON_KEY")
            result[key] = value
        return result

    def nonfinite(_):
        raise WorkbenchError("INVESTOR_KERNEL_NONFINITE_JSON")

    try:
        document = json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise WorkbenchError("INVESTOR_KERNEL_JSON_INVALID") from exc
    validate_contract(document, contract)
    return document


def main(argv=None):
    parser = argparse.ArgumentParser(description="Investor research/model arithmetic; not financial execution or a source certificate")
    parser.add_argument("--allow-synthetic", action="store_true", help="Explicit test/research permission, never live eligibility")
    args = parser.parse_args(argv)
    try:
        request = parse_request(sys.stdin.buffer.read(MAX_INPUT_BYTES + 1))
        if request["action"] == "research":
            result = research_reference(request["dataset"], request["plan"], request["policy"], request["profile"], allow_synthetic=args.allow_synthetic)
        else:
            result = assess_model(request["document"], request["now"])
        encoded = canonical_json(result)
        if len(encoded.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise WorkbenchError("INVESTOR_KERNEL_OUTPUT_TOO_LARGE")
        print(encoded)
        return 0
    except (ValueError, TypeError, KeyError, ArithmeticError, RecursionError, OSError) as exc:
        # JSON schema error messages may contain the rejected private input.
        code = str(exc).split(":", 1)[0]
        if not re.fullmatch(r"(?:INVESTOR_[A-Z_]+|CONTRACT_INVALID)", code):
            code = "INVESTOR_KERNEL_FAILED"
        print(canonical_json({"error": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
