import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { amount } from "../ledger/decimal";
import { priceInstant } from "../market-price-source";
import { validateInvestorSourceDocument } from "./kernel-contracts";
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

/** Independent original-byte replay, standing-rule proof and complete virtual review binding. */
export function readManagedActionReview(db:Database.Database,workspace:string,id:unknown,now:string):VerifiedSourceReview {
  return db.transaction(()=>{
    check(!managedActionReviewUnavailable(db,workspace,id,now));
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
    return value;
  }).deferred();
}
