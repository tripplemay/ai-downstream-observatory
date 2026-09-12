import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../../contracts/v1/common.schema.json";
import qualitySchema from "../../../../contracts/v1/ledger-fact-quality.schema.json";
import { Decimal } from "./decimal";

type Row = Record<string, unknown>;
export type FactQuality = "complete" | "provisional" | "blocked";
type Scope = { event_id: string; account_id: string; listing_id: string | null; currency: string };
export type DividendFactQuality = Scope & {
  gross_amount: string | null; recognized_tax: string | null; tax_status: "unknown" | "estimated" | "confirmed";
  net_status: "final" | "provisional" | null; cash_received: string; receivable: string; tax_payable: string;
  assessment_event_id: string | null; breakdown_event_id: string | null; child_event_ids: string[];
  nav_quality: FactQuality; performance_quality: FactQuality; attribution_quality: FactQuality; issues: string[];
};
export type CorporateActionFactQuality = Scope & {
  action_kind: string; resolution_event_id: string | null; resolution: "not_applicable" | "recorded" | null;
  supporting_event_ids: string[]; status: "unresolved" | "resolved"; issues: string[];
};
export interface LedgerFactQualityInput {
  portfolio_id: string; ledger_revision: number; cutoff_at: string; knowledge_at: string;
  mode: "as_known" | "restated"; period_start?: string | null;
}
export interface LedgerFactQuality {
  schema_version: "ledger-fact-quality-v1"; binding_id: string; portfolio_id: string; ledger_revision: number;
  cutoff_at: string; knowledge_at: string; mode: "as_known" | "restated"; period_start: string | null;
  nav_quality: FactQuality; performance_quality: FactQuality; attribution_quality: FactQuality;
  issues: string[]; dividends: DividendFactQuality[]; corporate_actions: CorporateActionFactQuality[];
  event_hashes: Record<string, string>;
}
type Event = Row & { id: string; portfolio_id: string; account_id: string; event_type: string; ledger_revision: number;
  effective_at: string; recorded_at: string; time_precision: string; source_timezone: string; reversal_of: string | null };
const roots = new Set(["dividend", "dividend_accrual", "dividend_net"]);
const childrenTypes = new Set(["dividend_payment", "dividend_breakdown", "dividend_tax_assessment", "dividend_tax_payment"]);
const qualityTypes = new Set([...roots, ...childrenTypes, "corporate_action_notice", "corporate_action_resolution"]);
const supportTypes = new Set(["opening_position", "buy", "sell", "settlement", ...roots, ...childrenTypes,
  "fee", "split", "security_in", "security_out", "security_transfer_out", "security_transfer_in", "security_transfer_return"]);
