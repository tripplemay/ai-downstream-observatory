import { openWorkbench } from "../../web/src/server/workbench-db";
import { createPortfolio, hash } from "../../web/src/server/ledger/service";
import { verificationContext } from "../../web/src/server/verifications/source";
import { requestVerification, getVerificationState } from "../../web/src/server/verifications/service";

const [filename, mode = "request", at = "2026-01-05T00:00:00.000000Z"] = process.argv.slice(2);
const db = openWorkbench(filename);
try {
  if (mode === "read") process.stdout.write(JSON.stringify(getVerificationState(db, {}, { now: at })) + "\n");
  else {
    const actor = { id: "SYNTHETIC-REQUESTING-HUMAN", kind: "human" as const };
    const portfolio = mode === "replay" ? (db.prepare("SELECT id FROM portfolios ORDER BY id LIMIT 1").get() as { id: string }).id
      : createPortfolio(db, actor, "SYNTHETIC runner service integration", at);
    const context = verificationContext(portfolio);
    const input = { portfolio_id: portfolio, check_id: "E-02.cash-contribution-neutrality.v1", expected_context_hash: hash(context),
      reason: "SYNTHETIC normal service request; never authorizes investment", idempotency_key: "synthetic-verification-request" };
    const receipt = requestVerification(db, actor, input, { now: at });
    const replay = requestVerification(db, actor, input, { now: at });
    if (receipt.request_id !== replay.request_id) throw new Error("REQUEST_REPLAY_CHANGED");
    process.stdout.write(JSON.stringify({ portfolio_id: portfolio, ...receipt }) + "\n");
  }
} finally { db.close(); }
