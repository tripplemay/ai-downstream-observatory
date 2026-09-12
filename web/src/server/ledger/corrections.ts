import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { assertLedgerCommand } from "../contracts";
import { assertWritableDatabase } from "../workbench-db";
import { amount, exact } from "./decimal";
import { isCorporateActionMarker } from "./engine";
import { readJsonAttachment, type AttachmentOptions } from "./attachments";
import { audit, canonical, getActiveLedgerEvents, hash, invalidateAccounts, rebuildProjections, recordFact, revision, validateLedgerTime, type Actor, type LedgerCommand, type LedgerEventRow, type Receipt } from "./service";

type EconomicRecord = Pick<LedgerCommand, "fact" | "effective_at" | "time_precision" | "source_timezone">;
type Anchor = { before_event_id?: string; after_event_id?: string };
export type CorrectionChange =
  | { action: "void"; event_id: string }
  | ({ action: "replace"; event_id: string; replacement: EconomicRecord } & Anchor)
  | ({ action: "insert"; local_id: string; record: EconomicRecord & Pick<LedgerCommand, "source_id" | "source_event_id"> } & Anchor);
export interface CorrectionCommand {
  portfolio_id: string; expected_revision: number; idempotency_key: string; attachment_id: string; reason: string; changes: CorrectionChange[];
}
export interface CorrectionReceipt {
  correction_id: string; start_revision: number; revision: number; audit_id: string;
  reversals: { original_event_id: string; reversal_event_id: string }[];
  replacements: { original_event_id: string; event_id: string }[];
  inserted: { local_id: string; event_id: string }[];
  affected_account_ids: string[]; warnings: string[]; duplicate?: boolean;
}
const id = z.string().min(1).max(200);
const economic = z.object({ fact: z.record(z.unknown()), effective_at: z.string(), time_precision: z.enum(["date", "second"]), source_timezone: z.string() }).strict();
const anchors = { before_event_id: id.optional(), after_event_id: id.optional() };
const correctionSchema = z.object({
  portfolio_id: id, expected_revision: z.number().int().nonnegative(), idempotency_key: id,
  attachment_id: id, reason: z.string().trim().min(1).max(2000),
  changes: z.array(z.discriminatedUnion("action", [
    z.object({ action: z.literal("void"), event_id: id }).strict(),
    z.object({ action: z.literal("replace"), event_id: id, replacement: economic, ...anchors }).strict(),
    z.object({ action: z.literal("insert"), local_id: id, record: economic.extend({ source_id: id, source_event_id: id.optional() }), ...anchors }).strict(),
  ])).min(1).max(100),
}).strict();

interface Node { key: string; command: LedgerCommand; original?: LedgerEventRow; changed: boolean; insertId?: string; anchor?: Anchor }
const timestamp = (node: Node) => Date.parse(node.command.effective_at);

function eventAccounts(db: Database.Database, event: LedgerEventRow): string[] {
  const rows = db.prepare("SELECT account_id FROM postings WHERE event_id=? UNION SELECT account_id FROM position_movements WHERE event_id=? UNION SELECT source_account_id account_id FROM security_transit_movements WHERE event_id=? UNION SELECT target_account_id account_id FROM security_transit_movements WHERE event_id=?").all(event.id, event.id, event.id, event.id) as { account_id: string }[];
  return [event.account_id, ...rows.map(row => row.account_id)];
}

function entrySignature(db: Database.Database, eventId: string): string {
  const event = db.prepare("SELECT payload_json FROM ledger_events WHERE id=?").get(eventId) as { payload_json: string };
  const fact = (JSON.parse(event.payload_json) as LedgerCommand).fact;
  return canonical({
    quality: { tax_status: fact.tax_status, net_status: fact.net_status, action_kind: fact.action_kind, resolution: fact.resolution, supporting_event_ids: fact.supporting_event_ids, evidence_reference: fact.evidence_reference },
    postings: db.prepare("SELECT account_id,currency,ledger_account,amount FROM postings WHERE event_id=? ORDER BY account_id,currency,ledger_account,amount").all(eventId),
    movements: db.prepare("SELECT account_id,listing_id,currency,quantity,cost_amount,cost_known FROM position_movements WHERE event_id=? ORDER BY account_id,listing_id,currency").all(eventId),
    transits: db.prepare("SELECT source_account_id,target_account_id,listing_id,currency,quantity,cost_amount,cost_known FROM security_transit_movements WHERE event_id=? ORDER BY source_account_id,target_account_id,listing_id,quantity,cost_amount").all(eventId),
  });
}

