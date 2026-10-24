import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorHash, investorId, investorInstant, researchTaskSchema, researchRegistrySchema } from "./schemas";
import type { InvestorProfileVersion } from "./types";
import { verifyInvestorKernelResult } from "./kernel-contracts";
import { readInvestorTrialRegistry } from "./trial-evidence";
import { latestInvestorResearchInput, readInvestorResearchSource } from "./source-inputs";
import { fixedPolicyDecisionRule } from "./fixed-policy";
import { investorResearchEngines, researchEngineForPlan, phaseExecutionReview, executionChecksUsable } from "./research-execution";

export const investorResearchEngine = "investor-diversified-reference-v1";
const requestSchema = z.object({ schema_version: z.literal("investor-research-request-v1"),
  engine_version: z.enum(investorResearchEngines), profile_hash: investorHash, input_hash: investorHash.nullable() }).strict();
export const investorResearchRunSchema = z.object({ schema_version: z.literal("investor-research-run-v1"), status: z.enum(["blocked", "calculated"]),
  request_id: investorId, profile_id: investorId, input_version: investorHash, engine_version: z.enum(investorResearchEngines),
  implementation_hash: investorHash, reason_codes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/)).min(1).max(40),
  result: z.record(z.string(), z.unknown()).nullable(), registry: researchRegistrySchema.nullable().optional(), created_at: investorInstant }).strict();
