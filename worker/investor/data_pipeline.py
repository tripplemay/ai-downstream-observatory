"""Advanced local owner operations, never an investor onboarding requirement."""

import argparse
import os
from pathlib import Path
import re
import stat
import sys

from worker.orchestration.db import ROOT, WorkbenchError, canonical_json, open_database
from .data_evidence import KINDS, MAX_REVIEW_BYTES, _assert, _object, _owner, collect_prices, purge_price_payload, review_source, store_source
from .data_snapshot import build_dataset
from .source_inputs import admit_evidence_input
from .monitor_data import build_monitor_data, check_reference_listing_identity
from .monitor_admission import admit_monitor_data, current_monitor_model
from .history_collection import plan_history, collect_history, MAX_BATCH_CALLS
from .confirmed_capture import collect_confirmed_prices, resolve_confirmed_capture, purge_confirmed_payload
from . import issuer_sources, managed_fx, issuer_schedule


def _private_descriptor(value):
    descriptor = None
    try:
        path = Path(value)
        _assert(path.is_absolute(), "INVESTOR_DATA_PRIVATE_FILE_REQUIRED")
        resolved = path.resolve(strict=True)
        _assert(ROOT != resolved and ROOT not in resolved.parents, "INVESTOR_DATA_PRIVATE_FILE_REQUIRED")
        before, parent = path.lstat(), resolved.parent.stat()
        _assert(stat.S_ISREG(before.st_mode) and stat.S_ISDIR(parent.st_mode)
            and parent.st_uid == os.geteuid() and stat.S_IMODE(parent.st_mode) & 0o077 == 0,
            "INVESTOR_DATA_PRIVATE_FILE_REQUIRED")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        info = os.fstat(descriptor)
        _assert(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
            and stat.S_IMODE(info.st_mode) & 0o077 == 0 and (info.st_dev, info.st_ino) == (before.st_dev, before.st_ino),
            "INVESTOR_DATA_PRIVATE_FILE_REQUIRED")
        return descriptor, path
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        raise


def _read_private_json(value, maximum):
    descriptor, _ = _private_descriptor(value)
    try:
        chunks, size = [], 0
        while size <= maximum:
            chunk = os.read(descriptor, min(8192, maximum + 1 - size))
            if not chunk:
                break
            chunks.append(chunk); size += len(chunk)
        _assert(0 < size <= maximum, "INVESTOR_DATA_PRIVATE_INPUT_LIMIT")
        return _object(b"".join(chunks))
    finally:
        os.close(descriptor)


