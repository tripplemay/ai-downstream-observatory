import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import common from "../../../../contracts/v1/common.schema.json";
import schema from "../../../../contracts/v1/investor-confirmed-capture.schema.json";
import { canonical, hash } from "../ledger/service";
import { amount } from "../ledger/decimal";
import { parseStrictJson } from "../strict-json";
import { priceInstant } from "../market-price-source";
import { investorInstant } from "./schemas";
import { readInvestorSourceReview } from "./source-inputs";

type Obj = Record<string, unknown>;
type Target = { mapping: { listing_id: string; provider_symbol: string; market: "CN" | "HK" | "US"; currency: string };
  session_date: string; close_at: string; available_at: string; calendar_hash: string };
const zones = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
const patterns = { CN: /^[0-9]{6}\.(SH|SZ)$/, HK: /^[0-9]{1,5}\.HK$/, US: /^[A-Z][A-Z0-9]{0,14}(?:[.-][A-Z0-9]{1,5})?\.US$/ };
const currencies = { CN: ["CNY"], HK: ["HKD", "CNY", "USD"], US: ["USD"] };
const uses = ["private_research", "private_retention", "private_display", "private_backup"];
const adapter = "longport-sdk-confirmed-day-v1", commit = "72e9be585d2724358ddaf7d6afbb64bb9e01205d";
const ajv = new Ajv2020({ strict: true, strictRequired: false }); addFormats(ajv); ajv.addSchema(common); ajv.addSchema(schema);
const receiptValid = ajv.getSchema(schema.$id)!, requestValid = ajv.getSchema(schema.$id + "#/$defs/request")!;
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_CONFIRMED_EVIDENCE_INVALID"); }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function list(value: unknown, max: number): Obj[] { check(Array.isArray(value) && value.length <= max); return value.map(obj); }
function equal(a: unknown, b: unknown) { check(canonical(a) === canonical(b)); }
function full(pattern: RegExp, value: unknown): value is string { return typeof value === "string" && pattern.exec(value)?.[0] === value; }
function utc6(value: unknown): string { check(typeof value === "string"); priceInstant(value); return value.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction: string | undefined) => "." + (fraction ?? "").padEnd(6, "0") + "Z"); }
function localDate(value: string, zone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
}
function target(raw: unknown): Target {
  const value = obj(raw), mapping = obj(value.mapping), market = mapping.market as Target["mapping"]["market"];
  check(Object.hasOwn(zones, market) && full(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/, mapping.listing_id)
    && full(patterns[market], mapping.provider_symbol) && typeof mapping.currency === "string" && currencies[market].includes(mapping.currency));
  const close = utc6(value.close_at), available = utc6(value.available_at);
  check(close === value.close_at && available === value.available_at && priceInstant(close) <= priceInstant(available)
    && localDate(close, zones[market]) === value.session_date && full(/^[a-f0-9]{64}$/, value.calendar_hash));
  equal(value, { mapping: { listing_id: mapping.listing_id, provider_symbol: mapping.provider_symbol, market, currency: mapping.currency },
    session_date: value.session_date, close_at: close, available_at: available, calendar_hash: value.calendar_hash });
  return value as unknown as Target;
}
function request(raw: unknown) {
  check(requestValid(raw)); const value = obj(raw), targets = list(value.targets, 32).map(target);
  check(new Set(targets.map(row => row.mapping.listing_id)).size === targets.length && new Set(targets.map(row => row.mapping.provider_symbol)).size === targets.length
    && targets.every((row, index) => index === 0 || targets[index - 1].mapping.listing_id < row.mapping.listing_id));
  return { value, targets };
}

