import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import DecimalJs from "decimal.js";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {basename,resolve} from "node:path";
import buySchema from "../../../../contracts/v1/bounded-cash-buy.schema.json";
import schema from "../../../../contracts/v1/bounded-cash-journal.schema.json";
import {buyDigest, buyImplementationHash, executeBuys, planBuys, type BuyInput, type BuyPlan, type BuyPolicy, type BuyOutcome, type BuyResult} from "./bounded-cash";

const ENGINE = "bounded-cash-journal-sandbox-v1";
const D = DecimalJs.clone({precision:160,rounding:DecimalJs.ROUND_HALF_EVEN,toExpNeg:-200,toExpPos:200});
const ajv = new Ajv2020({strict:true,strictRequired:false}); addFormats(ajv); ajv.addSchema(buySchema); ajv.addSchema(schema);
const sources = ["contracts/v1/bounded-cash-journal.schema.json","worker/execution_sandbox/journal.py",
  "worker/execution_sandbox/journal_store.py","web/src/server/execution-sandbox/journal.ts"];
export type StudyDeclaration = {schema_version:"bounded-cash-study-declaration-v1"; engine_version:typeof ENGINE; study_id:string;
  registered_at:string; qualification:"synthetic_test_only"; policy:BuyPolicy; implementation_hash:string; buy_implementation_hash:string;
  parameters_independently_preregistered:false; live_advice_eligible:false};
type PlannedBatch = {input:BuyInput; plan:BuyPlan};
export type JournalCommand = {command_id:string;at:string} & (
  {kind:"cash_contribution";payload:{contribution_id:string;amount_cny:string}}
  | {kind:"buy_plan";payload:PlannedBatch}
  | {kind:"buy_resolution";payload:{batch_id:string;outcome:BuyOutcome;result:BuyResult}});
export type JournalEvent = JournalCommand & {schema_version:"bounded-cash-event-v1";sequence:number;previous_hash:string;
  before_state_hash:string;after_state_hash:string;event_hash:string};
export type CashJournal = {schema_version:"bounded-cash-journal-v1";declaration:StudyDeclaration;declaration_hash:string;
  events:JournalEvent[];head_hash:string;journal_hash:string};
export type CashState = {schema_version:"bounded-cash-state-v1";study_id:string;revision:number;last_event_at:string;
  settled_cash_cny:string;total_contributions_cny:string;reserved_cny:string;free_cash_cny:string;
  positions:Record<string,string>;quantity_steps:Record<string,string>;open_batches:Record<string,PlannedBatch>;
  closed_batches:Record<string,string>;used_order_ids:string[];contribution_ids:string[];execution_failure_count:number;state_hash:string};
type UnsealedState = Omit<CashState,"reserved_cny"|"free_cash_cny"|"state_hash">;

