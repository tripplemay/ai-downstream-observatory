import { parseStrictJson } from "../src/server/strict-json";
import { fundedCashIntentReview, fundedExecutionReview, verifyFundedHistoryEconomics } from "../src/server/investor/funded-history-economics";
import type { FundedHistoryInput } from "../src/server/investor/funded-history";
import { fundedComparisonPathSchema } from "../src/server/investor/funded-comparison-schemas";
import { analysisPathSchema } from "../src/server/investor/funded-analysis-schemas";
import { analyzeFundedHistory } from "../src/server/investor/funded-analysis-math";

async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 18 * 1024 * 1024) throw new Error("limit"); chunks.push(bytes);
  }
  const raw = parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))) as
    { input: FundedHistoryInput; result: Record<string, unknown>; analysis_path?: "immediate" | "staged" };
  if (!raw || !["input,result", "analysis_path,input,result"].includes(Object.keys(raw).sort().join())) throw new Error("shape");
  if (Object.hasOwn(raw, "analysis_path")) {
    process.stdout.write(JSON.stringify({ analysis: analyzeFundedHistory(raw.input, raw.result, analysisPathSchema.parse(raw.analysis_path)) }) + "\n");
    return;
  }
  const verified = verifyFundedHistoryEconomics(raw.input, raw.result);
  const paths = Object.fromEntries(Object.entries(verified.economics).map(([name, value]) => [name,
    fundedComparisonPathSchema.parse({ ...Object.fromEntries(Object.keys(fundedComparisonPathSchema.shape).map(key => [key, (value as Record<string, unknown>)[key]])),
      ...(fundedExecutionReview(value) ? { execution_review: fundedExecutionReview(value) } : {}),
      ...(fundedCashIntentReview(value) ? { cash_intent_review: fundedCashIntentReview(value) } : {}) })]));
  process.stdout.write(JSON.stringify({ economics_hash: verified.independently_replayed_economics_hash, paths }) + "\n");
}
main().catch(() => { process.stderr.write("FUNDED_COMPARISON_REPLAY_FAILED\n"); process.exitCode = 1; });
