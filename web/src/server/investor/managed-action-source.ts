import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { amount } from "../ledger/decimal";
import { priceInstant } from "../market-price-source";
import { validateInvestorSourceDocument, validateRetainedActionEvidenceProof } from "./kernel-contracts";
import { ACTION_TARGETS, checkNoNewActionCandidate } from "./action-maintenance-candidate";
import type { ActionSnapshot } from "./action-maintenance-candidate";
import { actionCheck as check, actionDeadline, actionNyParts, actionObject as object, actionText } from "./action-source-parsers";
import type { ActionObject as Obj } from "./action-source-parsers";
import { actionAudit, actionJson, actionMillis, actionRead, actionSeal, actionSourceActive,
  readActionCaptureHeader, replayActionSourceCapture } from "./action-source-proof";
import type { VerifiedSourceReview } from "./source-inputs";

export const MANAGED_ACTION_PREFIX="managed-actions-review:";
const REASON="Derived under an owner-authorized no-new-action rule; not individually human-reviewed today.";
const time=priceInstant;
const minimum=(values:unknown[])=>values.map(time).reduce((a,b)=>a<b?a:b);
function control(db:Database.Database,workspace:string,row:Obj,authority:Obj,now:string) {
  const doc=actionSeal(row,"maintenance","control",now);
  actionAudit(db,workspace,row,"investor_control_action_maintenance","investor_action_control");
  check(row.authority_id === authority.id && doc.authority_id === authority.id && doc.authority_hash === authority.content_hash
    && row.actor_id === authority.actor_id && row.workspace_id === workspace && row.version === doc.version
    && [0,1].includes(row.enabled as number) && doc.enabled === !!row.enabled && doc.created_at === row.created_at
    && time(authority.created_at) <= time(row.created_at));return doc;
}
function authority(db:Database.Database,workspace:string,id:unknown,now:string) {
  const row=actionRead(db,"investor_action_authorities",id,workspace),doc=actionSeal(row,"maintenance","authority",now);
  actionAudit(db,workspace,row,"investor_register_action_maintenance","investor_action_authority");
  for(const key of ["listing_id","base_review_id","listing_review_id"])check(row[key] === doc[key]);
  check(actionMillis(doc.valid_from) < actionMillis(doc.valid_until));
  const controls=db.prepare("SELECT * FROM investor_action_controls WHERE authority_id=? ORDER BY version LIMIT 1001").all(id) as Obj[];
  check(controls.length > 0 && controls.length <= 1000);let previous=row.created_at;
  controls.forEach((entry,index)=>{control(db,workspace,entry,row,now);check(entry.version === index+1 && time(previous) <= time(entry.created_at)
    && (index !== 0 || entry.enabled === 0));previous=entry.created_at;});return {row,doc,current:controls.at(-1)!};
}
function active(grant:ReturnType<typeof authority>,now:string) {
  return grant.current.enabled === 1 && time(grant.doc.valid_from) <= time(now) && time(now) < time(grant.doc.valid_until);
}
function request(db:Database.Database,workspace:string,id:unknown,now:string) {
  const row=actionRead(db,"investor_action_requests",id,workspace),doc=actionSeal(row,"maintenance","request",now);
  actionAudit(db,workspace,row,"investor_request_action_maintenance","investor_action_request");
  const grant=authority(db,workspace,row.authority_id,now),original=actionRead(db,"investor_action_controls",row.control_id,workspace);
  control(db,workspace,original,grant.row,now);
  for(const key of ["workspace_id","authority_id","control_id","source_day","created_at","valid_until"])check(row[key] === doc[key]);
  const local=actionNyParts(row.created_at);
  check(row.actor_id === grant.row.actor_id && doc.authority_hash === grant.row.content_hash && doc.control_hash === original.content_hash
    && original.enabled === 1 && time(grant.doc.valid_from) <= time(row.created_at) && time(row.created_at) < time(grant.doc.valid_until)
    && local.hour >= 1 && row.source_day === local.day && row.valid_until === actionDeadline(row.created_at,grant.doc.valid_until));
  return {row,doc,grant,original};
}
function publication(db:Database.Database,workspace:string,id:unknown,now:string) {
  const row=actionRead(db,"investor_action_publications",id,workspace),doc=actionSeal(row,"maintenance","publication",now);
  actionAudit(db,workspace,row,"investor_publish_action_maintenance","investor_action_publication");
  const requested=request(db,workspace,row.request_id,now);
  for(const key of ["workspace_id","authority_id","request_id","sequence","previous_id","source_day","status","source_id","review_hash","coverage_end","created_at","valid_until"])check(row[key] === doc[key]);
  check(actionText(row.id).startsWith(MANAGED_ACTION_PREFIX) && doc.publication_id === row.id && row.actor_id === requested.grant.row.actor_id
    && row.authority_id === requested.grant.row.id && doc.authority_hash === requested.grant.row.content_hash
    && doc.control_id === requested.original.id && doc.control_hash === requested.original.content_hash
    && doc.request_hash === requested.row.content_hash && row.source_day === requested.row.source_day && time(requested.row.created_at) <= time(row.created_at));
  if(row.status === "published")check(time(row.created_at) < time(requested.row.valid_until)
    && time(requested.grant.doc.valid_from) <= time(row.created_at) && time(row.created_at) < time(requested.grant.doc.valid_until));
  if(row.previous_id) {
    const previous=actionRead(db,"investor_action_publications",row.previous_id,workspace),prior=actionSeal(previous,"maintenance","publication",now);
    actionAudit(db,workspace,previous,"investor_publish_action_maintenance","investor_action_publication");
    check(previous.authority_id === row.authority_id && Number(previous.sequence)+1 === row.sequence && prior.publication_id === previous.id
      && previous.content_hash === doc.previous_hash && time(previous.created_at) <= time(row.created_at) && actionText(previous.source_day) < actionText(row.source_day));
  } else check(row.sequence === 1 && doc.previous_hash === null);
  return {row,doc,requested,grant:requested.grant};
}
function quarantined(db:Database.Database,workspace:string,id:unknown,now:string):boolean {
  const blocked=db.prepare("SELECT id FROM investor_action_publications WHERE authority_id=? AND workspace_id=? AND status='blocked' ORDER BY sequence DESC LIMIT 1").get(id,workspace) as Obj|undefined;
  if(!blocked)return false;check(publication(db,workspace,blocked.id,now).row.status === "blocked");return true;
}
function manualHeader(db:Database.Database,workspace:string,id:unknown,kind:string,now:string) {
  check(!actionText(id).startsWith(MANAGED_ACTION_PREFIX));
  const row=actionRead(db,"investor_data_reviews",id,workspace),source=actionRead(db,"investor_data_sources",row.source_id,workspace);
  const doc=actionJson(row.document_json,8388608),sourceDoc=actionJson(source.document_json,131072);
  actionAudit(db,workspace,row,"investor_review_data_source","investor_data_review");
  actionAudit(db,workspace,source,"investor_store_data_source","investor_data_source");
  check(Object.keys(doc).sort().join() === "decision,facts,kind,reason,review_basis,schema_version,source_hash,source_id,valid_until,version"
    && doc.schema_version === "investor-data-review-v1" && doc.review_basis === "owner_reviewed_not_provider_certified"
    && source.kind === kind && doc.kind === kind && doc.source_id === source.id && doc.source_hash === source.content_hash
    && hash(sourceDoc) === source.content_hash && hash(doc) === row.content_hash && doc.version === row.version && doc.decision === row.decision
    && doc.valid_until === row.valid_until && time(source.created_at) <= time(row.created_at) && time(row.created_at) <= time(now));
  return {row,source,facts:object(doc.facts)};
}
function baseline(db:Database.Database,workspace:string,grant:ReturnType<typeof authority>,now:string) {
  const policy=grant.doc,base=manualHeader(db,workspace,policy.base_review_id,"actions",now),listing=manualHeader(db,workspace,policy.listing_review_id,"listing",now);
  check(base.row.decision === "approved" && listing.row.decision === "approved" && base.row.content_hash === policy.base_review_hash
    && listing.row.content_hash === policy.listing_review_hash && base.facts.listing_id === policy.listing_id && listing.facts.listing_id === policy.listing_id
    && listing.facts.provider_symbol === policy.provider_symbol && time(base.row.created_at) <= time(grant.row.created_at)
    && time(listing.row.created_at) <= time(grant.row.created_at));
  validateInvestorSourceDocument("facts",{kind:"actions",facts:base.facts});validateInvestorSourceDocument("facts",{kind:"listing",facts:listing.facts});
  check(amount(actionText(listing.facts.quantity_step)).gt(0) && amount(actionText(listing.facts.fee_rate)).gte(0)
    && amount(actionText(listing.facts.fee_rate)).lte(1) && actionText(listing.facts.fee_as_of) <= actionText(listing.row.created_at).slice(0,10)
    && (listing.facts.tradable_until === null || time(listing.facts.tradable_from) < time(listing.facts.tradable_until)));
  return {base,listing};
}
function latestManual(db:Database.Database,row:Obj) {
  const latest=object(db.prepare("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1").get(row.source_id));return latest.id === row.id;
}

