# -*- coding: utf-8 -*-
"""前向模拟盘：虚拟账户自动跟随轮动建议（etf-universe），按真实摩擦记账、逐日盯市。

口径：建议日次一交易日收盘成交；佣金万 1（fee_bps 可调）；场内 100 股整手；
QDII 溢价隐含在场内收盘价里；不模拟场外申赎。
净值写入 snapshots：paper:nav（总资产）/ paper:cash_pct（现金占比%）。

用法:
  python worker/paper_trade.py --init   # 建账户（幂等）
  python worker/paper_trade.py          # 每日：执行待执行建议 + 盯市（run_job daily 调用）"""
import argparse
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import db  # noqa: E402
from worker.rules import series, upsert_nav, log  # noqa: E402

ACCOUNT_NAME = "轮动模拟盘"
THEME_ID = "etf-universe"
INITIAL_CASH = 1_000_000.0
FEE_BPS = 1.0
LOT = 100


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def init_account(conn):
    row = conn.execute("SELECT id FROM paper_accounts WHERE theme_id = ? AND status = 'running'",
                       (THEME_ID,)).fetchone()
    if row:
        log("模拟盘账户已存在（id=%d），跳过" % row["id"])
        return
    conn.execute(
        "INSERT INTO paper_accounts (theme_id, name, initial_cash, cash, fee_bps, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (THEME_ID, ACCOUNT_NAME, INITIAL_CASH, INITIAL_CASH, FEE_BPS, now_str()))
    log("模拟盘账户已创建：%s，初始资金 %.0f 万，佣金万 %.0f" % (ACCOUNT_NAME, INITIAL_CASH / 1e4, FEE_BPS))


def latest_price(conn, code):
    pts = series(conn, "px:" + code)
    return pts[-1] if pts else (None, None)


def execute_rebalance(conn, acc, advice, exec_day):
    """按 advice 组合在 exec_day 收盘价调仓。先卖后买，整手取整，单腿失败留现金。"""
    aid = acc["id"]
    ts = now_str()
    positions = {r["code"]: dict(r) for r in conn.execute(
        "SELECT * FROM paper_positions WHERE account_id = ?", (aid,)).fetchall()}
    basket = json.loads(advice["basket_json"])
    basket_codes = {b["code"] for b in basket}

    # 当前总资产（按 exec_day 收盘价）
    total = acc["cash"]
    for code, pos in positions.items():
        _, px = latest_price(conn, code)
        if px:
            total += pos["shares"] * px
    fee_rate = acc["fee_bps"] / 10000.0
    cash = acc["cash"]
    skipped_legs = []

    def sell(code, pos, day):
        nonlocal cash
        _, px = latest_price(conn, code)
        if not px:
            log("模拟盘：%s 无价格，卖出腿跳过" % code)
            return
        amount = pos["shares"] * px
        fee = round(amount * fee_rate, 2)
        cash += amount - fee
        conn.execute(
            "INSERT INTO paper_trades (account_id, date, code, name, side, shares, price, fee, advice_id, note, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (aid, day, code, pos["name"], "sell", pos["shares"], px, fee, advice["id"],
             "建议 #%d 次日收盘调仓" % advice["id"], ts))
        conn.execute("DELETE FROM paper_positions WHERE account_id = ? AND code = ?", (aid, code))

    # 先卖：清掉不在组合内的持仓
    for code in list(positions):
        if code not in basket_codes:
            sell(code, positions.pop(code), exec_day)

    # 逐成员调平到目标市值
    for b in basket:
        code = b["code"]
        day, px = latest_price(conn, code)
        if not px or day != exec_day:
            log("模拟盘：%s 在 %s 无价格，该腿跳过（资金留现金，次日重试）" % (code, exec_day))
            skipped_legs.append(code)
            continue
        target_value = total * float(b["weight"])
        cur_value = positions[code]["shares"] * px if code in positions else 0.0
        diff = target_value - cur_value
        if abs(diff) < px * LOT:  # 不足一手不动
            continue
        if diff > 0:  # 买入
            shares = int(diff / (px * LOT)) * LOT
            cost_able = shares * px * (1 + fee_rate)
            if cost_able > cash:
                shares = int(cash / (px * LOT * (1 + fee_rate))) * LOT
                cost_able = shares * px * (1 + fee_rate)
            if shares <= 0:
                continue
            amount = shares * px
            fee = round(amount * fee_rate, 2)
            cash -= amount + fee
            old = positions.get(code)
            if old:
                new_shares = old["shares"] + shares
                new_cost = (old["cost"] * old["shares"] + amount) / new_shares
                conn.execute("UPDATE paper_positions SET shares = ?, cost = ?, updated_at = ?"
                             " WHERE account_id = ? AND code = ?", (new_shares, new_cost, ts, aid, code))
                positions[code]["shares"] = new_shares
            else:
                conn.execute("INSERT INTO paper_positions (account_id, code, name, shares, cost, updated_at)"
                             " VALUES (?,?,?,?,?,?)", (aid, code, b["name"], shares, px, ts))
                positions[code] = {"shares": shares, "cost": px, "name": b["name"]}
            conn.execute(
                "INSERT INTO paper_trades (account_id, date, code, name, side, shares, price, fee, advice_id, note, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (aid, exec_day, code, b["name"], "buy", shares, px, fee, advice["id"],
                 "建议 #%d 次日收盘调仓" % advice["id"], ts))
        else:  # 卖出部分
            shares = min(int(-diff / (px * LOT)) * LOT, positions[code]["shares"])
            if shares <= 0:
                continue
            amount = shares * px
            fee = round(amount * fee_rate, 2)
            cash += amount - fee
            remain = positions[code]["shares"] - shares
            conn.execute(
                "INSERT INTO paper_trades (account_id, date, code, name, side, shares, price, fee, advice_id, note, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (aid, exec_day, code, positions[code]["name"], "sell", shares, px, fee,
                 advice["id"], "建议 #%d 次日收盘调仓" % advice["id"], ts))
            if remain > 0:
                conn.execute("UPDATE paper_positions SET shares = ?, updated_at = ?"
                             " WHERE account_id = ? AND code = ?", (remain, ts, aid, code))
                positions[code]["shares"] = remain
            else:
                conn.execute("DELETE FROM paper_positions WHERE account_id = ? AND code = ?", (aid, code))
                del positions[code]

    # 有腿未成交则不推进 last_advice_id，下个交易日按当日价格重试未成交腿
    if skipped_legs:
        conn.execute("UPDATE paper_accounts SET cash = ? WHERE id = ?", (round(cash, 2), aid))
        log("模拟盘：建议 #%d 部分执行（%s），现金 %.0f，待重试: %s"
            % (advice["id"], exec_day, cash, "、".join(skipped_legs)))
    else:
        conn.execute("UPDATE paper_accounts SET cash = ?, last_advice_id = ? WHERE id = ?",
                     (round(cash, 2), advice["id"], aid))
        log("模拟盘：已执行建议 #%d（%s），现金 %.0f" % (advice["id"], exec_day, cash))


