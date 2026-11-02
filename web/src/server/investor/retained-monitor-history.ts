import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { Decimal } from "../ledger/decimal";
import { priceInstant as time } from "../market-price-source";
import { fixedPolicyUnsupported } from "./fixed-policy";
import { actionAudit, actionJson, actionRead } from "./action-source-proof";
import { readRetainedActionEvidence, MANAGED_ACTION_PREFIX, readManagedActionAuthorityWitness, readManagedActionHeader } from "./managed-action-source";
import { assembleInvestorSourceSnapshot, readInvestorSourceReview, readInvestorCurrentCalendarReview, type VerifiedSourceReview } from "./source-inputs";
import { retainedActionAvailabilityRefs, indexActionAvailability } from "./monitor-action-knowledge";
import { projectInvestorMonitorProjection } from "./monitor-source";
import { monitorCostsAt, verifyMonitorCostSettings } from "./monitor-costs";
import { readEvidenceReference } from "./reference-evidence";
import { readLegacyTransitionConfirmationReceipt, readLegacyTransitionPreviewWitness, readLegacyTransitionRegistrationReceipt,
  auditedLegacyTransitionDocument } from "./legacy-action-transition";
import { replayEvidenceModel } from "./evidence-model-state";
import { readBoundPlannedFundingMonitor } from "./planned-funding-source";
import type { PlannedFundingBinding } from "./planned-funding-monitor";
import { validateInvestorModelDocument, validateInvestorMonitorDataDocument, validateInvestorEvidenceCheckpoint,
  validateInvestorSourceDocument, validateRetainedMonitorHistoryProof } from "./kernel-contracts";