const qualityKeys = ["nav_quality", "performance_quality", "attribution_quality"] as const;
const rank = { complete: 0, provisional: 1, blocked: 2 };
const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv); ajv.addSchema(common);
const validEvidence = ajv.compile(qualitySchema);
const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const worst = (values: FactQuality[]): FactQuality => values.reduce((a, b) => rank[a] >= rank[b] ? a : b, "complete");
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => compare(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "number" && !Number.isFinite(value)) throw new Error("FACT_QUALITY_INVALID_JSON");
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
function object(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("FACT_QUALITY_INVALID_OBJECT");
  return value as Row;
}
const factOf = (event: Event) => object(object(JSON.parse(String(event.payload_json))).fact);
function decimal(value: unknown): Decimal {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error("FACT_QUALITY_INVALID_DECIMAL");
  return new Decimal(value);
}
const exact = (value: Decimal) => value.isZero() ? "0" : value.toFixed();
function instant(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || value.startsWith("0000")) throw new Error("FACT_QUALITY_TIMEZONE_REQUIRED");
  const local = Date.parse(match[1] + "Z"), milliseconds = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(milliseconds) || new Date(local).toISOString().slice(0, 19) !== match[1]) throw new Error("FACT_QUALITY_INVALID_TIME");
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}
function stamp(at: bigint): string {
  const seconds = at / 1000000n - (at < 0n && at % 1000000n !== 0n ? 1n : 0n);
  return new Date(Number(seconds * 1000n)).toISOString().slice(0, 19) + "." + String(at - seconds * 1000000n).padStart(6, "0") + "Z";
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function dateInZone(at: number, zone: string): string {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }));
  const parts = formatters.get(zone)!.formatToParts(new Date(at));
  return ["year", "month", "day"].map(name => parts.find(part => part.type === name)!.value).join("-");
}
function dayBoundary(day: string, zone: string, end: boolean): bigint {
  const nominal = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(nominal) || new Date(nominal).toISOString().slice(0, 10) !== day) throw new Error("FACT_QUALITY_INVALID_DATE");
  let low = nominal - 48 * 3600000, high = nominal + 72 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2), local = dateInZone(middle, zone);
    if (end ? local > day : local >= day) high = middle; else low = middle + 1;
  }
  return BigInt(low) * 1000n;
}
function eventTime(event: Event, byId: Map<string, Event>, interval = false, forceEnd = false): bigint {
  if (event.time_precision === "second") return instant(event.effective_at);
  if (event.time_precision !== "date") throw new Error("FACT_QUALITY_INVALID_PRECISION");
  const kind = byId.get(event.reversal_of ?? "")?.event_type ?? event.event_type;
  return dayBoundary(event.effective_at, event.source_timezone, forceEnd || kind === "corporate_action_resolution" || interval && kind !== "corporate_action_notice");
}
function sameScope(root: Event, fact: Row, child: Event, childFact: Row): boolean {
  return root.portfolio_id === child.portfolio_id && root.account_id === child.account_id && fact.currency === childFact.currency;
}
function validSource(event: Event, portfolioId: string): boolean {
  try {
    const payload = object(JSON.parse(String(event.payload_json)));
    if (event.event_type === "reversal") return hash(payload) === event.payload_hash && payload.original_event_id === event.reversal_of;
    const fact = object(payload.fact);
    const semantic = Object.fromEntries(Object.entries(payload).filter(([key]) => !["expected_revision", "idempotency_key"].includes(key)));
    return hash(semantic) === event.payload_hash && fact.type === event.event_type && fact.account_id === event.account_id && payload.portfolio_id === portfolioId
      && ["effective_at", "time_precision", "source_timezone", "source_id", "source_event_id"].every(key => (payload[key] ?? null) === (event[key] ?? null));
  } catch { return false; }
}
function obligation(gross: Decimal, tax: Decimal, cash: Decimal): [Decimal, Decimal] {
  if (gross.lt(0) || tax.lt(0) || tax.gt(gross) || cash.lt(0) || cash.gt(gross)) throw new Error("INVALID_DIVIDEND_BALANCE");
  const net = gross.sub(tax).sub(cash);
  return [Decimal.max(net, 0), Decimal.min(net, 0)];
}

