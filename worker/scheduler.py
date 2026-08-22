"""容器内定时调度器（替代 macOS launchd）。

每天 16:35 跑 daily（行情采集 + 规则引擎，A股收盘后）；
每月 11 日 09:20 跑 monthly，2/5/8/11 月 15 日 09:45 跑 quarterly。
状态记录在 data/.scheduler_state，同一天同一任务不重复触发；错过的时间点
在容器运行期间当天补跑，跨天不补。
"""
import json
import os
import subprocess
import time
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_FILE = os.path.join(BASE, "data", ".scheduler_state")
RUN_JOB = os.path.join(BASE, "jobs", "run_job.sh")

SCHEDULE = [
    # (job_type, month_set(None=每月), day(None=不按日), hour, minute, weekday(None=不限,0=周一))
    ("daily", None, None, 16, 35, None),
    ("weekly", None, None, 10, 5, 5),   # 每周六 10:05：估值采集 + 全行业周报
    ("monthly", None, 11, 9, 20, None),
    ("quarterly", {2, 5, 8, 11}, 15, 9, 45, None),
]


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def due_jobs(now):
    for job_type, months, day, hour, minute, weekday in SCHEDULE:
        if months is not None and now.month not in months:
            continue
        if weekday is not None and now.weekday() != weekday:
            continue
        if day is not None and now.day != day:
            continue
        if (now.hour, now.minute) < (hour, minute):
            continue
        yield job_type


def main():
    print(f"[scheduler] started at {datetime.now()}", flush=True)
    while True:
        now = datetime.now()
        state = load_state()
        today = now.strftime("%Y-%m-%d")
        for job_type in due_jobs(now):
            if state.get(job_type) == today:
                continue
            print(f"[scheduler] running {job_type} at {now}", flush=True)
            subprocess.run(["bash", RUN_JOB, job_type], cwd=BASE)
            state[job_type] = today
            save_state(state)
        time.sleep(60)


if __name__ == "__main__":
    main()
