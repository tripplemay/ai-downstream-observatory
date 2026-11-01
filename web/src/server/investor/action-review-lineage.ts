import type Database from "better-sqlite3";
import Decimal from "decimal.js";
import { canonical, hash } from "../ledger/service";
import { amount } from "../ledger/decimal";
import { priceInstant as time } from "../market-price-source";
import { actionCheck as check, actionNyParts, actionObject as object, actionText as text } from "./action-source-parsers";
import type { ActionObject as Obj } from "./action-source-parsers";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { checkActionReportAgreement, checkReviewedActionAppend, type ActionSnapshot } from "./action-maintenance-candidate";
import { readManagedActionAnchorContext, readManagedActionComparisonBasis, readManagedActionControlWitness, readManagedActionCurrentCaptures } from "./managed-action-source";
import { validateInvestorActionReviewDocument } from "./kernel-contracts";
import { actionReviewViewSchema } from "./action-review-schemas";
import { actionAddDays } from "./action-source-parsers";
import type { VerifiedSourceReview } from "./source-inputs";

const Exact = Decimal.clone({ precision: 128, rounding: Decimal.ROUND_HALF_EVEN });
const kinds = ["issuer", "dividends", "splits"] as const;
const fields = {
  issuer: ["ex_date", "issuer_type_code", "distribution_amount", "record_date", "pay_date"],
  dividends: ["date", "value", "unadjusted_value", "reported_currency", "declaration_date", "record_date", "payment_date", "reported_period"],
  splits: ["date", "numerator", "denominator"],
};
const cmp = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const millis = (value: bigint) => new Date(Number(value / 1000n)).toISOString();
function owner(db: Database.Database, workspace: string, actor: unknown) {
  const row = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
  check(row && row.owner_id === actor);
}
function previewHeader(db: Database.Database, workspace: string, actor: unknown, id: unknown, now: string) {
  owner(db, workspace, actor);
  const row = actionRead(db, "investor_action_review_previews", id, workspace), doc = actionJson(row.document_json);
  validateInvestorActionReviewDocument("preview", doc);
  check(canonical(doc) === row.document_json && hash(doc) === row.content_hash && row.actor_id === actor && doc.preview_id === row.id);
  for (const key of ["workspace_id", "workspace_revision", "authority_id", "control_id", "request_hash", "created_at", "valid_until"]) check(doc[key] === row[key]);
  check(time(doc.checked_at) <= time(row.created_at) && time(row.created_at) < time(row.valid_until) && time(row.created_at) <= time(now)
    && time(row.valid_until) - time(doc.checked_at) <= (doc.validity_policy === "owner_review_15m" ? 900000000n : 60000000n)
    && Number.isSafeInteger(row.workspace_revision) && Number(row.workspace_revision) > 0
    && doc.request_hash === hash({ authority_id: row.authority_id, expected_revision: Number(row.workspace_revision) - 1, idempotency_key: row.idempotency_key }));
  actionAudit(db, workspace, row, "investor_preview_action_review", "investor_action_review_preview");
  return doc;
}

/** Authenticated metadata only; this does not replay or approve source facts. */
export function readActionReviewPreviewWitness(db: Database.Database, workspace: string, actor: unknown, id: unknown, now: string) {
  return db.transaction(() => previewHeader(db, workspace, actor, id, now)).deferred();
}
function confirmationHeader(db: Database.Database, workspace: string, actor: unknown, id: unknown, now: string) {
  owner(db, workspace, actor);
  const row = actionRead(db, "investor_action_review_confirmations", id, workspace), doc = actionJson(row.document_json, 1048576);
  validateInvestorActionReviewDocument("confirmation", doc);
  check(canonical(doc) === row.document_json && hash(doc) === row.content_hash && row.actor_id === actor && doc.confirmation_id === row.id);
  for (const key of ["workspace_id", "workspace_revision", "preview_id", "previous_authority_id", "new_authority_id", "new_review_id", "request_hash", "created_at"]) check(doc[key] === row[key]);
  const request = object(doc.request), preview = previewHeader(db, workspace, actor, row.preview_id, now);
  check(hash(request) === row.request_hash && request.idempotency_key === row.idempotency_key && request.preview_id === row.preview_id
    && Number.isSafeInteger(row.workspace_revision) && Number(row.workspace_revision) > 0
    && request.expected_revision === Number(row.workspace_revision) - 1 && request.expected_revision === preview.workspace_revision
    && preview.authority_id === doc.previous_authority_id && preview.authority_hash === doc.previous_authority_hash && preview.draft_basis_hash === doc.draft_basis_hash
    && preview.control_id === doc.previous_control_id && preview.control_hash === doc.previous_control_hash
    && time(preview.created_at) <= time(row.created_at) && time(row.created_at) < time(preview.valid_until) && time(row.created_at) <= time(now));
  actionAudit(db, workspace, row, "investor_confirm_action_review", "investor_action_review_confirmation");
  return { row, doc, request };
}

