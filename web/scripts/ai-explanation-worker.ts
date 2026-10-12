import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { openWorkbench } from "../src/server/workbench-db";
import { runInvestorAiBackgroundPass } from "../src/server/investor/ai-explanation-background";

const healthFile = "/tmp/etf-ai-runtime-health.json";
export async function main(args: string[], verify: () => void) {
  if (args.length > 1 || args.length === 1 && !["--once", "--health"].includes(args[0])) throw new Error("AI_RUNTIME_INPUT_INVALID");
  if (args[0] === "--health") {
    const health = JSON.parse(readFileSync(healthFile, "utf8"));
    if (health.status !== "ready" || typeof health.at !== "number" || health.at > Date.now() || Date.now() - health.at > 120000) throw new Error("AI_RUNTIME_NOT_READY");
    return;
  }
  const abort = new AbortController(), stop = () => abort.abort();
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    do {
      let connection: ReturnType<typeof openWorkbench> | undefined;
      try {
        verify(); connection = openWorkbench();
        // Production authentication has one fixed owner. DB rows cannot select another principal or executable.
        await runInvestorAiBackgroundPass(connection, { id: "owner" }, process.env.WORKBENCH_AI_ENABLE_DISPATCH === "1", { signal: abort.signal, assert_runtime: verify });
        writeFileSync(healthFile, JSON.stringify({ status: "ready", at: Date.now() }), { mode: 0o600 });
      } catch {
        writeFileSync(healthFile, JSON.stringify({ status: "unavailable", at: Date.now() }), { mode: 0o600 });
        process.stderr.write("AI_RUNTIME_PASS_UNAVAILABLE\n");
        if (args[0] === "--once") throw new Error("AI_RUNTIME_PASS_UNAVAILABLE");
      } finally { connection?.close(); }
      if (args[0] === "--once" || abort.signal.aborted) break;
      try { await sleep(15000, undefined, { signal: abort.signal }); } catch { break; }
    } while (!abort.signal.aborted);
  } finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
}
