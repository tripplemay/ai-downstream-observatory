import { createHash } from "node:crypto";
import { exactNonnegativeDecimal, ExactJsonNumber, parseExactJson } from "../exact-json";
import { hash } from "../ledger/service";
import { priceInstant } from "../market-price-source";

export type ActionObject = Record<string, unknown>;
export type ActionDraft = { schema_version: string; source: ActionObject; records: ActionObject[];
  owner_reviewed: false; corporate_actions_complete: false; research_admitted: false; gaps: string[]; empty_is_not_absence_proof?: boolean };
export function actionCheck(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_ACTION_SOURCE_INVALID"); }
export function actionObject(value: unknown): ActionObject {
  actionCheck(value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof ExactJsonNumber));
  return value as ActionObject;
}
export function actionText(value: unknown): string {
  actionCheck(typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)); return value;
}
export function actionDay(value: unknown): string {
  const text = actionText(value); actionCheck(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) && text.slice(0,4) !== "0000");
  const date = new Date(text + "T00:00:00Z"); actionCheck(Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10) === text); return text;
}
export function actionAddDays(value: unknown, count: number): string {
  return actionDay(new Date(Date.parse(actionDay(value) + "T00:00:00Z") + count * 86400000).toISOString().slice(0,10));
}
export function actionNyParts(value: unknown) {
  const at = actionText(value); priceInstant(at);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const field = (name: string) => parts.find(part => part.type === name)!.value;
  return { day: actionDay(["year","month","day"].map(field).join("-")), hour: Number(field("hour")) };
}
export function actionDeadline(value: unknown, validUntil: unknown): string {
  const tomorrow = actionAddDays(actionNyParts(value).day, 1), candidates = ["04", "05"].map(hour => tomorrow + "T" + hour + ":00:00.000Z");
  const midnight = candidates.find(at => actionNyParts(at).day === tomorrow && actionNyParts(at).hour === 0);
  actionCheck(midnight); return priceInstant(midnight) < priceInstant(validUntil) ? midnight : actionText(validUntil);
}
export function actionMicroStamp(value: unknown): string {
  const at = actionText(value); priceInstant(at);
  return at.slice(0,19) + "." + (at.includes(".") ? at.slice(20,-1) : "").padEnd(6,"0") + "Z";
}
export const actionSha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
export function issuerDistributionUrl(fund: unknown, yieldFlag: unknown): string {
  actionCheck(typeof fund === "string" && /^[0-9]{4}$/.test(fund) && typeof yieldFlag === "boolean");
  return `https://advisors.vanguard.com/investments/products/api/funds/${fund}/pricing/distributions?hasDistributionYield=${yieldFlag}`;
}
export function eodhdActionWindow(at: unknown) {
  const end = actionAddDays(actionNyParts(at).day,-1); return { start_date: actionAddDays(end,-364), end_date: end };
}
export function eodhdActionUrl(parameters: ActionObject): string {
  actionCheck(["div","splits"].includes(actionText(parameters.kind)) && ["VT.US","BND.US"].includes(actionText(parameters.symbol))
    && actionAddDays(parameters.start_date,364) === actionDay(parameters.end_date));
  return `https://eodhd.com/api/${parameters.kind}/${parameters.symbol}?fmt=json&from=${parameters.start_date}&to=${parameters.end_date}`;
}
function rows(raw: Buffer, maximum: number, issuer: boolean): unknown[] {
  actionCheck(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= maximum);
  let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  if (issuer && text.startsWith("\ufeff")) text = text.slice(1);
  const value = parseExactJson(text,maximum); actionCheck(Array.isArray(value) && value.length <= 2048 && (!issuer || value.length > 0)); return value;
}
function keys(value: ActionObject, required: string[], optional: string[] = []) {
  actionCheck(required.every(key => Object.hasOwn(value,key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function shortText(value: unknown, maximum: number) { const text = actionText(value); actionCheck([...text].length <= maximum); return text; }
const sortRecords = (values: ActionObject[], fields: string[]) => values.sort((a,b) => {
  for (const key of fields) { if (a[key] !== b[key]) return (a[key] as string) < (b[key] as string) ? -1 : 1; } return 0;
});

/** Pure reconstruction from bytes; never validates the network origin or grants use. */
export function replayIssuerActionDraft(raw: Buffer, parameters: ActionObject): ActionDraft {
  const { fund_id, has_distribution_yield, retrieved_at, start_date, end_date } = parameters;
  const url = issuerDistributionUrl(fund_id,has_distribution_yield), start = actionDay(start_date), end = actionDay(end_date);
  actionCheck(start <= end && Date.parse(end) - Date.parse(start) < 3660 * 86400000 && end <= actionNyParts(retrieved_at).day);
  const input = rows(raw,1048576,true), seen = new Set<string>(), dates: string[] = [], records: ActionObject[] = [];
  for (const entry of input) {
    const row = actionObject(entry);
    keys(row,["amount","exDividendDate","payableDate","recordDate","reinvestDate","reinvestPrice","typeCode"],["distributionYieldAmount"]);
    actionCheck(["INC","CGLT","CGST"].includes(actionText(row.typeCode)));
    const amount = exactNonnegativeDecimal(row.amount), ex = actionDay(row.exDividendDate), record = actionDay(row.recordDate), pay = actionDay(row.payableDate);
    actionCheck(ex <= record && record <= pay); shortText(row.reinvestDate,100);
    if (Object.hasOwn(row,"distributionYieldAmount")) shortText(row.distributionYieldAmount,100);
    const key = hash({ fund_id, type_code: row.typeCode, ex_date: ex, record_date: record, pay_date: pay });
    actionCheck(!seen.has(key)); seen.add(key); dates.push(ex);
    if (start <= ex && ex <= end) records.push({ derived_event_key: key, issuer_type_code: row.typeCode,
      distribution_amount: amount, amount_basis: "not_supplied_in_payload", currency: null, ex_date: ex, record_date: record,
      pay_date: pay, date_precision: "date_not_instant", published_at: null, tax_per_unit: null });
  }
  dates.sort();
  return { schema_version: "vanguard-distributions-draft-v1", source: { provider: "vanguard_issuer", url,
    requested_fund_id: fund_id, requested_has_distribution_yield: has_distribution_yield, raw_sha256: actionSha(raw), raw_bytes: raw.length,
    retrieved_at: actionMicroStamp(retrieved_at), parser_version: "vanguard-distributions-draft-v1", range_start: start, range_end: end,
    archive_record_count: input.length, selected_record_count: records.length, archive_first_ex_date: dates[0], archive_last_ex_date: dates.at(-1),
    network_origin_verified_by_parser: false, fund_identity_verified_by_payload: false }, records: sortRecords(records,["ex_date","issuer_type_code","derived_event_key"]),
    owner_reviewed: false, corporate_actions_complete: false, research_admitted: false,
    gaps: ["ISSUER_FUND_IDENTITY_BINDING_REQUIRED","CURRENCY_AND_AMOUNT_BASIS_CONFIRMATION_REQUIRED","ISSUER_ANNOUNCEMENT_TIME_NOT_SUPPLIED",
      "DATE_TO_INSTANT_RECONSTRUCTION_REQUIRED","EXPLICIT_TAX_ASSUMPTION_REQUIRED","SPLIT_AND_DISTRIBUTION_COVERAGE_REVIEW_REQUIRED"] };
}

export function replayEodhdActionDraft(raw: Buffer, parameters: ActionObject): ActionDraft {
  const { kind, symbol, start_date, end_date, retrieved_at } = parameters, url = eodhdActionUrl(parameters);
  const window = eodhdActionWindow(retrieved_at); actionCheck(start_date === window.start_date && end_date === window.end_date);
  const input = rows(raw,262144,false), seen = new Set<string>(), records: ActionObject[] = [];
  for (const entry of input) {
    const row = actionObject(entry);
    keys(row,kind === "div" ? ["date","value","unadjustedValue","currency"] : ["date","split"],
      kind === "div" ? ["declarationDate","recordDate","paymentDate","period"] : []);
    const day = actionDay(row.date); actionCheck((start_date as string) <= day && day <= (end_date as string));
    const key = hash({ kind,symbol,date:day }); actionCheck(!seen.has(key)); seen.add(key);
    const event: ActionObject = { derived_event_key:key,date:day,date_precision:"date_not_instant",published_at:null };
    if (kind === "div") {
      actionCheck(typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency));
      Object.assign(event,{value:exactNonnegativeDecimal(row.value),unadjusted_value:exactNonnegativeDecimal(row.unadjustedValue),
        reported_currency:row.currency,amount_basis:"provider_reported_not_issuer_verified",tax_per_unit:null});
      for (const [field,target] of [["declarationDate","declaration_date"],["recordDate","record_date"],["paymentDate","payment_date"]])
        event[target] = row[field] === null || row[field] === undefined ? null : actionDay(row[field]);
      const period = row.period ?? null;
      if (period !== null) actionCheck([...shortText(period,100)].every(char => char.codePointAt(0)! >= 32 && char.codePointAt(0) !== 127));
      event.reported_period = period;
    } else {
      actionCheck(typeof row.split === "string" && /^[0-9]{1,12}(?:\.[0-9]{1,12})?\/[0-9]{1,12}(?:\.[0-9]{1,12})?$/.test(row.split));
      const [numerator,denominator] = row.split.split("/").map(value => exactNonnegativeDecimal(new ExactJsonNumber(value.replace(/^0+(?=[0-9])/u,"")),true));
      Object.assign(event,{numerator,denominator,ratio_direction:"provider_reported_not_issuer_verified"});
    }
    records.push(event);
  }
  return {schema_version:"eodhd-action-draft-v1",source:{provider:"eodhd",url_without_credentials:url,kind,requested_symbol:symbol,
    range_start:start_date,range_end:end_date,retrieved_at:actionMicroStamp(retrieved_at),raw_sha256:actionSha(raw),raw_bytes:raw.length,
    record_count:records.length,network_origin_verified_by_parser:false,instrument_identity_verified_by_payload:false},
    records:sortRecords(records,["date","derived_event_key"]),owner_reviewed:false,corporate_actions_complete:false,research_admitted:false,
    empty_is_not_absence_proof:records.length === 0,gaps:["INSTRUMENT_IDENTITY_BINDING_REQUIRED","ISSUER_CROSS_CHECK_REQUIRED",
      "HISTORY_AND_ABSENCE_REVIEW_REQUIRED","ANNOUNCEMENT_TIME_NOT_SUPPLIED","DATE_TO_INSTANT_RECONSTRUCTION_REQUIRED","TAX_AND_AMOUNT_BASIS_REVIEW_REQUIRED"]};
}