/** Historical registration receipt, not current economic/source qualification. */
export function readActionReviewConfirmationReceipt(db: Database.Database, workspace: string, actor: unknown, id: unknown, now: string) {
  return db.transaction(() => confirmationHeader(db, workspace, actor, id, now).doc).deferred();
}
function changes(previous: ActionSnapshot, current: ActionSnapshot, coverageEnd: string, commonEnd: string) {
  const index = (snapshot: ActionSnapshot) => Object.fromEntries(kinds.map(kind => {
    const groups = new Map<string, Obj[]>();
    for (const row of snapshot[kind].records) {
      const day = text(row[kind === "issuer" ? "ex_date" : "date"]);
      const projected = { ...Object.fromEntries(fields[kind].map(key => [key, row[key]])), record_hash: hash(row) };
      groups.set(day, [...(groups.get(day) ?? []), projected]);
    }
    for (const rows of groups.values()) rows.sort((a, b) => cmp(text(a.record_hash), text(b.record_hash)));
    return [kind, groups];
  })) as Record<typeof kinds[number], Map<string, Obj[]>>;
  const before = index(previous), after = index(current), days = new Set(kinds.flatMap(kind => [...before[kind].keys(), ...after[kind].keys()]));
  const result: Obj[] = [];
  for (const day of [...days].sort()) {
    const historical = day <= coverageEnd, prior: Obj = {}, next: Obj = {};
    for (const kind of kinds) {
      const a = previous[kind].source, b = current[kind].source;
      const inside = [text(a.range_start), text(b.range_start)].sort().at(-1)! <= day
        && day <= [text(a.range_end), text(b.range_end), coverageEnd].sort()[0];
      prior[kind] = historical && inside ? before[kind].get(day) ?? [] : [];
      next[kind] = !historical || inside ? after[kind].get(day) ?? [] : [];
    }
    if (hash(prior) !== hash(next)) result.push({ date: day, disposition: historical ? "historical_correction" : "new_report",
      outside_common_coverage: day > commonEnd, previous: prior, current: next, effective_at: null, payment_at: null, tax_per_unit: null });
  }
  check(result.length <= 4096); return result;
}
function expectedFacts(previous: Obj, current: ActionSnapshot, request: Obj, previewId: unknown, floor: string) {
  const facts = structuredClone(previous), oldEnd = text(facts.range_end);
  facts.range_end = kinds.map(kind => text(current[kind].source.range_end)).sort()[0];
  const issuer = new Map<string, Obj[]>(), splits = new Map<string, Obj>();
  for (const row of current.issuer.records) if (text(row.ex_date) > oldEnd) issuer.set(text(row.ex_date), [...(issuer.get(text(row.ex_date)) ?? []), row]);
  for (const row of current.splits.records) if (text(row.date) > oldEnd) { check(!splits.has(text(row.date))); splits.set(text(row.date), row); }
  const key = (kind: unknown, day: unknown) => canonical([kind, day]);
  const expected = new Set([...issuer.keys()].map(day => key("dividend", day)).concat([...splits.keys()].map(day => key("split", day))));
  check(Array.isArray(request.new_events)); const answers = request.new_events as Obj[];
  check(answers.length === expected.size && new Set(answers.map(row => key(row.type, row.date))).size === answers.length);
  const added: Obj[] = [];
  for (const answer of answers) {
    check(expected.has(key(answer.type, answer.date)) && actionNyParts(answer.at).day === answer.date);
    const event: Obj = { id: "reviewed-action:" + hash({ preview_id: previewId, type: answer.type, date: answer.date }),
      listing_id: facts.listing_id, type: answer.type, at: answer.at, published_at: floor, source_evidence: "explicit-owner-review:" + text(previewId) };
    if (answer.type === "dividend") {
      const gross = issuer.get(text(answer.date))!.reduce((sum, row) => sum.plus(new Exact(text(row.distribution_amount))), new Exact(0));
      const value = gross.isZero() ? "0" : gross.toFixed(); amount(value); amount(answer.tax_per_unit); time(answer.pay_at);
      Object.assign(event, { gross_per_unit: value, tax_per_unit: answer.tax_per_unit, pay_at: answer.pay_at });
    } else {
      const source = splits.get(text(answer.date))!, numerator = new Exact(text(source.numerator)), denominator = new Exact(text(source.denominator));
      const ratio = numerator.div(denominator); check(ratio.times(denominator).eq(numerator));
      event.ratio = ratio.isZero() ? "0" : ratio.toFixed(); amount(event.ratio);
    }
    added.push(event);
  }
  added.sort((a, b) => time(a.at) < time(b.at) ? -1 : time(a.at) > time(b.at) ? 1 : cmp(text(a.type), text(b.type)) || cmp(text(a.id), text(b.id)));
  check(Array.isArray(facts.events)); facts.events = [...facts.events, ...added]; return facts;
}

