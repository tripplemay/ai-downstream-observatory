import argparse
import json
from pathlib import Path
import sqlite3
import sys

from worker.orchestration.db import WorkbenchError, canonical_json, open_database
from .ai import record_review
from .registry import freeze_candidate, register_experiment, register_trial, run_trial, unseal_holdout


def load_json(path):
    with Path(path).open("rb") as handle:
        raw = handle.read(32 * 1024 * 1024 + 1)
    if len(raw) > 32 * 1024 * 1024:
        raise WorkbenchError("RESEARCH_INPUT_TOO_LARGE")
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise WorkbenchError("RESEARCH_DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    def invalid_constant(value):
        raise WorkbenchError("RESEARCH_NONFINITE_JSON")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid_constant)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Exploratory ETF research; no actual trades or strategy activation")
    parser.add_argument("--db", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    register = commands.add_parser("register")
    register.add_argument("--experiment", required=True)
    register.add_argument("--portfolio", required=True)
    register.add_argument("--plan", required=True)
    register.add_argument("--dataset", required=True)
    register.add_argument("--actor", required=True)
    trial = commands.add_parser("trial")
    trial.add_argument("--experiment", required=True)
    trial.add_argument("--phase", choices=("train", "validation", "holdout"), required=True)
    trial.add_argument("--parameters", required=True)
    trial.add_argument("--key", required=True)
    trial.add_argument("--actor", required=True)
    run = commands.add_parser("run")
    run.add_argument("--trial", required=True)
    freeze = commands.add_parser("freeze")
    freeze.add_argument("--experiment", required=True)
    freeze.add_argument("--validation-trial", required=True)
    freeze.add_argument("--actor", required=True)
    freeze.add_argument("--reason", required=True)
    unseal = commands.add_parser("unseal")
    unseal.add_argument("--experiment", required=True)
    unseal.add_argument("--actor", required=True)
    unseal.add_argument("--reason", required=True)
    review = commands.add_parser("review-file")
    review.add_argument("--run", required=True)
    review.add_argument("--model", required=True)
    review.add_argument("--file", required=True)
    args = parser.parse_args(argv)
    try:
        connection = open_database(args.db)
        try:
            if args.command == "register":
                result = register_experiment(connection, args.experiment, args.portfolio, load_json(args.plan), load_json(args.dataset), args.actor)
                result = {"experiment_id": result["id"], "plan_hash": result["plan_hash"], "dataset_hash": result["dataset_hash"]}
            elif args.command == "trial":
                result = register_trial(connection, args.experiment, args.phase, load_json(args.parameters), args.key, args.actor)
            elif args.command == "run":
                result = run_trial(connection, args.trial)
            elif args.command == "freeze":
                result = freeze_candidate(connection, args.experiment, args.validation_trial, args.actor, args.reason)
            elif args.command == "unseal":
                result = unseal_holdout(connection, args.experiment, args.actor, args.reason)
            else:
                with Path(args.file).open("rb") as handle:
                    raw = handle.read(128 * 1024 + 1)
                result = record_review(connection, args.run, args.model, raw.decode("utf-8"))
            print(canonical_json(result))
            return 2 if result.get("status") in ("failed", "invalid", "timeout") else 0
        finally:
            connection.close()
    except (ValueError, OSError, sqlite3.Error, RecursionError) as exc:
        print(canonical_json({"error": type(exc).__name__, "message": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