/** Status inspection authenticates headers only; it deliberately never reads source facts or payloads. */
export function readManagedActionProgressRecord(db:Database.Database,workspace:string,id:string,now:string) {
  const grant=authority(db,workspace,id,now),limits:unknown[]=[grant.doc.valid_from,grant.doc.valid_until];
  const head=(table:string,order:string,filter="")=>db.prepare(`SELECT id FROM ${table} WHERE workspace_id=? AND authority_id=? ${filter} ORDER BY ${order} DESC LIMIT 1`).get(workspace,id) as Obj|undefined;
  const requested=head("investor_action_requests","source_day"),last=head("investor_action_publications","sequence"),positive=head("investor_action_publications","sequence","AND status='published'"),blocked=head("investor_action_publications","sequence","AND status='blocked'");
  const intent=requested ? request(db,workspace,requested.id,now):null;
  const latest=last ? publication(db,workspace,last.id,now):null;
  const coverage=positive ? publication(db,workspace,positive.id,now):null;
  const quarantine=blocked ? publication(db,workspace,blocked.id,now):null;
  if(intent)limits.push(intent.row.valid_until);
  if(coverage)limits.push(coverage.row.valid_until);
  let dependencyReason:string|null=null;
  for(const [key,pin] of [["base_review_id","base_review_hash"],["listing_review_id","listing_review_hash"]]) {
    const row=db.prepare("SELECT id,workspace_id,source_id,version,decision,content_hash,actor_id,created_at,valid_until,audit_id FROM investor_data_reviews WHERE id=? AND workspace_id=?").get(grant.doc[key],workspace) as Obj|undefined;
    check(row && row.decision === "approved" && row.content_hash === grant.doc[pin] && time(row.created_at) <= time(grant.row.created_at));
    actionAudit(db,workspace,row,"investor_review_data_source","investor_data_review");limits.push(row.valid_until);
    if(time(row.valid_until) <= time(now))dependencyReason ??= "BASE_REVIEW_EXPIRED";
    else if(!latestManual(db,row))dependencyReason ??= "BASE_REVIEW_CHANGED";
  }
  const bindings=new Map<string,string>();
  for(const refs of [object(grant.doc.anchor_captures),...(coverage ? [object(coverage.doc.capture_refs)]:[])]) {
    for(const [key,ref] of Object.entries(refs)) {
      const kind=key === "issuer" ? "issuer":"eodhd",capture=readActionCaptureHeader(db,workspace,object(ref).capture_id,kind,now);
      check(capture.row.content_hash === object(ref).capture_hash);
      if(key === "issuer")check(capture.request.fund_id === ACTION_TARGETS[actionText(grant.doc.provider_symbol)]);
      else check(capture.request.symbol === grant.doc.provider_symbol && capture.request.kind === (key === "dividends" ? "div":"splits"));
      const binding=hash([capture.request.authority_id,capture.request.control_id]);
      if(bindings.has(key))check(bindings.get(key) === binding);bindings.set(key,binding);
      limits.push(capture.row.retain_until,capture.grant.doc.valid_until);
      if(time(now) >= minimum([capture.row.retain_until,capture.grant.doc.valid_until]))dependencyReason ??= "SOURCE_RETENTION_EXPIRED";
      else if(!actionSourceActive(capture.grant,now) || capture.grant.current.id !== capture.original.id)dependencyReason ??= "SOURCE_PERMISSION_CHANGED";
      else if(capture.purge)dependencyReason ??= "SOURCE_PAYLOAD_PURGED";
    }
  }
  if(coverage && time(coverage.row.valid_until) <= time(now))dependencyReason ??= "SOURCE_RETENTION_EXPIRED";
  return {grant,intent,latest,coverage,quarantine,dependencyReason,limits};
}

