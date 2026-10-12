import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { fundedComparisonPathSchema } from "./funded-comparison-schemas";
import type { FundedHistoryInput } from "./funded-history";
import { fundedAnalysisDataSchema } from "./funded-analysis-schemas";

const unavailable = "FUNDED_COMPARISON_SOURCE_UNAVAILABLE";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function rootDirectory() { return realpathSync(existsSync(path.resolve("migrations/manifest.json")) ? process.cwd() : path.resolve("..")); }
function bytes(root: string, relative: string) {
  let file = root;
  for (const name of relative.split("/")) { file = path.join(file, name); if (lstatSync(file).isSymbolicLink()) throw new Error(unavailable); }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || !realpathSync(file).startsWith(root + path.sep)) throw new Error(unavailable);
  return readFileSync(file);
}
export function fundedComparisonSourceFiles(root = rootDirectory()) {
  root = realpathSync(root); const names: string[] = [];
  function scan(relative: string, extensions: string[]) {
    const file = path.join(root, relative), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(unavailable);
    if (stat.isDirectory()) for (const child of readdirSync(file).sort()) scan(`${relative}/${child}`, extensions);
    else if (stat.isFile() && extensions.includes(path.extname(relative))) names.push(relative);
    if (names.length > 4096) throw new Error(unavailable);
  }
  scan("web/src/server", [".ts"]); scan("contracts", [".json"]); scan("migrations", [".sql", ".json"]);
  names.push("web/scripts/funded-comparison-worker.ts", "web/scripts/build-funded-comparison.mjs", "web/package.json", "web/package-lock.json",
    "web/tsconfig.json", "scripts/funded-comparison-source.mjs");
  return Object.fromEntries(names.sort().map(relative => [relative, digest(bytes(root, relative))]));
}
function currentSource(root: string) {
  try {
    const files = fundedComparisonSourceFiles(root), bundle = bytes(root, "web/dist/funded-comparison.mjs"), manifest = bytes(root, "web/dist/funded-comparison.manifest.json");
    const build = parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(manifest)) as Record<string, unknown>;
    if (Object.keys(build).sort().join() !== "bundle_sha256,entrypoint,schema_version,source_files"
      || build.schema_version !== "funded-comparison-build-v1" || build.entrypoint !== "web/scripts/funded-comparison-worker.ts"
      || build.bundle_sha256 !== digest(bundle) || canonical(build.source_files) !== canonical(files)) throw new Error(unavailable);
    return hash({ files, bundle: digest(bundle), manifest: digest(manifest) });
  } catch { throw new Error(unavailable); }
}
export function assertFundedComparisonBuild() { return currentSource(rootDirectory()); }

// Capacity is per server process, not a distributed admission guarantee.
const runtime = globalThis as typeof globalThis & { __etfFundedComparisonCapacity?: { total: number; workspaces: Set<string> } };
const capacity = runtime.__etfFundedComparisonCapacity ??= { total: 0, workspaces: new Set<string>() };
export async function withFundedComparisonCapacity<T>(workspace: string, work: () => Promise<T>) {
  if (capacity.total >= 2 || capacity.workspaces.has(workspace)) throw new Error("FUNDED_COMPARISON_BUSY");
  capacity.total++; capacity.workspaces.add(workspace);
  try { return await work(); } finally { capacity.total--; capacity.workspaces.delete(workspace); }
}
const replySchema = z.object({ economics_hash: z.string().regex(/^[a-f0-9]{64}$/), paths: z.object({
  immediate: fundedComparisonPathSchema, staged: fundedComparisonPathSchema }).strict() }).strict();
async function replayStored(input: FundedHistoryInput, result: Record<string, unknown>, signal?: AbortSignal, analysisPath?: "immediate" | "staged") {
  if (signal?.aborted) throw new Error("FUNDED_COMPARISON_ABORTED");
  const root = rootDirectory(), before = currentSource(root), request = Buffer.from(canonical({ input, result, ...(analysisPath ? { analysis_path: analysisPath } : {}) }));
  if (request.length > 18 * 1024 * 1024) throw new Error("FUNDED_COMPARISON_INPUT_LIMIT");
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=384", path.join(root, "web/dist/funded-comparison.mjs")], {
      cwd: path.join(root, "web"), env: { NODE_ENV: "production", PATH: path.dirname(process.execPath), LANG: "C.UTF-8", TZ: "UTC" }, shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = []; let size = 0, stderrSize = 0, failure: string | null = null;
    const stop = (code: string) => { failure ??= code; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("FUNDED_COMPARISON_TIMEOUT"), 60000);
    const abort = () => stop("FUNDED_COMPARISON_ABORTED");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > (analysisPath ? 8 * 1024 * 1024 : 65536)) stop("FUNDED_COMPARISON_OUTPUT_LIMIT"); else chunks.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderrSize += chunk.length; if (stderrSize > 4096) stop("FUNDED_COMPARISON_OUTPUT_LIMIT"); });
    child.stdin.on("error", () => { failure ??= "FUNDED_COMPARISON_REPLAY_FAILED"; });
    child.on("error", () => { failure ??= "FUNDED_COMPARISON_REPLAY_FAILED"; });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure || code !== 0) reject(new Error(failure ?? "FUNDED_COMPARISON_REPLAY_FAILED")); else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(request);
  });
  if (signal?.aborted) throw new Error("FUNDED_COMPARISON_ABORTED");
  if (currentSource(root) !== before) throw new Error("FUNDED_COMPARISON_SOURCE_CHANGED");
  try { return parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output)); }
  catch { throw new Error("FUNDED_COMPARISON_REPLAY_FAILED"); }
}
export async function replayStoredFundedComparison(input: FundedHistoryInput, result: Record<string, unknown>, signal?: AbortSignal) {
  const value = await replayStored(input, result, signal);
  const parsed = replySchema.safeParse(value);
  if (!parsed.success) throw new Error("FUNDED_COMPARISON_REPLAY_FAILED");
  return parsed.data;
}
export async function replayStoredFundedAnalysis(input: FundedHistoryInput, result: Record<string, unknown>, path: "immediate" | "staged", signal?: AbortSignal) {
  const value = await replayStored(input, result, signal, path);
  const parsed = z.object({ analysis: fundedAnalysisDataSchema }).strict().safeParse(value);
  if (!parsed.success) throw new Error("FUNDED_COMPARISON_REPLAY_FAILED");
  return parsed.data.analysis;
}
