import { createHash } from "node:crypto";
import { hash } from "../ledger/service";
import { parseStrictJson } from "../strict-json";
import { verifyInvestorKernelProof } from "./kernel-read-scope";

function object(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INVESTOR_EVIDENCE_INVALID");
  return value;
}

/** Pure document consistency only; current source/authority checks stay with the caller. */
export function parseSealedInvestorJson(raw: string, expectedHash: string): unknown {
  let checked = false, value: unknown;
  verifyInvestorKernelProof(() => typeof raw === "string" && typeof expectedHash === "string" && /^[a-f0-9]{64}$/.test(expectedHash)
    // UTF-16 keeps lone surrogates distinct from replacement characters.
    ? createHash("sha256").update("investor-sealed-json-object-v1\0").update(JSON.stringify([expectedHash, raw.length]))
      .update("\0").update(raw, "utf16le").digest("hex") : null, () => {
    value = object(parseStrictJson(raw));
    if (hash(value) !== expectedHash) throw new Error("INVESTOR_EVIDENCE_INVALID");
    checked = true;
  });
  return checked ? value : object(JSON.parse(raw));
}
