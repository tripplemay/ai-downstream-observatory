import type Database from "better-sqlite3";
import { hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { priceInstant } from "../market-price-source";
import { investorInstant } from "./schemas";
import { validateInvestorSourceDocument } from "./kernel-contracts";
import type { VerifiedSourceReview } from "./source-inputs";

type Obj = Record<string, unknown>;
const maximumContinuations = 16;
const zones: Record<string, string> = { CN: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" };
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_CALENDAR_CONTINUATION_INVALID"); }
function obj(value: unknown): Obj { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Obj; }
function json(raw: unknown) { check(typeof raw === "string" && Buffer.byteLength(raw) <= 8192); return obj(parseStrictJson(raw)); }
function rows(value: unknown): Obj[] { check(Array.isArray(value) && value.length > 0 && value.length <= 3660); return value.map(obj); }

function verifyCalendar(value: VerifiedSourceReview) {
  check(value.source.kind === "calendar" && investorInstant.safeParse(value.row.created_at).success
    && investorInstant.safeParse(value.row.valid_until).success && investorInstant.safeParse(value.source.created_at).success);
  const facts = value.facts, days = rows(facts.days), start = Date.parse(facts.range_start + "T00:00:00Z");
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zones[facts.market as string], year: "numeric", month: "2-digit", day: "2-digit" });
  const count = (Date.parse(facts.range_end + "T00:00:00Z") - start) / 86400000 + 1;
  check(Number.isInteger(count) && count > 0 && count <= 3660 && days.length === count);
  for (const [index, day] of days.entries()) {
    check(day.date === new Date(start + index * 86400000).toISOString().slice(0, 10));
    const values = [day.close_at, day.available_at, day.settled_at, day.settlement_rule_known_at];
    if (day.kind === "closed") { check(values.every(value => value === null)); continue; }
    check(values.every(value => typeof value === "string"));
    const parts = formatter.formatToParts(new Date(day.close_at as string));
    check(["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-") === day.date
      && priceInstant(day.close_at) <= priceInstant(day.available_at) && priceInstant(day.close_at) <= priceInstant(day.settled_at)
      && priceInstant(day.settlement_rule_known_at) <= priceInstant(day.close_at));
  }
}

function prefixHash(previous: VerifiedSourceReview, following: VerifiedSourceReview) {
  const before = previous.facts, after = following.facts, oldDays = rows(before.days), newDays = rows(after.days);
  check(after.market === before.market && after.range_start === before.range_start
    && (after.range_end as string) > (before.range_end as string) && newDays.length > oldDays.length
    && hash(newDays.slice(0, oldDays.length)) === hash(oldDays));
  return hash(before);
}

/** Preserve original facts; only the exact current calendar is returned for new collection. */
export function currentCalendarReview(db: Database.Database, workspace: string, original: VerifiedSourceReview, now: string,
  load: (id: string, at: string) => VerifiedSourceReview): VerifiedSourceReview {
  let value = original;
  verifyCalendar(value);
  const latest = db.prepare("SELECT id FROM investor_data_reviews WHERE source_id=? ORDER BY version DESC LIMIT 1")
    .get(value.source.id) as { id: string } | undefined;
  check(latest);
  for (let index = 0; index <= maximumContinuations; index++) {
    if (value.row.id === latest.id) return value;
    check(index < maximumContinuations);
    const row = db.prepare("SELECT * FROM investor_calendar_continuations WHERE workspace_id=? AND previous_review_id=?")
      .get(workspace, value.row.id) as Obj | undefined;
    check(row);
    const owner = db.prepare("SELECT owner_id FROM investor_workspaces WHERE id=?").get(workspace) as { owner_id: string } | undefined;
    const audit = db.prepare("SELECT * FROM audit_events WHERE id=?").get(row.audit_id) as Obj | undefined;
    check(owner && audit && owner.owner_id === row.actor_id && audit.actor_id === row.actor_id && audit.action === "investor_continue_calendar_review"
      && audit.object_type === "investor_calendar_continuation" && audit.object_id === row.id && audit.created_at === row.created_at);
    check(hash(json(audit.payload_json)) === hash({ content_hash: row.content_hash }));
    const document = json(row.document_json);
    validateInvestorSourceDocument("calendar_continuation", document);
    check(hash(document) === row.content_hash && document.workspace_id === workspace && row.workspace_id === workspace
      && document.source_id === row.source_id && row.source_id === value.source.id && document.source_hash === value.source.content_hash
      && document.previous_review_id === row.previous_review_id && row.previous_review_id === value.row.id
      && document.previous_review_hash === value.row.content_hash && document.new_review_id === row.new_review_id
      && investorInstant.safeParse(row.created_at).success && document.created_at === row.created_at && (row.created_at as string) <= now);
    const readAt = row.new_review_id === latest.id ? now : row.created_at as string;
    const following = load(row.new_review_id as string, readAt);
    verifyCalendar(following);
    check(following.source.id === value.source.id && following.source.content_hash === value.source.content_hash
      && following.row.version === value.row.version + 1 && following.row.created_at === row.created_at
      && following.row.created_at >= value.row.created_at && following.row.created_at < value.row.valid_until
      && document.new_review_hash === following.row.content_hash
      && document.market === following.facts.market && document.previous_facts_hash === prefixHash(value, following)
      && document.previous_range_end === value.facts.range_end && document.extended_range_end === following.facts.range_end);
    value = following;
  }
  throw new Error("INVESTOR_CALENDAR_CONTINUATION_INVALID");
}
