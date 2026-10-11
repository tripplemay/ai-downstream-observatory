import type Database from "better-sqlite3";
import { hash, type Actor } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorInstant, investorProfileSchema } from "./schemas";
import { readFundedStudyContext } from "./funded-study";
import { fundedComparisonSchema, fundedComparisonDenials, type FundedComparison } from "./funded-comparison-schemas";
import { assertFundedComparisonBuild, replayStoredFundedComparison, withFundedComparisonCapacity } from "./funded-comparison-process";

export function fundedComparisonSnapshot(db: Database.Database, actor: Actor, now: string) {
  if (!actor || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(actor.id)) throw new Error("UNAUTHENTICATED");
  if (!investorInstant.safeParse(now).success) throw new Error("INVESTOR_INVALID_CLOCK");
  return db.transaction(() => {
    const ws = db.prepare("SELECT id,owner_id,revision FROM investor_workspaces WHERE owner_id=?").get(actor.id) as
      { id: string; owner_id: string; revision: number } | undefined;
    const row = ws ? db.prepare("SELECT * FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(ws.id) as
      { id: string; version: number; content_hash: string; document_json: string; created_at: string } | undefined : undefined;
    const profile = row ? { id: row.id, version: row.version, content_hash: row.content_hash, created_at: row.created_at,
      document: investorProfileSchema.parse(parseStrictJson(row.document_json)) } : null;
    if (profile && (hash(profile.document) !== profile.content_hash || profile.created_at > now)) throw new Error("INVESTOR_EVIDENCE_INVALID");
    const context = ws && profile ? readFundedStudyContext(db, ws, profile, now) : null;
    const task = context?.task;
    const base: FundedComparison = { schema_version: "investor-funded-comparison-v1", workspace_id: ws?.id ?? null,
      workspace_revision: ws?.revision ?? 0, profile_id: profile?.id ?? null, funding_plan_id: task?.funding_plan_id ?? null,
      request_id: task?.id ?? null, input_version: task?.input_version ?? null, run_id: context?.run_id ?? null,
      checked_at: now, valid_until: context?.source?.row.valid_until ?? null, status: !task ? "not_started" : task.status === "outdated" ? "outdated"
        : task.status === "blocked" ? "blocked" : ["queued", "running", "retrying"].includes(task.status) ? "pending" : "unavailable",
      reason_codes: task?.reason_codes ?? [], candidates: [], ...fundedComparisonDenials };
    const inputs = context?.prepared?.inputs;
    if (!ws || !context?.run || !inputs?.length || ["outdated", "blocked", "pending"].includes(base.status)) return { base, entries: [] };
    const catalog = context.source && "catalog" in context.source ? context.source.catalog : null;
    if (!catalog) throw new Error("FUNDED_COMPARISON_EVIDENCE_INVALID");
    const entries = context.run.candidates.map((candidate, index) => {
      const parameters = inputs[index].context.parameters;
      const allocation = Object.entries(parameters.weights as Record<string, string>).sort(([a], [b]) => a.localeCompare(b)).map(([asset_id, weight]) => {
        const listing = catalog[asset_id];
        if (!listing) throw new Error("FUNDED_COMPARISON_EVIDENCE_INVALID");
        return { asset_id, weight, symbol: listing.provider_symbol, market: listing.market, currency: listing.currency, role: listing.role };
      });
      const entry = { candidate, input: inputs[index], allocation, rebalance: parameters.rebalance };
      if (!candidate.result_hash) return { ...entry, result: null, reason: candidate.reason_code ?? "FUNDED_STUDY_CANDIDATE_FAILED" };
      const header = db.prepare("SELECT * FROM investor_funded_result_headers WHERE run_id=? AND parameters_hash=? AND workspace_id=?")
        .get(context.run_id, candidate.parameters_hash, ws.id) as { input_hash: string; result_hash: string; valid_until: string; created_at: string } | undefined;
      if (!header) return { ...entry, result: null, reason: "FUNDED_COMPARISON_LEGACY_DIGEST_ONLY" };
      if (header.input_hash !== candidate.input_hash || header.result_hash !== candidate.result_hash || header.valid_until !== base.valid_until
        || header.created_at !== context.run!.created_at) throw new Error("FUNDED_COMPARISON_EVIDENCE_INVALID");
      const payload = db.prepare("SELECT payload FROM investor_funded_result_payloads WHERE run_id=? AND parameters_hash=?").get(context.run_id, candidate.parameters_hash) as { payload: Buffer } | undefined;
      const purged = db.prepare("SELECT 1 FROM investor_funded_result_purges WHERE run_id=? AND parameters_hash=?").get(context.run_id, candidate.parameters_hash);
      if (purged) return { ...entry, result: null, reason: "FUNDED_COMPARISON_PAYLOAD_PURGED" };
      if (!payload || !Buffer.isBuffer(payload.payload) || payload.payload.length > 1048576) throw new Error("FUNDED_COMPARISON_EVIDENCE_INVALID");
      const result = parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload.payload)) as Record<string, unknown>;
      if (!result || result.result_hash !== candidate.result_hash || result.input_hash !== candidate.input_hash) throw new Error("FUNDED_COMPARISON_EVIDENCE_INVALID");
      return { ...entry, result, reason: null };
    });
    return { base, entries };
  })();
}

