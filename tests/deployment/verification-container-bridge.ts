import assert from "node:assert/strict";
import { createPortfolio, hash } from "../../web/src/server/ledger/service";
import { openWorkbench } from "../../web/src/server/workbench-db";
import { currentVerificationSource, verificationContext } from "../../web/src/server/verifications/source";
import { getVerificationState, readVerificationArtifact, requestVerification } from "../../web/src/server/verifications/service";

const [mode, filename] = process.argv.slice(2);
const sourceRoot = process.env.VERIFICATION_SMOKE_SOURCE_ROOT ?? "/app";
if (mode === "source") {
  const source = currentVerificationSource(sourceRoot);
  console.log(JSON.stringify({ schema_version: "verification-image-source-smoke-v1", source_manifest_sha256: hash(source),
    bundle_sha256: source.files["web/dist/governance-fixture.mjs"], sidecar_sha256: source.files["web/dist/governance-fixture.manifest.json"],
    source_file_count: Object.keys(source.files).length }));
} else {
  assert.ok(filename && ["request", "read"].includes(mode));
  const db = openWorkbench(filename);
  try {
    const at = new Date().toISOString();
    if (mode === "request") {
      const actor = { id: "synthetic-container-human", kind: "human" as const };
      const portfolio = createPortfolio(db, actor, "Synthetic isolated verifier smoke", at);
      const context = verificationContext(portfolio, sourceRoot);
      const input = { portfolio_id: portfolio, check_id: "E-02.cash-contribution-neutrality.v1", expected_context_hash: hash(context),
        reason: "Synthetic container smoke only; no investment acceptance", idempotency_key: "synthetic-container-request" };
      const receipt = requestVerification(db, actor, input, { now: at, sourceRoot });
      assert.deepEqual(requestVerification(db, actor, input, { now: at, sourceRoot }), receipt);
      console.log(JSON.stringify({ portfolio_id: portfolio, ...receipt }));
    } else {
      const state = getVerificationState(db, {}, { now: at, sourceRoot });
      assert.equal(state.check.available, true); assert.equal(state.requests.length, 1);
      const request = state.requests[0];
      assert.deepEqual(request.evidence_issues, []); assert.equal(request.job_status, "succeeded");
      assert.ok(request.execution); assert.equal(request.execution.status, "pass");
      const artifact = readVerificationArtifact(db, state.selected_portfolio_id!, request.execution.artifact_id, { now: at, sourceRoot });
      assert.equal(artifact.sha256, request.execution.artifact_sha256);
      console.log(JSON.stringify({ request_id: request.id, status: request.execution.status, independent_ts_proof: true,
        downloaded_artifact_sha256: artifact.sha256, gate_eligible: state.check.gate_eligible }));
    }
  } finally { db.close(); }
}
