#!/bin/bash
# 用法: ./jobs/run_job.sh <daily|weekly|monthly|quarterly>
# daily:     只抓日频指标（宇宙/行情/模型价格/基金净值）+ 规则引擎（每交易日跑）
# weekly:    指数映射与 PE 估值采集 + 全行业 AI 周报（每周六）
# monthly:   全量采集 + 规则引擎 + AI 月度纪要（含信号灯轻量判定）
# quarterly: 全量采集 + 规则引擎 + AI 季度结构化分析（信号判定复核）
# launchd/scheduler 定时触发；规则引擎先跑，AI 分析能看到最新规则判定。
set -uo pipefail
cd "$(dirname "$0")/.."
source .venv/bin/activate
TYPE="${1:-monthly}"
{
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') run_job $TYPE ====="
  RC=0
  if [ "$TYPE" = "daily" ]; then
    python worker/fetch_data.py --only universe,etf_px,yf_price,model_price,fund_info || RC=$?
    python worker/rules.py || RC=$?
  elif [ "$TYPE" = "weekly" ]; then
    python worker/fetch_data.py --only index_data || RC=$?
    python worker/backtest_rotation.py || RC=$?
    python worker/analyze.py weekly || RC=$?
  elif [ "$TYPE" = "monthly" ] || [ "$TYPE" = "quarterly" ]; then
    python worker/fetch_data.py || RC=$?
    python worker/rules.py || RC=$?
    python worker/analyze.py "$TYPE" || RC=$?
  else
    echo "未知运行类型: $TYPE（应为 daily|weekly|monthly|quarterly）"
    RC=2
  fi
  if [ "$RC" -eq 0 ]; then
    echo "[STATUS] $TYPE SUCCESS"
  else
    echo "[STATUS] $TYPE FAILED rc=$RC"
  fi
} 2>&1 | tee -a data/jobs.log