/** Honest virtual metadata; it does not certify current raw evidence. */
export function readManagedActionHeader(db:Database.Database,workspace:string,id:unknown,now:string):VerifiedSourceReview {
  const {row,doc,grant}=publication(db,workspace,id,now),{base,listing}=baseline(db,workspace,grant,now);
  check(row.status === "published" && actionText(base.facts.range_end) < actionText(row.coverage_end) && actionText(row.coverage_end) < actionText(row.source_day)
    && time(row.created_at) < time(row.valid_until) && time(row.valid_until) <= minimum([grant.doc.valid_until,base.row.valid_until,listing.row.valid_until]));
  const prior=db.prepare("SELECT id FROM investor_action_publications WHERE authority_id=? AND workspace_id=? AND status='published' AND sequence<? ORDER BY sequence DESC LIMIT 1").get(row.authority_id,workspace,row.sequence) as Obj|undefined;
  if(prior)check(actionText(publication(db,workspace,prior.id,now).row.coverage_end) < actionText(row.coverage_end));
  const source=actionRead(db,"investor_data_sources",row.source_id,workspace),sourceDoc=actionJson(source.document_json,131072);
  actionAudit(db,workspace,source,"investor_store_data_source","investor_data_source");
  check(source.kind === "actions" && source.actor_id === grant.row.actor_id && source.created_at === row.created_at && source.content_hash === doc.source_hash
    && hash(sourceDoc) === source.content_hash && hash(sourceDoc) === hash({title:"Standing no-new-action coverage",
      reference:`investor-action-rule:${grant.row.id}:${row.source_day}`,excerpt:REASON}));
  const facts={...base.facts,range_end:row.coverage_end};validateInvestorSourceDocument("facts",{kind:"actions",facts});
  const review={schema_version:"investor-data-review-v2",source_id:source.id,source_hash:source.content_hash,kind:"actions",version:1,decision:"approved",
    facts,reason:REASON,valid_until:row.valid_until,review_basis:"owner_standing_no_new_actions_rule"};
  check(hash(facts) === doc.candidate_facts_hash && hash(review) === doc.review_hash && doc.review_hash === row.review_hash);
  return {row:{id:row.id,workspace_id:workspace,source_id:source.id,version:1,decision:"approved",document_json:canonical(review),content_hash:row.review_hash,
    actor_id:row.actor_id,created_at:row.created_at,valid_until:row.valid_until,audit_id:row.audit_id},source,facts} as unknown as VerifiedSourceReview;
}

