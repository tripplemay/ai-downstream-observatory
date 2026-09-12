import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { canonical, hash, revision } from "../ledger/service";
import { createProposal } from "../governance/service";
import type { GovernanceOptions } from "../governance/core";
import { assertEvaluationLease, evaluationStamp, prepareMonthlyEvaluation, type EvaluationLease } from "./evaluator";

export interface MonthlyEvaluationJobResult {
  schema_version: "monthly-evaluation-job-result-v1"; cycle_id: string; evaluation_attempt_id: string;
  outcome: "unchanged" | "proposed" | "blocked"; proposal_id: string | null;
}
export interface EvaluationPublishOptions extends GovernanceOptions {
  clock?: () => string; beforeCommit?: () => void;
}

/** Trusted worker only: an exact lease, never a caller-supplied financial result. */
export function publishMonthlyEvaluation(db: Database.Database, lease: EvaluationLease, options: EvaluationPublishOptions = {}): MonthlyEvaluationJobResult {
  if (db.inTransaction) throw new Error("EVALUATION_INDEPENDENT_TRANSACTION_REQUIRED");
  assertWritableDatabase(db);
  const clock = () => evaluationStamp(options.clock?.() ?? options.now ?? new Date().toISOString());
  const prepared = db.transaction(() => prepareMonthlyEvaluation(db, lease, { ...options, now: clock() })).deferred();
  options.beforeCommit?.();
  return db.transaction(() => {
    assertWritableDatabase(db);
    const now = clock(), fresh = prepareMonthlyEvaluation(db, lease, { ...options, now });
    if (fresh.input_hash !== prepared.input_hash) throw new Error("EVALUATION_INPUT_CHANGED");
    const { cycle } = fresh.binding;
    let outcome = fresh.outcome, proposalId: string | null = null, risk = fresh.risk, reasonCodes = fresh.reason_codes;
    if (outcome === "proposed") {
      if (!fresh.valuation_id || !fresh.expires_at || !fresh.candidate_items.length) throw new Error("EVALUATION_RESULT_INVALID");
      const proposal = createProposal(db, { id: "system:monthly-evaluation", kind: "strategy" }, {
        portfolio_id: cycle.portfolio_id, expected_revision: revision(db, cycle.portfolio_id), idempotency_key: `monthly:${cycle.id}:${fresh.binding.job_attempt_id}`,
        reason: `Explicit approved monthly targets; cycle ${cycle.id}; input ${fresh.input_hash}; human approval still required`,
        activation_id: fresh.binding.definition.activation_id, valuation_id: fresh.valuation_id, expires_at: fresh.expires_at, items: fresh.candidate_items,
      }, { ...options, now });
      proposalId = proposal.id; risk = proposal.risk;
      if (proposal.risk.status !== "pass") { outcome = "blocked"; reasonCodes = proposal.risk.checks.map(check => check.code); }
    }
    const result = { schema_version: "monthly-evaluation-result-v1", cycle_id: cycle.id, input_hash: fresh.input_hash,
      method_version: "manual_weight_targets_v1", outcome, reason_codes: reasonCodes, comparison_rows: fresh.comparisons,
      candidate_items: fresh.candidate_items, proposal_id: proposalId, risk, scheduled_at: cycle.scheduled_at,
      evaluated_at: fresh.binding.started_at, completed_at: now, late: evaluationStamp(fresh.binding.started_at) > evaluationStamp(cycle.scheduled_at), broker_order_sent: false };
    const id = randomUUID(), attempt = (db.prepare("SELECT COALESCE(MAX(attempt),0)+1 AS n FROM evaluation_attempts WHERE cycle_id=?").get(cycle.id) as { n: number }).n;
    db.prepare(`INSERT INTO evaluation_attempts(id,cycle_id,attempt,input_manifest,status,result_json,created_at,job_attempt_id,input_hash,result_hash,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, cycle.id, attempt, canonical(fresh.input_manifest), outcome === "blocked" ? "blocked" : "succeeded",
      canonical(result), fresh.binding.started_at, fresh.binding.job_attempt_id, fresh.input_hash, hash(result), now);
    const changed = db.prepare("UPDATE evaluation_cycles SET status=?,outcome=?,completed_at=?,terminal_attempt_id=?,state_revision=state_revision+1 WHERE id=? AND state_revision=?")
      .run(outcome === "blocked" ? "blocked" : "completed", outcome, now, id, cycle.id, cycle.state_revision);
    if (changed.changes !== 1) throw new Error("EVALUATION_CYCLE_CONFLICT");
    const jobResult: MonthlyEvaluationJobResult = { schema_version: "monthly-evaluation-job-result-v1", cycle_id: cycle.id, evaluation_attempt_id: id, outcome, proposal_id: proposalId };
    db.prepare("INSERT INTO outbox(id,dedup_key,topic,payload_json,status,max_attempts,not_before,created_at) VALUES(?,?,?,?,'pending',3,?,?)")
      .run(randomUUID(), `monthly-evaluation:${id}`, "monthly_evaluation", canonical(jobResult), now, now);
    // The guard runs after every effect, while the same write transaction is still held.
    const finished = clock();
    assertWritableDatabase(db); assertEvaluationLease(db, lease, finished);
    if (outcome !== "blocked" && (finished >= evaluationStamp(cycle.deadline_at)
      || (fresh.expires_at && finished >= evaluationStamp(fresh.expires_at)))) throw new Error("EVALUATION_DEADLINE_MISSED");
    db.prepare("UPDATE job_attempts SET status='succeeded',finished_at=? WHERE id=? AND status='running'").run(now, fresh.binding.job_attempt_id);
    db.prepare("UPDATE job_runs SET status='succeeded',result_json=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=?")
      .run(canonical(jobResult), now, lease.job_id);
    return jobResult;
  }).immediate();
}
