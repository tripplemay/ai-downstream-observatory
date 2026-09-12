import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const directory = new URL("../../contracts/v1/", import.meta.url);
const ajv = new Ajv2020({ strict: true, strictRequired: false });
addFormats(ajv);
for (const name of fs.readdirSync(directory).filter(name => name.endsWith(".schema.json"))) ajv.addSchema(JSON.parse(fs.readFileSync(new URL(name, directory), "utf8")));

test("Python research fixtures satisfy the same Ajv research plan/dataset schemas", () => {
  const code = "import json; from tests.research.fixtures import dataset,plan,parameters; print(json.dumps({'dataset':dataset(),'plan':plan(),'parameters':parameters()}))";
  const run = spawnSync(process.env.WORKBENCH_PYTHON || "python3", ["-c", code],
    { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const fixture = JSON.parse(run.stdout);
  for (const name of ["dataset", "plan", "parameters"]) {
    const validate = ajv.getSchema(`https://etf-workbench.invalid/contracts/v1/research-${name}.schema.json`);
    assert.equal(validate(fixture[name]), true, JSON.stringify(validate.errors));
  }
  const validate = ajv.getSchema("https://etf-workbench.invalid/contracts/v1/research-parameters.schema.json");
  assert.equal(validate({ ...fixture.parameters, weights: { "CN:TEST": 1 } }), false);
  assert.equal(validate({ ...fixture.parameters, activate_live: true }), false);
});