export function managedActionReviewUnavailable(db:Database.Database,workspace:string,id:unknown,now:string) {
  if(typeof id !== "string" || !id.startsWith(MANAGED_ACTION_PREFIX))return null;
  const value=readManagedActionHeader(db,workspace,id,now),{row,doc,grant}=publication(db,workspace,id,now),{base,listing}=baseline(db,workspace,grant,now);
  let reason:string|null=null;
  if(time(now) >= minimum([value.row.valid_until,grant.doc.valid_until]))reason="REFERENCE_SOURCE_EXPIRED";
  else if(!active(grant,now) || grant.current.id !== doc.control_id || quarantined(db,workspace,grant.row.id,now))reason="REFERENCE_SOURCE_NO_LONGER_CURRENT";
  for(const value of [base,listing]) {
    if(time(now) >= time(value.row.valid_until))reason ??= "REFERENCE_SOURCE_EXPIRED";
    else if(!latestManual(db,value.row))reason ??= "REFERENCE_SOURCE_NO_LONGER_CURRENT";
  }
  const bindings=new Map<string,string>();
  for(const refs of [object(grant.doc.anchor_captures),object(doc.capture_refs)]) {
    for(const [key,ref] of Object.entries(refs)) {
      const kind=key === "issuer" ? "issuer":"eodhd",capture=readActionCaptureHeader(db,workspace,object(ref).capture_id,kind,now);
      check(capture.row.content_hash === object(ref).capture_hash && time(capture.row.retain_until) >= time(row.valid_until));
      const binding=hash([capture.request.authority_id,capture.request.control_id]);if(bindings.has(key))check(bindings.get(key) === binding);bindings.set(key,binding);
      if(time(now) >= minimum([capture.row.retain_until,capture.grant.doc.valid_until]))reason ??= "REFERENCE_SOURCE_EXPIRED";
      else if(!actionSourceActive(capture.grant,now) || capture.grant.current.id !== capture.original.id)reason ??= "REFERENCE_SOURCE_NO_LONGER_CURRENT";
      else if(capture.purge)reason ??= "REFERENCE_SOURCE_PAYLOAD_PURGED";
      if(!capture.purge)check(db.prepare(`SELECT 1 FROM investor_${kind}_payloads WHERE workspace_id=? AND raw_sha256=?`).get(workspace,capture.row.raw_sha256));
    }
  }
  return reason;
}

function captures(db:Database.Database,workspace:string,refs:Obj,symbol:string,now:string) {
  const values={issuer:replayActionSourceCapture(db,workspace,object(refs.issuer).capture_id,"issuer",now),
    dividends:replayActionSourceCapture(db,workspace,object(refs.dividends).capture_id,"eodhd",now),
    splits:replayActionSourceCapture(db,workspace,object(refs.splits).capture_id,"eodhd",now)};
  const days=new Set<string>(),bindings:Obj={},snapshots={} as ActionSnapshot,limits:unknown[]=[];
  for(const [key,value] of Object.entries(values)) {
    check(value.row.content_hash === object(refs[key]).capture_hash);
    if(key === "issuer")check(value.draft.source.requested_fund_id === ACTION_TARGETS[symbol]);
    else check(value.draft.source.requested_symbol === symbol && value.draft.source.kind === (key === "dividends" ? "div":"splits"));
    days.add(actionText(key === "issuer" ? value.request.issuer_day:value.request.source_day));
    bindings[key]=value.binding;snapshots[key as keyof ActionSnapshot]=value.draft;limits.push(value.row.retain_until,value.grant.doc.valid_until);
  }
  check(days.size === 1 && values.dividends.grant.row.id === values.splits.grant.row.id && values.dividends.original.id === values.splits.original.id);
  return {values,bindings,snapshots,limits,day:[...days][0]};
}

