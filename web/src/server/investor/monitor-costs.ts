import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { priceInstant } from "../market-price-source";
import { validateInvestorModelDocument, validateInvestorMonitorCostRecord } from "./kernel-contracts";
import { monitorCostValuesSchema, monitorCostsIntentSchema, monitorCostStateSchema, type MonitorCostState } from "./monitor-cost-schemas";

type Obj = Record<string, unknown>;
const basis = "owner_research_assumptions_not_verified_broker_tariff";
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_MONITOR_COSTS_INVALID"); }
function json(raw: unknown, maximum = 8192) { check(typeof raw === "string" && Buffer.byteLength(raw) <= maximum); const value = parseStrictJson(raw); check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function values(costs: Obj) { const { assumption_hash: _, ...rest } = costs; return monitorCostValuesSchema.parse(rest); }
function readRecord(db: Database.Database, workspace: string, model: Obj, definition: Obj, row: Obj, at: string) {
  const doc = json(row.document_json), costs = doc.costs === null ? null : doc.costs as Obj;
  validateInvestorMonitorCostRecord(doc);
  check(Object.keys(doc).sort().join() === ["schema_version","workspace_id","model_id","model_hash","profile_hash","plan_hash","version","costs","created_at","effective_from","valid_until","basis","trading_permission"].sort().join()
    && doc.schema_version === "investor-monitor-cost-assumptions-v1" && doc.basis === basis && doc.trading_permission === false
    && canonical(doc) === row.document_json && hash(doc) === row.content_hash && doc.workspace_id === row.workspace_id && row.workspace_id === workspace
    && doc.model_id === row.model_id && row.model_id === model.id && doc.model_hash === model.content_hash
    && doc.profile_hash === definition.profile_hash && doc.plan_hash === definition.plan_hash && doc.version === row.version
    && Number.isSafeInteger(row.version) && Number(row.version) >= 1 && Number(row.version) <= 1000
    && doc.created_at === row.created_at && doc.effective_from === row.effective_from && doc.valid_until === row.valid_until
    && priceInstant(model.created_at) <= priceInstant(doc.created_at) && priceInstant(doc.created_at) <= priceInstant(at)
    && priceInstant(doc.effective_from) === priceInstant(doc.created_at) + 1000n);
  if (costs === null) check(doc.valid_until === null);
  else {
    check(Object.keys(costs).length === 6 && costs.assumption_hash === hash({ schema_version: "investor-owner-monitor-cost-values-v1", ...values(costs) })
      && priceInstant(doc.effective_from) < priceInstant(doc.valid_until) && priceInstant(doc.valid_until) <= priceInstant(definition.valid_until));
  }
  const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
  const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj | undefined;
  check(owner?.owner_id === row.actor_id && audit && audit.actor_id === row.actor_id && audit.action === "investor_set_monitor_costs"
    && audit.object_type === "investor_monitor_cost_assumptions" && audit.object_id === row.id && audit.created_at === row.created_at
    && canonical(json(audit.payload_json)) === canonical({ content_hash: row.content_hash }));
  return doc;
}
export function monitorCostsAt(db: Database.Database, workspace: string, definition: Obj, at: string) {
  const head = db.prepare("SELECT * FROM investor_monitor_cost_assumptions WHERE workspace_id=? AND model_id=? AND effective_from<=? ORDER BY version DESC LIMIT 1")
    .get(workspace, definition.model_id, at) as Obj | undefined;
  if (!head) return null;
  const model = db.prepare("SELECT * FROM investor_models WHERE id=? AND workspace_id=?").get(definition.model_id, workspace) as Obj | undefined;
  check(model && hash(definition) === model.content_hash);
  const rows = db.prepare("SELECT * FROM investor_monitor_cost_assumptions WHERE workspace_id=? AND model_id=? AND version<=? ORDER BY version")
    .all(workspace, model.id, head.version) as Obj[];
  check(rows.length === head.version && rows.length <= 1000);
  let doc: Obj | undefined, previous: Obj | undefined;
  rows.forEach((row, index) => { doc = readRecord(db, workspace, model, definition, row, at); check(row.version === index + 1 && (!previous || priceInstant(previous.effective_from) <= priceInstant(row.created_at))); previous = row; });
  check(doc); const known = doc.costs !== null && priceInstant(at) < priceInstant(doc.valid_until);
  return { row: head, document: doc, binding: { id: head.id, content_hash: head.content_hash }, costs: known ? doc.costs : null, deadline: known ? doc.valid_until as string : null };
}
export function verifyMonitorCostSettings(db: Database.Database, workspace: string, definition: Obj, settings: Obj, created: string) {
  const selected = monitorCostsAt(db, workspace, definition, created);
  if (!selected) { check(!Object.hasOwn(settings, "cost_assumptions")); return null; }
  check(canonical(settings.cost_assumptions) === canonical(selected.binding) && canonical((settings.policy as Obj).costs) === canonical(selected.costs));
  return selected.deadline;
}
function modelContext(db: Database.Database, workspace: string, modelId: string) {
  const row = db.prepare("SELECT * FROM investor_models WHERE id=? AND workspace_id=?").get(modelId, workspace) as Obj | undefined;
  check(row); const definition = json(row.document_json); validateInvestorModelDocument("definition", definition);
  check(hash(definition) === row.content_hash && definition.model_id === row.id && definition.created_at === row.created_at);
  return { row, definition };
}
export function appendMonitorCosts(db: Database.Database, workspace: string, actor: string, raw: unknown, now: string) {
  const input = monitorCostsIntentSchema.parse(raw), { row, definition } = modelContext(db, workspace, input.model_id);
  if ((input.costs === null) !== (input.validity_days === null)) throw new Error("INVESTOR_MONITOR_COSTS_INPUT_INVALID");
  const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
  const selected = db.prepare("SELECT plan_id FROM investor_plan_selections WHERE workspace_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace) as Obj | undefined;
  const profile = db.prepare("SELECT id,content_hash FROM investor_profiles WHERE workspace_id=? ORDER BY version DESC LIMIT 1").get(workspace) as Obj | undefined;
  const prior = db.prepare("SELECT * FROM investor_monitor_cost_assumptions WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, row.id) as Obj | undefined;
  if (owner?.owner_id !== actor || row.content_hash !== input.model_hash || selected?.plan_id !== row.plan_id || profile?.id !== row.profile_id
    || profile?.content_hash !== definition.profile_hash || definition.data_mode !== "reconstructed" || priceInstant(now) >= priceInstant(definition.valid_until)
    || input.expected_cost_version !== (prior?.version ?? 0) || prior && priceInstant(now) < priceInstant(prior.effective_from)) throw new Error("INVESTOR_MONITOR_COSTS_CONTEXT_CONFLICT");
  if (prior) readRecord(db, workspace, row, definition, prior, now);
  const costValues = input.costs, costs = costValues === null ? null : { ...costValues, assumption_hash: hash({ schema_version: "investor-owner-monitor-cost-values-v1", ...costValues }) };
  const effective = new Date(Number(priceInstant(now) / 1000n) + 1).toISOString();
  const expiry = costs === null ? null : new Date(Math.min(Number(priceInstant(definition.valid_until) / 1000n), Number(priceInstant(now) / 1000n) + input.validity_days! * 86400000)).toISOString();
  if (expiry !== null && effective >= expiry) throw new Error("INVESTOR_MONITOR_COSTS_CONTEXT_CONFLICT");
  const version = Number(prior?.version ?? 0) + 1; check(version <= 1000);
  const doc = { schema_version: "investor-monitor-cost-assumptions-v1", workspace_id: workspace, model_id: row.id, model_hash: row.content_hash,
    profile_hash: definition.profile_hash, plan_hash: definition.plan_hash, version, costs, created_at: now, effective_from: effective,
    valid_until: expiry, basis, trading_permission: false }, id = randomUUID(), digest = hash(doc), auditId = randomUUID();
  db.prepare("INSERT INTO audit_events(id,actor_id,action,object_type,object_id,payload_json,created_at) VALUES(?,?,'investor_set_monitor_costs','investor_monitor_cost_assumptions',?,?,?)")
    .run(auditId, actor, id, canonical({ content_hash: digest }), now);
  db.prepare("INSERT INTO investor_monitor_cost_assumptions VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, workspace, row.id, version, canonical(doc), digest, actor, now, effective, expiry, auditId);
  return { id, audit_id: auditId };
}
export function readMonitorCostState(db: Database.Database, workspace: string, modelId: string, now: string, editable: boolean): MonitorCostState {
  const { row, definition } = modelContext(db, workspace, modelId);
  const latest = db.prepare("SELECT * FROM investor_monitor_cost_assumptions WHERE workspace_id=? AND model_id=? ORDER BY version DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
  const doc = latest ? readRecord(db, workspace, row, definition, latest, now) : null;
  const applied = db.prepare("SELECT document_json FROM investor_monitor_evidence_inputs WHERE workspace_id=? AND model_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(workspace, modelId) as Obj | undefined;
  const settings = applied ? json(applied.document_json, 1048576).settings as Obj : null;
  const selected = monitorCostsAt(db, workspace, definition, now);
  const matches = !doc || selected && settings && settings.cost_assumptions !== undefined
    && canonical(settings.cost_assumptions) === canonical(selected.binding)
    && canonical((settings.policy as Obj).costs) === canonical(selected.costs);
  return monitorCostStateSchema.parse({ model_id: modelId, model_hash: row.content_hash,
    status: !doc ? "unknown" : !matches ? "pending" : doc.costs === null ? "unknown" : priceInstant(now) >= priceInstant(doc.valid_until) ? "expired" : "known",
    version: latest?.version ?? 0, costs: doc?.costs ?? null, effective_from: doc?.effective_from ?? null, valid_until: doc?.valid_until ?? null,
    model_valid_until: definition.valid_until, input_applied: !!doc && !!matches, editable, basis, trading_permission: false });
}
