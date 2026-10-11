import { useEffect, useRef, useState } from "react";

export function useInvestorDisplayTime(checkedAt: string | null, deadlineKey: string) {
  const [now, setNow] = useState<number | null>(null);
  const clock = useRef<{ wall: number; elapsed: number } | null>(null);
  const baseline = checkedAt === null ? 0 : Date.parse(checkedAt);
  const readNow = () => {
    const elapsed = performance.now(), previous = clock.current;
    const wall = Math.max(baseline, Date.now(), previous ? previous.wall + Math.max(0, elapsed - previous.elapsed) : 0);
    clock.current = { wall, elapsed };
    return wall;
  };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlines = deadlineKey.split("|").filter(Boolean).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const arm = (current: number) => {
      if (timer !== undefined) clearTimeout(timer);
      const deadline = deadlines.find(value => value > current);
      if (deadline !== undefined) timer = setTimeout(wake, Math.min(deadline - current, 2147483647));
    };
    const wake = () => { const current = readNow(); setNow(previous => Math.max(previous ?? 0, current)); arm(current); };
    wake(); document.addEventListener("visibilitychange", wake);
    return () => { if (timer !== undefined) clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [baseline, deadlineKey]);
  // The first SSR/client render uses the same checked time; later renders also latch forward clock jumps.
  return { now: Math.max(baseline, now ?? baseline, clock.current === null ? 0 : readNow()), readNow };
}

export function useInvestorDisplayClock(checkedAt: string | null, deadlineKey: string): number {
  return useInvestorDisplayTime(checkedAt, deadlineKey).now;
}