/** Only today's normal retained batches; never fetch, retry or substitute yesterday. */
export function readManagedActionCurrentCaptures(db:Database.Database,workspace:string,id:unknown,now:string) {
  const grant=authority(db,workspace,id,now),symbol=actionText(grant.doc.provider_symbol),day=actionNyParts(now).day,refs:Obj={};
  for(const kind of ["issuer","dividends","splits"]) {
    const rows=(kind === "issuer" ? db.prepare(`SELECT c.id,c.content_hash FROM investor_issuer_requests r JOIN investor_issuer_captures c
      ON c.request_id=r.id AND c.workspace_id=r.workspace_id WHERE r.workspace_id=? AND r.issuer_day=? AND r.fund_id=? LIMIT 2`)
      .all(workspace,day,ACTION_TARGETS[symbol]) : db.prepare(`SELECT c.id,c.content_hash FROM investor_eodhd_requests r JOIN investor_eodhd_captures c
      ON c.request_id=r.id AND c.workspace_id=r.workspace_id WHERE r.workspace_id=? AND r.source_day=? AND r.symbol=? AND r.kind=? LIMIT 2`)
      .all(workspace,day,symbol,kind === "dividends" ? "div":"splits")) as Obj[];
    if(rows.length !== 1)throw new Error("ACTION_REVIEW_CURRENT_REPORTS_UNAVAILABLE");
    refs[kind]={capture_id:rows[0].id,capture_hash:rows[0].content_hash};
  }
  const value=captures(db,workspace,refs,symbol,now);check(value.day === day);return value;
}

/** Replays selected retained reports, not today's coverage or monitor admission. */
export function readManagedActionReportCaptures(db:Database.Database,workspace:string,id:unknown,refs:Obj,now:string) {
  const basis=readManagedActionAnchorContext(db,workspace,id,now);
  const value=captures(db,workspace,refs,actionText(basis.grant.doc.provider_symbol),now);
  for(const kind of ["issuer","dividends","splits"])for(const key of ["authority_id","authority_hash","control_id","control_hash"])
    check(object(value.bindings[kind])[key] === object(basis.anchor.bindings[kind])[key]);
  return value;
}

/** Current source-qualified anchor, not permission to resume a retired rule. */
export function readManagedActionAnchorContext(db:Database.Database,workspace:string,id:unknown,now:string) {
  const grant=authority(db,workspace,id,now),{base,listing}=baseline(db,workspace,grant,now);
  for(const value of [base,listing])check(latestManual(db,value.row) && time(now) < time(value.row.valid_until)
    && canonical(actionJson(value.row.document_json,8388608)) === value.row.document_json
    && canonical(actionJson(value.source.document_json,131072)) === value.source.document_json);
  return replayActionAnchorContext(db,workspace,grant,base,listing,now);
}

function replayActionAnchorContext(db:Database.Database,workspace:string,grant:ReturnType<typeof authority>,
  base:ReturnType<typeof manualHeader>,listing:ReturnType<typeof manualHeader>,now:string) {
  const policy=grant.doc;
  check(listing.facts.market === "US" && listing.facts.currency === "USD" && Object.hasOwn(ACTION_TARGETS,actionText(policy.provider_symbol))
    && time(listing.facts.tradable_from) <= time(now) && (listing.facts.tradable_until === null || time(now) < time(listing.facts.tradable_until)));
  const anchor=captures(db,workspace,object(policy.anchor_captures),actionText(policy.provider_symbol),now);
  for(const value of Object.values(anchor.values))check(time(value.row.created_at) <= time(grant.row.created_at));
  checkNoNewActionCandidate(base.facts,anchor.snapshots,anchor.snapshots,actionText(policy.provider_symbol),actionText(policy.listing_id));
  const bindingHash=hash({base_review_hash:base.row.content_hash,listing_review_hash:listing.row.content_hash,bindings:anchor.bindings});
  const limits=[...anchor.limits,base.row.valid_until,listing.row.valid_until];
  if(listing.facts.tradable_until !== null)limits.push(listing.facts.tradable_until);
  check(bindingHash === policy.anchor_binding_hash && time(policy.valid_until) <= minimum(limits));
  return {grant,base:base as unknown as VerifiedSourceReview,listing:listing as unknown as VerifiedSourceReview,anchor,bindingHash,limits};
}

/** Retained original anchor only: a changed manual review is not current qualification. */
export function readRetainedActionAnchorContext(db:Database.Database,workspace:string,id:unknown,now:string) {
  const grant=authority(db,workspace,id,now),{base,listing}=baseline(db,workspace,grant,now);
  const manual=retainedManualAction(db,workspace,base.row.id,now);
  check(hash(manual.original) === hash(base) && latestManual(db,listing.row) && time(now)<time(listing.row.valid_until));
  for(const value of [base,listing])check(canonical(actionJson(value.row.document_json,8388608)) === value.row.document_json
    && canonical(actionJson(value.source.document_json,131072)) === value.source.document_json);
  return {...replayActionAnchorContext(db,workspace,grant,base,listing,now),
    readValidUntil:new Date(Number(minimum([grant.doc.valid_until,manual.latest.row.valid_until])/1000n)).toISOString()};
}

