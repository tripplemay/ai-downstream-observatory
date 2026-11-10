"""Bounded process-local timings; no evidence, account identifiers or caching."""

from contextlib import contextmanager
import time


class WorkerTimings:
    def __init__(self, role, emit, *, monotonic=time.monotonic, cpu=time.process_time, interval=60):
        self.role, self.emit, self.monotonic, self.cpu = role, emit, monotonic, cpu
        self.interval, self.started, self.phases = interval, monotonic(), {}

    @contextmanager
    def phase(self, name):
        wall, cpu, failed = self.monotonic(), self.cpu(), False
        try:
            yield
        except BaseException:
            failed = True
            raise
        finally:
            elapsed, consumed = self.monotonic() - wall, self.cpu() - cpu
            item = self.phases.setdefault(name, {"count": 0, "errors": 0, "wall_seconds": 0.0, "cpu_seconds": 0.0, "max_seconds": 0.0})
            item["count"] += 1
            item["errors"] += int(failed)
            item["wall_seconds"] += elapsed
            item["cpu_seconds"] += consumed
            item["max_seconds"] = max(item["max_seconds"], elapsed)

    def flush(self, *, force=False):
        now = self.monotonic()
        if self.phases and (force or now - self.started >= self.interval):
            self.emit({"event": "worker_phase_timings", "role": self.role, "interval_seconds": now - self.started,
                "phases": self.phases})
            self.started, self.phases = now, {}