def mark_to_market(conn, acc, day):
    aid = acc["id"]
    total = acc["cash"]
    for r in conn.execute("SELECT code, shares FROM paper_positions WHERE account_id = ?",
                          (aid,)).fetchall():
        _, px = latest_price(conn, r["code"])
        if px:
            total += r["shares"] * px
    ts = now_str()
    pts = series(conn, "paper:nav")
    if pts and pts[-1][0] >= day:
        return
    upsert_nav(conn, "paper:nav", day, round(total, 2), ts)
    upsert_nav(conn, "paper:cash_pct", day, round(acc["cash"] / total * 100, 1) if total else 100.0, ts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", action="store_true", help="创建模拟盘账户（幂等）")
    args = ap.parse_args()
    db.init_db()
    conn = db.get_db()
    try:
        if args.init:
            with conn:
                init_account(conn)
            return
        acc = conn.execute(
            "SELECT * FROM paper_accounts WHERE theme_id = ? AND status = 'running'",
            (THEME_ID,)).fetchone()
        if acc is None:
            log("模拟盘账户不存在（先 --init），跳过")
            return
        latest_day = conn.execute("SELECT MAX(period_date) AS d FROM snapshots"
                                  " WHERE metric_key LIKE 'px:%'").fetchone()["d"]
        if not latest_day:
            return
        advice = conn.execute("SELECT * FROM advice ORDER BY id DESC LIMIT 1").fetchone()
        with conn:
            if advice and advice["id"] > acc["last_advice_id"] and latest_day > advice["date"]:
                execute_rebalance(conn, acc, advice, latest_day)
                acc = conn.execute("SELECT * FROM paper_accounts WHERE id = ?", (acc["id"],)).fetchone()
            mark_to_market(conn, acc, latest_day)
        log("模拟盘盯市完成：%s" % latest_day)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