/** Pure protocol replay. No JSON label authenticates a network or license. */
export function replayConfirmedProtocol(raw: Buffer, rawRequest: unknown, parentStarted: string, parentReturned: string) {
  try {
    const { value: input, targets } = request(rawRequest);
    check(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 2097152 && raw.at(-1) === 10);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw), lines = text.slice(0, -1).split("\n");
    check(lines.length >= 2 && lines.length <= 34);
    const frames = lines.map(line => { check(Buffer.byteLength(line) > 0 && Buffer.byteLength(line) <= 65536); const value = obj(parseStrictJson(line)); check(canonical(value) === line); return value; });
    const first = frames[0], last = frames.at(-1)!, started = utc6(first.started_at);
    equal(first, { frame: "ready", watch_id: input.watch_id, request_hash: hash(input), started_at: started, sdk_version: "4.3.7", adapter_version: adapter });
    check(priceInstant(parentStarted) <= priceInstant(started) && priceInstant(started) <= priceInstant(parentReturned));
    equal(last, { frame: "finished", watch_id: input.watch_id, events: frames.length - 2, reason: "watch_window_elapsed" });
    const mapped = new Map(targets.map(row => [row.mapping.provider_symbol, row])), seen = new Set<string>();
    let previous = priceInstant(started);
    const records = frames.slice(1, -1).map((frame, index) => {
      check(Object.keys(frame).sort().join() === "frame,projection,sequence,sha256" && frame.frame === "bar" && frame.sequence === index + 1);
      const projection = obj(frame.projection), selected = target(projection.target), symbol = selected.mapping.provider_symbol;
      check(mapped.has(symbol) && !seen.has(symbol)); seen.add(symbol); equal(selected, mapped.get(symbol));
      const source = obj(projection.source), received = utc6(source.received_at), at = priceInstant(received);
      check(at >= previous && at <= priceInstant(parentReturned) && at >= priceInstant(selected.available_at)); previous = at;
      const row = obj(projection.candlestick), money = (key: string) => {
        check(full(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, row[key])); return amount(row[key]);
      };
      const open = money("open"), high = money("high"), low = money("low"), close = money("close"); money("turnover");
      check(close.gt(0) && low.lte(open) && low.lte(close) && high.gte(open) && high.gte(close) && high.gte(low));
      check(full(/^(?:0|[1-9][0-9]{0,18})$/, row.volume) && BigInt(row.volume) <= 9223372036854775807n && row.trade_session === 0);
      const timestamp = utc6(row.timestamp);
      check(timestamp === row.timestamp && localDate(timestamp, zones[selected.mapping.market]) === selected.session_date
        && priceInstant(timestamp) <= priceInstant(selected.close_at));
      equal(row, { open: row.open, high: row.high, low: row.low, close: row.close, turnover: row.turnover, volume: row.volume, timestamp, trade_session: 0 });
      equal(source, { provider: "longport", sdk_version: "4.3.7", sdk_source_commit: commit, adapter_version: adapter,
        capture_kind: "sdk_confirmed_callback_projection", period: "day", adjust_type: "none", trade_session: "regular", push_mode: "confirmed", is_confirmed: true,
        confirmation_semantics: "pinned_sdk_local_engine_not_exchange_signoff", receiver_started_at: started, received_at: received,
        source_timezone: zones[selected.mapping.market], sdk_datetime_basis: "runtime_utc_from_unix_timestamp", publication_time_status: "not_supplied",
        provider_revision_status: "not_supplied", network_bytes_preserved: false, calendar_verified_by_adapter: false, mapping_verified_by_adapter: false,
        account_buyability_verified: false, subscription_snapshot_used: false, stream_continuity_verified: false });
      equal(projection, { schema_version: "longport-confirmed-day-projection-v1", watch_id: input.watch_id, target: selected, candlestick: row, source });
      check(frame.sha256 === hash(projection));
      return { listing_id: selected.mapping.listing_id, currency: selected.mapping.currency, observed_at: selected.session_date, time_precision: "date",
        value: row.close, metric: "close", price_basis: "unadjusted", published_at: null, provider_revision: null, ingested_at: received,
        source_timezone: zones[selected.mapping.market], provider_timestamp: timestamp, provenance: "live_observed", projection_sha256: frame.sha256 };
    });
    return { records, status: records.length === targets.length ? "complete" : records.length ? "partial" : "no_confirmed_events",
      qualification: "parser_only_not_network_authenticated" };
  } catch { throw new Error("INVESTOR_CONFIRMED_EVIDENCE_INVALID"); }
}

