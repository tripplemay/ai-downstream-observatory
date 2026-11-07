import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { priceInstant as time } from "../market-price-source";
import { checkNoNewActionCandidate, type ActionSnapshot } from "./action-maintenance-candidate";
import { actionCheck as check, actionText as text, type ActionObject as Obj } from "./action-source-parsers";
import { readManagedActionProgressRecord } from "./managed-action-source";
import { validateUnchangedActionRecovery } from "./kernel-contracts";

export function isUnchangedActionRecovery(document: Obj) {
  return ["investor-unchanged-action-recovery-submit-v1", "investor-unchanged-action-recovery-confirmation-v1"].includes(String(document.schema_version));
}

/** Authenticated metadata only; not current raw-source or recovery qualification. */
export function readActionRecoveryFailure(db: Database.Database, workspace: string, authority: string, now: string) {
  const failed = readManagedActionProgressRecord(db, workspace, authority, now).quarantine;
  check(failed && failed.row.status === "blocked" && time(failed.row.created_at) <= time(now));
  check(["SOURCE_CAPTURE_TERMINAL_FAILURE", "MAINTENANCE_WINDOW_MISSED"].includes(String(failed.doc.failure_code)));
  return { failed_publication_id: failed.row.id, failed_publication_hash: failed.row.content_hash,
    failed_source_day: failed.row.source_day, failed_at: failed.row.created_at, failure_code: failed.doc.failure_code };
}

/** Independent pure comparison; the caller must prove failure, owner and source bindings. */
export function checkUnchangedActionRecovery(before: Obj, after: Obj, previous: ActionSnapshot, current: ActionSnapshot,
  symbol: string, listingId: string, knowledgeFloor: string, reviewedAt: string, failure: Obj) {
  check(["SOURCE_CAPTURE_TERMINAL_FAILURE", "MAINTENANCE_WINDOW_MISSED"].includes(String(failure.failure_code)));
  const candidate = checkNoNewActionCandidate(before, previous, current, symbol, listingId);
  check(candidate.status === "eligible_candidate_only" && hash({ ...before, range_end: candidate.candidate_range_end }) === hash(after));
  check(text(candidate.current_source_day) > text(failure.failed_source_day));
  const floor = Object.values(current).map(value => time(value.source.retrieved_at)).reduce((a, b) => a > b ? a : b);
  check(time(failure.failed_at) < floor && floor <= time(knowledgeFloor) && time(knowledgeFloor) <= time(reviewedAt));
  const result = { status: "unchanged_recovery_prepared_only", previous_facts_hash: hash(before), reviewed_facts_hash: hash(after),
    previous_snapshot_hash: hash(previous), current_snapshot_hash: hash(current), previous_coverage_end: before.range_end,
    new_coverage_end: after.range_end, added_event_count: 0, added_dividend_count: 0, added_split_count: 0, new_nominal_difference_count: 0,
    knowledge_basis: "current_complete_report_receipts_only", late_knowledge_event_count: 0, continuation_timing_ready: true,
    requires_separate_knowledge_or_start: false, old_events_and_tax_assumption_unchanged: true, owner_approval_verified: false,
    source_authority_verified: false, handover_registered: false, research_admitted: false, trading_permission: false,
    provider_calls: 0, database_writes: 0, raw_amounts_or_tax_text_output: false, ...failure };
  validateUnchangedActionRecovery("proof", result);
  return result;
}