function point(events: Event[], input: LedgerFactQualityInput, cutoff: bigint, known: bigint, interval: boolean): Omit<LedgerFactQuality, "binding_id"> {
  const byId = new Map(events.map(event => [event.id, event]));
  const visible = events.filter(event => event.portfolio_id === input.portfolio_id && event.ledger_revision <= input.ledger_revision && instant(event.recorded_at) <= known && eventTime(event, byId, interval) <= cutoff);
  const reversed = new Set(visible.flatMap(event => event.reversal_of ? [event.reversal_of] : []));
  const active = new Map(visible.filter(event => event.event_type !== "reversal" && !reversed.has(event.id)).map(event => [event.id, event]));
  const relevant = new Set(visible.filter(event => qualityTypes.has(event.event_type)).map(event => event.id));
  for (const event of visible) if (event.reversal_of && relevant.has(event.reversal_of)) relevant.add(event.id);
  const hashes: Record<string, string> = {}, globalIssues: string[] = [];
  for (const event of visible) if (relevant.has(event.id)) {
    hashes[event.id] = hash(event);
    if (!validSource(event, input.portfolio_id)) globalIssues.push("FACT_QUALITY_SOURCE_INVALID:" + event.id);
  }
  const visibleById = new Map(visible.map(event => [event.id, event]));
  const reversalsById = new Map<string, Event[]>();
  for (const event of visible) if (event.reversal_of) reversalsById.set(event.reversal_of, [...(reversalsById.get(event.reversal_of) ?? []), event]);
  const dependencyValid = (identity: string): boolean => {
    const seen = new Set<string>();
    while (identity) {
      if (seen.has(identity)) return false;
      seen.add(identity);
      const node = visibleById.get(identity);
      if (node) hashes[identity] = hash(node);
      for (const reverse of reversalsById.get(identity) ?? []) {
        hashes[reverse.id] = hash(reverse);
        if (!validSource(reverse, input.portfolio_id)) globalIssues.push("FACT_QUALITY_SOURCE_INVALID:" + reverse.id);
      }
      if (!node || !validSource(node, input.portfolio_id)) {
        if (node) globalIssues.push("FACT_QUALITY_SOURCE_INVALID:" + identity);
        return false;
      }
      if (!active.has(identity)) return false;
      identity = factOf(node).related_event_id as string;
    }
    return true;
  };
  const children = new Map<string, Event[]>();
  for (const event of active.values()) if (childrenTypes.has(event.event_type) || event.event_type === "corporate_action_resolution") {
    try {
      const parent = factOf(event).related_event_id;
      if (typeof parent !== "string") throw new Error("invalid_parent");
      children.set(parent, [...(children.get(parent) ?? []), event]);
      const root = active.get(parent);
      if (!root || !(childrenTypes.has(event.event_type) ? roots.has(root.event_type) : root.event_type === "corporate_action_notice")) globalIssues.push("FACT_QUALITY_ORPHAN_CHILD:" + event.id);
    } catch { globalIssues.push("FACT_QUALITY_SOURCE_INVALID:" + event.id); }
  }
  const dividends: DividendFactQuality[] = [], actions: CorporateActionFactQuality[] = [];
  for (const root of [...active.values()].sort((a, b) => compare(a.id, b.id))) {
    if (!roots.has(root.event_type) && root.event_type !== "corporate_action_notice") continue;
    let fact: Row;
    try { fact = factOf(root); } catch { globalIssues.push("FACT_QUALITY_SOURCE_INVALID:" + root.id); continue; }
    const scope: Scope = { event_id: root.id, account_id: root.account_id, listing_id: fact.listing_id as string ?? null, currency: fact.currency as string };
    const linked = [...(children.get(root.id) ?? [])].sort((a, b) => {
      const left = eventTime(a, byId), right = eventTime(b, byId);
      return left === right ? a.ledger_revision - b.ledger_revision || compare(a.id, b.id) : left < right ? -1 : 1;
    });
    const issues: string[] = [];
    if (root.event_type === "corporate_action_notice") {
      const resolution = linked.length === 1 ? linked[0] : undefined;
      let supported: string[] = [], valid = Boolean(resolution), resolutionKind: CorporateActionFactQuality["resolution"] = null;
      if (resolution) {
        try {
          const resolved = factOf(resolution);
          resolutionKind = resolved.resolution as typeof resolutionKind;
          if (!Array.isArray(resolved.supporting_event_ids) || resolved.supporting_event_ids.some(id => typeof id !== "string")) throw new Error("invalid_support");
          supported = resolved.supporting_event_ids as string[];
          valid = sameScope(root, fact, resolution, resolved) && supported.length === new Set(supported).size;
          if (resolved.resolution === "not_applicable") valid &&= supported.length === 0;
          else if (resolved.resolution === "recorded") {
            valid &&= supported.length > 0;
            let matchedListing = !fact.listing_id;
            for (const id of supported) {
              const support = active.get(id);
              const dependencyOk = dependencyValid(id);
              if (!dependencyOk || !support || !supportTypes.has(support.event_type) || !sameScope(root, fact, support, factOf(support))) { valid = false; continue; }
              const seen = new Set<string>();
              let current: Event | undefined = support, listing: unknown;
              while (current && !seen.has(current.id)) {
                seen.add(current.id);
                const currentFact = factOf(current);
                if (currentFact.listing_id) { listing = currentFact.listing_id; break; }
                current = active.get(String(currentFact.related_event_id));
              }
              if (listing === fact.listing_id) matchedListing = true;
            }
            valid &&= matchedListing;
          } else valid = false;
        } catch { valid = false; }
      }
      if (!valid) {
        issues.push("CORPORATE_ACTION_UNRESOLVED:" + root.id);
        if (linked.length) issues.push("CORPORATE_ACTION_RESOLUTION_INVALID:" + root.id);
      }
      actions.push({ ...scope, action_kind: fact.action_kind as string, resolution_event_id: resolution?.id ?? null,
        resolution: resolutionKind, supporting_event_ids: [...supported].sort(), status: valid ? "resolved" : "unresolved", issues: sorted(issues) });
      continue;
    }
    let gross: Decimal | null = null, tax: Decimal | null = null, cash = new Decimal(0), receivable = new Decimal(0), payable = new Decimal(0);
    let taxStatus: DividendFactQuality["tax_status"] = "unknown", assessmentId: string | null = null, breakdownId: string | null = null, assessmentConfirmed = false;
    const netStatus = fact.net_status as DividendFactQuality["net_status"] ?? null;
    try {
      if (root.event_type === "dividend_net") {
        cash = decimal(fact.amount);
        if (cash.lt(0) || !["final", "provisional"].includes(netStatus ?? "")) throw new Error("invalid_net");
      } else {
        gross = decimal(fact.amount);
        taxStatus = fact.tax_status as typeof taxStatus ?? (fact.tax === undefined ? "unknown" : "confirmed");
        if (!["unknown", "estimated", "confirmed"].includes(taxStatus) || taxStatus === "unknown" && fact.tax !== undefined) throw new Error("invalid_tax_status");
        tax = taxStatus === "unknown" ? null : decimal(fact.tax);
        if (root.event_type === "dividend") cash = gross.sub(tax ?? 0);
      }
      for (const child of linked) {
        const value = factOf(child);
        if (!sameScope(root, fact, child, value)) throw new Error("scope");
        if (child.event_type === "dividend_breakdown") {
          if (root.event_type !== "dividend_net" || breakdownId !== null) throw new Error("breakdown");
          gross = decimal(value.gross_amount); tax = decimal(value.tax);
          if (!gross.sub(tax).eq(decimal(fact.amount))) throw new Error("breakdown");
          taxStatus = "confirmed"; breakdownId = child.id;
        } else if (child.event_type === "dividend_tax_assessment") {
          if (gross === null || !["estimated", "confirmed"].includes(String(value.tax_status))) throw new Error("assessment_without_gross");
          tax = decimal(value.tax); taxStatus = value.tax_status as typeof taxStatus; assessmentId = child.id;
          assessmentConfirmed = taxStatus === "confirmed";
        } else if (child.event_type === "dividend_payment") {
          if (gross === null || decimal(value.amount).lt(0)) throw new Error("invalid_payment");
          cash = cash.add(decimal(value.amount));
        } else if (child.event_type === "dividend_tax_payment") {
          const amount = decimal(value.amount);
          if (gross === null || amount.lt(0)) throw new Error("invalid_tax_payment");
          if (amount.gt(obligation(gross, tax ?? new Decimal(0), cash)[1].negated())) throw new Error("tax_payment_exceeds_payable");
          cash = cash.sub(amount);
        }
        if (gross !== null) obligation(gross, tax ?? new Decimal(0), cash);
      }
      if (gross !== null) [receivable, payable] = obligation(gross, tax ?? new Decimal(0), cash);
    } catch { issues.push("DIVIDEND_STATE_INVALID:" + root.id); }
    let nav: FactQuality = issues.length ? "blocked" : "complete", attribution: FactQuality = nav;
    if (nav !== "blocked") {
      if (root.event_type === "dividend_net" && breakdownId === null) {
        attribution = "provisional"; issues.push("DIVIDEND_BREAKDOWN_UNCONFIRMED:" + root.id);
      }
      if (root.event_type === "dividend_net" && netStatus !== "final" && !assessmentConfirmed || gross !== null && taxStatus !== "confirmed") {
        nav = attribution = "provisional"; issues.push("DIVIDEND_TAX_UNCONFIRMED:" + root.id);
      }
      if (!interval && [root, ...linked].some(event => event.time_precision === "date" && eventTime(event, byId) <= cutoff && cutoff < eventTime(event, byId, false, true))) {
        nav = attribution = "provisional"; issues.push("DATE_ONLY_DIVIDEND_ON_CUTOFF_DAY:" + root.id);
      }
    }
    dividends.push({ ...scope, gross_amount: gross === null ? null : exact(gross), recognized_tax: tax === null ? null : exact(tax), tax_status: taxStatus,
      net_status: netStatus, cash_received: exact(cash), receivable: exact(receivable), tax_payable: exact(payable), assessment_event_id: assessmentId,
      breakdown_event_id: breakdownId, child_event_ids: linked.map(event => event.id).sort(), nav_quality: nav, performance_quality: nav,
      attribution_quality: attribution, issues: sorted(issues) });
  }
  const blocked: FactQuality[] = globalIssues.length || actions.some(action => action.status !== "resolved") ? ["blocked"] : [];
  return { schema_version: "ledger-fact-quality-v1", portfolio_id: input.portfolio_id, ledger_revision: input.ledger_revision,
    cutoff_at: stamp(cutoff), knowledge_at: stamp(known), period_start: null, mode: input.mode,
    nav_quality: worst([...dividends.map(item => item.nav_quality), ...blocked]), performance_quality: worst([...dividends.map(item => item.performance_quality), ...blocked]),
    attribution_quality: worst([...dividends.map(item => item.attribution_quality), ...blocked]), dividends, corporate_actions: actions,
    issues: sorted([...globalIssues, ...dividends.flatMap(item => item.issues), ...actions.flatMap(item => item.issues)]), event_hashes: hashes };
}

