const maximumProofs = 64;
let proofs: Set<string> | null = null;

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