function orderNodes(nodes: Node[], moving: Node[]): Node[] {
  const markers = [...nodes, ...moving].filter(node => isCorporateActionMarker(node.command.fact.type));
  const economicNodes = nodes.filter(node => !isCorporateActionMarker(node.command.fact.type));
  const economicMoving = moving.filter(node => !isCorporateActionMarker(node.command.fact.type));
  if (moving.some(node => isCorporateActionMarker(node.command.fact.type) && (node.anchor?.before_event_id || node.anchor?.after_event_id))) throw new Error("CORRECTION_INVALID_ORDER_ANCHOR");
  const all = [...economicNodes, ...economicMoving];
  const precisions = new Set(all.map(node => node.command.time_precision));
  if (precisions.size > 1) throw new Error("CORRECTION_MIXED_TIME_PRECISION_UNSUPPORTED");
  if (precisions.has("date") && new Set(all.map(node => node.command.source_timezone)).size > 1) throw new Error("CORRECTION_CROSS_TIMEZONE_DATE_UNSUPPORTED");
  const ordered = [...economicNodes].sort((a, b) => timestamp(a) - timestamp(b));
  for (const node of economicMoving) {
    const before = node.anchor?.before_event_id, after = node.anchor?.after_event_id;
    if (before && after) throw new Error("CORRECTION_INVALID_ORDER_ANCHOR");
    const sameTime = ordered.some(other => timestamp(other) === timestamp(node));
    let position: number;
    if (before || after) {
      const anchor = ordered.findIndex(other => other.key === (before ?? after));
      if (anchor < 0 || timestamp(ordered[anchor]) !== timestamp(node)) throw new Error("CORRECTION_INVALID_ORDER_ANCHOR");
      position = anchor + Number(Boolean(after));
    } else {
      if (sameTime) throw new Error("CORRECTION_ORDER_ANCHOR_REQUIRED");
      position = ordered.findIndex(other => timestamp(other) > timestamp(node));
      if (position < 0) position = ordered.length;
    }
    ordered.splice(position, 0, node);
  }
  // Informational dates do not move monetary facts; append markers in dependency order.
  const ready = new Set(ordered.map(node => node.key)), pending = [...markers];
  while (pending.length) {
    const index = pending.findIndex(node => [node.command.fact.related_event_id, ...(node.command.fact.supporting_event_ids ?? [])].every(id => !id || ready.has(id)));
    if (index < 0) throw new Error("CORRECTION_DEPENDENCY_MISSING_OR_LATER");
    const [node] = pending.splice(index, 1); ordered.push(node); ready.add(node.key);
  }
  return ordered;
}

