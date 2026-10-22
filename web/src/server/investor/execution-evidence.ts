import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { assertWritableDatabase } from "../workbench-db";
import { audit, canonical, hash, type Actor } from "../ledger/service";
import { MAX_ATTACHMENT_BYTES, readAttachment, storeCsvAttachment, storeJsonAttachment, type AttachmentOptions } from "../ledger/attachments";
import { parseStrictJson } from "../strict-json";
import { getInvestorAccountWorkspace } from "./accounts";
import { assertExecutionScope, getExecutionFollowupContext } from "./execution-followup";
import { executionEvidenceReceiptSchema, executionUploadScopeSchema } from "./execution-followup-schemas";

export function storeInvestorExecutionEvidence(db: Database.Database, actor: Actor, rawScope: unknown,
  upload: { bytes: Uint8Array; media_type: "application/json" | "text/csv"; idempotency_key: string }, now: string, options: AttachmentOptions = {}) {
  const input = executionUploadScopeSchema.parse(rawScope);
  if (!upload.bytes.byteLength || upload.bytes.byteLength > MAX_ATTACHMENT_BYTES || !["application/json", "text/csv"].includes(upload.media_type)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(upload.idempotency_key)) throw new Error("INVESTOR_EXECUTION_UPLOAD_INVALID");
  const bytes = Buffer.from(upload.bytes), contentHash = createHash("sha256").update(bytes).digest("hex");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error("INVESTOR_EXECUTION_UPLOAD_INVALID"); }
  const semantic = { ...input, content_hash: contentHash, byte_size: bytes.byteLength, media_type: upload.media_type }, fingerprint = hash(semantic);
  assertWritableDatabase(db);
  return db.transaction(() => {
    assertWritableDatabase(db);
    const accounts = getInvestorAccountWorkspace(db, actor, now), book = accounts.books.find(row => row.id === input.portfolio_id);
    if (!book || accounts.link?.document.portfolio_id !== book.id || !accounts.accounts.some(row => row.id === input.account_id && row.status !== "disabled"))
      throw new Error("INVESTOR_ACCOUNT_OUT_OF_SCOPE");
    const dedupScope = "investor-execution-upload:" + actor.id;
    const prior = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(dedupScope, upload.idempotency_key) as
      { payload_hash: string; result_json: string } | undefined;
    if (prior) {
      if (prior.payload_hash !== fingerprint) throw new Error("INVESTOR_EXECUTION_UPLOAD_DUPLICATE_CONFLICT");
      const result = executionEvidenceReceiptSchema.parse(parseStrictJson(prior.result_json));
      if (result.workspace_id !== accounts.workspace_id || result.portfolio_id !== input.portfolio_id || result.account_id !== input.account_id
        || result.content_hash !== contentHash || result.byte_size !== bytes.byteLength || result.media_type !== upload.media_type) throw new Error("INVESTOR_EXECUTION_EVIDENCE_INVALID");
      const original = db.prepare("SELECT payload_json FROM audit_events WHERE id=? AND actor_id=? AND portfolio_id=? AND action='investor_store_execution_evidence'")
        .get(result.audit_id, actor.id, book.id) as { payload_json: string } | undefined;
      if (!original || canonical(parseStrictJson(original.payload_json)) !== canonical({ input: semantic, attachment_id: result.attachment_id }))
        throw new Error("INVESTOR_EXECUTION_EVIDENCE_INVALID");
      const proof = readAttachment(db, actor, book.id, result.attachment_id, { ...options, accountId: input.account_id });
      if (proof.attachment.content_hash !== contentHash || proof.attachment.media_type !== upload.media_type || proof.attachment.byte_size !== bytes.byteLength)
        throw new Error("INVESTOR_EXECUTION_EVIDENCE_INVALID");
      assertWritableDatabase(db); return result;
    }
    const context = getExecutionFollowupContext(db, actor, input.account_id, now); assertExecutionScope(context, input);
    if (context.workspace_revision !== input.expected_workspace_revision) throw new Error("INVESTOR_EXECUTION_CONTEXT_CONFLICT");
    if (context.evidence.length >= 50) throw new Error("INVESTOR_EXECUTION_CAPACITY_REQUIRES_REVIEW");
    const attachment = upload.media_type === "text/csv"
      ? storeCsvAttachment(db, actor, { portfolio_id: book.id, account_id: input.account_id, bytes }, { ...options, now })
      : storeJsonAttachment(db, actor, { portfolio_id: book.id, account_id: input.account_id, raw: text }, { ...options, now });
    const auditId = audit(db, actor, "investor_store_execution_evidence", "attachment", attachment.id, book.id, book.ledger_revision,
      { input: semantic, attachment_id: attachment.id }, now);
    const result = executionEvidenceReceiptSchema.parse({ schema_version: "investor-execution-evidence-v1", workspace_id: context.workspace_id,
      portfolio_id: book.id, account_id: input.account_id, attachment_id: attachment.id, content_hash: attachment.content_hash,
      byte_size: attachment.byte_size, media_type: attachment.media_type, audit_id: auditId });
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)")
      .run(dedupScope, upload.idempotency_key, fingerprint, canonical(result), now);
    assertWritableDatabase(db); return result;
  }).immediate();
}