/** Select the original recorded publication, while all permission reads still use now. */
export function readRetainedActionComparisonContext(db:Database.Database,workspace:string,id:unknown,publicationId:unknown,recordedAt:string,now:string) {
  const context=readRetainedActionAnchorContext(db,workspace,id,now);
  check(time(recordedAt)<=time(now));
  const head=db.prepare("SELECT id FROM investor_action_publications WHERE workspace_id=? AND authority_id=? AND status='published' AND created_at<=? ORDER BY sequence DESC LIMIT 1")
    .get(workspace,id,recordedAt) as Obj|undefined;
  check((head?.id??null) === publicationId);
  if(!head)return {...context,prior:context.base,previous:context.anchor.snapshots,publicationId:null,historicalLimits:context.anchor.limits};
  const metadata=publication(db,workspace,head.id,now);
  check(metadata.row.authority_id === id && metadata.row.status === "published" && time(now)<time(metadata.row.valid_until));
  const evidence=replayManagedActionReviewEvidence(db,workspace,head.id,now);
  return {...context,prior:evidence.value,previous:evidence.current.snapshots,publicationId:actionText(head.id),historicalLimits:evidence.current.limits,
    readValidUntil:new Date(Number(minimum([context.readValidUntil,metadata.row.valid_until])/1000n)).toISOString()};
}

/** Historical comparison only: quarantine/retirement is NOT cleared or admitted. */
export function readManagedActionComparisonBasis(db:Database.Database,workspace:string,id:unknown,now:string) {
  const context=readManagedActionAnchorContext(db,workspace,id,now),{grant,anchor,base,limits,bindingHash}=context,policy=grant.doc;
  const head=db.prepare("SELECT id FROM investor_action_publications WHERE workspace_id=? AND authority_id=? AND status='published' ORDER BY sequence DESC LIMIT 1")
    .get(workspace,id) as Obj|undefined;
  if(!head)return {...context,prior:base,previous:anchor.snapshots,publicationId:null,historicalLimits:anchor.limits};
  const {row,doc}=publication(db,workspace,head.id,now),prior=readManagedActionHeader(db,workspace,head.id,now);
  const current=captures(db,workspace,object(doc.capture_refs),actionText(policy.provider_symbol),now);
  for(const value of Object.values(current.values))check(time(value.row.created_at) <= time(row.created_at));
  for(const kind of Object.keys(anchor.bindings))for(const field of ["authority_id","authority_hash","control_id","control_hash"])
    check(object(anchor.bindings[kind])[field] === object(current.bindings[kind])[field]);
  const candidate=checkNoNewActionCandidate(base.facts,anchor.snapshots,current.snapshots,actionText(policy.provider_symbol),actionText(policy.listing_id));
  const validUntil=new Date(Number(minimum([policy.valid_until,...limits,...current.limits])/1000n)).toISOString();
  check(time(now) < time(row.valid_until) && current.day === row.source_day && validUntil === row.valid_until
    && candidate.candidate_range_end === row.coverage_end && candidate.candidate_facts_hash === doc.candidate_facts_hash
    && hash({authority_input:policy,anchor_binding_hash:bindingHash,current_bindings:current.bindings,candidate}) === doc.checked_input_hash);
  return {...context,prior,previous:current.snapshots,publicationId:actionText(head.id),historicalLimits:current.limits};
}

/** Authenticate authority metadata without treating it as source qualification. */
export function readManagedActionAuthorityWitness(db:Database.Database,workspace:string,id:unknown,now:string) {
  return authority(db,workspace,id,now);
}

/** Authenticate an immutable control witness without treating it as current. */
export function readManagedActionControlWitness(db:Database.Database,workspace:string,authorityId:unknown,id:unknown,now:string) {
  const grant=authority(db,workspace,authorityId,now),row=actionRead(db,"investor_action_controls",id,workspace);
  control(db,workspace,row,grant.row,now);return row;
}

/** Independent original-byte replay, standing-rule proof and complete virtual review binding. */
export function readManagedActionReview(db:Database.Database,workspace:string,id:unknown,now:string):VerifiedSourceReview {
  return db.transaction(()=>{
    check(!managedActionReviewUnavailable(db,workspace,id,now));
    return replayManagedActionReview(db,workspace,id,now);
  }).deferred();
}

/** Raw historical comparison only; never resume or admit a retired control. */
export function readManagedActionHistoricalReview(db:Database.Database,workspace:string,id:unknown,now:string):VerifiedSourceReview {
  return db.transaction(()=>{
    const {row}=publication(db,workspace,id,now);
    check(row.status === "published" && time(now)<time(row.valid_until));
    readManagedActionAnchorContext(db,workspace,row.authority_id,now);
    return replayManagedActionReview(db,workspace,id,now);
  }).deferred();
}

function replayManagedActionReview(db:Database.Database,workspace:string,id:unknown,now:string):VerifiedSourceReview {
  return replayManagedActionReviewEvidence(db,workspace,id,now).value;
}

