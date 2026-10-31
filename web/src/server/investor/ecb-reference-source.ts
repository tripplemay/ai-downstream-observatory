import { createHash } from "node:crypto";
import { canonical, hash } from "../ledger/service";
import { amount } from "../ledger/decimal";
import { priceInstant } from "../market-price-source";

type Element = { name: string; tag: string; attrs: Record<string, string>; namespaces: Record<string, string>; text: string; children: Element[] };
export type FxFacts = { currency: string; unit: "CNY_per_unit_currency"; rows: { observed_at: string; assumed_available_at: string; value: string }[] };
const gesmes = "http://www.gesmes.org/xml/2002-08-01", ecb = "http://www.ecb.int/vocabulary/2002-08-01/eurofxref";
export const currentEcbUrl = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
const currencies = new Set("EUR USD JPY BGN CZK DKK GBP HUF PLN RON SEK CHF ISK NOK HRK RUB TRY AUD BRL CAD CNY HKD IDR ILS INR KRW MXN MYR NZD PHP SGD THB ZAR".split(" "));
const berlin = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function check(value: unknown): asserts value { if (!value) throw new Error("INVESTOR_FX_XML_INVALID"); }
function attributes(raw: string) {
  const attrs: Record<string, string> = {}, pattern = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(["'])(.*?)\2/gy;
  let offset = 0;
  while (raw.slice(offset).trim()) {
    pattern.lastIndex = offset; const found = pattern.exec(raw);
    check(found && !Object.hasOwn(attrs, found[1]) && !/[<&]/.test(found[3]));
    attrs[found[1]] = found[3]; offset = pattern.lastIndex;
  }
  return attrs;
}

/** Bounded namespace-aware subset used by the fixed feed; no DTD/entity expansion. */
function parseXml(raw: Buffer): Element {
  check(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 2097152);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  check(!/<!\s*(DOCTYPE|ENTITY)\b/i.test(text));
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[^>]+>|[^<]+/gy, stack: Element[] = [];
  let root: Element | undefined, nodes = 0, declarations = 0, offset = 0;
  while (offset < text.length) {
    tokens.lastIndex = offset; const match = tokens.exec(text); check(match); offset = tokens.lastIndex;
    const token = match[0];
    if (token.startsWith("<!--")) { check(!token.slice(4, -3).includes("--")); continue; }
    if (token.startsWith("<?")) {
      if (/^<\?xml(?:\s|\?>)/i.test(token)) {
        check(++declarations === 1 && !root && match.index === 0 && /^<\?xml\s/.test(token));
        const declared = attributes(token.slice(5, -2));
        check(declared.version === "1.0" && Object.keys(declared).every(key => ["version", "encoding", "standalone"].includes(key))
          && (!declared.encoding || ["utf-8", "utf8"].includes(declared.encoding.toLowerCase()))
          && (!declared.standalone || ["yes", "no"].includes(declared.standalone)));
      }
      continue;
    }
    if (!token.startsWith("<")) {
      if (stack.length) stack[stack.length - 1].text += token;
      else check(!token.trim());
      continue;
    }
    if (token.startsWith("</")) {
      const close = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(token);
      check(close && stack.length && stack.pop()!.name === close[1]); continue;
    }
    const open = /^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/.exec(token); check(open);
    const attrs = attributes(open[2]), namespaces = { ...(stack.at(-1)?.namespaces ?? {}) };
    for (const key of Object.keys(attrs)) if (key === "xmlns" || key.startsWith("xmlns:")) {
      namespaces[key === "xmlns" ? "" : key.slice(6)] = attrs[key]; delete attrs[key];
    }
    const qualified = open[1].split(":"); check(qualified.length <= 2);
    const uri = namespaces[qualified.length === 2 ? qualified[0] : ""]; check(uri);
    const element: Element = { name: open[1], tag: "{" + uri + "}" + qualified.at(-1), attrs, namespaces, text: "", children: [] };
    check(++nodes <= 5000 && stack.length < 4);
    if (stack.length) stack[stack.length - 1].children.push(element);
    else { check(!root); root = element; }
    if (!open[3]) stack.push(element);
  }
  check(root && stack.length === 0); return root;
}
function container(node: Element, uri: string, tag: string, keys: string[] = []) {
  check(node.tag === "{" + uri + "}" + tag && !node.text.trim() && Object.keys(node.attrs).sort().join() === keys.sort().join());
}
function dayMillis(day: string): number {
  check(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day) && Number(day.slice(0, 4)) >= 1);
  const value = Date.parse(day + "T00:00:00Z"); check(Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === day); return value;
}
function berlinParts(ms: number) {
  const parts = berlin.formatToParts(new Date(ms)), get = (key: string) => parts.find(part => part.type === key)!.value;
  return { day: [get("year").padStart(4, "0"), get("month"), get("day")].join("-"), clock: [get("hour"), get("minute"), get("second")].join(":") };
}
function midnight(day: string): string {
  const base = dayMillis(day), parts = berlinParts(base), local = Date.parse(parts.day + "T" + parts.clock + "Z");
  const result = base - (local - base), checked = berlinParts(result);
  check(checked.day === day && checked.clock === "00:00:00"); return new Date(result).toISOString();
}
function nextDay(day: string) { return new Date(dayMillis(day) + 86400000).toISOString().slice(0, 10); }
export function currentEcbCollectionWindow(createdAt: string) {
  const local = berlinParts(Number(priceInstant(createdAt) / 1000n));
  check(Number(local.clock.slice(0, 2)) >= 1);
  return { feed_day: local.day, valid_until: midnight(nextDay(local.day)) };
}
function positiveRate(value: string) {
  check(value.length <= 58 && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) && amount(value).gt(0));
  const [whole, fraction = ""] = value.split("."); return [BigInt(whole + fraction), 10n ** BigInt(fraction.length)] as const;
}
function cross(numerator: string, denominator: string): string {
  const [a, b] = positiveRate(numerator), [c, d] = positiveRate(denominator), n = a * d * 10n ** 18n, divisor = b * c;
  let integer = n / divisor; const remainder = n % divisor;
  if (remainder * 2n > divisor || remainder * 2n === divisor && integer % 2n === 1n) integer += 1n;
  const digits = integer.toString().padStart(19, "0"), result = (digits.slice(0, -18) + "." + digits.slice(-18)).replace(/0+$/, "").replace(/\.$/, "");
  check(amount(result).gt(0)); return result;
}
function microStamp(value: string) {
  const micro = priceInstant(value), ms = micro / 1000n, remainder = micro % 1000000n;
  return new Date(Number(ms)).toISOString().slice(0, 19) + "." + remainder.toString().padStart(6, "0") + "Z";
}

