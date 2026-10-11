import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, mkdtempSync, rmSync, chmodSync, existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { hash, canonical } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { investorHash, investorInstant } from "./schemas";
import { aiMonitorReviewSchema, validateAiMonitorReview, type AiMonitorContext } from "./ai-explanation-schemas";

const failure = "INVESTOR_AI_CONFIG_UNAVAILABLE";
function privateDocument(filename: string) {
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(filename)) throw new Error();
    const before = lstatSync(filename); if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1
      || before.ino !== stat.ino || before.dev !== stat.dev || stat.size < 1 || stat.size > 16384) throw new Error();
    const bytes = Buffer.alloc(16385);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size || length > 16384) throw new Error();
    const raw = bytes.subarray(0, length);
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch { throw new Error(failure); }
  finally { if (fd !== undefined) closeSync(fd); }
}
const settingsBase = { base_url: z.string().min(1).max(2000).regex(/^[\x21-\x7e]+$/), api_key: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}$/), max_output_tokens: z.number().int().min(512).max(2048) };
const settingsSchema = z.discriminatedUnion("schema_version", [
  z.object({ ...settingsBase, schema_version: z.literal("readonly-ai-gateway-v1") }).strict(),
  z.object({ ...settingsBase, schema_version: z.literal("readonly-ai-gateway-config-v2"), request_profile: z.literal("deepseek_non_thinking"),
    model: z.enum(["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-flash", "deepseek-pro"]) }).strict(),
]);
export const aiSharingCategories = ["model_ratios", "target_deviation", "strategy_trigger_codes"] as const;
const consentSchema = z.object({ schema_version: z.literal("investor-ai-sharing-consent-v1"), principal_id: z.string().min(1).max(200),
  gateway_audience_hash: investorHash, decision: z.literal("allow"), allowed_categories: z.tuple([z.literal("model_ratios"), z.literal("target_deviation"), z.literal("strategy_trigger_codes")]),
  source: z.literal("explicit_user_confirmation"), valid_from: investorInstant, valid_until: investorInstant }).strict();
export type AiSettings = { config_file: string; consent_file: string; config_hash: string; audience_hash: string; consent_hash: string; valid_until: string };
export function readAiExplanationSettings(configFile: string, consentFile: string, actor: { id: string }, now: string): AiSettings {
  try {
    investorInstant.parse(now);
    const config = settingsSchema.parse(privateDocument(configFile)), url = new URL(config.base_url);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || url.port && url.port !== "443"
      || config.base_url.includes("?") || config.base_url.includes("#")) throw new Error();
    const audienceHash = hash({ base_url: config.base_url.replace(/\/+$/, ""), model: config.model,
      request_profile: "request_profile" in config ? config.request_profile : null });
    const consent = consentSchema.parse(privateDocument(consentFile));
    if (consent.principal_id !== actor.id || consent.gateway_audience_hash !== audienceHash || Date.parse(consent.valid_from) > Date.parse(now)
      || Date.parse(consent.valid_until) <= Date.parse(now) || Date.parse(consent.valid_until) <= Date.parse(consent.valid_from)
      || Date.parse(consent.valid_until) - Date.parse(consent.valid_from) > 31 * 86400000) throw new Error("INVESTOR_AI_CONSENT_NOT_CURRENT");
    return { config_file: configFile, consent_file: consentFile, config_hash: hash(config), audience_hash: audienceHash,
      consent_hash: hash(consent), valid_until: consent.valid_until };
  } catch (error) {
    if (error instanceof Error && error.message === "INVESTOR_AI_CONSENT_NOT_CURRENT") throw error;
    throw new Error(failure);
  }
}
const files = ["worker/research/ai_gateway.py", "worker/research/ai.py", "worker/ai_explanation/context.py", "worker/ai_explanation/__init__.py",
  "worker/market/contracts.py", "worker/market/providers/process.py", "worker/orchestration/db.py", "worker/accounting/decimal_math.py", "worker/accounting/__init__.py",
  "web/src/server/investor/ai-explanation-context.ts", "web/src/server/investor/ai-explanation-process.ts", "web/src/server/investor/ai-explanation-schemas.ts",
  "web/src/server/investor/ai-explanation.ts",
  "web/src/server/investor/ai-explanation-memory.ts",
  "web/src/server/investor/ai-explanation-store.ts", "web/src/server/investor/ai-explanation-retention.ts",
  "web/src/server/investor/ai-explanation-background.ts", "web/scripts/ai-explanation-worker.ts",
  "web/scripts/build-ai-explanation.mjs", "web/scripts/run-ai-explanation.mjs", "scripts/ai-explanation-source.mjs",
  "migrations/0038_investor_ai_requests.sql", "migrations/0039_investor_ai_queue_guards.sql",
  "contracts/v1/ai-monitor-context.schema.json", "contracts/v1/ai-monitor-review.schema.json", "contracts/v1/ai-research-review.schema.json", "contracts/v1/common.schema.json"];
