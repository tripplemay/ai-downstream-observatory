import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { observationSchema, poolItemSchema, signalUpdateSchema } from "../src/lib/schemas";

test("oversized bounded collections reject before parsing or refining any element", () => {
  let visited = 0;
  const element = z.string().refine(() => { visited++; return false; });
  const oversized = Array.from({ length: 1000 }, (_, index) => String(index));
  for (const schema of [z.array(element).max(2), z.array(element).length(2),
    z.set(element).max(2), z.map(element, element).max(2)]) {
    const input = schema instanceof z.ZodSet ? new Set(oversized)
      : schema instanceof z.ZodMap ? new Map(oversized.map(value => [value, value])) : oversized;
    const parsed = schema.safeParse(input);
    assert.equal(parsed.success, false);
    assert.equal(visited, 0);
    if (!parsed.success) assert.equal(parsed.error.issues.length, 1);
  }
});

test("session envelope extension retains strictness and original cross-field refinements", () => {
  const body = z.object({ count: z.number().int(), rows: z.array(z.string()).max(2) }).strict()
    .refine(value => value.count === value.rows.length, "COUNT_MISMATCH");
  const envelope = body.safeExtend({ session_binding: z.string().length(64) }).strict();
  const valid = { count: 1, rows: ["a"], session_binding: "b".repeat(64) };
  assert.deepEqual(envelope.parse(valid), valid);
  for (const invalid of [{ ...valid, count: 0 }, { ...valid, surprise: true }, { ...valid, session_binding: "short" }])
    assert.equal(envelope.safeParse(invalid).success, false);
});

test("explicit unknown-value records keep arbitrary JSON values and reject non-object inputs", () => {
  const schema = z.record(z.string(), z.unknown());
  const value = { schema_version: "fixture-v1", number: 1, nested: { flag: false }, empty: null };
  assert.deepEqual(schema.parse(value), value);
  for (const invalid of [null, [], "{}", 1]) assert.equal(schema.safeParse(invalid).success, false);
});

test("legacy form defaults and field-level resolver errors remain usable with the patched runtime", async () => {
  assert.deepEqual(poolItemSchema.parse({ themeId: "fixture", name: "ETF" }), {
    themeId: "fixture", name: "ETF", code: "", channel: "", position: "", note: "",
  });
  assert.deepEqual(signalUpdateSchema.parse({ themeId: "fixture", id: "signal", status: "watch" }), {
    themeId: "fixture", id: "signal", status: "watch", current_value: "", note: "",
  });
  const resolve = zodResolver(observationSchema);
  const options = { fields: {}, shouldUseNativeValidation: false, criteriaMode: "all" as const };
  const valid = { themeId: "fixture", date: "2026-01-01", light: "green" as const };
  assert.deepEqual(await resolve(valid, undefined, options), { errors: {}, values: { ...valid, note: "" } });
  const invalid = await resolve({ ...valid, date: "not-a-date" }, undefined, options);
  assert.equal(invalid.errors.date?.message, "日期格式应为 YYYY-MM-DD");
  assert.deepEqual(invalid.values, {});
});
