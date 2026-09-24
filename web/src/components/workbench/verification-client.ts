import { z } from "zod";
import { verificationCommandSchema } from "@/server/verifications/schemas";
import { VERIFICATION_CHECK_ID, VERIFICATION_SUITE_VERSION, type VerificationCommand, type VerificationReceipt, type VerificationState } from "@/server/verifications/types";

const id = z.string().min(1).max(200), digest = z.string().regex(/^[a-f0-9]{64}$/), stamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/);
const issues = z.array(z.string().min(1).max(200)).max(100), status = z.enum(["pass", "fail", "blocked"]);
const result = z.object({ schema_version: z.literal("verification-check-result-v2"), check_id: z.literal(VERIFICATION_CHECK_ID), status,
  issues, assertions: z.array(z.object({ id, status }).strict()).max(100), gate_eligible: z.literal(false), completed_requirements: z.tuple([]) }).strict();
const execution = z.object({ id, status, artifact_id: id, artifact_sha256: digest, result_hash: digest, result,
  started_at: stamp, finished_at: stamp, attempt: z.number().int().positive(), execution_authority: z.literal("controlled_runner"),
  data_provenance: z.literal("synthetic"), acceptance_scope: z.literal("engineering_subcheck"), current_runtime_match: z.boolean().nullable() }).strict();
const request = z.object({ id, check_id: z.literal(VERIFICATION_CHECK_ID), requested_at: stamp, requested_by: id, context_hash: digest,
  job_status: z.string().min(1).max(100), execution: execution.nullable(), evidence_issues: issues }).strict();
const state = z.object({ portfolios: z.array(z.object({ id, name: z.string().max(200), base_currency: z.string().min(1).max(16) }).strict()).max(1000),
  selected_portfolio_id: id.nullable(), read_only: z.boolean(), check: z.object({ id: z.literal(VERIFICATION_CHECK_ID), suite_version: z.literal(VERIFICATION_SUITE_VERSION),
    acceptance_scope: z.literal("engineering_subcheck"), data_provenance: z.literal("synthetic"), gate_eligible: z.literal(false), available: z.boolean(), context_hash: digest.nullable(), issues }).strict(),
  requests: z.array(request).max(50), next_cursor: z.string().min(1).max(1024).nullable(), session_binding: digest }).strict();
const receipt = z.object({ request_id: id, check_id: z.literal(VERIFICATION_CHECK_ID), context_hash: digest, status: z.literal("queued"), session_binding: digest }).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function hash(value: unknown) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function assertVerificationState(value: unknown, portfolio: string | null, selectedRequest: string | null, binding: string): Promise<VerificationState> {
  const parsed = state.safeParse(value); if (!parsed.success) throw new Error("VERIFICATION_RESPONSE_INVALID");
  const body = parsed.data;
  if (body.session_binding !== binding || portfolio !== null && body.selected_portfolio_id !== portfolio
    || body.selected_portfolio_id !== null && !body.portfolios.some(row => row.id === body.selected_portfolio_id)
    || new Set(body.portfolios.map(row => row.id)).size !== body.portfolios.length || new Set(body.requests.map(row => row.id)).size !== body.requests.length
    || selectedRequest !== null && (body.requests.length !== 1 || body.requests[0].id !== selectedRequest || body.next_cursor !== null)
    || body.check.available && body.check.context_hash === null
    || body.selected_portfolio_id === null && body.requests.length !== 0) throw new Error("VERIFICATION_RESPONSE_INVALID");
  for (const row of body.requests) {
    if (row.execution && (row.execution.status !== row.execution.result.status || await hash(row.execution.result) !== row.execution.result_hash)) throw new Error("VERIFICATION_RESPONSE_INVALID");
  }
  return body;
}
export interface VerificationPending { portfolio: string; binding: string; contextHash: string; command: VerificationCommand; body: string }
export function prepareVerificationRequest(data: VerificationState, reason: string, binding: string, key: string): VerificationPending {
  if (data.read_only || !data.selected_portfolio_id || !data.check.available || !data.check.context_hash || !digest.safeParse(binding).success) throw new Error("VERIFICATION_WRITE_LOCKED");
  const parsed = verificationCommandSchema.safeParse({ portfolio_id: data.selected_portfolio_id, check_id: data.check.id,
    expected_context_hash: data.check.context_hash, reason, idempotency_key: key });
  if (!parsed.success) throw new Error("VERIFICATION_COMMAND_INVALID");
  return { portfolio: parsed.data.portfolio_id, binding, contextHash: parsed.data.expected_context_hash, command: parsed.data, body: JSON.stringify({ command: parsed.data }) };
}
export function assertVerificationReceipt(value: unknown, pending: VerificationPending): VerificationReceipt {
  const parsed = receipt.safeParse(value); if (!parsed.success || parsed.data.session_binding !== pending.binding
    || parsed.data.check_id !== pending.command.check_id || parsed.data.context_hash !== pending.contextHash) throw new Error("VERIFICATION_RESPONSE_INVALID");
  return parsed.data;
}

export async function readVerificationArtifact(response: Response, expectedHash: string, binding: string): Promise<Blob> {
  if (response.status !== 200 || !digest.safeParse(expectedHash).success || response.headers.get("x-workbench-session-binding") !== binding
    || response.headers.get("x-artifact-sha256") !== expectedHash || response.headers.get("content-type") !== "application/octet-stream"
    || response.headers.get("x-content-type-options") !== "nosniff"
    || response.headers.get("content-disposition") !== 'attachment; filename="verification-artifact.json"') throw new Error("VERIFICATION_ARTIFACT_INVALID");
  const maximum = 1048576, declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error("VERIFICATION_ARTIFACT_INVALID");
  const reader = response.body?.getReader(); if (!reader) throw new Error("VERIFICATION_ARTIFACT_INVALID");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break; length += value.byteLength;
      if (length > maximum) { void reader.cancel().catch(() => {}); throw new Error("VERIFICATION_ARTIFACT_INVALID"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== expectedHash) throw new Error("VERIFICATION_ARTIFACT_INVALID");
    return new Blob([bytes], { type: "application/octet-stream" });
  } catch { throw new Error("VERIFICATION_ARTIFACT_INVALID"); }
  finally { reader.releaseLock(); }
}
