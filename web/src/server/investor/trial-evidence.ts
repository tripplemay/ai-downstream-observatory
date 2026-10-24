import type Database from "better-sqlite3";
import { z } from "zod";
import { hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorHash, investorId, investorInstant, researchRegistrySchema } from "./schemas";
import { validateInvestorTrialDocument } from "./kernel-contracts";
import { readInvestorResearchSource } from "./source-inputs";

type ObjectValue = Record<string, unknown>;
type SealedRow = { document_json: string; content_hash: string; created_at: string };
function requireEvidence(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_EVIDENCE_INVALID"); }
function object(value: unknown): ObjectValue {
  requireEvidence(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as ObjectValue;
}
function sealed(row: SealedRow, now: string) {
  const value = object(parseStrictJson(row.document_json));
  requireEvidence(hash(value) === row.content_hash && investorInstant.safeParse(row.created_at).success && row.created_at <= now);
  return value;
}
function micros(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  requireEvidence(match && new Date(match[1] + "Z").toISOString().slice(0, 19) === match[1]);
  return BigInt(Date.parse(match[1] + "Z")) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
const freezeSchema = z.object({ experiment_id: investorId, parameters_hash: investorHash, selection_basis: z.literal("train_only"),
  manifest_hash: investorHash, train_result_hashes: z.record(investorHash, investorHash) }).strict();

/** Local append-only audit; never certifies unseen data or permits live advice. */
export function readInvestorTrialRegistry(db: Database.Database, workspaceId: string,
  request: { id: string; input_id: string | null; evidence_input_id?: string | null; input_version: string }, profileHash: string, now: string,
  publication?: { implementation_hash: string; result: ObjectValue | null; registry?: unknown },
  resolvedSource?: ReturnType<typeof readInvestorResearchSource>) {
  try {
    const stored = publication?.registry === undefined || publication.registry === null ? null : researchRegistrySchema.parse(publication.registry);
    const row = stored
      ? db.prepare("SELECT * FROM investor_experiments WHERE id=? AND workspace_id=? AND request_id=?").get(stored.experiment_id, workspaceId, request.id)
      : db.prepare("SELECT * FROM investor_experiments WHERE workspace_id=? AND request_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspaceId, request.id);
    if (!row) { requireEvidence(stored === null); return null; }
    const experiment = row as SealedRow & { id: string; workspace_id: string; request_id: string; implementation_hash: string };
    const manifest = sealed(experiment, now); validateInvestorTrialDocument("experiment", manifest);
    requireEvidence(manifest.experiment_id === experiment.id && manifest.request_id === request.id && manifest.workspace_id === workspaceId
      && manifest.input_version === request.input_version && manifest.profile_hash === profileHash && manifest.created_at === experiment.created_at
      && manifest.implementation_hash === experiment.implementation_hash && (!publication || publication.implementation_hash === experiment.implementation_hash));
    const source = resolvedSource === undefined ? readInvestorResearchSource(db, workspaceId, request, now) : resolvedSource;
    requireEvidence(source?.payload && source.row.created_at <= experiment.created_at && manifest.source_qualification === source.row.source_qualification);
    const input = object(source.payload), plan = object(input.plan), policy = object(input.policy);
    requireEvidence(Object.keys(input).sort().join() === "dataset,plan,policy"
      && object(input.dataset).mode === (source.row.source_qualification === "synthetic_test_only" ? "synthetic" : "reconstructed"));
    for (const name of ["dataset", "plan", "policy"]) requireEvidence(manifest[name + "_hash"] === hash(input[name]));
    const candidates = (policy.candidates as unknown[]).map(hash).sort();
    const budgets = object(manifest.trial_budgets), windows = object(manifest.windows);
    requireEvidence(hash(manifest.candidate_hashes) === hash(candidates) && manifest.benchmark_hash === hash(plan.benchmark)
      && hash(windows) === hash(plan.windows) && budgets.train === candidates.length);
    const trials = db.prepare(`SELECT t.*,t.rowid intent_rowid,r.document_json,r.content_hash,r.created_at result_at,
      r.job_id result_job,r.fencing_token result_token FROM investor_trial_intents t LEFT JOIN investor_trial_results r ON r.trial_id=t.id
      WHERE t.experiment_id=? ORDER BY t.rowid LIMIT 11`).all(experiment.id) as {
        id: string; phase: "train" | "validation" | "holdout"; parameters_hash: string; window_start_us: number; window_end_us: number;
        job_id: string; fencing_token: number; created_at: string; intent_rowid: number;
        document_json: string | null; content_hash: string | null; result_at: string | null; result_job: string | null; result_token: number | null;
      }[];
    requireEvidence(trials.length <= candidates.length + 2);
    const job = db.prepare("SELECT id,fencing_token FROM job_runs WHERE job_type='investor_research' AND command_request_id IS NULL AND scope=? AND period=? AND input_version=?")
      .get(workspaceId, request.id, request.input_version) as { id: string; fencing_token: number } | undefined;
    requireEvidence(job);
    const phases = { train: { registered: 0, completed: 0 }, validation: { registered: 0, completed: 0 }, holdout: { registered: 0, completed: 0 } };
    const trainHashes: Record<string, string> = {}, summaries = new Map<string, ObjectValue>();
    for (const trial of trials) {
      requireEvidence(trial.phase in phases && candidates.includes(trial.parameters_hash) && trial.job_id === job.id
        && trial.fencing_token <= job.fencing_token && trial.fencing_token > 0 && investorInstant.safeParse(trial.created_at).success
        && trial.created_at >= experiment.created_at && trial.created_at <= now);
      const window = object(windows[trial.phase]);
      requireEvidence(BigInt(trial.window_start_us) === micros(window.start as string) && BigInt(trial.window_end_us) === micros(window.end as string));
      phases[trial.phase].registered++;
      if (trial.document_json !== null) {
        requireEvidence(trial.content_hash && trial.result_at && trial.result_job === job.id && trial.result_token !== null
          && trial.result_token >= trial.fencing_token && trial.result_token <= job.fencing_token && trial.result_at >= trial.created_at);
        const summary = sealed({ document_json: trial.document_json, content_hash: trial.content_hash, created_at: trial.result_at }, now);
        validateInvestorTrialDocument("summary", summary, plan.schema_version as string);
        requireEvidence(summary.phase === trial.phase && hash(summary.window) === hash(window));
        phases[trial.phase].completed++;
        summaries.set(trial.phase + ":" + trial.parameters_hash, summary);
        if (trial.phase === "train") trainHashes[trial.parameters_hash] = trial.content_hash;
      }
    }
    for (const phase of ["train", "validation", "holdout"] as const) requireEvidence(phases[phase].registered <= (budgets[phase] as number));
    const frozen = db.prepare("SELECT * FROM investor_candidate_freezes WHERE experiment_id=?").get(experiment.id) as {
      evidence_json: string; content_hash: string; parameters_hash: string; created_at: string; job_id: string; fencing_token: number;
    } | undefined;
    if (frozen) {
      const evidence = freezeSchema.parse(sealed({ ...frozen, document_json: frozen.evidence_json }, now));
      requireEvidence(evidence.experiment_id === experiment.id && evidence.parameters_hash === frozen.parameters_hash
        && candidates.includes(frozen.parameters_hash) && evidence.manifest_hash === experiment.content_hash
        && hash(evidence.train_result_hashes) === hash(trainHashes) && Object.keys(trainHashes).length === candidates.length
        && frozen.job_id === job.id && frozen.fencing_token <= job.fencing_token
        && trials.filter(trial => trial.phase !== "train").every(trial => trial.parameters_hash === frozen.parameters_hash && trial.created_at >= frozen.created_at)
        && trials.filter(trial => trial.phase === "train").every(trial => trial.result_at !== null && trial.result_at <= frozen.created_at));
    } else requireEvidence(phases.validation.registered === 0 && phases.holdout.registered === 0);
    if (publication?.result) {
      const result = publication.result;
      const publishedCandidates = result.candidates as ObjectValue[];
      requireEvidence(publishedCandidates.length === phases.train.completed);
      for (const candidate of publishedCandidates) requireEvidence(hash(candidate.train) === hash(summaries.get("train:" + candidate.parameters_hash)));
      if (result.selected_parameters !== null) {
        requireEvidence(frozen && frozen.parameters_hash === hash(result.selected_parameters));
        for (const summary of result.phase_evidence as ObjectValue[]) requireEvidence(hash(summary) === hash(summaries.get(summary.phase + ":" + frozen.parameters_hash)));
      } else requireEvidence(!frozen && phases.validation.registered === 0 && phases.holdout.registered === 0);
    }
    const maximum = (db.prepare("SELECT coalesce(max(rowid),0) n FROM investor_trial_intents").get() as { n: number }).n;
    const watermark = stored?.exposure_watermark ?? maximum;
    requireEvidence(watermark <= maximum && watermark >= Math.max(0, ...trials.map(trial => trial.intent_rowid)));
    const holdout = object(windows.holdout);
    const exposures = (db.prepare("SELECT count(DISTINCT experiment_id) n FROM investor_trial_intents WHERE experiment_id!=? AND rowid<=? AND window_start_us<=? AND window_end_us>=?")
      .get(experiment.id, watermark, micros(holdout.end as string), micros(holdout.start as string)) as { n: number }).n;
    const receipt = researchRegistrySchema.parse({ experiment_id: experiment.id, manifest_hash: experiment.content_hash, phases,
      freeze_hash: frozen?.content_hash ?? null, prior_window_exposures: exposures, exposure_watermark: watermark,
      holdout_status: exposures > 0 ? "previously_exposed" : "not_independently_verified", coverage: "local_investor_trials_only", live_advice_eligible: false });
    if (stored) requireEvidence(hash(stored) === hash(receipt));
    return receipt;
  } catch { throw new Error("INVESTOR_EVIDENCE_INVALID"); }
}
