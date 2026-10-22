type Instant = { seconds: number; fraction: string };

function instant(value: string): Instant {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(value);
  if (!match) throw new Error("INVALID_PROPOSAL_EXPIRY");
  const millis = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 19) !== match[1]) throw new Error("INVALID_PROPOSAL_EXPIRY");
  // Removing insignificant zeros preserves exact ordering without truncating fractional precision.
  return { seconds: millis / 1000, fraction: (match[2] ?? "").replace(/0+$/, "") };
}

function compare(left: Instant, right: Instant): number {
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  return left.fraction === right.fraction ? 0 : left.fraction < right.fraction ? -1 : 1;
}

export function compareProposalInstants(left: string, right: string): number {
  return compare(instant(left), instant(right));
}

export function proposalExpiryWithinTtl(expiresAt: string, now: string, ttlSeconds: number): boolean {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error("INVALID_PROPOSAL_EXPIRY");
  const deadline = instant(expiresAt), current = instant(now);
  return compare(deadline, current) > 0 && compare(deadline, { ...current, seconds: current.seconds + ttlSeconds }) <= 0;
}