function verifiedConfirmation(db: Database.Database, workspace: string, actor: unknown, id: unknown, now: string) {
  const { doc, request } = confirmationHeader(db, workspace, actor, id, now);
  const before = readManagedActionComparisonBasis(db, workspace, doc.previous_authority_id, now);
  const after = readManagedActionAnchorContext(db, workspace, doc.new_authority_id, now);
  const old = before.grant, next = after.grant;
  check(old.row.id !== next.row.id && old.row.content_hash === doc.previous_authority_hash && next.row.content_hash === doc.new_authority_hash
    && old.current.enabled === 0 && next.doc.base_review_id === doc.new_review_id);
  for (const key of ["listing_id", "provider_symbol", "listing_review_id", "listing_review_hash"]) check(old.doc[key] === next.doc[key]);
  const original = readManagedActionControlWitness(db, workspace, old.row.id, doc.previous_control_id, now);
  const retired = readManagedActionControlWitness(db, workspace, old.row.id, doc.retired_control_id, now);
  const initialId = object(db.prepare("SELECT id FROM investor_action_controls WHERE authority_id=? AND version=1").get(next.row.id)).id;
  const initial = readManagedActionControlWitness(db, workspace, next.row.id, initialId, now);
  const selected = readManagedActionControlWitness(db, workspace, next.row.id, doc.new_control_id, now);
  check(original.content_hash === doc.previous_control_hash && retired.content_hash === doc.retired_control_hash && retired.enabled === 0
    && retired.version === Number(original.version) + Number(!!original.enabled) && time(original.created_at) <= time(retired.created_at)
    && time(retired.created_at) <= time(doc.created_at) && initial.enabled === 0 && initial.created_at === doc.created_at
    && selected.created_at === doc.created_at && next.row.created_at === doc.created_at && selected.content_hash === doc.new_control_hash
    && selected.enabled === Number(request.enable_rule) && selected.version === (request.enable_rule ? 2 : 1));
  check(after.base.row.id === doc.new_review_id && after.base.row.content_hash === doc.new_review_hash
    && after.base.row.created_at === doc.created_at && after.base.source.created_at === doc.created_at && after.base.source.id !== before.base.source.id
    && before.publicationId === doc.previous_publication_id && before.prior.row.id === doc.previous_review_id && before.prior.row.content_hash === doc.previous_review_hash
    && time(before.prior.row.created_at) <= time(doc.created_at) && time(old.row.created_at) <= time(doc.created_at));
  for (const kind of kinds) for (const field of ["authority_id", "authority_hash", "control_id", "control_hash"])
    check(object(before.anchor.bindings[kind])[field] === object(after.anchor.bindings[kind])[field]);
  const receipts = Object.values(after.anchor.values).flatMap(value => [text(value.row.created_at), text(value.draft.source.retrieved_at)]);
  const floor = receipts.reduce((a, b) => time(a) >= time(b) ? a : b);
  const maximum = millis([old.doc.valid_until, ...before.limits, ...after.limits, ...before.historicalLimits].map(time).reduce((a, b) => a < b ? a : b));
  check(next.doc.valid_from === doc.created_at && next.doc.valid_until === maximum && after.base.row.valid_until === maximum);
  const facts = expectedFacts(before.prior.facts, after.anchor.snapshots, request, doc.preview_id, floor);
  check(hash(facts) === hash(after.base.facts));
  const proof = checkReviewedActionAppend(before.prior.facts, facts, before.previous, after.anchor.snapshots,
    text(old.doc.provider_symbol), text(old.doc.listing_id), floor, text(doc.created_at));
  check(hash(proof) === hash(doc.append_proof));
  const basis = { workspace, owner: actor, authority_id: old.row.id, authority_hash: old.row.content_hash, control_id: original.id, control_hash: original.content_hash,
    publication_id: before.publicationId, previous_review_hash: before.prior.row.content_hash, previous_facts_hash: hash(before.prior.facts),
    previous_snapshot_hash: hash(before.previous), current_snapshot_hash: hash(after.anchor.snapshots), current_bindings: after.anchor.bindings,
    changes: changes(before.previous, after.anchor.snapshots, text(before.prior.facts.range_end), text(facts.range_end)), knowledge_not_before: floor, maximum_valid_until: maximum };
  check(hash(basis) === doc.draft_basis_hash);
  return { document: doc, before: before.base, after: after.base };
}