function reverseEvent(db: Database.Database, actor: Actor, original: LedgerEventRow, input: CorrectionCommand, correctionId: string, now: string): string {
  const eventId = randomUUID(), nextRevision = revision(db, input.portfolio_id) + 1;
  const payload = { kind: "ledger_reversal", original_event_id: original.id, original_payload_hash: original.payload_hash, correction_id: correctionId, attachment_id: input.attachment_id, reason: input.reason };
  db.prepare("INSERT INTO ledger_events(id,portfolio_id,account_id,event_type,effective_at,time_precision,source_timezone,recorded_at,source_id,source_event_id,idempotency_key,payload_hash,payload_json,reversal_of,ledger_revision,actor_id,reason,import_batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(eventId, input.portfolio_id, original.account_id, "reversal", original.effective_at, original.time_precision, original.source_timezone, now, `correction:${correctionId}`, original.id, `reversal:${original.id}`, hash(payload), canonical(payload), original.id, nextRevision, actor.id, input.reason, original.import_batch_id);
  const postings = db.prepare("SELECT account_id,currency,ledger_account,amount FROM postings WHERE event_id=?").all(original.id) as { account_id: string; currency: string; ledger_account: string; amount: string }[];
  for (const posting of postings) db.prepare("INSERT INTO postings(id,event_id,account_id,currency,ledger_account,amount) VALUES(?,?,?,?,?,?)")
    .run(randomUUID(), eventId, posting.account_id, posting.currency, posting.ledger_account, exact(amount(posting.amount).neg()));
  const movements = db.prepare("SELECT account_id,listing_id,currency,quantity,cost_amount,cost_known FROM position_movements WHERE event_id=?").all(original.id) as { account_id: string; listing_id: string; currency: string; quantity: string; cost_amount: string; cost_known: number }[];
  for (const movement of movements) db.prepare("INSERT INTO position_movements(id,event_id,account_id,listing_id,quantity,cost_amount,cost_known,currency) VALUES(?,?,?,?,?,?,?,?)")
    .run(randomUUID(), eventId, movement.account_id, movement.listing_id, exact(amount(movement.quantity).neg()), exact(amount(movement.cost_amount).neg()), movement.cost_known, movement.currency);
  const transits = db.prepare("SELECT * FROM security_transit_movements WHERE event_id=?").all(original.id) as { transfer_event_id: string; source_account_id: string; target_account_id: string; listing_id: string; currency: string; quantity: string; cost_amount: string; cost_known: number }[];
  for (const movement of transits) db.prepare("INSERT INTO security_transit_movements(id,event_id,transfer_event_id,source_account_id,target_account_id,listing_id,currency,quantity,cost_amount,cost_known) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), eventId, movement.transfer_event_id, movement.source_account_id, movement.target_account_id, movement.listing_id, movement.currency, exact(amount(movement.quantity).neg()), exact(amount(movement.cost_amount).neg()), movement.cost_known);
  db.prepare("UPDATE ledger_heads SET revision=?,updated_at=? WHERE portfolio_id=?").run(nextRevision, now, input.portfolio_id);
  audit(db, actor, "reverse_fact", "ledger_event", eventId, input.portfolio_id, nextRevision, payload, now);
  return eventId;
}

/** Atomic append-only reversal plus chronological replay. No chronology bypass is exposed. */
export function correctLedger(db: Database.Database, actor: Actor, command: CorrectionCommand, options: AttachmentOptions = {}): CorrectionReceipt {
  if (!actor?.id?.trim()) throw new Error("UNAUTHENTICATED");
  assertWritableDatabase(db);
  const parsed = correctionSchema.safeParse(command);
  if (!parsed.success || !Number.isSafeInteger(command.expected_revision)) throw new Error("INVALID_CORRECTION_COMMAND");
  const input = parsed.data as CorrectionCommand;
  const clock = new Date(options.now ?? new Date().toISOString());
  if (!Number.isFinite(clock.getTime())) throw new Error("INVALID_CLOCK");
  const now = clock.toISOString();
  const { expected_revision: _expected, idempotency_key: _key, ...semantic } = input;
  void _expected; void _key;
  const digest = hash(semantic), scope = `correction:${input.portfolio_id}`;
  return db.transaction(() => {
    assertWritableDatabase(db);
    // Verify the immutable evidence even for a retry; changed files never pass by dedup alone.
    readJsonAttachment(db, actor, input.portfolio_id, input.attachment_id, options);
    const previous = db.prepare("SELECT payload_hash,result_json FROM command_dedup WHERE scope=? AND idempotency_key=?").get(scope, input.idempotency_key) as { payload_hash: string; result_json: string } | undefined;
    if (previous) {
      if (previous.payload_hash !== digest) throw new Error("DUPLICATE_CONFLICT");
      assertWritableDatabase(db);
      return { ...JSON.parse(previous.result_json), duplicate: true } as CorrectionReceipt;
    }
    const startRevision = revision(db, input.portfolio_id);
    if (startRevision !== input.expected_revision) throw new Error("VERSION_CONFLICT");
    const original = getActiveLedgerEvents(db, input.portfolio_id);
    const nodes = new Map(original.map(event => [event.id, { key: event.id, command: JSON.parse(event.payload_json) as LedgerCommand, original: event, changed: false } as Node]));
    const touched = new Set<string>(), affected = new Set<string>(), evidenceAccounts = new Set<string>(), moving: Node[] = [];
    const correctionId = randomUUID();
    for (const change of input.changes) {
      const key = change.action === "insert" ? `insert:${change.local_id}` : change.event_id;
      if (touched.has(key)) throw new Error("CORRECTION_DUPLICATE_TARGET");
      touched.add(key);
      if (change.action === "insert") {
        if (nodes.has(key)) throw new Error("CORRECTION_DUPLICATE_TARGET");
        const record: LedgerCommand = { ...change.record, portfolio_id: input.portfolio_id, expected_revision: startRevision, idempotency_key: `correction:${correctionId}:${moving.length}`, reason: input.reason };
        assertLedgerCommand(record); validateLedgerTime(record, now);
        evidenceAccounts.add(record.fact.account_id);
        if (record.fact.target_account_id) evidenceAccounts.add(record.fact.target_account_id);
        moving.push({ key, command: record, changed: true, insertId: change.local_id, anchor: change });
      } else {
        const node = nodes.get(key);
        if (!node) throw new Error("CORRECTION_EVENT_NOT_ACTIVE");
        for (const account of eventAccounts(db, node.original!)) evidenceAccounts.add(account);
        if (change.action === "void") nodes.delete(key);
        else {
          const old = node.command.fact, replacement = change.replacement.fact;
          if (old.account_id !== replacement.account_id || old.type !== replacement.type || old.currency !== replacement.currency || old.listing_id !== replacement.listing_id) throw new Error("CORRECTION_IDENTITY_CHANGE_UNSUPPORTED");
          const updated = { ...node.command, ...change.replacement, reason: input.reason };
          assertLedgerCommand(updated); validateLedgerTime(updated, now);
          if (replacement.target_account_id) evidenceAccounts.add(replacement.target_account_id);
          const moved = Date.parse(updated.effective_at) !== timestamp(node) || Boolean(change.before_event_id || change.after_event_id);
          node.command = updated; node.changed = true;
          if (moved) { nodes.delete(key); moving.push({ ...node, anchor: change }); }
        }
      }
    }
    for (const accountId of evidenceAccounts) {
      readJsonAttachment(db, actor, input.portfolio_id, input.attachment_id, { ...options, accountId });
      affected.add(accountId);
    }
    const ordered = orderNodes([...nodes.values()], moving);
    let prefix = 0;
    while (prefix < original.length && prefix < ordered.length && original[prefix].id === ordered[prefix].key && !ordered[prefix].changed) prefix++;
    if (original.length - prefix + ordered.length - prefix > 5000) throw new Error("CORRECTION_REPLAY_LIMIT");
    const savedAccounts = db.prepare("SELECT id,status,row_version FROM accounts WHERE portfolio_id=?").all(input.portfolio_id) as { id: string; status: string; row_version: number }[];
    const eventIds = new Map(ordered.map((node, index) => [node.key, index < prefix ? node.key : randomUUID()]));
    // Dependencies must point backwards in the final economic sequence, including explicit inserted references.
    const preceding = new Set<string>();
    for (const node of ordered) {
      if (node.command.fact.related_event_id && !preceding.has(node.command.fact.related_event_id)) throw new Error("CORRECTION_DEPENDENCY_MISSING_OR_LATER");
      if ((node.command.fact.supporting_event_ids ?? []).some(id => !preceding.has(id))) throw new Error("CORRECTION_DEPENDENCY_MISSING_OR_LATER");
      preceding.add(node.key);
    }
    const reversals = original.slice(prefix).reverse().map(event => ({ original_event_id: event.id, reversal_event_id: reverseEvent(db, actor, event, input, correctionId, now) }));
    rebuildProjections(db, actor, input.portfolio_id, now);
    const receipts: Receipt[] = [], replacements: CorrectionReceipt["replacements"] = [], inserted: CorrectionReceipt["inserted"] = [];
    for (const [index, node] of ordered.slice(prefix).entries()) {
      const fact = { ...node.command.fact };
      if (fact.related_event_id) fact.related_event_id = eventIds.get(fact.related_event_id)!;
      if (fact.supporting_event_ids) fact.supporting_event_ids = fact.supporting_event_ids.map(id => eventIds.get(id)!);
      const replay: LedgerCommand = { ...node.command, fact, expected_revision: revision(db, input.portfolio_id), idempotency_key: `correction:${correctionId}:replay:${index}`, reason: input.reason };
      if (node.original) { replay.source_id = `correction:${correctionId}`; replay.source_event_id = node.original.id; }
      const receipt = recordFact(db, actor, replay, now, { eventId: eventIds.get(node.key), correctionId, supersedesEventId: node.original?.id, importBatchId: node.original?.import_batch_id ?? undefined });
      if (receipt.duplicate || receipt.event_id !== eventIds.get(node.key)) throw new Error("CORRECTION_SOURCE_ALREADY_RECORDED");
      receipts.push(receipt);
      if (node.original) {
        replacements.push({ original_event_id: node.original.id, event_id: receipt.event_id });
        if (entrySignature(db, node.original.id) !== entrySignature(db, receipt.event_id)) {
          for (const accountId of eventAccounts(db, node.original)) affected.add(accountId);
          const replacement = db.prepare("SELECT * FROM ledger_events WHERE id=?").get(receipt.event_id) as LedgerEventRow;
          for (const accountId of eventAccounts(db, replacement)) affected.add(accountId);
        }
      } else inserted.push({ local_id: node.insertId!, event_id: receipt.event_id });
    }
    // Unrelated suffix rows may be replayed for chronology, but that is not an account fact change.
    for (const account of savedAccounts) db.prepare("UPDATE accounts SET status=?,row_version=? WHERE id=?").run(account.status, account.row_version, account.id);
    invalidateAccounts(db, affected);
    const finalRevision = revision(db, input.portfolio_id), auditId = randomUUID();
    const result: CorrectionReceipt = { correction_id: correctionId, start_revision: startRevision, revision: finalRevision, audit_id: auditId, reversals, replacements, inserted, affected_account_ids: [...affected].sort(), warnings: [...new Set(receipts.flatMap(receipt => receipt.warnings))] };
    db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,portfolio_id,ledger_revision,payload_json,created_at) VALUES(?,?,'correct_ledger','portfolio',?,?,?,?,?)")
      .run(auditId, actor.id, input.portfolio_id, input.portfolio_id, finalRevision, canonical({ ...result, attachment_id: input.attachment_id, reason: input.reason, changes: input.changes }), now);
    db.prepare("INSERT INTO command_dedup(scope,idempotency_key,payload_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(scope, input.idempotency_key, digest, canonical(result), now);
    assertWritableDatabase(db);
    return result;
  }).immediate();
}