type Obj=Record<string,unknown>;
type Ledger=Map<string,{action:Obj;input_id:string;input_hash:string}>;
type Source={document:Obj;projection:Obj;catalog:Record<string,Obj>;reviews:VerifiedSourceReview[];ancestry:Map<string,Map<string,string>>;readValidUntil:string};
const legacy=new Set(["investor-monitor-data-input-v1","investor-monitor-data-input-v2","investor-monitor-data-input-v3"]);
function check(value:unknown):asserts value {if(!value)throw new Error("INVESTOR_RETAINED_MONITOR_HISTORY_INVALID");}
function text(value:unknown):string {check(typeof value === "string");return value;}
function obj(value:unknown):Obj {check(value!==null && typeof value === "object" && !Array.isArray(value));return value as Obj;}
function rows(value:unknown):Obj[] {check(Array.isArray(value));return value.map(obj);}
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
const minimum=(values:unknown[])=>text(values.reduce((a,b)=>time(a)<time(b)?a:b));
function input(db:Database.Database,workspace:string,actor:{id:string},modelId:string,id:unknown,now:string) {
  const row=actionRead(db,"investor_monitor_evidence_inputs",id,workspace),document=actionJson(row.document_json,1048576);
  actionAudit(db,workspace,row,"investor_admit_monitor_source","investor_monitor_evidence_input");validateInvestorMonitorDataDocument("input",document);
  check(row.model_id===modelId && row.actor_id===actor.id && row.source_qualification==="owner_reviewed_reconstructed"
    && canonical(document)===row.document_json && hash(document)===row.content_hash && document.workspace_id===workspace && document.model_id===modelId
    && document.created_at===row.created_at && document.valid_until===row.valid_until && document.source_qualification===row.source_qualification && time(row.created_at)<=time(now));
  return {row,document};
}
function reviewKind(db:Database.Database,workspace:string,id:unknown) {
  const row=db.prepare("SELECT s.kind FROM investor_review_headers r JOIN investor_data_sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id WHERE r.id=? AND r.workspace_id=?")
    .get(id,workspace) as Obj|undefined;check(row);return text(row.kind);
}
function snapshot(db:Database.Database,workspace:string,actor:{id:string},segment:Obj,now:string,frozen:string) {
  const manifest=obj(segment.snapshot),audited=manifest.schema_version==="investor-monitor-source-snapshot-v2",confirmed=manifest.schema_version!=="investor-data-snapshot-v1";
  validateInvestorSourceDocument(audited?"audited_monitor_snapshot":confirmed?"monitor_snapshot":"snapshot",manifest);
  check(manifest.workspace_id===workspace && manifest.created_at===frozen && time(frozen)<=time(now) && manifest.mode==="reconstructed");
  const refs=rows(manifest.review_refs),reviews=new Map<string,VerifiedSourceReview>(),deadlines:string[]=[];
  check(refs.every((ref,index)=>index===0 || text(refs[index-1].review_id)<text(ref.review_id)));
  const known=new Map<string,VerifiedSourceReview>(),listings=new Map<string,string>();
  for(const ref of refs)if(reviewKind(db,workspace,ref.review_id)!=="actions") {
    const value=readInvestorSourceReview(db,workspace,ref,now);known.set(value.row.id,value);
    if(value.source.kind==="listing")listings.set(text(value.facts.listing_id),value.row.id);
  }
  for(const ref of refs) {
    const kind=reviewKind(db,workspace,ref.review_id);let value:VerifiedSourceReview;
    if(kind==="actions") {
      const facts=text(ref.review_id).startsWith(MANAGED_ACTION_PREFIX)?readManagedActionHeader(db,workspace,ref.review_id,now).facts:
        obj(actionJson(actionRead(db,"investor_data_reviews",ref.review_id,workspace).document_json).facts);
      const listingId=listings.get(text(facts.listing_id));check(listingId);
      const retained=readRetainedActionEvidence(db,workspace,actor.id,text(ref.review_id),now,listingId);
      value={row:retained.original_review,source:retained.original_source,facts:retained.original_facts};deadlines.push(retained.proof.valid_until);
    } else {
      value=known.get(text(ref.review_id))!;check(value);deadlines.push(value.row.valid_until);
      if(kind==="calendar")deadlines.push(readInvestorCurrentCalendarReview(db,workspace,value.row.id,now).row.valid_until);
    }
    check(same(ref,{review_id:value.row.id,review_hash:value.row.content_hash,source_id:value.source.id,source_hash:value.source.content_hash})
      && time(value.row.created_at)<=time(frozen) && time(now)<time(value.row.valid_until));
    reviews.set(value.row.id,value);
  }
  const captures=rows(manifest.capture_refs);
  check(captures.length>0 && captures.length<=1000 && captures.every((ref,index)=>index===0 || text(captures[index-1].capture_id)<text(ref.capture_id)));
  for(const ref of captures) {
    const callback=confirmed && ref.kind==="confirmed_sdk",prefix=callback?"investor_confirmed":"investor_price";
    const row=db.prepare(`SELECT * FROM ${prefix}_captures WHERE id=? AND workspace_id=?`).get(ref.capture_id,workspace) as Obj|undefined;
    check(row && time(row.created_at)<=time(frozen) && time(now)<time(row.retain_until)
      && !db.prepare(`SELECT 1 FROM ${prefix}_purges WHERE capture_id=?`).get(ref.capture_id));deadlines.push(text(row.retain_until));
  }
  const actions=[...reviews.values()].filter(row=>row.source.kind==="actions");
  const knowledge=audited?retainedActionAvailabilityRefs(db,workspace,actions,now,frozen,listings):null;
  if(knowledge){check(same(knowledge.refs,manifest.action_availability_refs));if(knowledge.readValidUntil)deadlines.push(knowledge.readValidUntil);}
  const expiry=minimum(deadlines);
  // The assembler compares the original retained deadlines, never substitutes a new access deadline into old hashes.
  const originalExpiry=minimum([...reviews.values()].map(row=>row.row.valid_until).concat(captures.map(ref=>{
    const prefix=confirmed && ref.kind==="confirmed_sdk"?"investor_confirmed":"investor_price";
    return text(obj(db.prepare(`SELECT retain_until FROM ${prefix}_captures WHERE id=? AND workspace_id=?`).get(ref.capture_id,workspace)).retain_until);
  })));
  const rebuilt=assembleInvestorSourceSnapshot(db,workspace,{...segment,created_at:frozen,valid_until:originalExpiry},now,confirmed,reviews,knowledge?.refs??null);
  check(rebuilt.dataset && rebuilt.catalog && rebuilt.reviews && rebuilt.valid_until && !rebuilt.unavailable_reason);
  return {...rebuilt,readValidUntil:minimum([expiry,originalExpiry]),ancestry:knowledge?.ancestry??new Map<string,Map<string,string>>()};
}
function baseSource(db:Database.Database,workspace:string,actor:{id:string},definition:Obj,document:Obj,now:string):Source {
  validateInvestorMonitorDataDocument("input",document);
  const frozen=text(document.created_at),settings=obj(document.settings),costDeadline=verifyMonitorCostSettings(db,workspace,definition,settings,frozen);
  check((legacy.has(text(document.schema_version)) || document.schema_version==="investor-monitor-data-input-v4")
    && document.workspace_id===workspace && document.model_id===definition.model_id && document.target_definition_hash===definition.target_definition_hash
    && time(definition.created_at)<=time(frozen) && time(frozen)<=time(now) && time(now)<time(document.valid_until) && time(frozen)<time(definition.valid_until));
  const catalog=Object.create(null) as Record<string,Obj>,reviews=new Map<string,VerifiedSourceReview>(),observations=new Map<string,Obj>(),sessions:Obj[]=[],markets=new Set<string>();
  const deadlines:string[]=[],readDeadlines:string[]=[],availabilityRefs:Obj[]=[],ancestry=new Map<string,Map<string,string>>();
  const segments=rows(document.segments);
  check(segments.every((segment,index)=>index===0 || text(rows(obj(segments[index-1].snapshot).capture_refs)[0].capture_id)<text(rows(obj(segment.snapshot).capture_refs)[0].capture_id)));
  for(const segment of segments) {
    const source=snapshot(db,workspace,actor,segment,now,frozen),scope=new Set(Object.values(source.catalog).map(row=>text(row.market)));
    check(scope.size===1 && [...scope].every(market=>!markets.has(market)));scope.forEach(market=>markets.add(market));
    for(const [id,value] of Object.entries(source.catalog)){check(!Object.hasOwn(catalog,id));catalog[id]=value;}
    for(const row of source.reviews)reviews.set(row.row.id,row);
    for(const row of source.dataset.observations){const prior=observations.get(text(row.id));check(!prior || same(prior,row));observations.set(text(row.id),row);}
    sessions.push(...source.dataset.sessions);deadlines.push(source.valid_until);readDeadlines.push(source.readValidUntil);
    for(const [id,value] of source.ancestry)ancestry.set(id,value);
    if(document.schema_version==="investor-monitor-data-input-v4")availabilityRefs.push(...rows(obj(segment.snapshot).action_availability_refs));
  }
  check(deadlines.length>0 && minimum(deadlines)===document.valid_until);
  const projection=projectInvestorMonitorProjection(definition,document,{reviews,catalog,observations,sessions,markets,availabilityRefs,costDeadline});
  check(hash(projection)===document.projection_hash);
  let version=segments.some(row=>obj(row.snapshot).schema_version==="investor-monitor-price-snapshot-v1")?"investor-monitor-data-input-v2":"investor-monitor-data-input-v1";
  if(Object.hasOwn(settings,"cost_assumptions"))version="investor-monitor-data-input-v3";
  if(document.schema_version==="investor-monitor-data-input-v4")version="investor-monitor-data-input-v4";
  check(document.schema_version===version);
  return {document,projection,catalog,reviews:[...reviews.values()],ancestry,readValidUntil:minimum(readDeadlines)};
}
function audited(definition:Obj,source:Source) {
  const targets=new Map(rows(definition.targets).map(row=>[text(row.listing_id),row])),refs=rows(source.document.segments).flatMap(row=>rows(obj(row.snapshot).action_availability_refs));
  const available=indexActionAvailability(source.reviews.filter(row=>row.source.kind==="actions"),refs,text(source.document.created_at)),actions:Obj[]=[];
  const millis=(value:unknown)=>{const at=time(value);check(at%1000n===0n);return new Date(Number(at/1000n)).toISOString();};
  for(const review of source.reviews)if(review.source.kind==="actions") {
    const target=targets.get(text(review.facts.listing_id));check(target);
    for(const event of rows(review.facts.events)) {
      const common={listing_id:target.listing_id,known_at:available(review.row.id,event.id).known_at},id=text(event.id);
      if(event.type==="split")actions.push({...common,id:"split:"+id,kind:"split",effective_at:millis(event.at),ratio:event.ratio});
      else actions.push({...common,id:"ex:"+id,kind:"dividend_ex",effective_at:millis(event.at),currency:target.currency,
        net_per_unit:new Decimal(text(event.gross_per_unit)).sub(text(event.tax_per_unit)).toFixed(),entitlement_id:"entitlement:"+id,
        tax_assumption_hash:hash({tax_assumption:review.facts.tax_assumption,tax_per_unit:event.tax_per_unit})},
        {...common,id:"pay:"+id,kind:"dividend_payment",effective_at:millis(event.pay_at),currency:target.currency,entitlement_id:"entitlement:"+id,ex_at:millis(event.at)});
    }
  }
  check(actions.length<=20000 && new Set(actions.map(row=>row.id)).size===actions.length);return actions.sort((a,b)=>cmp(text(a.id),text(b.id)));
}
function carryActions(ledger:Ledger,actions:Obj[]) {
  const current=new Map(actions.map(row=>[text(row.id),row]));check(current.size===actions.length);
  return [...ledger].sort(([a],[b])=>cmp(a,b)).map(([id,bound])=>{
    const replacement=current.get(id);check(replacement);
    const economics=(value:Obj)=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=="known_at"));
    check(same(economics(bound.action),economics(replacement)) && time(replacement.known_at)<=time(bound.action.known_at));
    return {id,original_input_id:bound.input_id,original_input_hash:bound.input_hash,original_action_hash:hash(bound.action),audited_action_hash:hash(replacement),
      recorded_known_at:bound.action.known_at,audited_known_at:replacement.known_at};
  });
}
function unprocessedHistory(definition:Obj,state:Obj,ledger:Ledger,actions:Obj[]) {
  const markets=new Map(rows(definition.targets).map(row=>[text(row.listing_id),text(row.market)]));
  for(const action of actions){const market=markets.get(text(action.listing_id));check(market);
    check(ledger.has(text(action.id)) || !(time(obj(state.initialized_at)[market])<time(action.effective_at) && time(action.effective_at)<=time(obj(state.market_cutoffs)[market])));}
}
function originPin(db:Database.Database,workspace:string,review:VerifiedSourceReview,now:string) {
  if(!review.row.id.startsWith(MANAGED_ACTION_PREFIX))return [review.row.id,review.row.content_hash];
  const row=actionRead(db,"investor_action_publications",review.row.id,workspace),grant=readManagedActionAuthorityWitness(db,workspace,row.authority_id,now);
  return [text(grant.doc.base_review_id),text(grant.doc.base_review_hash)];
}
function actionExtension(db:Database.Database,workspace:string,previous:Source,current:Source,now:string) {
  const actions=(source:Source)=>new Map(source.reviews.filter(row=>row.source.kind==="actions").map(row=>[text(row.facts.listing_id),row]));
  const before=actions(previous),after=actions(current);check(same([...before.keys()].sort(),[...after.keys()].sort()));
  for(const [id,review] of before){const selected=after.get(id)!,[original,digest]=originPin(db,workspace,review,now);
    check(current.ancestry.get(selected.row.id)?.get(original)===digest && text(selected.facts.range_start)<=text(review.facts.range_start)
      && text(review.facts.range_end)<=text(selected.facts.range_end));}
}
function previewScope(db:Database.Database,workspace:string,definition:Obj,previous:Source,candidate:Source,now:string) {
  const old=previous.document,next=candidate.document,settings=structuredClone(obj(old.settings)),cost=monitorCostsAt(db,workspace,definition,text(next.created_at));
  if(cost){settings.cost_assumptions=cost.binding;obj(settings.policy).costs=cost.costs;}else check(!Object.hasOwn(settings,"cost_assumptions"));
  const before=rows(old.segments),after=rows(next.segments);check(same(settings,next.settings) && before.length===after.length);
  for(const [index,segment] of before.entries()) {
    const original=obj(segment.snapshot),selected=obj(after[index].snapshot),nonActions=(value:Obj)=>rows(value.review_refs).filter(ref=>reviewKind(db,workspace,ref.review_id)!=="actions");
    check(same(nonActions(original),nonActions(selected)));
    const expected={...original,schema_version:"investor-monitor-source-snapshot-v2",created_at:next.created_at,
      capture_refs:original.schema_version==="investor-data-snapshot-v1"?rows(original.capture_refs).map(row=>({kind:"historical_sdk",...row})):original.capture_refs,
      review_refs:selected.review_refs,action_availability_refs:selected.action_availability_refs,
      publication_times:"reconstructed_prices_and_audited_action_review_times_not_point_in_time",use_scope:"monitor_only"};check(same(expected,selected));
  }
  actionExtension(db,workspace,previous,candidate,now);
}
type TransitionContext={receipt:Obj;admission:Obj;ledger:Ledger;state:Obj;candidate:Source};
function bindV5(db:Database.Database,workspace:string,definition:Obj,raw:Source,context:TransitionContext,now:string):Source {
  const {receipt,ledger,state}=context;check(time(context.admission.created_at)<=time(raw.document.created_at) && time(raw.document.created_at)<=time(now) && time(now)<time(receipt.valid_until));
  actionExtension(db,workspace,context.candidate,raw,now);const actions=audited(definition,raw),carry=carryActions(ledger,actions);
  check(hash(carry)===receipt.carry_hash && carry.length===receipt.carry_count);unprocessedHistory(definition,state,ledger,actions);
  const indexed=new Map(actions.map(row=>[text(row.id),row])),projection=structuredClone(raw.projection);
  for(const action of rows(projection.corporate_actions)){check(same(action,indexed.get(text(action.id))));if(ledger.has(text(action.id)))action.known_at=ledger.get(text(action.id))!.action.known_at;}
  const reference={id:receipt.confirmation_id,content_hash:hash(receipt)};
  Object.assign(projection,{schema_version:"investor-monitor-data-projection-v3",transition:reference,knowledge_protocol:"owner_confirmed_legacy_accounting_carry_v1",
    valid_until:minimum([projection.valid_until,receipt.valid_until])});
  for(const row of [...rows(projection.quotes),...rows(projection.fx)])row.valid_until=minimum([row.valid_until,receipt.valid_until]);
  validateInvestorMonitorDataDocument("projection",projection);
  const document={...raw.document,schema_version:"investor-monitor-data-input-v5",transition:reference,audited_projection_hash:raw.document.projection_hash,
    audited_valid_until:raw.document.valid_until,projection_hash:hash(projection),valid_until:minimum([raw.document.valid_until,receipt.valid_until])};
  validateInvestorMonitorDataDocument("input",document);return {...raw,document,projection};
}
function payload(db:Database.Database,id:unknown) {
  const row=db.prepare("SELECT payload FROM investor_evidence_checkpoint_payloads WHERE checkpoint_id=?").get(id) as {payload:Buffer}|undefined;
  check(row && Buffer.isBuffer(row.payload) && row.payload.length>0 && row.payload.length<=4194304);
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(row.payload),value=actionJson(raw,4194304);
  check(canonical(value)===raw);validateInvestorEvidenceCheckpoint(value);return value;
}
function source(db:Database.Database,workspace:string,actor:{id:string},definition:Obj,document:Obj,now:string,bindings:Obj[],protocols:string[],ledger:Ledger):Source {
  if(document.schema_version!=="investor-monitor-data-input-v5")return baseSource(db,workspace,actor,definition,document,now);
  const reference=obj(document.transition),receipt=readLegacyTransitionConfirmationReceipt(db,actor,workspace,text(reference.id));
  check(reference.content_hash===hash(receipt) && receipt.model_hash===hash(definition) && receipt.model_id===definition.model_id
    && time(receipt.created_at)<=time(now) && time(now)<time(receipt.valid_until));
  const admissionRow=db.prepare("SELECT id FROM investor_legacy_transition_admissions WHERE workspace_id=? AND transition_id=?").get(workspace,reference.id) as Obj|undefined;check(admissionRow);
  const registration=readLegacyTransitionRegistrationReceipt(db,actor,workspace,text(admissionRow.id)),admission=registration.admission;check(same(registration.confirmation,receipt));
  const checkpoint=obj(receipt.checkpoint),sequence=checkpoint.sequence;check(typeof sequence==="number" && Number.isInteger(sequence) && sequence>=1 && sequence<=bindings.length
    && protocols.slice(0,sequence).every(protocol=>legacy.has(protocol)));
  const head=bindings[sequence-1],state=payload(db,head.id);check(hash(state)===head.content_hash && same(checkpoint,{id:head.id,sequence,content_hash:head.content_hash,
    chain_hash:hash(bindings.slice(0,sequence)),processed_actions_hash:hash(state.processed_actions)}));
  const prefix:Ledger=new Map();for(const id of Object.keys(obj(state.processed_actions))){const bound=ledger.get(id);check(bound);prefix.set(id,bound);}
  check(same(Object.fromEntries([...prefix].map(([id,value])=>[id,hash(value.action)])),state.processed_actions));
  const old=input(db,workspace,actor,text(definition.model_id),receipt.legacy_input_id,now).document;
  check(legacy.has(text(old.schema_version)) && hash(old)===receipt.legacy_input_hash && receipt.valid_until===minimum([head.valid_until,old.valid_until,definition.valid_until]));
  const control=actionRead(db,"investor_model_controls",receipt.control_id,workspace);check(control.model_id===definition.model_id && hash(control)===receipt.control_hash && time(control.created_at)<=time(receipt.created_at));
  const preview=readLegacyTransitionPreviewWitness(db,actor,workspace,text(receipt.preview_id));
  const storedPreview=actionRead(db,"investor_legacy_transition_previews",receipt.preview_id,workspace),candidateDocument=actionJson(storedPreview.candidate_json,1048576);
  const previous=baseSource(db,workspace,actor,definition,old,now),candidate=baseSource(db,workspace,actor,definition,candidateDocument,now);
  previewScope(db,workspace,definition,previous,candidate,now);const actions=audited(definition,candidate),carry=carryActions(prefix,actions);
  check(hash(carry)===receipt.carry_hash && carry.length===receipt.carry_count && obj(preview.proof).audited_projection_hash===hash(candidate.projection));
  unprocessedHistory(definition,state,prefix,actions);const context={receipt,admission,ledger:prefix,state,candidate};
  const root=input(db,workspace,actor,text(definition.model_id),admission.input_id,now).document;
  const rebuiltRoot=bindV5(db,workspace,definition,baseSource(db,workspace,actor,definition,auditedLegacyTransitionDocument(root),now),context,now);check(same(rebuiltRoot.document,root));
  const rebuilt=bindV5(db,workspace,definition,baseSource(db,workspace,actor,definition,auditedLegacyTransitionDocument(document),now),context,now);check(same(rebuilt.document,document));
  rebuilt.readValidUntil=minimum([rebuilt.readValidUntil,previous.readValidUntil,candidate.readValidUntil,rebuiltRoot.readValidUntil,receipt.valid_until]);return rebuilt;
}