/** On-demand read only; child CPU work runs outside SQLite transactions and the HTTP event loop. */
export async function getFundedComparison(db: Database.Database, actor: Actor, options: { clock?: () => string; signal?: AbortSignal } = {}) {
  const clock = options.clock ?? (() => new Date().toISOString()), now = clock(), initial = fundedComparisonSnapshot(db, actor, now);
  if (!initial.entries.length) return fundedComparisonSchema.parse(initial.base);
  return withFundedComparisonCapacity(initial.base.workspace_id!, async () => {
    const implementation = assertFundedComparisonBuild();
    const candidates: FundedComparison["candidates"] = [];
    for (const entry of initial.entries) {
      if (options.signal?.aborted) throw new Error("FUNDED_COMPARISON_ABORTED");
      let candidate: FundedComparison["candidates"][number] = { parameters_hash: entry.candidate.parameters_hash, result_hash: entry.candidate.result_hash,
        allocation: entry.allocation as FundedComparison["candidates"][number]["allocation"], rebalance: entry.rebalance as FundedComparison["candidates"][number]["rebalance"],
        status: entry.candidate.result_hash ? "unavailable" : "failed", reason_code: entry.reason, economics_hash: null, paths: null };
      if (entry.result) {
        try {
          const replay = await replayStoredFundedComparison(entry.input, entry.result, options.signal);
          candidate = { ...candidate, status: entry.candidate.status === "failed" ? "verified_with_execution_gaps" : "verified_retrospective",
            reason_code: entry.candidate.reason_code, economics_hash: replay.economics_hash, paths: replay.paths };
        } catch (error) {
          if (options.signal?.aborted) throw error;
          candidate.reason_code = "FUNDED_COMPARISON_REPLAY_FAILED";
        }
      }
      candidates.push(candidate);
    }
    const checked = clock();
    if (assertFundedComparisonBuild() !== implementation) throw new Error("FUNDED_COMPARISON_SOURCE_CHANGED");
    if (checked < now) throw new Error("INVESTOR_INVALID_CLOCK");
    const final = fundedComparisonSnapshot(db, actor, checked);
    // The check time advances, but the underlying private inputs must not.
    const { checked_at: ignoredInitial, ...initialBase } = initial.base, { checked_at: ignoredFinal, ...finalBase } = final.base;
    void ignoredInitial; void ignoredFinal;
    if (hash(initialBase) !== hash(finalBase) || hash(initial.entries) !== hash(final.entries)) {
      return fundedComparisonSchema.parse({ ...final.base, status: "outdated", reason_codes: ["FUNDED_STUDY_BINDING_CHANGED"], candidates: [] });
    }
    const complete = candidates.every(row => row.status === "verified_retrospective");
    return fundedComparisonSchema.parse({ ...final.base, status: complete ? "verified_retrospective" : "partial",
      economics_independently_replayed: complete, reason_codes: complete ? [] : ["FUNDED_COMPARISON_INCOMPLETE"], candidates });
  });
}
