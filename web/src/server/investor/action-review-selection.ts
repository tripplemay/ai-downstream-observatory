import type Database from "better-sqlite3";
import { priceInstant as time } from "../market-price-source";
import { readActionReviewConfirmationContext, readActionReviewConfirmationReceipt } from "./action-review-lineage";
import { MANAGED_ACTION_PREFIX, managedActionReviewUnavailable, readManagedActionAuthorityWitness, readManagedActionHeader, readManagedActionHistoricalReview, readManagedActionProgressRecord, readManagedActionReview } from "./managed-action-source";
import { readInvestorSourceReview, type VerifiedSourceReview } from "./source-inputs";
import { hash } from "../ledger/service";

type Obj=Record<string,unknown>;
function check(value:unknown):asserts value {if(!value)throw new Error("ACTION_REVIEW_SELECTION_INVALID");}

export function checkpointActionReviewNeedsReplay(db:Database.Database,workspace:string,id:unknown,now:string) {
  check(typeof id==="string");
  return actionReviewSourceRetired(db,workspace,id,now)||id.startsWith(MANAGED_ACTION_PREFIX)
    &&managedActionReviewUnavailable(db,workspace,id,now)==="REFERENCE_SOURCE_NO_LONGER_CURRENT";
}

/** Negative metadata only; successful reads still reparse original evidence. */
export function actionReviewManualUnavailable(db:Database.Database,workspace:string,id:unknown,now:string) {
  const rows=db.prepare("SELECT id,actor_id FROM investor_action_review_confirmations WHERE workspace_id=? AND new_review_id=? LIMIT 2").all(workspace,id) as Obj[];
  check(rows.length<=1);if(!rows.length)return null;
  const doc=readActionReviewConfirmationReceipt(db,workspace,rows[0].actor_id,rows[0].id,now),progress=readManagedActionProgressRecord(db,workspace,doc.new_authority_id as string,now),{grant}=progress;
  check(grant.doc.base_review_id===id&&grant.doc.base_review_hash===doc.new_review_hash&&grant.row.content_hash===doc.new_authority_hash);
  if(time(now)>=time(grant.doc.valid_until as string)||["BASE_REVIEW_EXPIRED","SOURCE_RETENTION_EXPIRED"].includes(progress.dependencyReason??""))return "REFERENCE_SOURCE_EXPIRED";
  if(progress.dependencyReason==="SOURCE_PAYLOAD_PURGED")return "REFERENCE_SOURCE_PAYLOAD_PURGED";
  return progress.quarantine||progress.dependencyReason||time(now)<time(grant.doc.valid_from as string)?"REFERENCE_SOURCE_NO_LONGER_CURRENT":null;
}

/** Metadata denies a retired monitor source; it never admits replacement facts. */
export function actionReviewSourceRetired(db:Database.Database,workspace:string,id:unknown,now:string) {
  check(typeof id === "string");
  return db.transaction(()=>{
    let publication:Obj|undefined;
    if(id.startsWith(MANAGED_ACTION_PREFIX)) {
      readManagedActionHeader(db,workspace,id,now);
      publication=db.prepare("SELECT authority_id,created_at FROM investor_action_publications WHERE workspace_id=? AND id=?").get(workspace,id) as Obj|undefined;
      check(publication);
    }
    const rows=(publication?db.prepare(`SELECT id,actor_id FROM investor_action_review_confirmations
      WHERE workspace_id=? AND previous_authority_id=? AND created_at<=? LIMIT 2`).all(workspace,publication.authority_id,now)
      :db.prepare(`SELECT c.id,c.actor_id FROM investor_action_review_confirmations c JOIN investor_action_authorities a
        ON a.id=c.previous_authority_id AND a.workspace_id=c.workspace_id WHERE c.workspace_id=? AND a.base_review_id=? AND c.created_at<=? LIMIT 2`).all(workspace,id,now)) as Obj[];
    check(rows.length<=1);if(!rows.length)return false;
    const doc=readActionReviewConfirmationReceipt(db,workspace,rows[0].actor_id,rows[0].id,now),grant=readManagedActionAuthorityWitness(db,workspace,doc.previous_authority_id,now);
    check(grant.row.content_hash === doc.previous_authority_hash && grant.current.enabled === 0
      &&(publication?publication.authority_id === grant.row.id && time(publication.created_at as string)<=time(doc.created_at as string):grant.doc.base_review_id === id));
    return true;
  }).deferred();
}

