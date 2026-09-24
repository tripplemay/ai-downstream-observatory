import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { verificationCommandSchema } from "./schemas";
import { parseVerificationContext } from "./source";
import { VERIFICATION_CHECK_ID, type VerificationCommand, type VerificationContext } from "./types";

export interface VerificationRequestRow {
  id: string; portfolio_id: string; check_id: string; context_json: string; context_hash: string;
  requested_by: string; audit_id: string; requested_at: string;
}
export const evidenceInvalid = (): Error => new Error("VERIFICATION_EVIDENCE_INVALID");
export function verificationInstant(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/u.exec(value);
  if (!match) throw evidenceInvalid();
  const date = new Date(`${match[1]}.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== match[1]) throw evidenceInvalid();
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
}
export function readVerificationRequest(db: Database.Database, portfolio: string, requestId: string): { row: VerificationRequestRow; context: VerificationContext; input: VerificationCommand } {
  const row = db.prepare("SELECT * FROM verification_requests WHERE id=? AND portfolio_id=?").get(requestId, portfolio) as VerificationRequestRow | undefined;
  if (!row) throw new Error("VERIFICATION_REQUEST_NOT_FOUND");
  try {
    const context = parseVerificationContext(row.context_json);
    if (row.context_json !== canonical(context) || hash(context) !== row.context_hash || row.check_id !== VERIFICATION_CHECK_ID
      || context.portfolio_id !== portfolio || context.check_id !== row.check_id || row.requested_at !== verificationInstant(row.requested_at)
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u.test(row.requested_by) || /^system(?::|$)/iu.test(row.requested_by)) throw evidenceInvalid();
    const command = db.prepare("SELECT * FROM command_requests WHERE id=?").get(row.id) as { portfolio_id: string; command_type: string; payload_json: string; payload_hash: string; actor_id: string; created_at: string; idempotency_key: string } | undefined;
    const payload = { schema_version: "verification-request-v2", verification_request_id: row.id, portfolio_id: portfolio, check_id: row.check_id, context_hash: row.context_hash };
    if (!command || command.command_type !== "governance_verification_v2" || command.portfolio_id !== portfolio || command.actor_id !== "system:governance-verifier-v2"
      || command.created_at !== row.requested_at || command.payload_json !== canonical(payload) || command.payload_hash !== hash(payload)) throw evidenceInvalid();
    const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as { actor_id: string; action: string; object_type: string; object_id: string; portfolio_id: string; created_at: string; payload_json: string; ledger_revision: number | null } | undefined;
    if (!audit || audit.actor_id !== row.requested_by || audit.action !== "request_verification" || audit.object_type !== "verification_request"
      || audit.object_id !== row.id || audit.portfolio_id !== portfolio || audit.created_at !== row.requested_at || audit.ledger_revision !== null) throw evidenceInvalid();
    const proof = parseStrictJson(audit.payload_json) as { actor_kind: string; input: unknown; result: unknown };
    const input = verificationCommandSchema.parse(proof.input);
    const result = { request_id: row.id, check_id: row.check_id, context_hash: row.context_hash, status: "queued" };
    if (canonical(proof) !== canonical({ actor_kind: "human", input, result }) || proof.actor_kind !== "human"
      || input.portfolio_id !== portfolio || input.check_id !== row.check_id || input.expected_context_hash !== row.context_hash
      || input.idempotency_key !== command.idempotency_key) throw evidenceInvalid();
    return { row, context, input };
  } catch { throw evidenceInvalid(); }
}
