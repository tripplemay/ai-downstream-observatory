import assert from "node:assert/strict";
import test from "node:test";
import { parseStrictJson } from "../src/server/strict-json";

test("strict JSON retains legal values but rejects duplicate escaped and nested keys", () => {
  for (const value of [null, 1, [], { a: [1, { a: "quoted \\\" { } , :", b: ["a", "a"] }], b: "a" }]) {
    assert.deepEqual(parseStrictJson(JSON.stringify(value)), value);
  }
  for (const raw of ['{"amount":"1","amount":"100"}', '{"a":1,"\\u0061":2}', '[{"a":{"x":1,"x":2}}]']) {
    assert.throws(() => parseStrictJson(raw), /DUPLICATE_JSON_KEY/);
  }
  assert.throws(() => parseStrictJson('['.repeat(65) + '0' + ']'.repeat(65)), /JSON_DEPTH_EXCEEDED/);
  assert.throws(() => parseStrictJson('{"a":NaN}'));
});