/** Current candidates retain unrelated overlapping sources; no newest-wins. */
function currentSuccessions(db:Database.Database,workspace:string,identity:unknown,start:string,end:string,now:string) {
  const rows=db.prepare(`SELECT c.id,c.actor_id FROM investor_action_review_confirmations c
    LEFT JOIN investor_action_authorities old ON old.id=c.previous_authority_id AND old.workspace_id=c.workspace_id
    LEFT JOIN investor_action_authorities next ON next.id=c.new_authority_id AND next.workspace_id=c.workspace_id
    WHERE c.workspace_id=? AND c.created_at<=? AND (old.listing_id=? OR next.listing_id=?) ORDER BY c.created_at,c.id LIMIT 257`).all(workspace,now,identity,identity) as Obj[];
  check(rows.length<=256);
  const byNew=new Map<string,ReturnType<typeof readActionReviewConfirmationContext>>(),retired=new Set<string>(),shadowed=new Set<string>();
  for(const row of rows) {
    const value=readActionReviewConfirmationContext(db,workspace,row.actor_id,row.id,now),doc=value.document;
    check(typeof doc.new_authority_id === "string" && typeof doc.previous_authority_id === "string"
      && !byNew.has(doc.new_authority_id) && !retired.has(doc.previous_authority_id)
      && value.before.facts.listing_id === identity && value.after.facts.listing_id === identity);
    byNew.set(doc.new_authority_id,value);retired.add(doc.previous_authority_id);shadowed.add(value.before.row.id);
  }
  const terminals=new Map<string,VerifiedSourceReview>();
  for(const [id,entry] of byNew) {
    const seen=new Set<string>();let cursor=id;
    while(byNew.has(cursor)) {check(!seen.has(cursor)&&seen.size<256);seen.add(cursor);cursor=byNew.get(cursor)!.document.previous_authority_id as string;}
    if(retired.has(id))continue;
    const progress=readManagedActionProgressRecord(db,workspace,id,now),{grant}=progress;
    check(!progress.quarantine && !progress.dependencyReason && time(grant.doc.valid_from as string)<=time(now)
      && time(now)<time(grant.doc.valid_until as string) && entry.after.row.id === grant.doc.base_review_id && entry.after.row.content_hash === grant.doc.base_review_hash);
    terminals.set(id,entry.after);
  }
  const candidates:VerifiedSourceReview[]=[],rules=db.prepare(`SELECT a.id FROM investor_action_authorities a JOIN investor_action_controls c ON c.authority_id=a.id
    WHERE a.workspace_id=? AND a.listing_id=? AND a.created_at<=? AND c.enabled=1
    AND c.version=(SELECT max(version) FROM investor_action_controls WHERE authority_id=a.id)
    AND json_extract(a.document_json,'$.valid_from')<=? LIMIT 129`).all(workspace,identity,now,now) as Obj[];
  check(rules.length<=1);
  for(const row of rules) {
    const progress=readManagedActionProgressRecord(db,workspace,row.id as string,now),{grant}=progress;
    check(!progress.quarantine&&!progress.dependencyReason&&time(now)<time(grant.doc.valid_until as string));
    if(!progress.coverage) {check(terminals.has(row.id as string));continue;}
    const value=readManagedActionReview(db,workspace,progress.coverage.row.id,now);shadowed.add(grant.doc.base_review_id as string);
    if((value.facts.range_start as string)<=start&&start<=end&&end<=(value.facts.range_end as string))candidates.push(value);
  }
  const manual=db.prepare(`SELECT r.id review_id,r.content_hash review_hash,r.source_id,s.content_hash source_hash FROM investor_data_reviews r
    JOIN investor_data_sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id
    WHERE r.workspace_id=? AND s.kind='actions' AND r.decision='approved' AND r.created_at<=? AND r.valid_until>?
      AND r.version=(SELECT max(version) FROM investor_data_reviews WHERE source_id=r.source_id)
      AND json_extract(r.document_json,'$.facts.listing_id')=? AND json_extract(r.document_json,'$.facts.range_start')<=?
      AND json_extract(r.document_json,'$.facts.range_end')>=? LIMIT ?`).all(workspace,now,now,identity,start,end,129+shadowed.size) as Obj[];
  const remaining=manual.filter(ref=>!shadowed.has(ref.review_id as string));check(remaining.length<=128);
  for(const ref of remaining)candidates.push(readInvestorSourceReview(db,workspace,ref,now));
  check(candidates.length===1);return {current:candidates[0],byNew,terminals};
}