function requireValue(value: unknown, code: string): asserts value {if (!value) throw new Error("CASH_JOURNAL_"+code);}
function contract(value:unknown,kind:string) {requireValue(ajv.getSchema(schema.$id+"#/$defs/"+kind)!(value),"CONTRACT_INVALID");}
function text(value:DecimalJs) {return value.isZero() ? "0" : value.toFixed();}
function time(value:string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(value);
  requireValue(match && !value.startsWith("0000"),"INSTANT_INVALID");
  const ms = Date.parse(match[1]+"Z"); requireValue(Number.isFinite(ms) && new Date(ms).toISOString().slice(0,19)===match[1],"INSTANT_INVALID");
  return BigInt(ms)*1000n+BigInt(match[2]);
}
function sealed(value:Record<string,unknown>,field:string) {const body={...value};delete body[field];requireValue(buyDigest(body)===value[field],"HASH_MISMATCH");}
export function journalImplementationHash() {
  const root = resolve(basename(process.cwd())==="web" ? ".." : ".");
  return buyDigest({engine_version:ENGINE,buy_implementation_hash:buyImplementationHash(),sources:Object.fromEntries(sources.map(path =>
    [path,createHash("sha256").update(readFileSync(resolve(root,path))).digest("hex")]))});
}
function declaration(value:StudyDeclaration) {
  contract(value,"declaration"); time(value.registered_at);
  requireValue(value.implementation_hash===journalImplementationHash() && value.buy_implementation_hash===buyImplementationHash(),"IMPLEMENTATION_CHANGED");
  requireValue([value.policy.price_buffer_bps,value.policy.commission_bps,value.policy.slippage_bps].every(rate=>new D(rate).lte(10000))
    && new D(value.policy.slippage_bps).lte(value.policy.price_buffer_bps),"POLICY_INVALID");
}
export function declareStudy(studyId:string,registeredAt:string,policy:BuyPolicy):StudyDeclaration {
  const result:StudyDeclaration={schema_version:"bounded-cash-study-declaration-v1",engine_version:ENGINE,study_id:studyId,registered_at:registeredAt,
    qualification:"synthetic_test_only",policy:structuredClone(policy),implementation_hash:journalImplementationHash(),buy_implementation_hash:buyImplementationHash(),
    parameters_independently_preregistered:false,live_advice_eligible:false};
  declaration(result); return result;
}
export function newJournal(value:StudyDeclaration):CashJournal {
  declaration(value); const hash=buyDigest(value);
  const body={schema_version:"bounded-cash-journal-v1" as const,declaration:structuredClone(value),declaration_hash:hash,events:[] as JournalEvent[],head_hash:hash};
  return {...body,journal_hash:buyDigest(body)};
}
export function journalReservations(state:Pick<CashState,"open_batches">) {
  return Object.values(state.open_batches).flatMap(batch=>batch.plan.orders.filter(order=>new D(order.reserved_cny).gt(0))
    .map(order=>({order_id:order.order_id,budget_cny:order.reserved_cny}))).sort((a,b)=>a.order_id<b.order_id?-1:a.order_id>b.order_id?1:0);
}
function finishState(value:UnsealedState):CashState {
  const reserved=journalReservations(value).reduce((sum,row)=>sum.add(row.budget_cny),new D(0)),cash=new D(value.settled_cash_cny);
  requireValue(reserved.gte(0) && cash.gte(reserved) && cash.lte("999999999999999999.99"),"CASH_INVARIANT_BROKEN");
  const body={...value,reserved_cny:text(reserved),free_cash_cny:text(cash.sub(reserved))},result={...body,state_hash:buyDigest(body)};
  contract(result,"state");return result;
}
function initial(value:StudyDeclaration):CashState {
  return finishState({schema_version:"bounded-cash-state-v1",study_id:value.study_id,revision:0,last_event_at:value.registered_at,
    settled_cash_cny:"0",total_contributions_cny:"0",positions:{},quantity_steps:{},open_batches:{},closed_batches:{},used_order_ids:[],contribution_ids:[],execution_failure_count:0});
}
function commandFromEvent(event:JournalEvent):JournalCommand {
  return structuredClone({command_id:event.command_id,at:event.at,kind:event.kind,payload:event.payload}) as JournalCommand;
}
function transition(state:CashState,value:StudyDeclaration,command:JournalCommand):CashState {
  contract(command,"command");const at=time(command.at);requireValue(at>=time(state.last_event_at),"TIME_REVERSED");
  const due=Object.entries(state.open_batches).map(([id,batch])=>({id,deadline:batch.plan.orders.map(order=>time(order.expires_at)).reduce((a,b)=>a>b?a:b)}))
    .filter(row=>row.deadline<=at);
  if (due.length) {
    const earliest=due.map(row=>row.deadline).reduce((a,b)=>a<b?a:b);
    requireValue(command.kind==="buy_resolution" && due.some(row=>row.id===command.payload.batch_id && row.deadline===earliest),"RESOLVE_DUE_BATCH_FIRST");
  }
  const {state_hash:ignoredHash,reserved_cny:ignoredReserved,free_cash_cny:ignoredFree,...body}=structuredClone(state);
  void ignoredHash;void ignoredReserved;void ignoredFree;
  if (command.kind==="cash_contribution") {
    const payload=command.payload;
    requireValue(!state.contribution_ids.includes(payload.contribution_id),"CONTRIBUTION_ALREADY_USED");
    requireValue(new D(payload.amount_cny).gt(0),"CONTRIBUTION_NOT_POSITIVE");
    body.settled_cash_cny=text(new D(state.settled_cash_cny).add(payload.amount_cny));
    body.total_contributions_cny=text(new D(state.total_contributions_cny).add(payload.amount_cny));
    body.contribution_ids=[...state.contribution_ids,payload.contribution_id].sort();
  } else if (command.kind==="buy_plan") {
    const {input,plan}=command.payload,id=input.batch_id;
    requireValue(command.at===input.decision_at,"DECISION_TIME_MISMATCH");
    requireValue(buyDigest(input.policy)===buyDigest(value.policy),"FROZEN_POLICY_MISMATCH");
    requireValue(new D(input.settled_cash_cny).eq(state.settled_cash_cny) && new D(input.unsettled_receivable_cny).isZero(),"CASH_SNAPSHOT_MISMATCH");
    requireValue(buyDigest(input.existing_reservations)===buyDigest(journalReservations(state)),"RESERVATION_SNAPSHOT_MISMATCH");
    requireValue(!Object.hasOwn(state.open_batches,id) && !Object.hasOwn(state.closed_batches,id),"BATCH_ALREADY_USED");
    requireValue(input.orders.every(order=>!state.used_order_ids.includes(order.order_id)),"ORDER_ALREADY_USED");
    requireValue(buyDigest(plan)===buyDigest(planBuys(input)),"PLAN_REPLAY_MISMATCH");
    for (const order of input.orders) {
      const step=text(new D(order.quantity_step));
      requireValue(!Object.hasOwn(body.quantity_steps,order.listing_id) || body.quantity_steps[order.listing_id]===step,"QUANTITY_STEP_CHANGED");
      body.quantity_steps[order.listing_id]=step;
    }
    requireValue(Object.keys(body.open_batches).length<20 && Object.keys(body.quantity_steps).length<=20,"STUDY_SCOPE_LIMIT");
    body.open_batches[id]=structuredClone(command.payload);
    body.used_order_ids=[...state.used_order_ids,...input.orders.map(order=>order.order_id)].sort();
  } else {
    const payload=command.payload,id=payload.batch_id;
    requireValue(Object.hasOwn(state.open_batches,id),"BATCH_NOT_OPEN");
    requireValue(command.at===payload.outcome.evaluated_at,"EVALUATION_TIME_MISMATCH");
    const batch=state.open_batches[id],result=executeBuys(batch.input,batch.plan,payload.outcome);
    requireValue(buyDigest(result)===buyDigest(payload.result),"RESULT_REPLAY_MISMATCH");
    body.settled_cash_cny=text(new D(state.settled_cash_cny).sub(result.total_debited_cny));
    for (const order of result.orders) if (order.status==="simulated_filled") {
      const prior=Object.hasOwn(body.positions,order.listing_id)?body.positions[order.listing_id]:"0";
      body.positions[order.listing_id]=text(new D(prior).add(order.quantity));
    }
    delete body.open_batches[id];body.closed_batches[id]=result.result_hash;
    body.execution_failure_count+=result.execution_failure_count;
  }
  body.revision=state.revision+1;body.last_event_at=command.at;return finishState(body);
}

