import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { audit, canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { readVerificationRequest, verificationInstant, evidenceInvalid, type VerificationRequestRow } from "./binding";
import { verificationCommandSchema, verificationQuerySchema } from "./schemas";
import { currentVerificationSource, verificationContext } from "./source";
import { verifiedExecution } from "./proof";
import { VERIFICATION_CHECK_ID, VERIFICATION_SUITE_VERSION, type VerificationActor, type VerificationOptions, type VerificationReceipt, type VerificationQuery, type VerificationRequestView, type VerificationState } from "./types";

const clientErrors = new Set(["VERIFICATION_COMMAND_INVALID", "VERIFICATION_QUERY_INVALID", "VERIFICATION_CURSOR_INVALID", "VERIFICATION_CLOCK_INVALID", "VERIFICATION_PERMISSION_DENIED",
  "VERIFICATION_PORTFOLIO_NOT_FOUND", "VERIFICATION_REQUEST_NOT_FOUND", "VERIFICATION_ARTIFACT_NOT_FOUND", "VERIFICATION_CONTEXT_CHANGED", "VERIFICATION_IDEMPOTENCY_CONFLICT",
  "VERIFICATION_EVIDENCE_INVALID", "VERIFICATION_SOURCE_UNAVAILABLE", "VERIFICATION_RESPONSE_TOO_LARGE"]);
export const isVerificationClientError = (code: string): boolean => clientErrors.has(code);
function now(options: VerificationOptions): string {
  try { return verificationInstant(options.now ?? new Date().toISOString()); } catch { throw new Error("VERIFICATION_CLOCK_INVALID"); }
}
function human(actor: VerificationActor): void {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  if (actor.kind !== "human" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(actor.id) || /^system(?::|$)/iu.test(actor.id)) throw new Error("VERIFICATION_PERMISSION_DENIED");
}
function readonly(db: Database.Database): boolean {
  try { assertWritableDatabase(db); return false; } catch (error) { if (error instanceof Error && error.message === "WORKBENCH_READ_ONLY") return true; throw error; }
}
export function requestVerification(db: Database.Database, actor: VerificationActor, raw: unknown, options: VerificationOptions = {}): VerificationReceipt {
  human(actor); assertWritableDatabase(db);
  const parsed = verificationCommandSchema.safeParse(raw); if (!parsed.success) throw new Error("VERIFICATION_COMMAND_INVALID");
  const input = parsed.data, stamp = now(options), scope = `verification-v2:${input.portfolio_id}`, digest = hash({ actor_id: actor.id, input });
  return db.transaction(() => {
    assertWritableDatabase(db);
    if (!db.prepare("SELECT 1 FROM portfolios WHERE id=?").get(input.portfolio_id)) throw new Error("VERIFICATION_PORTFOLIO_NOT_FOUND");
    const prior = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== digest) throw new Error("VERIFICATION_IDEMPOTENCY_CONFLICT");
      const receipt = parseStrictJson(prior.result_json) as VerificationReceipt;
      const binding = readVerificationRequest(db, input.portfolio_id, receipt.request_id);
      const expected = { request_id: binding.row.id, check_id: VERIFICATION_CHECK_ID, context_hash: binding.row.context_hash, status: "queued" as const };
      if (canonical(receipt) !== canonical(expected) || binding.row.requested_by !== actor.id || canonical(binding.input) !== canonical(input)) throw evidenceInvalid();
      return expected;
    }
    const context = verificationContext(input.portfolio_id, options.sourceRoot), contextHash = hash(context);
    if (contextHash !== input.expected_context_hash) throw new Error("VERIFICATION_CONTEXT_CHANGED");
    const id = randomUUID(), payload = { schema_version: "verification-request-v2", verification_request_id: id, portfolio_id: input.portfolio_id, check_id: input.check_id, context_hash: contextHash };
    const receipt: VerificationReceipt = { request_id: id, check_id: input.check_id, context_hash: contextHash, status: "queued" };
    db.prepare("INSERT INTO command_requests(id,portfolio_id,command_type,idempotency_key,payload_hash,payload_json,actor_id,created_at) VALUES(?,?,'governance_verification_v2',?,?,?,'system:governance-verifier-v2',?)")
      .run(id, input.portfolio_id, input.idempotency_key, hash(payload), canonical(payload), stamp);
    const auditId = audit(db, actor, "request_verification", "verification_request", id, input.portfolio_id, null, { actor_kind: "human", input, result: receipt }, stamp);
    db.prepare("INSERT INTO verification_requests(id,portfolio_id,check_id,context_json,context_hash,requested_by,audit_id,requested_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, input.portfolio_id, input.check_id, canonical(context), contextHash, actor.id, auditId, stamp);
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, input.idempotency_key, digest, canonical(receipt), stamp);
    if (hash(currentVerificationSource(options.sourceRoot)) !== context.source_manifest_hash) throw new Error("VERIFICATION_CONTEXT_CHANGED");
    readVerificationRequest(db, input.portfolio_id, id); assertWritableDatabase(db); return receipt;
  }).immediate();
}
function cursorValue(raw: string, portfolio: string): { at: string; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(raw)) throw new Error("encoding");
    const bytes = Buffer.from(raw, "base64url"); if (bytes.toString("base64url") !== raw) throw new Error("encoding");
    const value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { portfolio: string; at: string; id: string };
    if (canonical(Object.keys(value).sort()) !== canonical(["at", "id", "portfolio"]) || value.portfolio !== portfolio
      || value.at !== verificationInstant(value.at) || typeof value.id !== "string" || !value.id || value.id.length > 200) throw new Error("shape");
    return value;
  } catch { throw new Error("VERIFICATION_CURSOR_INVALID"); }
}
export function getVerificationState(db: Database.Database, raw: VerificationQuery = {}, options: VerificationOptions = {}): VerificationState {
  const parsed = verificationQuerySchema.safeParse(raw); if (!parsed.success) throw new Error("VERIFICATION_QUERY_INVALID");
  const query = parsed.data, clock = now(options);
  return db.transaction(() => {
    const portfolios = db.prepare("SELECT id,name,base_currency FROM portfolios ORDER BY created_at,id LIMIT 1001").all() as VerificationState["portfolios"];
    if (portfolios.length > 1000) throw new Error("VERIFICATION_RESPONSE_TOO_LARGE");
    const selected = query.portfolio ?? portfolios[0]?.id ?? null;
    if (selected && !portfolios.some(p => p.id === selected)) throw new Error("VERIFICATION_PORTFOLIO_NOT_FOUND");
    const state: VerificationState = { portfolios, selected_portfolio_id: selected, read_only: readonly(db), check: { id: VERIFICATION_CHECK_ID, suite_version: VERIFICATION_SUITE_VERSION,
      acceptance_scope: "engineering_subcheck", data_provenance: "synthetic", gate_eligible: false, available: false, context_hash: null, issues: [] }, requests: [], next_cursor: null };
    if (!selected) { if (query.cursor || query.request) throw new Error("VERIFICATION_QUERY_INVALID"); return state; }
    let currentSourceHash: string | null = null;
    try { const context = verificationContext(selected, options.sourceRoot); state.check.context_hash = hash(context); state.check.available = true; currentSourceHash = context.source_manifest_hash; }
    catch { state.check.issues = ["VERIFICATION_SOURCE_UNAVAILABLE"]; }
    const limit = query.limit ?? 20, cursor = query.cursor ? cursorValue(query.cursor, selected) : null;
    const rows = (query.request
      ? db.prepare("SELECT * FROM verification_requests WHERE portfolio_id=? AND id=?").all(selected, query.request)
      : db.prepare(`SELECT * FROM verification_requests WHERE portfolio_id=? ${cursor ? "AND (requested_at<? OR (requested_at=? AND id<?))" : ""} ORDER BY requested_at DESC,id DESC LIMIT ?`)
        .all(selected, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), limit + 1)) as VerificationRequestRow[];
    if (query.request && rows.length !== 1) throw new Error("VERIFICATION_REQUEST_NOT_FOUND");
    for (const row of rows.slice(0, limit)) {
      const view: VerificationRequestView = { id: row.id, check_id: VERIFICATION_CHECK_ID, requested_at: row.requested_at, requested_by: row.requested_by,
        context_hash: row.context_hash, job_status: "queued", execution: null, evidence_issues: [] };
      try {
        readVerificationRequest(db, selected, row.id);
        const jobs = db.prepare("SELECT id,status FROM job_runs WHERE command_request_id=? ORDER BY id").all(row.id) as { id: string; status: string }[];
        if (jobs.length > 1) throw evidenceInvalid();
        const job = jobs[0]; view.job_status = job?.status ?? "queued";
        const execution = db.prepare("SELECT id FROM verification_executions WHERE request_id=?").get(row.id) as { id: string } | undefined;
        if (execution) view.execution = verifiedExecution(db, selected, execution.id, clock, currentSourceHash).view;
        else if (job?.status === "succeeded") throw evidenceInvalid();
        else if (job && ["failed", "skipped", "partial"].includes(job.status)) view.evidence_issues = ["VERIFICATION_JOB_DID_NOT_PRODUCE_VERIFIED_EVIDENCE"];
      } catch { view.execution = null; view.evidence_issues = ["VERIFICATION_EVIDENCE_INVALID"]; }
      state.requests.push(view);
    }
    if (rows.length > limit) { const last = rows[limit - 1]; state.next_cursor = Buffer.from(canonical({ portfolio: selected, at: last.requested_at, id: last.id })).toString("base64url"); }
    if (Buffer.byteLength(canonical(state), "utf8") > 2 * 1024 * 1024) throw new Error("VERIFICATION_RESPONSE_TOO_LARGE");
    return state;
  })();
}
export function readVerificationArtifact(db: Database.Database, portfolio: string, artifactId: string, options: VerificationOptions = {}): { id: string; body: Buffer; sha256: string } {
  if (![portfolio, artifactId].every(value => typeof value === "string" && value.length > 0 && value.length <= 200)) throw new Error("VERIFICATION_QUERY_INVALID");
  return db.transaction(() => {
    const row = db.prepare("SELECT e.id FROM verification_executions e JOIN verification_requests r ON r.id=e.request_id WHERE r.portfolio_id=? AND e.artifact_id=?").get(portfolio, artifactId) as { id: string } | undefined;
    if (!row) throw new Error("VERIFICATION_ARTIFACT_NOT_FOUND");
    const proof = verifiedExecution(db, portfolio, row.id, now(options), null);
    return { id: artifactId, body: proof.body, sha256: proof.view.artifact_sha256 };
  })();
}
