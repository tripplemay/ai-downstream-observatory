type Instant = { seconds: number; fraction: string };
const utc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/;

function instant(value: string): Instant {
  const match = utc.exec(value);
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

export function proposalClockInstant(normalized: string, original?: string): string {
  if (!original || !utc.test(original) || Date.parse(original) !== Date.parse(normalized)) return normalized;
  // Preserve an internal worker's precision, not an unrelated caller clock or a new audit timestamp.
  instant(original);
  return original;
}

export function proposalExpiryWithinTtl(expiresAt: string, now: string, ttlSeconds: number): boolean {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) throw new Error("INVALID_PROPOSAL_EXPIRY");
  const deadline = instant(expiresAt), current = instant(now);
  return compare(deadline, current) > 0 && compare(deadline, { ...current, seconds: current.seconds + ttlSeconds }) <= 0;
}
