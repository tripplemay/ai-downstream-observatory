type Timer = ReturnType<typeof setTimeout>;
type TimeSource = { wall: () => number; monotonic: () => number;
  schedule: (callback: () => void, delay: number) => Timer; cancel: (timer: Timer) => void };
const realTime: TimeSource = { wall: Date.now, monotonic: () => performance.now(),
  schedule: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); return timer; }, cancel: clearTimeout };
type Entry<T> = { value: T; scope: string; wallDeadline: number; monotonicDeadline: number; timer?: Timer };

/** Independent expiry drops local derived text even when nobody polls the API. */
export class AiExplanationMemory<T> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(private readonly dispose: (value: T) => void, private readonly time: TimeSource = realTime) {}
  get size() { this.prune(); return this.entries.size; }
  values() { this.prune(); return [...this.entries.values()].map(entry => entry.value); }
  private prune() { for (const key of this.entries.keys()) this.get(key); }
  private remaining(entry: Entry<T>) {
    // Neither a backwards wall-clock change nor a forwards jump extends retention.
    return Math.min(entry.wallDeadline - this.time.wall(), entry.monotonicDeadline - this.time.monotonic());
  }
  private arm(key: string, entry: Entry<T>) {
    const remaining = this.remaining(entry);
    if (remaining <= 0) { this.delete(key); return; }
    entry.timer = this.time.schedule(() => {
      if (this.entries.get(key) === entry) this.arm(key, entry);
    }, Math.min(Math.ceil(remaining), 2147483647));
  }
  set(key: string, value: T, scope: string, ttl: number) {
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 31 * 86400000) throw new Error("INVESTOR_AI_BINDING_CHANGED");
    this.delete(key);
    const entry = { value, scope, wallDeadline: this.time.wall() + ttl, monotonicDeadline: this.time.monotonic() + ttl };
    this.entries.set(key, entry); this.arm(key, entry);
  }
  get(key: string) {
    const entry = this.entries.get(key);
    if (entry && this.remaining(entry) <= 0) { this.delete(key); return undefined; }
    return entry?.value;
  }
  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.timer !== undefined) this.time.cancel(entry.timer);
    this.dispose(entry.value);
  }
  clearScope(scope: string, except?: string) {
    for (const [key, entry] of this.entries) if (entry.scope === scope && key !== except) this.delete(key);
  }
}
