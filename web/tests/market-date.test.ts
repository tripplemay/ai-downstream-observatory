import assert from "node:assert/strict";
import test from "node:test";
import { formatMarketLocalDate } from "../src/server/market-date";

test("fixed market formatters preserve exact old date output and reuse at most three immutable formatters", () => {
  const Original = Intl.DateTimeFormat; let constructions = 0;
  Intl.DateTimeFormat = function(...args: ConstructorParameters<typeof Original>) {
    constructions++; return new Original(...args);
  } as typeof Original;
  const expected = (date: Date, timeZone: string) => {
    const parts = new Original("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    return ["year", "month", "day"].map(key => parts.find(part => part.type === key)!.value).join("-");
  };
  try {
    for (const zone of ["Asia/Shanghai", "Asia/Hong_Kong", "America/New_York"])
      for (const at of ["2024-02-29T15:59:59.999Z", "2024-02-29T16:00:00.000Z", "2026-03-08T06:59:59.999Z",
        "2026-03-08T07:00:00.000Z", "2026-11-01T05:59:59.999Z", "2026-11-01T06:00:00.000Z", "2026-01-01T04:59:59.999Z"])
        for (let n = 0; n < 5; n++) {
          const date = new Date(at); assert.equal(formatMarketLocalDate(date, zone), expected(date, zone));
        }
    assert.equal(constructions, 3, "formatters, never dates or evidence, are reusable");
    for (let n = 0; n < 2; n++) assert.equal(formatMarketLocalDate(new Date(0), "UTC"), expected(new Date(0), "UTC"));
    assert.equal(constructions, 5, "other timezones retain uncached legacy behavior");
    assert.throws(() => formatMarketLocalDate(new Date(NaN), "America/New_York"), RangeError);
    assert.throws(() => formatMarketLocalDate(new Date(0), "INVALID/TIMEZONE"), RangeError);
  } finally { Intl.DateTimeFormat = Original; }
});
