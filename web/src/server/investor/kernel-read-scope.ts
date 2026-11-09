import { createHash } from "node:crypto";
import { serialize } from "node:v8";

const maximumProofs = 64;
let proofs: Set<string> | null = null;

/** Ephemeral plain-JSON identity, never a persisted evidence or authority hash. */
export function investorKernelProofKey(value: unknown): string | null {
  let remaining = 1000000;
  const seen = new Set<object>();
  function eligible(item: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 64) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    seen.add(item);
    if (array && item.length > remaining) return false;
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) return false;
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string") return false;
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property?.enumerable || !("value" in property)) return false;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) return false;
      if (!eligible(property.value, depth + 1)) return false;
    }
    return true;
  }
  try {
    if (!eligible(value, 0)) return null;
    // Serialization may miss equivalent representations; a miss only revalidates.
    return createHash("sha256").update("investor-kernel-binary-proof-v1\0").update(serialize(value)).digest("hex");
  } catch { return null; }
}

/** A synchronous read only; never retain evidence or trust across requests. */
export function withInvestorKernelReadScope<T>(read: () => T): T {
  const parent = proofs;
  proofs = new Set();
  try {
    const value = read();
    if (value !== null && (typeof value === "object" || typeof value === "function") && "then" in value)
      throw new Error("INVESTOR_KERNEL_READ_SCOPE_MUST_BE_SYNCHRONOUS");
    return value;
  } finally { proofs = parent; }
}

/** Only deterministic, complete-byte-bound calculation checks belong here. */
export function verifyInvestorKernelProof(key: () => string | null, verify: () => void): void {
  const scope = proofs;
  if (scope === null) { verify(); return; }
  const digest = key();
  if (digest === null) { verify(); return; }
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("INVESTOR_KERNEL_PROOF_KEY_INVALID");
  if (scope.has(digest)) return;
  verify();
  if (proofs === scope && scope.size < maximumProofs) scope.add(digest);
}