export function enqueueInvestorResearch(db: Database.Database, workspaceId: string, profile: InvestorProfileVersion, now: string) {
  const input = latestInvestorResearchInput(db, workspaceId, now);
  const inputId = input?.source_kind === "synthetic" ? input.id : null;
  const evidenceId = input?.source_kind === "evidence" ? input.id : null;
  const source = input ? readInvestorResearchSource(db, workspaceId, { input_id: inputId, evidence_input_id: evidenceId }, now) : null;
  const document = requestSchema.parse({ schema_version: "investor-research-request-v1", engine_version: researchEngineForPlan(source?.payload?.plan ?? source?.document?.plan),
    profile_hash: profile.content_hash, input_hash: input?.content_hash ?? null });
  const inputVersion = hash(document);
  const existing = db.prepare("SELECT id,document_json,input_id,evidence_input_id FROM investor_research_requests WHERE workspace_id=? AND profile_id=? AND input_version=?")
    .get(workspaceId, profile.id, inputVersion) as { id: string; document_json: string; input_id: string | null; evidence_input_id: string | null } | undefined;
  if (existing) {
    if (existing.document_json !== canonical(document) || existing.input_id !== inputId || existing.evidence_input_id !== evidenceId) throw new Error("INVESTOR_EVIDENCE_INVALID");
    return existing.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO investor_research_requests(id,workspace_id,profile_id,input_id,evidence_input_id,input_version,document_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, workspaceId, profile.id, inputId, evidenceId, inputVersion, canonical(document), now);
  return id;
}

export function readInvestorResearchTask(db: Database.Database, workspaceId: string, profile: InvestorProfileVersion, now: string) {
  const row = db.prepare(`SELECT r.*,j.id job_id,j.status job_status,j.lease_until,j.attempt_count,j.max_attempts,
    u.status run_status,u.document_json run_json,u.content_hash run_hash,u.observation_id,u.created_at run_at
    FROM investor_research_requests r LEFT JOIN job_runs j ON j.job_type='investor_research'
      AND j.command_request_id IS NULL AND j.scope=r.workspace_id AND j.period=r.id AND j.input_version=r.input_version
    LEFT JOIN investor_research_runs u ON u.request_id=r.id AND u.workspace_id=r.workspace_id AND u.job_id=j.id
    WHERE r.workspace_id=? AND r.profile_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(workspaceId, profile.id) as {
      id: string; input_id: string | null; evidence_input_id: string | null; input_version: string; document_json: string; created_at: string;
      job_id: string | null; job_status: string | null; lease_until: string | null; attempt_count: number | null; max_attempts: number | null;
      run_status: string | null; run_json: string | null; run_hash: string | null; observation_id: string | null; run_at: string | null;
    } | undefined;
  if (!row) return null;
  const document = requestSchema.parse(parseStrictJson(row.document_json));
  if (hash(document) !== row.input_version || document.profile_hash !== profile.content_hash
    || !investorInstant.safeParse(row.created_at).success || row.created_at > now) throw new Error("INVESTOR_EVIDENCE_INVALID");
  const input = latestInvestorResearchInput(db, workspaceId, now);
  const source = readInvestorResearchSource(db, workspaceId, row, now);
  if ((source?.row.content_hash ?? null) !== document.input_hash || source && source.row.created_at > row.created_at
    || document.engine_version !== researchEngineForPlan(source?.payload?.plan ?? source?.document?.plan)) throw new Error("INVESTOR_EVIDENCE_INVALID");
  const inputCurrent = (row.evidence_input_id ?? row.input_id) === (input?.id ?? null) && document.input_hash === (input?.content_hash ?? null);
  let study: z.infer<typeof researchTaskSchema>["study"] = null;
  let registry: z.infer<typeof researchTaskSchema>["registry"] = null;
  let reasonCodes: string[] = [];
  if (row.run_json !== null) {
    const run = investorResearchRunSchema.parse(parseStrictJson(row.run_json));
    if (hash(run) !== row.run_hash || run.request_id !== row.id || run.profile_id !== profile.id || run.input_version !== row.input_version
      || run.engine_version !== document.engine_version || run.status !== row.run_status || run.created_at !== row.run_at || run.created_at < row.created_at || run.created_at > now
      || row.job_status !== "succeeded" || !row.observation_id || (run.status === "blocked") !== (run.result === null)) throw new Error("INVESTOR_EVIDENCE_INVALID");
    reasonCodes = run.reason_codes;
    if (!source?.unavailable_reason) registry = readInvestorTrialRegistry(db, workspaceId, row, profile.content_hash, now, run, source);
    if (run.result && !source?.unavailable_reason) {
      if (!source?.payload) throw new Error("INVESTOR_EVIDENCE_INVALID");
      const payload = source.payload;
      const result = verifyInvestorKernelResult({ action: "research", ...payload, profile: profile.document }, run.result);
      const frozenCandidates = new Map(((payload.policy as Record<string, unknown>).candidates as Record<string, unknown>[]).map(parameters => [hash(parameters), parameters]));
      if (result.implementation_hash !== run.implementation_hash || result.engine_version !== run.engine_version
        || result.data_mode !== (source.row.source_qualification === "synthetic_test_only" ? "synthetic" : "reconstructed")) throw new Error("INVESTOR_EVIDENCE_INVALID");
      study = { status: result.status as "risk_options_ready" | "reference_ready" | "insufficient_evidence",
        qualification: source.row.source_qualification as "synthetic_test_only" | "owner_reviewed_reconstructed",
        phase_checks: (result.phase_evidence as { phase: "train" | "validation" | "holdout"; execution_failure_count: number; benchmark_execution_failure_count: number }[])
          .map(summary => ({ phase: summary.phase, execution_failure_count: summary.execution_failure_count,
            benchmark_execution_failure_count: summary.benchmark_execution_failure_count, ...phaseExecutionReview(summary) })),
        ...(source.document && source.catalog ? { source_context: {
          range_start: (source.document.snapshot as Record<string, string>).range_start,
          range_end: (source.document.snapshot as Record<string, string>).range_end,
          valid_until: source.row.valid_until, basis: "owner_reviewed_historical_reconstruction" as const,
          listings: Object.values(source.catalog).map(value => ({ listing_id: value.listing_id as string, provider_symbol: value.provider_symbol as string,
            market: value.market as "CN" | "HK" | "US", role: value.role as "growth" | "defensive" | "diversifier" })),
        } } : {}), result_hash: result.result_hash as string, implementation_hash: run.implementation_hash,
        candidates: (result.candidates as { parameters_hash: string; weights: Record<string, string>; train: { twr: string | null; annualized_unit_return: string | null; max_drawdown: string | null; benchmark_twr: string | null; benchmark_annualized_unit_return: string | null; benchmark_max_drawdown: string | null; excess_twr: string | null; execution_failure_count: number; benchmark_execution_failure_count: number }; stresses: { id: string; label: string; portfolio_return: string }[] }[])
          .map(candidate => {
            const metricsComplete = [candidate.train.twr, candidate.train.annualized_unit_return, candidate.train.max_drawdown,
              candidate.train.benchmark_twr, candidate.train.benchmark_annualized_unit_return, candidate.train.benchmark_max_drawdown,
              candidate.train.excess_twr].every(value => value !== null);
            return { parameters_hash: candidate.parameters_hash, weights: candidate.weights,
            ...(fixedPolicyDecisionRule(frozenCandidates.get(candidate.parameters_hash)!, true) ? { decision_rule: fixedPolicyDecisionRule(frozenCandidates.get(candidate.parameters_hash)!, true) } : {}),
            train_net_twr: candidate.train.twr, train_drawdown: candidate.train.max_drawdown, benchmark_net_twr: candidate.train.benchmark_twr,
            usable: metricsComplete && executionChecksUsable({ ...candidate.train, ...phaseExecutionReview(candidate.train) }),
            train_checks: { metrics_complete: metricsComplete, execution_failure_count: candidate.train.execution_failure_count,
              benchmark_execution_failure_count: candidate.train.benchmark_execution_failure_count, ...phaseExecutionReview(candidate.train) },
            stresses: candidate.stresses.map(stress => ({ id: stress.id, label: stress.label, portfolio_return: stress.portfolio_return })) };
          }) };
    }
  }
  else if (!source?.unavailable_reason) registry = readInvestorTrialRegistry(db, workspaceId, row, profile.content_hash, now, undefined, source);
  if (source?.unavailable_reason) reasonCodes = [source.unavailable_reason, ...reasonCodes.filter(code => code !== source.unavailable_reason)].slice(0, 40);
  const status = !inputCurrent || source?.unavailable_reason ? "outdated" : row.run_status === "blocked" ? "blocked" : row.run_status === "calculated" ? "calculated"
    : row.job_status === "running" && row.lease_until !== null && Date.parse(row.lease_until) > Date.parse(now) ? "running"
    : row.job_status === "running" || row.job_status === "retry_queued" ? "retrying"
    : row.job_status === "failed" ? "failed" : row.job_status === "skipped" || row.job_status === "cancelled" ? "outdated"
    : row.job_status === null || row.job_status === "queued" ? "queued" : "invalid";
  if (status === "invalid" || (row.job_status === "succeeded" && row.run_json === null)) throw new Error("INVESTOR_EVIDENCE_INVALID");
  return researchTaskSchema.parse({ id: row.id, profile_id: profile.id, profile_version: profile.version, input_version: row.input_version,
    engine_version: document.engine_version, status, created_at: row.created_at, completed_at: row.run_at,
    reason_codes: reasonCodes, study, registry, live_advice_eligible: false });
}