export function replayJournal(journal:CashJournal):CashState {
  contract(journal,"journal");sealed(journal,"journal_hash");declaration(journal.declaration);
  requireValue(buyDigest(journal.declaration)===journal.declaration_hash,"DECLARATION_HASH_MISMATCH");
  let state=initial(journal.declaration),previous=journal.declaration_hash;const ids=new Set<string>();
  for (const [index,event] of journal.events.entries()) {
    sealed(event,"event_hash");
    requireValue(event.sequence===index+1 && event.previous_hash===previous && event.before_state_hash===state.state_hash,"CHAIN_MISMATCH");
    requireValue(!ids.has(event.command_id),"COMMAND_ALREADY_USED");
    state=transition(state,journal.declaration,commandFromEvent(event));
    requireValue(event.after_state_hash===state.state_hash,"STATE_REPLAY_MISMATCH");previous=event.event_hash;ids.add(event.command_id);
  }
  requireValue(previous===journal.head_hash,"HEAD_HASH_MISMATCH");return state;
}
export function appendJournalCommand(journal:CashJournal,command:JournalCommand):CashJournal {
  const before=replayJournal(journal);contract(command,"command");requireValue(journal.events.length<512,"EVENT_LIMIT");
  requireValue(!journal.events.some(event=>event.command_id===command.command_id),"COMMAND_ALREADY_USED");
  const after=transition(before,journal.declaration,command);
  const eventBody={schema_version:"bounded-cash-event-v1" as const,sequence:after.revision,...structuredClone(command),
    previous_hash:journal.head_hash,before_state_hash:before.state_hash,after_state_hash:after.state_hash};
  const event={...eventBody,event_hash:buyDigest(eventBody)};
  const {journal_hash:ignored,...old}=structuredClone(journal);void ignored;
  const body={...old,events:[...old.events,event],head_hash:event.event_hash},result={...body,journal_hash:buyDigest(body)};
  contract(result,"journal");return result;
}
