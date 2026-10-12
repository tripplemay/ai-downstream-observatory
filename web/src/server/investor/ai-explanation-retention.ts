type Timer = ReturnType<typeof setTimeout>;
const runtime = globalThis as typeof globalThis & { __etfAiRetentionTimers?: Map<string, Timer> };
const timers = runtime.__etfAiRetentionTimers ??= new Map<string, Timer>();

/** Poll only local retention state; this never starts or retries a gateway call. */
export function startAiRetention(key: string, maintain: () => boolean) {
  if (timers.has(key)) return;
  const schedule = () => {
    const timer = setTimeout(() => {
      let again = true;
      try { again = maintain(); } catch { /* A recovery lock or unavailable DB never permits bypassing write guards. */ }
      if (again) schedule(); else timers.delete(key);
    }, 60000);
    timer.unref(); timers.set(key, timer);
  };
  schedule();
}