/** Independent BigInt/date/XML replay of the Python current-FX draft, no HTTP. */
export function replayCurrentEcbDraft(raw: Buffer, retrievedAt: string, requested: string[]) {
  check(Array.isArray(requested) && requested.length >= 1 && requested.length <= 2 && new Set(requested).size === requested.length
    && requested.every(currency => ["USD", "HKD"].includes(currency)));
  const selected = [...requested].sort(), retrieved = priceInstant(retrievedAt), localToday = berlinParts(Number(retrieved / 1000n)).day;
  const root = parseXml(raw); container(root, gesmes, "Envelope"); check(root.children.length === 3);
  const [subject, sender, outer] = root.children;
  check(subject.tag === "{" + gesmes + "}subject" && !Object.keys(subject.attrs).length && !subject.children.length && subject.text.trim() === "Reference rates");
  container(sender, gesmes, "Sender"); check(sender.children.length === 1);
  const name = sender.children[0]; check(name.tag === "{" + gesmes + "}name" && !Object.keys(name.attrs).length && !name.children.length && name.text.trim() === "European Central Bank");
  container(outer, ecb, "Cube"); check(outer.children.length >= 1 && outer.children.length <= 100);
  const dates = new Set<string>(), facts: Record<string, FxFacts> = Object.fromEntries(selected.map(currency => [currency, { currency, unit: "CNY_per_unit_currency", rows: [] }]));
  for (const day of outer.children) {
    container(day, ecb, "Cube", ["time"]); const date = day.attrs.time; dayMillis(date);
    check(date <= localToday && !dates.has(date) && day.children.length > 0); dates.add(date);
    const rates: Record<string, string> = {};
    for (const row of day.children) {
      container(row, ecb, "Cube", ["currency", "rate"]); check(!row.children.length);
      const { currency, rate } = row.attrs; check(currencies.has(currency) && currency !== "EUR" && !Object.hasOwn(rates, currency));
      positiveRate(rate); rates[currency] = rate;
    }
    check(rates.CNY && selected.every(currency => rates[currency]));
    for (const currency of selected) facts[currency].rows.push({ observed_at: midnight(date), assumed_available_at: midnight(nextDay(date)), value: cross(rates.CNY, rates[currency]) });
  }
  for (const value of Object.values(facts)) value.rows.sort((a,b) => a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0);
  const days = [...dates].sort(), notBefore = Object.values(facts).flatMap(value => value.rows.map(row => row.assumed_available_at)).sort().at(-1)!;
  const metadata = { provider: "ecb", feed: "hist_90d", url: currentEcbUrl, parser_version: "ecb-reference-xml-v1",
    raw_sha256: createHash("sha256").update(raw).digest("hex"), raw_bytes: raw.length, retrieved_at: microStamp(retrievedAt),
    source_timezone: "Europe/Berlin", rate_kind: "reference_not_executable", base_currency: "EUR", publication_time_status: "not_supplied",
    network_origin_verified_by_parser: false, freshness_status: "not_assessed", requested_currencies: selected,
    first_rate_date: days[0], last_rate_date: days.at(-1)!, rate_date_count: dates.size,
    rounding: { arithmetic: "exact_rational", method: "ROUND_HALF_EVEN", scale: 18 },
    availability_policy: "next_calendar_day_midnight_Europe_Berlin", observation_policy: "rate_date_midnight_date_anchor_not_intraday_observation",
    not_before: notBefore, availability_status: priceInstant(notBefore) <= retrieved ? "available" : "pending",
    facts_hashes: Object.fromEntries(Object.entries(facts).map(([currency, value]) => [currency, hash(value)])) };
  const excerpt = "ECB reference rates, not executable FX. CNY-per-unit is cross-converted from EUR reference legs. "
    + "Observed time is a Europe/Berlin date anchor, not an intraday quote or publication time. "
    + "Availability is conservatively assumed at next calendar-day midnight Europe/Berlin. "
    + "No dates or currency legs are filled. Current download is not a point-in-time archive. " + canonical(metadata);
  return { metadata, facts, source_document: { title: "ECB private current reference FX draft", reference: currentEcbUrl, excerpt }, owner_reviewed: false, production_admitted: false };
}