function replayManagedActionReviewEvidence(db:Database.Database,workspace:string,id:unknown,now:string) {
    const value=readManagedActionHeader(db,workspace,id,now),{row,doc,grant}=publication(db,workspace,id,now),{base,listing}=baseline(db,workspace,grant,now),policy=grant.doc;
    check(listing.facts.market === "US" && listing.facts.currency === "USD" && Object.hasOwn(ACTION_TARGETS,actionText(policy.provider_symbol))
      && time(listing.facts.tradable_from) <= time(now) && (listing.facts.tradable_until === null || time(now) < time(listing.facts.tradable_until)));
    const anchor=captures(db,workspace,object(policy.anchor_captures),actionText(policy.provider_symbol),now);
    for(const capture of Object.values(anchor.values))check(time(capture.row.created_at) <= time(grant.row.created_at));
    checkNoNewActionCandidate(base.facts,anchor.snapshots,anchor.snapshots,actionText(policy.provider_symbol),actionText(policy.listing_id));
    const anchorHash=hash({base_review_hash:base.row.content_hash,listing_review_hash:listing.row.content_hash,bindings:anchor.bindings});
    check(anchorHash === policy.anchor_binding_hash);
    const current=captures(db,workspace,object(doc.capture_refs),actionText(policy.provider_symbol),now);
    for(const capture of Object.values(current.values))check(time(capture.row.created_at) <= time(row.created_at));
    for(const key of Object.keys(anchor.bindings))for(const field of ["authority_id","authority_hash","control_id","control_hash"])
      check(object(anchor.bindings[key])[field] === object(current.bindings[key])[field]);
    const candidate=checkNoNewActionCandidate(base.facts,anchor.snapshots,current.snapshots,actionText(policy.provider_symbol),actionText(policy.listing_id));
    const limits=[...anchor.limits,base.row.valid_until,listing.row.valid_until];if(listing.facts.tradable_until !== null)limits.push(listing.facts.tradable_until);
    check(time(policy.valid_until) <= minimum(limits));
    const validUntil=new Date(Number(minimum([policy.valid_until,...limits,...current.limits])/1000n)).toISOString();
    check(current.day === row.source_day && validUntil === row.valid_until && candidate.candidate_range_end === row.coverage_end
      && candidate.candidate_facts_hash === doc.candidate_facts_hash && hash({authority_input:policy,anchor_binding_hash:anchorHash,current_bindings:current.bindings,candidate}) === doc.checked_input_hash);
    return {value,row,grant,base,listing,anchor,current};
}

function retainedManualAction(db:Database.Database,workspace:string,id:unknown,now:string,market="US") {
  const zone=({US:"America/New_York",CN:"Asia/Shanghai",HK:"Asia/Hong_Kong"} as Record<string,string>)[market];check(zone);
  const original=manualHeader(db,workspace,id,"actions",now);
  check(original.row.decision === "approved" && time(now)<time(original.row.valid_until));
  const rows=db.prepare("SELECT id,version FROM investor_data_reviews WHERE source_id=? AND version>=? ORDER BY version LIMIT 1001")
    .all(original.source.id,original.row.version) as Obj[];
  check(rows.length>0 && rows.length<=1000);let previous=original.row.created_at,latest=original;
  rows.forEach((row,index)=>{
    const value=manualHeader(db,workspace,row.id,"actions",now);
    check(row.version === Number(original.row.version)+index && value.row.decision === "approved"
      && time(previous)<=time(value.row.created_at) && value.facts.listing_id === original.facts.listing_id);
    validateInvestorSourceDocument("facts",{kind:"actions",facts:value.facts});
    const facts=value.facts,events=facts.events as Obj[];
    check(actionText(facts.range_start)<=actionText(facts.range_end) && new Set(events.map(event=>event.id)).size === events.length);
    for(const event of events) {
      time(event.at);const parts=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(new Date(actionText(event.at)));
      const day=["year","month","day"].map(key=>parts.find(part=>part.type===key)!.value).join("-");time(event.published_at);
      check(event.listing_id === facts.listing_id && actionText(facts.range_start)<=day && day<=actionText(facts.range_end));
      if(event.type === "dividend")check(time(event.pay_at)>=time(event.at) && amount(actionText(event.tax_per_unit)).gte(0)
        && amount(actionText(event.tax_per_unit)).lte(amount(actionText(event.gross_per_unit))));
      else check(amount(actionText(event.ratio)).gt(0));
    }
    previous=value.row.created_at;latest=value;
  });
  check(time(now)<time(latest.row.valid_until));return {original,latest};
}

