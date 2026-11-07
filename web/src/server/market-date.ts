const fixedZones = new Set(["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York"]);
const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatMarketLocalDate(value: Date, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    if (fixedZones.has(timeZone)) formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(value);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
}
