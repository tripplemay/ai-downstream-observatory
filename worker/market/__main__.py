import argparse
import json
from pathlib import Path
import sys

from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from .batches import ingest_document
from .synthetic import synthetic_document
from .valuation import value_portfolio


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise WorkbenchError("DUPLICATE_JSON_KEY:" + key)
        result[key] = value
    return result


def _load(path):
    with Path(path).open("rb") as handle:
        raw = handle.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise WorkbenchError("INPUT_TOO_LARGE")
    def invalid_constant(value):
        raise WorkbenchError("NON_FINITE_JSON_VALUE:" + value)
    return json.loads(raw, object_pairs_hook=_pairs, parse_constant=invalid_constant)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Explicit ETF market commands; live reads require an inspect command")
    commands = parser.add_subparsers(dest="command", required=True)
    ingest = commands.add_parser("ingest")
    ingest.add_argument("--db", required=True)
    ingest.add_argument("--file", required=True)
    ingest.add_argument("--publish", action="store_true")
    value = commands.add_parser("value")
    value.add_argument("--db", required=True)
    value.add_argument("--portfolio", required=True)
    value.add_argument("--cutoff", required=True)
    value.add_argument("--rules", required=True)
    value.add_argument("--mode", choices=("as_known", "restated"), default="as_known")
    synthetic = commands.add_parser("synthetic")
    synthetic.add_argument("--batch", required=True)
    synthetic.add_argument("--listing", required=True)
    synthetic.add_argument("--currency", default="CNY")
    synthetic.add_argument("--price", default="10")
    preview = commands.add_parser("inspect-longbridge", help="OAuth read-only sample checks; no database or price persistence")
    preview.add_argument("--cli-binary", required=True)
    preview.add_argument("--oauth-home", required=True)
    preview.add_argument("--symbol", required=True)
    preview.add_argument("--start", required=True)
    preview.add_argument("--end", required=True)
    preview.add_argument("--expected-date", action="append", required=True)
    apikey = commands.add_parser("inspect-longbridge-apikey", help="Private API Key daily sample; no database or price persistence")
    credential_source = apikey.add_mutually_exclusive_group(required=True)
    credential_source.add_argument("--credentials-file")
    credential_source.add_argument("--credentials-env", action="store_true")
    apikey.add_argument("--symbol", required=True)
    apikey.add_argument("--currency", required=True)
    apikey.add_argument("--start", required=True)
    apikey.add_argument("--end", required=True)
    apikey.add_argument("--expected-date", action="append", required=True)
    apikey.add_argument("--diagnose", action="store_true", help="Fixed phase/validation codes only; no exception text")
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect-longbridge-apikey":
            from .providers.longbridge_apikey import inspect_longbridge_apikey
            try:
                result = inspect_longbridge_apikey(credentials_file=args.credentials_file, credentials_env=args.credentials_env,
                                                  symbol=args.symbol,
                                                  currency=args.currency, start_date=args.start, end_date=args.end,
                                                  expected_dates=args.expected_date, diagnose=args.diagnose)
            except WorkbenchError:
                raise
            except Exception:
                raise WorkbenchError("LONGPORT_INSPECTION_FAILED") from None
            print(canonical_json(result))
            return 0
        if args.command == "inspect-longbridge":
            from .providers.longbridge_cli import inspect_longbridge_cli
            result = inspect_longbridge_cli(binary_path=args.cli_binary, oauth_home=args.oauth_home,
                                           symbol=args.symbol, start_date=args.start, end_date=args.end,
                                           expected_dates=args.expected_date)
            print(canonical_json(result))
            return 0
        if args.command == "synthetic":
            print(canonical_json(synthetic_document(args.batch, args.listing, args.currency, args.price)))
            return 0
        connection = open_database(args.db)
        try:
            if args.command == "ingest":
                result = ingest_document(connection, _load(args.file), publish=args.publish)
                print(canonical_json(result))
                return 0 if result["status"] in ("validated", "published") else 2
            result = value_portfolio(connection, args.portfolio, args.cutoff, _load(args.rules), args.mode)
            print(canonical_json(result))
            return 0 if result["quality"] == "complete" else 2
        finally:
            connection.close()
    except (WorkbenchError, ValueError, OSError) as exc:
        print(canonical_json({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
