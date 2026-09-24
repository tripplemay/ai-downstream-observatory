import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { canonical, hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { VERIFICATION_CHECK_ID, VERIFICATION_SUITE_VERSION, type VerificationContext, type VerificationSourceManifest } from "./types";

export const bytesHash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const fixedFiles = ["web/scripts/governance-fixture.ts", "web/scripts/build-governance-fixture.mjs", "web/package.json", "web/package-lock.json", "web/tsconfig.json",
  "requirements-workbench.txt", "scripts/migrate-workbench.mjs", "scripts/verification-source.mjs"];
const bundlePath = "web/dist/governance-fixture.mjs", buildPath = "web/dist/governance-fixture.manifest.json";
function rootDirectory(selected?: string): string {
  const candidate = selected ?? (existsSync(path.resolve(process.cwd(), "migrations/manifest.json")) ? process.cwd() : path.resolve(process.cwd(), ".."));
  return realpathSync(candidate);
}
function sourceBytes(root: string, relative: string): Buffer {
  const file = path.join(root, relative), stat = lstatSync(file);
  let component = root;
  for (const name of relative.split("/")) {
    component = path.join(component, name);
    if (lstatSync(component).isSymbolicLink()) throw new Error("VERIFICATION_SOURCE_UNAVAILABLE");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024 || !realpathSync(file).startsWith(root + path.sep)) throw new Error("VERIFICATION_SOURCE_UNAVAILABLE");
  return readFileSync(file);
}
export function verificationSourceFiles(selected?: string): Record<string, string> {
  const root = rootDirectory(selected), names: string[] = [];
  if (readdirSync(path.join(root, "worker")).includes("__init__.py")) throw new Error("VERIFICATION_SOURCE_UNAVAILABLE");
  const scan = (relative: string, extensions: string[]) => {
    const file = path.join(root, relative), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("VERIFICATION_SOURCE_UNAVAILABLE");
    if (stat.isDirectory()) for (const child of readdirSync(file).sort()) scan(`${relative}/${child}`, extensions);
    else if (stat.isFile() && extensions.includes(path.extname(relative))) names.push(relative);
    if (names.length > 4096) throw new Error("VERIFICATION_SOURCE_UNAVAILABLE");
  };
  for (const directory of ["accounting", "market", "orchestration", "performance", "research", "governance_verification"]) scan(`worker/${directory}`, [".py"]);
  scan("web/src/server", [".ts"]); scan("contracts", [".json"]); scan("migrations", [".sql", ".json"]);
  names.push(...fixedFiles);
  if (names.length > 4096 || new Set(names).size !== names.length) throw new Error("VERIFICATION_SOURCE_UNAVAILABLE");
  return Object.fromEntries(names.sort().map(relative => [relative, bytesHash(sourceBytes(root, relative))]));
}
export function currentVerificationSource(selected?: string): VerificationSourceManifest {
  try {
    const root = rootDirectory(selected), files = verificationSourceFiles(root);
    const bundle = sourceBytes(root, bundlePath), raw = sourceBytes(root, buildPath);
    const build = parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)) as Record<string, unknown>;
    if (canonical(Object.keys(build).sort()) !== canonical(["bundle_sha256", "entrypoint", "schema_version", "source_files"])
      || build.schema_version !== "verification-fixture-build-v2" || build.entrypoint !== "web/scripts/governance-fixture.ts"
      || build.bundle_sha256 !== bytesHash(bundle) || canonical(build.source_files) !== canonical(files)) throw new Error("invalid build");
    return { schema_version: "verification-source-v2", files: { ...files, [bundlePath]: bytesHash(bundle), [buildPath]: bytesHash(raw) } };
  } catch { throw new Error("VERIFICATION_SOURCE_UNAVAILABLE"); }
}
export function verificationContext(portfolio: string, selected?: string): VerificationContext {
  const source = currentVerificationSource(selected);
  return { schema_version: "verification-context-v2", portfolio_id: portfolio, check_id: VERIFICATION_CHECK_ID,
    suite_version: VERIFICATION_SUITE_VERSION, source_manifest: source, source_manifest_hash: hash(source) };
}
export function parseVerificationContext(raw: string): VerificationContext {
  try {
    if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) throw new Error("limit");
    const context = parseStrictJson(raw) as VerificationContext;
    if (canonical(Object.keys(context).sort()) !== canonical(["check_id", "portfolio_id", "schema_version", "source_manifest", "source_manifest_hash", "suite_version"])
      || context.schema_version !== "verification-context-v2" || context.check_id !== VERIFICATION_CHECK_ID || context.suite_version !== VERIFICATION_SUITE_VERSION
      || typeof context.portfolio_id !== "string" || !context.portfolio_id || context.portfolio_id.length > 200
      || canonical(Object.keys(context.source_manifest).sort()) !== canonical(["files", "schema_version"])
      || context.source_manifest.schema_version !== "verification-source-v2" || hash(context.source_manifest) !== context.source_manifest_hash) throw new Error("shape");
    const files = context.source_manifest.files;
    if (!files || typeof files !== "object" || Array.isArray(files) || Object.keys(files).length > 4098) throw new Error("files");
    for (const required of [...fixedFiles, bundlePath, buildPath, "migrations/manifest.json", "web/src/server/ledger/engine.ts", "worker/market/valuation.py", "worker/performance/pipeline.py"]) {
      if (!files[required]) throw new Error("missing file");
    }
    for (const [name, digest] of Object.entries(files)) if (!/^[a-zA-Z0-9_./-]+$/u.test(name) || name.startsWith("/") || name.split("/").includes("..") || !/^[a-f0-9]{64}$/u.test(digest)) throw new Error("invalid file");
    return context;
  } catch { throw new Error("VERIFICATION_EVIDENCE_INVALID"); }
}
