import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { modelAssessmentObservation } from "../src/server/investor/kernel-contracts";
import type { InvestorProfileVersion } from "../src/server/investor/types";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Imported only by the temporary browser fixture seeder, never an API or production producer.
export function computedBrowserObservation(profile: InvestorProfileVersion, now: string, mode: string) {
  if (profile.document.loss_tolerance === null || !["CN", "HK", "US"].every(market => profile.document.markets.includes(market as "CN" | "HK" | "US"))) {
    throw new Error("SYNTHETIC_BROWSER_CONSTRAINTS_REQUIRED");
  }
  const python = process.env.WORKBENCH_TEST_PYTHON || "python3";
  const fixture = spawnSync(python, ["-c", "import json; from tests.investor.fixtures import monitor_input; print(json.dumps(monitor_input()))"],
    { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000 });
  if (fixture.status !== 0) throw new Error("SYNTHETIC_BROWSER_FIXTURE_FAILED");
  const document = JSON.parse(fixture.stdout);
  document.profile_id = profile.id; document.profile_version = profile.version; document.profile_hash = profile.content_hash;
  const at = Date.parse(now), date = (delta: number) => new Date(at + delta).toISOString();
  for (const [index, row] of document.quotes.entries()) {
    row.observed_at = date(-(6 - index) * 3600000); row.expected_close_at = row.observed_at;
    row.known_at = now; row.valid_until = date(3600000);
  }
  for (const row of document.fx) { row.observed_at = date(-3600000); row.known_at = now; row.valid_until = date(3600000); }
  if (mode === "computed-decision") document.funding_intent = { id: "synthetic-browser-flow", amount_cny: "2000", expected_at: now };
  if (mode === "computed-stale") document.quotes[1].observed_at = date(-30 * 3600000);
  const request = { action: "monitor" as const, document, now };
  const child = spawnSync(python, ["-m", "worker.investor"], { cwd: root, input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000 });
  if (child.status !== 0) throw new Error("SYNTHETIC_BROWSER_KERNEL_FAILED");
  return { observation: modelAssessmentObservation(request, JSON.parse(child.stdout)), weights: document.after_weights as Record<string, string> };
}
