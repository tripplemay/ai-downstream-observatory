#!/usr/bin/env python3
"""Partition the original unittest discovery by module without dropping cases."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def partition(cases, count):
    if type(count) is not int or not 1 <= count <= 32:
        raise ValueError("INVALID_SHARD_COUNT")
    ids = [case.id() for case in cases]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("EMPTY_OR_DUPLICATE_TEST_DISCOVERY")
    modules = sorted({case.__class__.__module__ for case in cases})
    assignment = {module: index % count for index, module in enumerate(modules)}
    groups = [[] for _ in range(count)]
    for case in cases:
        groups[assignment[case.__class__.__module__]].append(case)
    return groups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shard", type=int, required=True)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--list", action="store_true", help="List the selected cases without executing tests")
    args = parser.parse_args()
    if not 1 <= args.shards <= 32 or not 0 <= args.shard < args.shards:
        parser.error("INVALID_SHARD_INDEX_OR_COUNT")
    sys.path.insert(0, str(ROOT))
    loader = unittest.TestLoader()
    cases = list(flatten(loader.discover(str(ROOT / "tests"), pattern="test_*.py")))
    if loader.errors:
        sys.stderr.write("\n".join(loader.errors) + "\n")
        return 1
    selected = partition(cases, args.shards)[args.shard]
    if not selected:
        parser.error("EMPTY_SHARD")
    all_ids = sorted(case.id() for case in cases)
    report = {"shard": args.shard, "shards": args.shards, "discovered": len(cases),
              "discovery_sha256": hashlib.sha256(json.dumps(all_ids, separators=(",", ":")).encode()).hexdigest(),
              "selected_ids": [case.id() for case in selected], "status": "DISCOVERED"}
    if args.list:
        print(json.dumps(report))
        return 0
    report["source_sha"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    destination = ROOT / "artifacts" / "verification" / f"python-shard-{args.shard}-of-{args.shards}.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Keep a discovery record even when a runner cancels the test process.
    with destination.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print(f"Discovered {len(cases)} cases; shard {args.shard + 1}/{args.shards}: {len(selected)} cases", flush=True)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(selected))
    report.update(status="PASS" if result.wasSuccessful() else "FAIL", tests_run=result.testsRun,
                  failures=len(result.failures), errors=len(result.errors), skipped=len(result.skipped))
    destination.write_text(json.dumps(report, indent=2) + "\n")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
