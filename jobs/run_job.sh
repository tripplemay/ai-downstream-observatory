#!/bin/bash
# 用法: ./jobs/run_job.sh <monthly|quarterly>
# launchd 定时触发：先抓公开数据（fetch_data.py），再调 AIGC 网关分析（analyze.py）
set -uo pipefail
cd "$(dirname "$0")/.."
source .venv/bin/activate
TYPE="${1:-monthly}"
{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') run_job $TYPE ====="
  python worker/fetch_data.py
  FETCH_RC=$?
  python worker/analyze.py "$TYPE"
  AN_RC=$?
  if [ "$FETCH_RC" -eq 0 ] && [ "$AN_RC" -eq 0 ]; then
    echo "[STATUS] $TYPE SUCCESS"
  else
    echo "[STATUS] $TYPE FAILED fetch=$FETCH_RC analyze=$AN_RC"
  fi
} 2>&1 | tee -a data/jobs.log
