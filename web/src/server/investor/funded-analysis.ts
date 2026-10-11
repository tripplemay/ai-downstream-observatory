import type Database from "better-sqlite3";
import { hash, type Actor } from "../ledger/service";
import { fundedComparisonSnapshot } from "./funded-comparison";
import { fundedComparisonDenials } from "./funded-comparison-schemas";
import { fundedAnalysisSchema, type FundedPathAnalysis } from "./funded-analysis-schemas";
import { assertFundedComparisonBuild, replayStoredFundedAnalysis, withFundedComparisonCapacity } from "./funded-comparison-process";

/** Selects only a candidate already frozen in this owner's current study. No inline data or writes. */
export async function getFundedPathAnalysis(db: Database.Database, actor: Actor, selector: { parameters_hash: string; path: "immediate" | "staged" },
  options: { clock?: () => string; signal?: AbortSignal } = {}) {
  const clock = options.clock ?? (() => new Date().toISOString()), now = clock(), initial = fundedComparisonSnapshot(db, actor, now);
  const { candidates: ignored, schema_version: ignoredVersion, ...scope } = initial.base; void ignored; void ignoredVersion;
  const base: FundedPathAnalysis = fundedAnalysisSchema.parse({ ...scope, schema_version: "investor-funded-path-analysis-v1", ...selector, analysis: null });
  if (!initial.entries.length) return base;
  const entry = initial.entries.find(value => value.candidate.parameters_hash === selector.parameters_hash);
  if (!entry || !entry.result) return fundedAnalysisSchema.parse({ ...base, status: "unavailable", reason_codes: [entry?.reason ?? "FUNDED_ANALYSIS_CANDIDATE_UNAVAILABLE"] });
  return withFundedComparisonCapacity(base.workspace_id!, async () => {
    const implementation = assertFundedComparisonBuild();
    const analysis = await replayStoredFundedAnalysis(entry.input, entry.result!, selector.path, options.signal);
    const checked = clock();
    if (assertFundedComparisonBuild() !== implementation) throw new Error("FUNDED_COMPARISON_SOURCE_CHANGED");
    if (checked < now) throw new Error("INVESTOR_INVALID_CLOCK");
    const final = fundedComparisonSnapshot(db, actor, checked);
    const { checked_at: initialClock, ...initialBase } = initial.base, { checked_at: finalClock, ...finalBase } = final.base; void initialClock; void finalClock;
    if (hash(initialBase) !== hash(finalBase) || hash(initial.entries) !== hash(final.entries)) {
      const { candidates: ignoredCandidates, schema_version: ignoredSchema, ...finalScope } = final.base; void ignoredCandidates; void ignoredSchema;
      return fundedAnalysisSchema.parse({ ...finalScope, ...fundedComparisonDenials, schema_version: "investor-funded-path-analysis-v1", ...selector,
        status: "outdated", reason_codes: ["FUNDED_STUDY_BINDING_CHANGED"], analysis: null });
    }
    const complete = entry.candidate.status !== "failed" && analysis.candidate.summary.execution_failure_count === 0 && analysis.baseline.summary.execution_failure_count === 0;
    return fundedAnalysisSchema.parse({ ...base, checked_at: checked, status: complete ? "verified_retrospective" : "verified_with_execution_gaps",
      economics_independently_replayed: complete, reason_codes: complete ? [] : ["FUNDED_STUDY_EXECUTION_GAPS"], analysis });
  });
}