/** Rebuild evidence from immutable raw event rows; this never infers cash from a tax estimate. */
export function buildLedgerFactQuality(rows: readonly Row[], input: LedgerFactQualityInput): LedgerFactQuality {
  if (!["as_known", "restated"].includes(input.mode)) throw new Error("INVALID_FACT_QUALITY_MODE");
  if (!Number.isSafeInteger(input.ledger_revision) || input.ledger_revision < 0) throw new Error("INVALID_LEDGER_REVISION");
  const events = rows as Event[], cutoff = instant(input.cutoff_at), known = input.mode === "as_known" ? cutoff : instant(input.knowledge_at);
  const isPeriod = input.period_start !== undefined && input.period_start !== null;
  const evidence = point(events, input, cutoff, known, isPeriod);
  if (isPeriod) {
    const start = instant(input.period_start!), byId = new Map(events.map(event => [event.id, event]));
    if (start > cutoff) throw new Error("INVALID_FACT_QUALITY_PERIOD");
    const boundaries = new Set<bigint>([start]), qualityIds = new Set(events.filter(event => qualityTypes.has(event.event_type)).map(event => event.id));
    for (const event of events) {
      if (event.portfolio_id !== input.portfolio_id || event.ledger_revision > input.ledger_revision || !qualityIds.has(event.id) && !qualityIds.has(event.reversal_of ?? "")) continue;
      const at = eventTime(event, byId, true), recorded = instant(event.recorded_at);
      if (start < at && at < cutoff) boundaries.add(at);
      if (input.mode === "as_known" && start < recorded && recorded < cutoff) boundaries.add(recorded);
    }
    for (const boundary of [...boundaries].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
      const intermediate = point(events, input, boundary, input.mode === "as_known" ? boundary : known, true);
      for (const key of qualityKeys) evidence[key] = worst([evidence[key], intermediate[key]]);
      evidence.issues = sorted([...evidence.issues, ...intermediate.issues]);
      Object.assign(evidence.event_hashes, intermediate.event_hashes);
    }
    evidence.period_start = stamp(start);
  }
  evidence.event_hashes = Object.fromEntries(Object.entries(evidence.event_hashes).sort(([a], [b]) => compare(a, b)));
  const result = { ...evidence, binding_id: hash(evidence) };
  if (!validEvidence(result)) throw new Error("FACT_QUALITY_EVIDENCE_INVALID");
  return result;
}