/** Reads private receipts only. No SDK, collection, write, scheduling or AI. */
export function readInvestorConfirmedCapture(db: Database.Database, workspace: string, captureId: string, now: string, allowSynthetic = false) {
  try {
    check(investorInstant.safeParse(now).success && typeof allowSynthetic === "boolean");
    const row = db.prepare("SELECT * FROM investor_confirmed_captures WHERE id=? AND workspace_id=?").get(captureId, workspace) as Obj | undefined;
    check(row && typeof row.receipt_json === "string" && Buffer.byteLength(row.receipt_json) <= 131072
      && investorInstant.safeParse(row.created_at).success && investorInstant.safeParse(row.retain_until).success
      && (row.created_at as string) <= now && now < (row.retain_until as string)
      && (row.qualification === "isolated_official_sdk_callback" || allowSynthetic && row.qualification === "injected_test_receiver"));
    const receipt = obj(parseStrictJson(row.receipt_json)); check(receiptValid(receipt) && canonical(receipt) === row.receipt_json && hash(receipt) === row.receipt_hash);
    for (const [key, column] of [["capture_id", "id"], ["workspace_id", "workspace_id"], ["watch_id", "watch_id"], ["qualification", "qualification"],
      ["status", "status"], ["payload_sha256", "payload_sha256"], ["created_at", "created_at"], ["retain_until", "retain_until"]]) check(receipt[key] === row[column]);
    const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as Obj | undefined;
    const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj | undefined;
    check(owner?.owner_id === row.actor_id && audit?.actor_id === row.actor_id && audit?.action === "investor_store_confirmed_capture"
      && audit?.object_type === "investor_confirmed_capture" && audit?.object_id === row.id && audit?.created_at === row.created_at);
    equal(parseStrictJson(audit.payload_json as string), { content_hash: row.receipt_hash });
    const { targets } = request(receipt.request), bindings = list(receipt.bindings, 32);
    equal(targets, bindings.map(value => value.target)); check(obj(receipt.request).watch_id === receipt.watch_id);
    const started = utc6(receipt.call_started_at), returned = utc6(receipt.call_returned_at);
    check(started === receipt.call_started_at && returned === receipt.call_returned_at && priceInstant(started) <= priceInstant(returned)
      && priceInstant(returned) < priceInstant(row.created_at) + 1000n);
    const normalized = db.prepare("SELECT * FROM investor_confirmed_targets WHERE capture_id=? ORDER BY listing_id").all(captureId);
    equal(normalized, bindings.map(value => ({ capture_id: captureId, workspace_id: workspace, listing_id: obj(obj(value.target).mapping).listing_id,
      ...Object.fromEntries(["rights", "listing", "calendar"].map(kind => [kind + "_review_id", obj(obj(value.reviews)[kind]).review_id])) })));
    const deadlines: bigint[] = [];
    for (const binding of bindings) {
      const selected = target(binding.target), refs = obj(binding.reviews);
      const reviews = ["rights", "listing", "calendar"].map(kind => {
        const value = readInvestorSourceReview(db, workspace, obj(refs[kind]), now);
        check(value.source.kind === kind && priceInstant(value.row.created_at) <= priceInstant(started)); return value;
      });
      const [rights, listing, calendar] = reviews, grant = rights.facts, asset = listing.facts, days = calendar.facts;
      check(Array.isArray(grant.uses) && uses.every(use => (grant.uses as string[]).includes(use)) && (grant.markets as string[]).includes(selected.mapping.market)
        && priceInstant(grant.valid_from) <= priceInstant(started) && priceInstant(now) < priceInstant(grant.valid_until));
      equal(selected.mapping, Object.fromEntries(["listing_id", "provider_symbol", "market", "currency"].map(key => [key, asset[key]])));
      check(days.market === asset.market && selected.calendar_hash === calendar.row.content_hash
        && (days.range_start as string) <= selected.session_date && selected.session_date <= (days.range_end as string));
      const sessions = list(days.days, 3660), count = (Date.parse(days.range_end + "T00:00:00Z") - Date.parse(days.range_start + "T00:00:00Z")) / 86400000 + 1;
      check(sessions.length === count && count > 0 && count <= 3660);
      sessions.forEach((day, index) => {
        check(day.date === new Date(Date.parse(days.range_start + "T00:00:00Z") + index * 86400000).toISOString().slice(0, 10));
        if (day.kind === "closed") check([day.close_at, day.available_at, day.settled_at, day.settlement_rule_known_at].every(value => value === null));
        else check(localDate(utc6(day.close_at), zones[selected.mapping.market]) === day.date && priceInstant(day.close_at) <= priceInstant(day.available_at)
          && priceInstant(day.close_at) <= priceInstant(day.settled_at) && priceInstant(day.settlement_rule_known_at) <= priceInstant(day.close_at));
      });
      const session = sessions.find(row => row.date === selected.session_date); check(session && session.kind !== "closed");
      check(selected.close_at === utc6(session.close_at) && selected.available_at === utc6(session.available_at)
        && priceInstant(asset.tradable_from) <= priceInstant(selected.close_at) && (!asset.tradable_until || priceInstant(selected.close_at) < priceInstant(asset.tradable_until)));
      deadlines.push(priceInstant(grant.valid_until), priceInstant(rights.row.valid_until), priceInstant(row.created_at) + BigInt(grant.retention_days as number) * 86400000000n);
    }
    const retain = deadlines.reduce((a, b) => a < b ? a : b); check(row.retain_until === new Date(Number(retain / 1000n)).toISOString());
    const stored = db.prepare("SELECT projection FROM investor_confirmed_payloads WHERE capture_id=?").get(captureId) as { projection: Buffer } | undefined;
    check(stored && Buffer.isBuffer(stored.projection) && stored.projection.length > 0 && stored.projection.length <= 3145728
      && createHash("sha256").update(stored.projection).digest("hex") === row.payload_sha256
      && !db.prepare("SELECT 1 FROM investor_confirmed_purges WHERE capture_id=?").get(captureId));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(stored.projection), payload = obj(parseStrictJson(text)); check(canonical(payload) === text);
    const frames = list(payload.frames, 34);
    equal(payload, { schema_version: "investor-confirmed-protocol-envelope-v1", qualification: row.qualification,
      call_started_at: started, call_returned_at: returned, frames });
    const protocol = Buffer.from(frames.map(value => canonical(value) + "\n").join(""));
    const replay = replayConfirmedProtocol(protocol, receipt.request, started, returned); check(replay.status === row.status);
    return { capture: row, receipt, records: replay.records, status: replay.status, live_advice_eligible: false };
  } catch { throw new Error("INVESTOR_CONFIRMED_EVIDENCE_INVALID"); }
}
