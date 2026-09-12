import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const directory = new URL("../../contracts/v1/", import.meta.url);
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats(ajv);
for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(fs.readFileSync(new URL(name, directory), "utf8")));
}
const validate = ajv.getSchema("https://etf-workbench.invalid/contracts/v1/valuation-rules.schema.json");
const rules = {
  schema_version: "valuation-rules-v1", approved: true, approval_evidence: "fixture only",
  price_scope_by_market: { CN: "prices:CN" }, expected_sessions: { CN: "2025-01-03" },
  corporate_actions_complete: { "CN:TEST": true }, max_fx_age_seconds: 86400,
};

test("shared valuation rules validate in Ajv without granting live advice", () => {
  assert.equal(validate(rules), true, JSON.stringify(validate.errors));
  const missingEvidence = { ...rules };
  delete missingEvidence.approval_evidence;
  assert.equal(validate(missingEvidence), false);
  assert.equal(validate({ ...rules, live_advice: true }), false);
  assert.equal(validate({ ...rules, expected_sessions: { CN: "2025-02-30" } }), false);
  assert.equal(validate({ ...rules, max_fx_age_seconds: -1 }), false);
});

test("ASCII-key market manifest canonical JSON matches Python including Unicode values", () => {
  const value = { z: 1, batch: { source_evidence: "\u4eba\u5de5\u6838\u5bf9", expected_rows: 1, id: "batch:1" }, a: [true, null, "0.01"] };
  const canonical = item => Array.isArray(item) ? `[${item.map(canonical).join(",")}]`
    : item !== null && typeof item === "object" ? `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`
      : JSON.stringify(item);
  const run = spawnSync(process.env.WORKBENCH_PYTHON || "python3", ["-c", "import json,sys; from worker.orchestration.db import canonical_json; print(canonical_json(json.load(sys.stdin)))"],
    { cwd: new URL("../../", import.meta.url), input: JSON.stringify(value), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), canonical(value));
});