/** Current qualified replay, never historical receipt recovery or monitor admission. */
export function readActionReviewConfirmation(db: Database.Database, workspace: string, actor: unknown, id: unknown, now: string) {
  return db.transaction(() => verifiedConfirmation(db, workspace, actor, id, now).document).deferred();
}

/** Internal normal-resolver input; equal amounts alone never inherit knowledge. */
function eventOrigins(db: Database.Database, workspace: string, review: VerifiedSourceReview, now: string, seen: Set<string>): Map<string, Obj> {
  check(seen.size < 256 && !seen.has(review.row.id)); const visited = new Set(seen); visited.add(review.row.id);
  const row = db.prepare("SELECT id FROM investor_action_review_confirmations WHERE workspace_id=? AND new_review_id=?").get(workspace, review.row.id) as Obj | undefined;
  check(Array.isArray(review.facts.events)); const events = review.facts.events as Obj[];
  if (!row) return new Map(events.map(event => [text(event.id), { original_review_id: review.row.id, original_review_hash: review.row.content_hash, known_at: review.row.created_at }]));
  const value = verifiedConfirmation(db, workspace, review.row.actor_id, row.id, now);
  check(value.after.row.id === review.row.id && value.after.row.content_hash === review.row.content_hash && hash(value.after.facts) === hash(review.facts));
  const origins = eventOrigins(db, workspace, value.before, now, visited);
  for (const event of events) if (!origins.has(text(event.id))) origins.set(text(event.id), {
    original_review_id: review.row.id, original_review_hash: review.row.content_hash, known_at: value.document.created_at });
  check(origins.size === events.length && events.every(event => origins.has(text(event.id)))); return origins;
}

export function confirmedEventOrigins(db: Database.Database, workspace: string, review: VerifiedSourceReview, now: string) {
  return db.transaction(() => eventOrigins(db, workspace, review, now, new Set())).deferred();
}