/** Select only a proven extension; unrelated equal or newer facts remain ambiguous. */
export function transitionActionReview(db:Database.Database,workspace:string,ref:Obj,start:string,end:string,now:string) {
  const id=ref.review_id;check(typeof id==="string");
  const previous=id.startsWith(MANAGED_ACTION_PREFIX)?readManagedActionHistoricalReview(db,workspace,id,now):readInvestorSourceReview(db,workspace,ref,now);
  check(previous.row.content_hash===ref.review_hash&&previous.source.id===ref.source_id&&previous.source.content_hash===ref.source_hash);
  const {current}=currentSuccessions(db,workspace,previous.facts.listing_id,start,end,now);
  if(current.row.id===id)return current;
  if(checkpointActionReviewNeedsReplay(db,workspace,id,now)) {
    checkpointPredecessorReview(db,workspace,ref,start,end,now);return current;
  }
  check(id.startsWith(MANAGED_ACTION_PREFIX)&&current.row.id.startsWith(MANAGED_ACTION_PREFIX));
  const before=db.prepare("SELECT * FROM investor_action_publications WHERE workspace_id=? AND id=?").get(workspace,id) as Obj|undefined;
  const after=db.prepare("SELECT * FROM investor_action_publications WHERE workspace_id=? AND id=?").get(workspace,current.row.id) as Obj|undefined;
  check(before&&after&&before.authority_id===after.authority_id&&Number(before.sequence)<Number(after.sequence));
  const beforeDoc=JSON.parse(before.document_json as string) as Obj,afterDoc=JSON.parse(after.document_json as string) as Obj;
  const basis=(value:Obj)=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=="range_end"));
  check(beforeDoc.control_id===afterDoc.control_id&&(previous.facts.range_end as string)<=(current.facts.range_end as string)
    &&hash(basis(previous.facts))===hash(basis(current.facts)));
  return current;
}

/** Only a verified linked predecessor can replay an existing checkpoint. */
export function checkpointPredecessorReview(db:Database.Database,workspace:string,ref:Obj,start:string,end:string,now:string) {
  const id=ref.review_id;check(typeof id === "string");
  const previous=id.startsWith(MANAGED_ACTION_PREFIX)?readManagedActionHistoricalReview(db,workspace,id,now):readInvestorSourceReview(db,workspace,ref,now);
  check(previous.row.content_hash === ref.review_hash&&previous.source.id === ref.source_id&&previous.source.content_hash === ref.source_hash);
  const {current,byNew,terminals}=currentSuccessions(db,workspace,previous.facts.listing_id,start,end,now);
  const oldPublication=id.startsWith(MANAGED_ACTION_PREFIX)?db.prepare("SELECT * FROM investor_action_publications WHERE workspace_id=? AND id=?").get(workspace,id) as Obj:null;
  const withoutEnd=(value:Obj)=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=="range_end"));
  if(!actionReviewSourceRetired(db,workspace,id,now)) {
    check(oldPublication&&current.row.id.startsWith(MANAGED_ACTION_PREFIX));
    const publication=db.prepare("SELECT * FROM investor_action_publications WHERE workspace_id=? AND id=?").get(workspace,current.row.id) as Obj;
    const oldDoc=JSON.parse(oldPublication.document_json as string) as Obj,newDoc=JSON.parse(publication.document_json as string) as Obj;
    check(oldPublication.authority_id===publication.authority_id&&Number(oldPublication.sequence)<Number(publication.sequence)
      &&oldDoc.control_id!==newDoc.control_id&&(previous.facts.range_end as string)<=(current.facts.range_end as string)
      &&hash(withoutEnd(previous.facts))===hash(withoutEnd(current.facts)));
    return previous;
  }
  let cursor:string;
  if(current.row.id.startsWith(MANAGED_ACTION_PREFIX)) {
    const row=db.prepare("SELECT authority_id FROM investor_action_publications WHERE workspace_id=? AND id=?").get(workspace,current.row.id) as Obj;cursor=row.authority_id as string;
  } else {const matches=[...terminals].filter(([,value])=>value.row.id === current.row.id);check(matches.length===1);cursor=matches[0][0];}
  check(terminals.has(cursor));
  const seen=new Set<string>();
  while(byNew.has(cursor)) {
    check(!seen.has(cursor)&&seen.size<256);seen.add(cursor);const entry=byNew.get(cursor)!,doc=entry.document;
    if(!oldPublication&&entry.before.row.id===id) {check(hash(previous.facts)===hash(entry.before.facts)&&previous.row.content_hash===entry.before.row.content_hash);return previous;}
    if(oldPublication&&oldPublication.authority_id===doc.previous_authority_id) {
      const bound=db.prepare("SELECT sequence FROM investor_action_publications WHERE workspace_id=? AND id=?").get(workspace,doc.previous_publication_id) as Obj|undefined;
      check(bound&&time(oldPublication.created_at as string)<=time(doc.created_at as string)&&Number(oldPublication.sequence)<=Number(bound.sequence)
        &&(previous.facts.range_end as string)<=((doc.append_proof as Obj).previous_coverage_end as string));
      check(hash(withoutEnd(previous.facts))===hash(withoutEnd(entry.before.facts)));return previous;
    }
    cursor=doc.previous_authority_id as string;
  }
  throw new Error("ACTION_REVIEW_SELECTION_INVALID");
}