/** Exact retained originals, not a VerifiedSourceReview or permission to resume. */
export function readRetainedActionEvidence(db:Database.Database,workspace:string,actor:string,id:string,now:string,listingReviewId?:string) {
  return db.transaction(()=>{
    now=actionMillis(now);
    check((db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj|undefined)?.owner_id === actor);
    check(actionText(id).length>0 && id.length<=300);
    const listing=listingReviewId?manualHeader(db,workspace,listingReviewId,"listing",now):null;
    if(listing){check(listing.row.decision==="approved" && latestManual(db,listing.row) && time(now)<time(listing.row.valid_until));
      validateInvestorSourceDocument("facts",{kind:"listing",facts:listing.facts});
      check(amount(actionText(listing.facts.quantity_step)).gt(0) && amount(actionText(listing.facts.fee_rate)).gte(0)
        && amount(actionText(listing.facts.fee_rate)).lte(1) && actionText(listing.facts.fee_as_of)<=actionText(listing.row.created_at).slice(0,10)
        && (listing.facts.tradable_until===null || time(listing.facts.tradable_from)<time(listing.facts.tradable_until)));}
    let original:VerifiedSourceReview,latest:ReturnType<typeof manualHeader>,recorded:Obj|null=null,grant:ReturnType<typeof authority>|null=null;
    const bindings:Obj[]=[];
    if(id.startsWith(MANAGED_ACTION_PREFIX)) {
      if(listing)check(listing.facts.market==="US");
      const metadata=publication(db,workspace,id,now);
      const manual=retainedManualAction(db,workspace,metadata.grant.doc.base_review_id,now);
      const boundListing=baseline(db,workspace,metadata.grant,now).listing;
      check(metadata.row.status === "published" && time(now)<time(metadata.row.valid_until)
        && latestManual(db,boundListing.row) && time(now)<time(boundListing.row.valid_until));
      const evidence=replayManagedActionReviewEvidence(db,workspace,id,now);
      original=evidence.value;latest=manual.latest;recorded=evidence.row;grant=evidence.grant;
      for(const [prefix,source] of [["anchor",evidence.anchor],["publication",evidence.current]] as const)
        for(const [key,binding] of Object.entries(source.bindings))bindings.push({slot:prefix+"_"+key,...object(binding)});
      bindings.sort((a,b)=>actionText(a.slot)<actionText(b.slot)?-1:1);
    } else {
      const manual=retainedManualAction(db,workspace,id,now,listing?actionText(listing.facts.market):"US");
      original=manual.original as unknown as VerifiedSourceReview;latest=manual.latest;
    }
    const row=original.row,source=original.source;
    if(listing)check(listing.facts.listing_id===original.facts.listing_id);
    const proof={schema_version:"investor-retained-action-evidence-v1",workspace_id:workspace,actor_id:actor,
      review_id:row.id,review_hash:row.content_hash,source_id:source.id,source_hash:source.content_hash,facts_hash:hash(original.facts),
      latest_manual_review_id:latest.row.id,latest_manual_review_hash:latest.row.content_hash,
      publication_id:recorded?.id??null,publication_hash:recorded?.content_hash??null,
      authority_id:grant?.row.id??null,authority_hash:grant?.row.content_hash??null,capture_bindings:bindings,checked_at:now,
      valid_until:new Date(Number(minimum([row.valid_until,latest.row.valid_until,...(listing?[listing.row.valid_until]:[])])/1000n)).toISOString(),
      purpose:"retained_historical_comparison_only",evidence_basis:bindings.length?"standing_rule_original_capture_replay":"owner_review_record_only",
      original_raw_reports_replayed:!!bindings.length,current_source_eligibility_restored:false,economic_correction_approved:false,
      checkpoint_created:false,monitoring_resumed:false,historical_observations_rewritten:false,trading_permission:false,
      provider_calls:0,database_writes:0,distribution:"private_owner_only_not_ai"};
    validateRetainedActionEvidenceProof(proof);
    return {original_review:row,original_source:source,original_facts:original.facts,proof};
  }).deferred();
}

/** Internal: the caller already used the normal original-byte review resolver. */
export function readManagedActionOrigin(db:Database.Database,workspace:string,value:VerifiedSourceReview,now:string):VerifiedSourceReview {
  const {row,grant}=publication(db,workspace,value.row.id,now),{base}=baseline(db,workspace,grant,now);
  check(row.status === "published" && row.review_hash === value.row.content_hash
    && hash(base.facts.events) === hash(value.facts.events) && base.facts.listing_id === value.facts.listing_id
    && base.facts.tax_assumption === value.facts.tax_assumption && time(base.row.created_at) <= time(value.row.created_at));
  return base as unknown as VerifiedSourceReview;
}

/** Retained original resolver input only; it never makes the old rule current. */
export function readRetainedActionOrigin(db:Database.Database,workspace:string,value:VerifiedSourceReview,now:string):VerifiedSourceReview {
  const {row}=publication(db,workspace,value.row.id,now);
  const {base}=readRetainedActionAnchorContext(db,workspace,row.authority_id,now);
  check(row.status === "published" && row.review_hash === value.row.content_hash
    && hash(base.facts.events) === hash(value.facts.events) && base.facts.listing_id === value.facts.listing_id
    && base.facts.tax_assumption === value.facts.tax_assumption && time(base.row.created_at)<=time(value.row.created_at));
  return base;
}