function rootDirectory() { return realpathSync(existsSync(path.resolve("migrations/manifest.json")) ? process.cwd() : path.resolve("..")); }
export function aiExplanationImplementationHash() {
  try {
    const root = rootDirectory();
    return hash(Object.fromEntries(files.map(name => {
      const file = path.join(root, name), stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !realpathSync(file).startsWith(root + path.sep) || stat.size > 2097152) throw new Error();
      return [name, createHash("sha256").update(readFileSync(file)).digest("hex")];
    })));
  } catch { throw new Error("INVESTOR_AI_IMPLEMENTATION_UNAVAILABLE"); }
}
const usageSchema = z.object({ prompt_tokens: z.number().int().nonnegative().max(1000000), completion_tokens: z.number().int().nonnegative().max(1000000),
  total_tokens: z.number().int().nonnegative().max(1000000) }).strict().refine(row => row.prompt_tokens + row.completion_tokens === row.total_tokens);
export const aiTransportResultSchema = z.object({ review: aiMonitorReviewSchema, review_hash: investorHash, context_hash: investorHash,
  reported_model_hash: investorHash, usage: usageSchema.nullable() }).strict();
const safeErrors = new Set(["AUTHENTICATION_FAILED", "PERMISSION_DENIED", "RATE_LIMITED", "TIMEOUT", "CALL_TIMEOUT", "HTTP_FAILED",
  "RESPONSE_TRUNCATED", "RESPONSE_TOOL_REQUESTED", "RESPONSE_REFUSED", "OUTPUT_INVALID", "CONFIG_INVALID", "REQUEST_INVALID"]
  .map(name => "AI_GATEWAY_" + name));
export async function requestAiMonitorReview(context: AiMonitorContext, settings: AiSettings, signal?: AbortSignal) {
  const root = rootDirectory(), implementation = aiExplanationImplementationHash();
  const python = process.env.WORKBENCH_AI_PYTHON;
  if (!python || !path.isAbsolute(python)) throw new Error("INVESTOR_AI_RUNTIME_UNAVAILABLE");
  const input = Buffer.from(canonical(context)); if (input.length > 4096) throw new Error("INVESTOR_AI_INPUT_LIMIT");
  if (signal?.aborted) throw new Error("INVESTOR_AI_ABORTED");
  const directory = mkdtempSync(path.join(os.tmpdir(), "etf-ai-explanation-")); chmodSync(directory, 0o700);
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const launcher = "import os,signal,sys;signal.signal(signal.SIGALRM,signal.SIG_DFL);signal.setitimer(signal.ITIMER_REAL,30);os.execve(sys.argv[1],sys.argv[1:],os.environ)";
      const child = spawn(python, ["-I", "-c", launcher, python, "-I", path.join(root, "worker/research/ai_gateway.py"), "--monitor-review", settings.config_file, settings.config_hash], {
        cwd: directory, env: { HOME: directory, LANG: "C.UTF-8", TZ: "UTC", PYTHONUTF8: "1", NODE_ENV: "production" }, shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [], err: Buffer[] = []; let size = 0, errors = 0, failed: string | null = null;
      const stop = (code: string) => { failed ??= code; child.kill("SIGKILL"); };
      const timer = setTimeout(() => stop("INVESTOR_AI_TIMEOUT"), 35000), abort = () => stop("INVESTOR_AI_ABORTED");
      signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
      child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16384) stop("INVESTOR_AI_OUTPUT_INVALID"); else out.push(chunk); });
      child.stderr.on("data", (chunk: Buffer) => { errors += chunk.length; if (errors > 1024) stop("INVESTOR_AI_OUTPUT_INVALID"); else err.push(chunk); });
      child.stdin.on("error", () => { failed ??= "INVESTOR_AI_FAILED"; }); child.on("error", () => { failed ??= "INVESTOR_AI_RUNTIME_UNAVAILABLE"; });
      child.on("close", code => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        if (!failed && code !== 0) {
          try { const value = z.object({ error: z.string() }).strict().parse(parseStrictJson(Buffer.concat(err).toString("utf8")));
            if (safeErrors.has(value.error)) failed = value.error; } catch { /* Never disclose arbitrary diagnostics. */ }
          failed ??= "INVESTOR_AI_FAILED";
        }
        if (failed) reject(new Error(failed)); else resolve(Buffer.concat(out));
      });
      child.stdin.end(input);
    });
    if (signal?.aborted) throw new Error("INVESTOR_AI_ABORTED");
    if (implementation !== aiExplanationImplementationHash()) throw new Error("INVESTOR_AI_BINDING_CHANGED");
    try {
      const value = aiTransportResultSchema.parse(parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
      validateAiMonitorReview(value.review, context);
      if (value.review_hash !== hash(value.review) || value.context_hash !== hash(context)) throw new Error();
      return value;
    } catch { throw new Error("INVESTOR_AI_OUTPUT_INVALID"); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