/** Reconstruct recorded history only; all raw access uses now, never an old permission clock. */
export function readRetainedMonitorHistory(db:Database.Database,workspace:string,actor:{id:string},modelId:string,now:string) {
  return db.transaction(()=>{
    const checked=time(now);check(checked%1000n===0n);now=new Date(Number(checked/1000n)).toISOString();
    check((db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj|undefined)?.owner_id===actor.id);
    const model=actionRead(db,"investor_models",modelId,workspace),definition=actionJson(model.document_json,1048576);validateInvestorModelDocument("definition",definition);
    const profile=db.prepare("SELECT * FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspace) as Obj|undefined;
    const selection=db.prepare("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace) as Obj|undefined;
    const reference=readEvidenceReference(db,workspace,text(model.plan_id),now);
    check(profile && selection && reference && !reference.unavailable_reason && hash(definition)===model.content_hash
      && definition.model_id===modelId && definition.profile_id===model.profile_id && definition.plan_id===model.plan_id && definition.created_at===model.created_at
      && profile.id===model.profile_id && hash(actionJson(profile.document_json))===profile.content_hash && profile.content_hash===definition.profile_hash
      && profile.version===definition.profile_version && selection.plan_id===model.plan_id && time(profile.created_at)<=time(now)
      && reference.row.content_hash===definition.plan_hash && reference.document.profile_id===profile.id && reference.document.data_mode==="reconstructed"
      && reference.document.valid_until===definition.valid_until && time(definition.created_at)<=time(now) && time(now)<time(definition.valid_until)
      && same(reference.document.targets.map(({listing_id,market,currency,weight})=>({listing_id,market,currency,weight})),definition.targets)
      && (definition.schema_version==="investor-model-definition-v2")===(reference.document.schema_version==="investor-reference-plan-v2")
      && (reference.document.schema_version!=="investor-reference-plan-v2" || same(definition.fixed_policy,reference.document.fixed_policy))
      && !fixedPolicyUnsupported(reference.document));
    const headers=db.prepare("SELECT * FROM investor_evidence_model_checkpoints WHERE workspace_id=? AND model_id=? ORDER BY sequence LIMIT 1001").all(workspace,modelId) as Obj[];
    check(headers.length>0 && headers.length<=1000);const bindings:Obj[]=[],protocols:string[]=[],ledger:Ledger=new Map();
    let previous:Obj|null=null,origin:Obj|null=null,firstProjection:Obj|null=null,finalProjection:Obj|null=null,expiry=text(definition.valid_until),readDeadline=expiry;
    for(const [index,header] of headers.entries()) {
      check(header.sequence===index+1 && header.previous_hash===(previous?hash(previous):null) && time(header.created_at)<=time(now) && time(now)<time(header.valid_until)
        && !db.prepare("SELECT 1 FROM investor_monitor_payload_purges WHERE kind='checkpoint' AND entity_id=?").get(header.id));
      const bound=input(db,workspace,actor,modelId,header.input_id,now);expiry=minimum([expiry,bound.document.valid_until]);check(header.valid_until===expiry);
      const rebuilt=source(db,workspace,actor,definition,bound.document,now,bindings,protocols,ledger);readDeadline=minimum([readDeadline,rebuilt.readValidUntil]);
      const targets=reference.document.targets;check(targets.length===Object.keys(rebuilt.catalog).length);
      for(const target of targets){const listing=rebuilt.catalog[target.listing_id];check(listing && listing.provider_symbol===target.symbol && listing.market===target.market && listing.currency===target.currency);}
      verifyMonitorCostSettings(db,workspace,definition,obj(bound.document.settings),text(header.created_at));const stored=payload(db,header.id);
      const funding=stored.schema_version==="investor-evidence-model-checkpoint-v3"?readBoundPlannedFundingMonitor(db,actor,workspace,stored.funding_binding as PlannedFundingBinding,text(header.created_at),now):null;
      const result=replayEvidenceModel(definition,rebuilt.projection,previous,text(header.created_at),text(bound.row.content_hash),false,funding?.request??null);
      check(same(result.checkpoint,stored) && hash(stored)===header.content_hash && stored.projection_hash===header.projection_hash && header.projection_hash===hash(rebuilt.projection));
      for(const action of rows(rebuilt.projection.corporate_actions)){const id=text(action.id);check(obj(stored.processed_actions)[id]===hash(action));if(!ledger.has(id))ledger.set(id,{action,input_id:text(bound.row.id),input_hash:text(bound.row.content_hash)});}
      check(same(Object.fromEntries([...ledger].map(([id,value])=>[id,hash(value.action)])),stored.processed_actions));
      bindings.push({...header,input_hash:bound.row.content_hash});protocols.push(text(bound.document.schema_version));if(!origin){origin=stored;firstProjection=rebuilt.projection;}
      previous=stored;finalProjection=rebuilt.projection;
    }
    const control=db.prepare("SELECT * FROM investor_model_controls WHERE model_id=? ORDER BY version DESC LIMIT 1").get(modelId) as Obj|undefined;check(control && time(control.created_at)<=time(now));
    check(origin && previous && firstProjection && finalProjection);
    const actions=[...ledger].sort(([a],[b])=>cmp(a,b)).map(([,value])=>value.action);
    const proof={schema_version:"investor-retained-monitor-history-v1",workspace_id:workspace,actor_id:actor.id,model_id:modelId,model_hash:model.content_hash,control_hash:hash(control),
      origin_checkpoint_id:bindings[0].id,head_checkpoint_id:bindings.at(-1)!.id,head_checkpoint_sequence:bindings.length,checkpoint_chain_hash:hash(bindings),original_actions_hash:hash(actions),
      input_bindings:bindings.map((row,index)=>({checkpoint_id:row.id,sequence:row.sequence,checkpoint_hash:row.content_hash,input_id:row.input_id,input_hash:row.input_hash,
        input_protocol:protocols[index],projection_hash:row.projection_hash,created_at:row.created_at,valid_until:row.valid_until})),checked_at:now,source_valid_until:minimum([expiry,readDeadline]),
      purpose:"recorded_history_comparison_only",status:"original_history_replayed_not_recovered",original_inputs_replayed:true,original_states_replayed:true,original_knowledge_replayed:true,
      reference_source_current_at_check:true,corrected_source_evidence_verified:false,current_source_eligibility_restored:false,economic_correction_approved:false,checkpoint_created:false,
      monitoring_resumed:false,historical_observations_rewritten:false,trading_permission:false,provider_calls:0,database_writes:0,distribution:"private_owner_only_not_ai"};
    validateRetainedMonitorHistoryProof(proof);return {definition,origin,head:previous,origin_projection:firstProjection,head_projection:finalProjection,original_actions:actions,proof};
  }).deferred();
}