def _parser():
    parser = argparse.ArgumentParser(description="Private owner-reviewed research evidence; no trades, no provider certification")
    parser.add_argument("--db", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--actor", required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    source = commands.add_parser("store-source")
    source.add_argument("--kind", choices=KINDS, required=True); source.add_argument("--file", required=True)
    review = commands.add_parser("review-source")
    review.add_argument("--source", required=True); review.add_argument("--file", required=True)
    collect = commands.add_parser("collect-prices")
    for name in ("rights-review", "listing-review", "calendar-review", "start", "end", "credentials-file"):
        collect.add_argument("--" + name, required=True)
    for command in ("plan-history", "collect-history"):
        history = commands.add_parser(command)
        for name in ("rights-review", "listing-review", "calendar-review", "start", "end"):
            history.add_argument("--" + name, required=True)
        if command == "collect-history":
            history.add_argument("--credentials-file", required=True)
            history.add_argument("--plan-hash", required=True)
            history.add_argument("--max-calls", type=int, choices=range(1, MAX_BATCH_CALLS + 1), default=1)
    snapshot = commands.add_parser("check-snapshot")
    snapshot.add_argument("--capture", action="append", required=True)
    snapshot.add_argument("--actions-review", action="append", required=True)
    snapshot.add_argument("--fx-review", action="append", default=[])
    snapshot.add_argument("--start", required=True); snapshot.add_argument("--end", required=True)
    admit = commands.add_parser("admit-research")
    admit.add_argument("--capture", action="append", required=True)
    admit.add_argument("--actions-review", action="append", required=True)
    admit.add_argument("--fx-review", action="append", default=[])
    for name in ("start", "end", "design-file"):
        admit.add_argument("--" + name, required=True)
    for command in ("check-monitor-snapshot", "admit-monitor-snapshot"):
        monitor = commands.add_parser(command)
        monitor.add_argument("--model", required=True)
        monitor.add_argument("--file", required=True)
    purge = commands.add_parser("purge-price-payload")
    purge.add_argument("--capture", required=True)
    confirmed = commands.add_parser("collect-confirmed-prices")
    confirmed.add_argument("--file", required=True)
    confirmed.add_argument("--credentials-file", required=True)
    for command in ("check-confirmed-capture", "purge-confirmed-payload"):
        commands.add_parser(command).add_argument("--capture", required=True)
    commands.add_parser("register-issuer-authority").add_argument("--file", required=True)
    control = commands.add_parser("control-issuer-authority")
    control.add_argument("--authority", required=True)
    flags = control.add_mutually_exclusive_group(required=True)
    flags.add_argument("--enable", action="store_true"); flags.add_argument("--disable", action="store_true")
    issuer = commands.add_parser("collect-issuer-draft")
    for name in ("authority", "request-key", "start", "end"):
        issuer.add_argument("--" + name, required=True)
    commands.add_parser("inspect-issuer-request").add_argument("--request-key", required=True)
    for command in ("check-issuer-capture", "purge-issuer-capture"):
        commands.add_parser(command).add_argument("--capture", required=True)
    commands.add_parser("register-fx-authority").add_argument("--file", required=True)
    commands.add_parser("register-issuer-schedule").add_argument("--file", required=True)
    control = commands.add_parser("control-issuer-schedule")
    control.add_argument("--schedule", required=True)
    flags = control.add_mutually_exclusive_group(required=True)
    flags.add_argument("--enable", action="store_true"); flags.add_argument("--disable", action="store_true")
    commands.add_parser("inspect-issuer-scheduled-request").add_argument("--request", required=True)
    control = commands.add_parser("control-fx-authority")
    control.add_argument("--authority", required=True)
    flags = control.add_mutually_exclusive_group(required=True)
    flags.add_argument("--enable", action="store_true"); flags.add_argument("--disable", action="store_true")
    commands.add_parser("inspect-fx-request").add_argument("--feed-day", required=True)
    for command in ("check-fx-capture", "purge-fx-capture"):
        commands.add_parser(command).add_argument("--capture", required=True)
    commands.add_parser("check-fx-head").add_argument("--authority", required=True)
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    db = None
    try:
        descriptor, path = _private_descriptor(args.db)
        os.close(descriptor)
        db = open_database(path)
        _owner(db, args.workspace, args.actor)
        if args.command == "store-source":
            row = store_source(db, args.workspace, args.actor, args.kind, _read_private_json(args.file, 131072))
            result = {"source_id": row["id"], "kind": row["kind"], "content_hash": row["content_hash"]}
        elif args.command == "register-issuer-schedule":
            row = issuer_schedule.register_schedule(db, args.workspace, args.actor, _read_private_json(args.file, 4096))
            control = db.execute("SELECT enabled FROM investor_issuer_schedule_controls WHERE schedule_id=? ORDER BY version DESC LIMIT 1", (row["id"],)).fetchone()
            result = {"schedule_id": row["id"], "schedule_hash": row["content_hash"], "enabled": bool(control["enabled"]), "research_admitted": False}
        elif args.command == "control-issuer-schedule":
            row = issuer_schedule.set_schedule_enabled(db, args.workspace, args.actor, args.schedule, args.enable)
            result = {"schedule_id": args.schedule, "control_id": row["id"], "enabled": bool(row["enabled"]), "research_admitted": False}
        elif args.command == "inspect-issuer-scheduled-request":
            result = issuer_schedule.inspect_scheduled_request(db, args.workspace, args.actor, args.request)
        elif args.command == "register-fx-authority":
            row = managed_fx.register_authority(db, args.workspace, args.actor, _read_private_json(args.file, 16384))
            control = db.execute("SELECT enabled FROM investor_fx_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (row["id"],)).fetchone()
            result = {"authority_id": row["id"], "content_hash": row["content_hash"], "enabled": bool(control[0]),
                "authorization_basis": "owner_reviewed_standing_rule_not_provider_certified", "source_reviews_published_by_this_command": False}
        elif args.command == "control-fx-authority":
            row = managed_fx.set_authority_enabled(db, args.workspace, args.actor, args.authority, args.enable)
            result = {"control_id": row["id"], "version": row["version"], "enabled": bool(row["enabled"]), "source_reviews_published_by_this_command": False}
        elif args.command == "inspect-fx-request":
            result = managed_fx.inspect_request(db, args.workspace, args.actor, args.feed_day)
        elif args.command == "check-fx-capture":
            value = managed_fx.resolve_capture(db, args.workspace, args.capture)
            row = value["capture"]
            result = {"capture_id": row["id"], "raw_sha256": row["raw_sha256"], "raw_bytes": row["raw_bytes"],
                "retain_until": row["retain_until"], "not_before": row["not_before"], "market_values_output": False, "production_admitted": False}
        elif args.command == "purge-fx-capture":
            row = managed_fx.purge_capture(db, args.workspace, args.actor, args.capture)
            result = {"capture_id": row["capture_id"], "reason": row["reason"], "created_at": row["created_at"], "backup_purge_verified": False}
        elif args.command == "check-fx-head":
            row = db.execute("SELECT id FROM investor_fx_publications WHERE authority_id=? AND workspace_id=? AND status='published' ORDER BY sequence DESC LIMIT 1", (args.authority, args.workspace)).fetchone()
            _assert(row is not None, "INVESTOR_FX_HEAD_NOT_READY")
            head, doc, _ = managed_fx._resolved_publication(db, args.workspace, row["id"], managed_fx._clock(None))
            result = {"publication_id": head["id"], "content_hash": head["content_hash"], "sequence": head["sequence"],
                "currencies": sorted(doc["refs"]), "human_review_performed": False, "trading_permission": False, "market_values_output": False}
        elif args.command == "register-issuer-authority":
            row = issuer_sources.register_authority(db, args.workspace, args.actor, _read_private_json(args.file, 16384))
            control = db.execute("SELECT enabled FROM investor_issuer_controls WHERE authority_id=? ORDER BY version DESC LIMIT 1", (row["id"],)).fetchone()
            result = {"authority_id": row["id"], "content_hash": row["content_hash"], "enabled": bool(control[0]),
                "authorization_basis": "owner_declared_private_use_not_provider_certified", "research_admitted": False}
        elif args.command == "control-issuer-authority":
            row = issuer_sources.set_authority_enabled(db, args.workspace, args.actor, args.authority, args.enable)
            result = {"control_id": row["id"], "version": row["version"], "enabled": bool(row["enabled"]), "research_admitted": False}
        elif args.command == "collect-issuer-draft":
            result = issuer_sources.collect_issuer_draft(db, args.workspace, args.actor, args.authority, args.request_key, args.start, args.end)
        elif args.command == "inspect-issuer-request":
            result = issuer_sources.request_state(db, args.workspace, args.actor, args.request_key)
        elif args.command == "check-issuer-capture":
            value = issuer_sources.resolve_issuer_capture(db, args.workspace, args.actor, args.capture)
            row = value["capture"]
            result = {"capture_id": row["id"], "raw_sha256": row["raw_sha256"], "raw_bytes": row["raw_bytes"],
                "qualification": row["qualification"], "retain_until": row["retain_until"], "record_count": len(value["draft"]["records"]),
                "gaps": value["draft"]["gaps"], "research_admitted": False, "market_values_output": False, "live_advice_eligible": False}
        elif args.command == "purge-issuer-capture":
            row = issuer_sources.purge_issuer_capture(db, args.workspace, args.actor, args.capture)
            result = {"capture_id": row["capture_id"], "reason": row["reason"], "created_at": row["created_at"], "backup_purge_verified": False}
        elif args.command == "review-source":
            document = _read_private_json(args.file, MAX_REVIEW_BYTES)
            required = {"decision", "facts", "reason", "valid_until"}
            _assert(required <= set(document) <= required | {"continues_calendar_review_id"})
            row = review_source(db, args.workspace, args.actor, args.source, **document)
            result = {"review_id": row["id"], "version": row["version"], "decision": row["decision"], "content_hash": row["content_hash"],
                "review_basis": "owner_reviewed_not_provider_certified"}
            if "calendar_continuation_id" in row:
                result.update(calendar_continuation_id=row["calendar_continuation_id"], historical_prefix_unchanged=True,
                    historical_reference_expiry_extended=False, collection_permission_granted=False, trading_permission=False)
        elif args.command == "collect-prices":
            row = collect_prices(db, args.workspace, args.actor, args.rights_review, args.listing_review, args.calendar_review,
                args.start, args.end, credentials_file=args.credentials_file)
            result = {"capture_id": row["id"], "receipt_hash": row["receipt_hash"], "projection_sha256": row["projection_sha256"],
                "qualification": row["qualification"], "retain_until": row["retain_until"], "market_values_output": False}
        elif args.command == "collect-confirmed-prices":
            document = _read_private_json(args.file, 32768)
            _assert(set(document) == {"targets", "watch_seconds"})
            row = collect_confirmed_prices(db, args.workspace, args.actor, document["targets"],
                watch_seconds=document["watch_seconds"], credentials_file=args.credentials_file)
            result = {"capture_id": row["id"], "status": row["status"], "receipt_hash": row["receipt_hash"], "qualification": row["qualification"],
                "retain_until": row["retain_until"], "market_values_output": False, "monitor_queue_updated": False, "live_advice_eligible": False}
        elif args.command == "check-confirmed-capture":
            value = resolve_confirmed_capture(db, args.workspace, args.capture)
            row = value["capture"]
            result = {"capture_id": row["id"], "status": row["status"], "receipt_hash": row["receipt_hash"], "qualification": row["qualification"],
                "record_count": len(value["records"]), "retain_until": row["retain_until"], "market_values_output": False,
                "monitor_queue_updated": False, "live_advice_eligible": False}
        elif args.command == "purge-confirmed-payload":
            row = purge_confirmed_payload(db, args.workspace, args.actor, args.capture)
            result = {"capture_id": row["capture_id"], "reason": row["reason"], "created_at": row["created_at"], "backup_purge_verified": False}
        elif args.command in ("plan-history", "collect-history"):
            arguments = (db, args.workspace, args.actor, args.rights_review, args.listing_review, args.calendar_review, args.start, args.end)
            result = plan_history(*arguments) if args.command == "plan-history" else collect_history(*arguments,
                plan_hash=args.plan_hash, max_calls=args.max_calls, credentials_file=args.credentials_file)
        elif args.command == "check-snapshot":
            snapshot = build_dataset(db, args.workspace, args.capture, args.actions_review, args.fx_review, args.start, args.end)
            result = {"mode": snapshot["dataset"]["mode"], "dataset_hash": snapshot["dataset_hash"], "manifest_hash": snapshot["manifest_hash"],
                "asset_count": len(snapshot["dataset"]["assets"]), "observation_count": len(snapshot["dataset"]["observations"]),
                "valid_until": snapshot["valid_until"], "live_advice_eligible": False, "research_queue_updated": False,
                "market_values_output": False, "dataset_exported": False}
        elif args.command == "admit-research":
            design = _read_private_json(args.design_file, 131072)
            _assert(set(design) == {"plan", "policy"})
            row = admit_evidence_input(db, args.workspace, args.actor, args.capture, args.actions_review, args.fx_review,
                args.start, args.end, design["plan"], design["policy"])
            result = {"input_id": row["id"], "content_hash": row["content_hash"], "request_id": row["request_id"],
                "source_qualification": row["source_qualification"], "live_advice_eligible": False, "market_values_output": False}
        elif args.command in ("check-monitor-snapshot", "admit-monitor-snapshot"):
            from .runtime import _milliseconds
            checked = _milliseconds()
            _, definition, reference = current_monitor_model(db, args.workspace, args.model, checked)
            document = _read_private_json(args.file, 131072)
            _assert(set(document) == {"windows", "settings"})
            if args.command == "admit-monitor-snapshot":
                row = admit_monitor_data(db, args.workspace, args.actor, args.model, document["windows"], document["settings"])
                result = {"input_id": row["id"], "content_hash": row["content_hash"], "source_qualification": row["source_qualification"],
                    "monitor_queue_updated": False, "model_enablement_changed": False, "market_values_output": False, "live_advice_eligible": False}
                print(canonical_json(result))
                return 0
            projected = build_monitor_data(db, args.workspace, definition, document["windows"], document["settings"], now=checked)
            check_reference_listing_identity(reference["targets"], projected["catalog"])
            result = {"mode": "reconstructed", "source_qualification": projected["document"]["source_qualification"],
                "input_hash": projected["content_hash"], "projection_hash": projected["document"]["projection_hash"],
                "market_count": len(projected["document"]["segments"]), "quote_count": len(projected["projection"]["quotes"]),
                "quality_gaps": projected["projection"]["quality_gaps"], "valid_until": projected["projection"]["valid_until"],
                "monitor_queue_updated": False, "model_enablement_changed": False, "market_values_output": False, "live_advice_eligible": False}
        else:
            row = purge_price_payload(db, args.workspace, args.actor, args.capture)
            result = {"capture_id": row["capture_id"], "reason": row["reason"], "created_at": row["created_at"], "backup_purge_verified": False}
        print(canonical_json(result))
        return 0
    except Exception as error:
        code = str(error).split(":", 1)[0]
        if not re.fullmatch(r"(?:INVESTOR_(?:DATA|ISSUER|FX)_[A-Z_]+|LONGPORT_[A-Z_]+|WORKBENCH_[A-Z_]+|RESTORE_PENDING_REVIEW|SCHEMA_VERSION_MISMATCH|MIGRATION_MANIFEST_MISMATCH|CONTRACT_INVALID)", code):
            code = "INVESTOR_DATA_PIPELINE_FAILED"
        print(canonical_json({"error": code}), file=sys.stderr)
        return 1
    finally:
        if db is not None:
            db.close()


if __name__ == "__main__":
    raise SystemExit(main())