/** Current private view, independently rebuilt; a registered witness alone is insufficient. */
export function readActionReviewPreview(db: Database.Database, workspace: string, actor: unknown, id: unknown, now: string) {
  return db.transaction(() => {
    const witness=previewHeader(db,workspace,actor,id,now);
    const changed=()=>{throw new Error("ACTION_REVIEW_VIEW_CHANGED");};
    const ws=db.prepare("SELECT revision FROM investor_workspaces WHERE id=?").get(workspace) as Obj|undefined;
    if(time(now) >= time(witness.valid_until) || ws?.revision !== witness.workspace_revision)changed();
    if(db.prepare("SELECT 1 FROM investor_action_review_confirmations WHERE workspace_id=? AND previous_authority_id=?").get(workspace,witness.authority_id))changed();
    const before=readManagedActionComparisonBasis(db,workspace,witness.authority_id,now),{grant}=before;
    const leaves=db.prepare(`SELECT a.id FROM investor_action_authorities a WHERE a.workspace_id=? AND json_extract(a.document_json,'$.provider_symbol')=?
      AND NOT EXISTS(SELECT 1 FROM investor_action_review_confirmations c WHERE c.previous_authority_id=a.id) LIMIT 2`).all(workspace,grant.doc.provider_symbol) as Obj[];
    if(leaves.length !== 1 || leaves[0].id !== grant.row.id)changed();
    if(grant.row.content_hash !== witness.authority_hash || grant.current.id !== witness.control_id || grant.current.content_hash !== witness.control_hash)changed();
    check(time(grant.doc.valid_from) <= time(now) && time(now) < time(grant.doc.valid_until));
    eventOrigins(db,workspace,before.base,now,new Set());
    const current=readManagedActionCurrentCaptures(db,workspace,grant.row.id,now),previous=before.previous,next=current.snapshots;
    for(const kind of kinds) {
      for(const key of ["authority_id","authority_hash","control_id","control_hash"])check(object(before.anchor.bindings[kind])[key] === object(current.bindings[kind])[key]);
      const a=previous[kind].source,b=next[kind].source;
      check(text(b.range_start) >= text(a.range_start) && text(b.range_end) >= text(a.range_end)
        && time(b.retrieved_at) >= time(a.retrieved_at) && text(b.range_start) <= actionAddDays(before.prior.facts.range_end,1));
    }
    const start=kinds.map(kind=>text(next[kind].source.range_start)).sort().at(-1)!,end=kinds.map(kind=>text(next[kind].source.range_end)).sort()[0];
    check(start <= end && start <= text(before.prior.facts.range_end));
    const receipts=Object.values(current.values).flatMap(value=>[text(value.row.created_at),text(value.draft.source.retrieved_at)]);
    const floor=receipts.reduce((a,b)=>time(a) >= time(b) ? a:b);check(time(floor) <= time(now));
    const maximum=millis([grant.doc.valid_until,...before.limits,...before.historicalLimits,...current.limits].map(time).reduce((a,b)=>a < b ? a:b));
    const rows=changes(previous,next,text(before.prior.facts.range_end),end);
    const basis={workspace,owner:actor,authority_id:grant.row.id,authority_hash:grant.row.content_hash,control_id:grant.current.id,control_hash:grant.current.content_hash,
      publication_id:before.publicationId,previous_review_hash:before.prior.row.content_hash,previous_facts_hash:hash(before.prior.facts),
      previous_snapshot_hash:hash(previous),current_snapshot_hash:hash(next),current_bindings:current.bindings,changes:rows,
      knowledge_not_before:floor,maximum_valid_until:maximum};
    if(hash(basis) !== witness.draft_basis_hash)changed();
    let agreement=true;try{checkActionReportAgreement(next);}catch{agreement=false;}
    const historical=rows.some(row=>row.disposition === "historical_correction");
    const supported=agreement && !historical && rows.length > 0 && rows.every(row=>!row.outside_common_coverage);
    const status=historical ? "historical_correction_required":!agreement || rows.some(row=>row.outside_common_coverage) ? "source_review_required":rows.length ? "new_reported_actions":"no_reported_changes";
    const until=millis([time(now)+60000000n,time(witness.valid_until),time(maximum)].reduce((a,b)=>a < b ? a:b));check(time(now) < time(until));
    const view=actionReviewViewSchema.parse({schema_version:"investor-action-review-view-v1",preview:witness,provider_symbol:grant.doc.provider_symbol,
      source_day:current.day,status,previous_coverage_end:before.prior.facts.range_end,candidate_coverage_end:end,knowledge_not_before:floor,
      unchanged_tax_assumption:before.prior.facts.tax_assumption,changes:rows,confirmation_supported:supported,checked_at:now,refresh_after:until,
      visibility:"private_owner_only_not_ai",provider_calls:0,research_admitted:false,trading_permission:false});
    check(Buffer.byteLength(canonical(view)) <= 4194304);return view;
  }).deferred();
}
