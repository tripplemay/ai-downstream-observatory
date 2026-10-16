"""Opt-in recorded-account journey against an isolated production-build fixture."""

import argparse
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--worker-python", required=True)
    parser.add_argument("--with-securities", action="store_true", help="Continue through invented security registration, buy/sell, partial settlements and independent position reconciliation")
    parser.add_argument("--with-valuation", action="store_true", help="After securities, use the isolated Python fixture helper to calculate a three-currency NAV and verify later-fact invalidation")
    args = parser.parse_args()
    if args.with_valuation and not args.with_securities:
        parser.error("--with-valuation requires --with-securities")
    root = Path(__file__).resolve().parents[2]
    db, output = Path(args.db).resolve(strict=True), Path(args.output).resolve()
    if (db.parent.parent != Path(tempfile.gettempdir()).resolve()
            or not db.parent.name.startswith("etf-browser-fixture-") or db.name != "workbench.db"):
        raise ValueError("ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED")
    if not output.is_relative_to(root / "artifacts" / "verification"):
        raise ValueError("PRIVATE_VERIFICATION_OUTPUT_REQUIRED")
    output.mkdir(parents=True, exist_ok=True)
    tables = ("portfolios", "accounts", "ledger_events", "postings", "position_movements",
              "approval_events", "activations", "reservations", "execution_reports")
    protected = ("investor_profiles", "investor_funding_plans", "investor_models", "investor_ai_requests", "outbox", "job_runs")

    def rows():
        child = subprocess.run([args.worker_python, "-c",
            "import json,sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); c.row_factory=sqlite3.Row; "
            "print(json.dumps({t:[dict(r) for r in c.execute('SELECT * FROM '+t+' ORDER BY rowid')] for t in json.loads(sys.argv[2])})); c.close()",
            str(db), json.dumps(tables + protected + ("account_projections", "position_projections", "valuation_runs"))],
            capture_output=True, text=True, timeout=15, check=True)
        return json.loads(child.stdout)

    def sources():
        names = ("contracts", "migrations", "web/src", "web/scripts", "tests/investor")
        files = [f for name in names for f in (root / name).rglob("*")
                 if f.is_file() and f.suffix in (".py", ".ts", ".tsx", ".mjs", ".json", ".sql")]
        return {str(f.relative_to(root)): sha256(f.read_bytes()).hexdigest() for f in sorted(files)}

    assert all(not rows()[name] for name in tables)
    checks, errors, requests, lost_receipts = [], [], [], []
    report = {"status": "RUNNING", "synthetic_fixture_only": True, "headless": True,
              "playwright_version": importlib.metadata.version("playwright"), "checks": checks,
              "source_sha256": sources(), "production_changed": False, "real_provider_called": False,
              "securities_transcription": args.with_securities,
              "valuation_fixture": args.with_valuation,
              "external_ai_called": False, "response_payloads_mocked": False,
              "transport_fault": "one real committed cash POST response discarded before the browser receives it",
              "limits": ["invented personal account documents, not real broker or market acceptance",
                         "loopback self-signed HTTPS is not public TLS, container or production acceptance",
                         "valuation setup uses the isolated Python fixture helper, not a native user valuation command or production ingestion",
                         "recorded account facts, snapshots and independent reconciliation are not account-level executable advice or broker certification"]}
    base, endpoint = "https://127.0.0.1:3147", "/api/workbench/investor"
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
    empty_day = (datetime.now(timezone.utc) - timedelta(days=2)).date().isoformat()

    def check(label, condition=True):
        assert condition, label
        checks.append(label)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                report["browser_version"] = browser.version
                report["build_id"] = (root / "web/.next-fixture-production/BUILD_ID").read_text().strip()
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, ignore_https_errors=True)
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("request", lambda request: requests.append({"method": request.method, "url": request.url,
                        "raw_body": request.post_data if request.method == "POST" and request.url in (base + endpoint, base + "/api/workbench") else None,
                        "body": json.loads(request.post_data) if request.method == "POST" and request.url in (base + endpoint, base + "/api/workbench") else None})
                        if request.url.startswith(base + "/api/workbench") else None)

                def go(path):
                    page.goto(base + path)
                    page.wait_for_load_state("networkidle")
                    page.wait_for_selector("[data-hydrated=true]")

                def capture(name):
                    for label, width, height in (("desktop", 1440, 1000), ("mobile", 390, 844)):
                        page.set_viewport_size({"width": width, "height": height})
                        page.evaluate("window.scrollTo(0, 0)")
                        page.evaluate("() => new Promise(requestAnimationFrame)")
                        check(name + " " + label + " has no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                        page.screenshot(path=str(output / (name + "-" + label + ".png")), full_page=True)
                    page.set_viewport_size({"width": 1440, "height": 1000})

                page.goto(base + "/workbench")
                page.wait_for_load_state("networkidle")
                page.get_by_label("工作台密码").fill("SYNTHETIC-ETF-FIXTURE-ONLY-2026")
                page.get_by_role("button", name="登录", exact=True).click()
                page.wait_for_load_state("networkidle")
                page.wait_for_selector("[data-hydrated=true]")
                page.locator("input[name=horizon]").fill("12")
                page.locator("select[name=liquidity]").select_option("none_in_horizon")
                page.get_by_label("A 股", exact=True).check()
                page.get_by_role("button", name="保存偏好并检查研究条件", exact=True).click()
                expect(page.get_by_role("button", name="重新检查研究条件", exact=True)).to_be_enabled(timeout=30000)
                session = context.request.get(base + "/api/auth/session").json()
                headers = {"X-Workbench-Session-Binding": session["session_binding"]}

                def get(path=""):
                    response = context.request.get(base + endpoint + path, headers=headers)
                    assert response.status == 200
                    return response.json()

                go("/workbench/accounts")
                expect(page.get_by_label("账本名称", exact=True)).to_be_enabled(timeout=30000)
                page.get_by_label("账本名称", exact=True).fill("FICTIONAL CASH UI BOOK")
                page.get_by_label("账户别名", exact=True).fill("FICTIONAL CASH UI ACCOUNT")
                page.get_by_label("券商名称", exact=True).fill("FICTIONAL BROKER")
                page.get_by_role("button", name="仅建档并关联，不生成现金或持仓", exact=True).click()
                panel = page.locator('section[aria-label="人工资金回录"]')
                reconciliation = page.locator('section[aria-label="独立对账"]')
                expect(panel.get_by_role("button", name="录入已到账或已转出资金", exact=True)).to_be_enabled(timeout=30000)
                csv_fold = page.get_by_test_id("optional-account-csv")
                expect(csv_fold).to_be_visible()
                check("optional CSV starts collapsed but remains mounted without a submission", not csv_fold.evaluate("element => element.open")
                      and csv_fold.locator('section[aria-label="后台 CSV 导入"]').count() == 1
                      and not any(r["method"] == "POST" and "/csv/" in r["url"] for r in requests))
                csv_fold.locator("summary").click()
                expect(page.get_by_label("后台 CSV 原件", exact=True)).to_be_visible()
                (output / "reconnaissance.txt").write_text(page.locator("body").inner_text())
                check("cash metadata is lazy and empty account creation creates no money", not any("/cash-recording?" in r["url"] for r in requests)
                      and not rows()["ledger_events"])
                account_id = get("/accounts")["accounts"][0]["id"]

                def statement(reference, date, amounts, position_quantities=None):
                    reconciliation.get_by_role("button", name="录入独立资料", exact=True).click()
                    reconciliation.get_by_label("独立资料编号或说明", exact=True).fill(reference)
                    reconciliation.get_by_label("账单截至日期（完整当地日）", exact=True).fill(date)
                    reconciliation.get_by_label("账单时区", exact=True).select_option("Asia/Shanghai")
                    for currency, amount in amounts.items():
                        group = reconciliation.get_by_role("heading", name=currency + " · 原件金额", exact=True).locator("..")
                        expect(group.get_by_label("已结算现金", exact=True)).to_have_value("")
                        group.get_by_label("已结算现金", exact=True).fill(amount)
                        group.get_by_role("checkbox").check()
                    for label, quantity in (position_quantities or {}).items():
                        expect(reconciliation.get_by_label(label, exact=True)).to_have_value("")
                        reconciliation.get_by_label(label, exact=True).fill(quantity)
                    reconciliation.get_by_role("checkbox").last.check()
                    reconciliation.get_by_role("button", name="保存独立资料并对账", exact=True).click()
                    expect(reconciliation).to_contain_text("本次资料匹配", timeout=30000)

                statement("FICTIONAL EMPTY INDEPENDENT STATEMENT", empty_day, {"CNY": "0"})
                check("independent empty statement matches without fabricating cash", get("/reconciliation?account=" + account_id)["latest"]["current_facts"]
                      and not rows()["ledger_events"])
                frozen = rows()
                if not csv_fold.evaluate("element => element.open"):
                    csv_fold.locator("summary").click()
                expect(page.get_by_label("后台 CSV 原件", exact=True)).to_be_visible()

                def begin():
                    panel.get_by_role("button", name="录入已到账或已转出资金", exact=True).click()
                    expect(panel.get_by_label("实际资金本金（不含费用）", exact=True)).to_be_enabled(timeout=30000)
                    for label in ("已发生的资金方向", "实际资金币种", "实际资金本金（不含费用）", "实际资金日期", "资金资料时区",
                                  "资金来源标识（与后续 CSV 保持一致）", "原始资金流水唯一编号", "资金独立资料编号或说明"):
                        expect(panel.get_by_label(label, exact=True)).to_have_value("")
                    expect(panel.get_by_role("checkbox")).not_to_be_checked()

                begin()
                expect(page.get_by_label("账户导入目标", exact=True)).to_be_disabled()
                expect(page.get_by_role("button", name="刷新状态", exact=True)).to_be_disabled()
                expect(page.get_by_role("button", name="核对账户资料", exact=True)).to_be_disabled()
                expect(reconciliation.get_by_role("button", name="重读对账范围", exact=True)).to_be_disabled()
                expect(reconciliation.get_by_role("button", name="录入独立资料", exact=True)).to_have_count(0)
                expect(page.get_by_role("button", name="录入已发生成交", exact=True)).to_be_disabled()
                expect(page.get_by_role("button", name="复核对照", exact=True)).to_be_disabled()
                expect(page.get_by_label("后台 CSV 原件", exact=True)).to_be_disabled()
                csv_fold.locator("summary").click()
                check("closing optional CSV keeps its component and the active cash draft lock", not csv_fold.evaluate("element => element.open")
                      and csv_fold.locator('section[aria-label="后台 CSV 导入"]').count() == 1
                      and page.get_by_role("button", name="刷新状态", exact=True).is_disabled())
                check("blank draft locks account, refresh, CSV and reconciliation without a POST")
                capture("cash-blank-draft")
                panel.get_by_role("button", name="取消并清除资金草稿", exact=True).click()
                expect(page.get_by_label("账户导入目标", exact=True)).to_be_enabled()
                check("cancel releases scope and writes no facts", rows() == frozen)

                def fill(currency, direction, amount, source):
                    begin()
                    panel.get_by_label("已发生的资金方向", exact=True).select_option(direction)
                    panel.get_by_label("实际资金币种", exact=True).select_option(currency)
                    panel.get_by_label("实际资金本金（不含费用）", exact=True).fill(amount)
                    panel.get_by_label("实际资金日期", exact=True).fill(yesterday)
                    panel.get_by_label("资金资料时区", exact=True).select_option("Asia/Shanghai")
                    panel.get_by_label("资金来源标识（与后续 CSV 保持一致）", exact=True).fill("FICTIONAL-CASH-UI")
                    panel.get_by_label("原始资金流水唯一编号", exact=True).fill(source)
                    panel.get_by_label("资金独立资料编号或说明", exact=True).fill("FICTIONAL INDEPENDENT CASH DOCUMENT " + source)
                    panel.get_by_role("checkbox").check()

                def cash_posts():
                    return [r["body"] for r in requests if r["body"] and r["body"].get("action") == "record_linked_cash_fact"]

                def discard_once(route):
                    if route.request.method == "POST" and route.request.post_data_json.get("action") == "record_linked_cash_fact" and not lost_receipts:
                        response = route.fetch()
                        assert response.status == 200
                        lost_receipts.append(response.json())
                        route.abort("failed")
                    else:
                        route.continue_()

                page.route(base + endpoint, discard_once)
                fill("CNY", "deposit", "1000.01", "cash-ui-in-CNY")
                panel.get_by_label("实际资金本金（不含费用）", exact=True).fill("1000.02")
                expect(panel.get_by_role("checkbox")).not_to_be_checked()
                panel.get_by_label("实际资金本金（不含费用）", exact=True).fill("1000.01")
                panel.get_by_role("checkbox").check()
                panel.get_by_role("button", name="保存已发生的资金事实", exact=True).click()
                retry = page.get_by_role("button", name="核对并重试原请求", exact=True)
                expect(retry).to_be_enabled(timeout=30000)
                committed = rows()
                check("lost response leaves one committed event and a pending original request", len(committed["ledger_events"]) == 1
                      and len(lost_receipts) == 1 and len(cash_posts()) == 1)
                capture("cash-unknown-response")
                retry.click()
                expect(page.get_by_text("资金事实已保存或复用原记录；未发起转账或确认计划资金。请重新独立对账，并核对估值版本。", exact=True)).to_be_visible(timeout=30000)
                expect(retry).to_have_count(0)
                page.unroute(base + endpoint, discard_once)
                check("explicit retry sends identical bytes and does not add financial rows", len(cash_posts()) == 2
                      and cash_posts()[0] == cash_posts()[1]
                      and len({r["raw_body"] for r in requests if r["body"] and r["body"].get("action") == "record_linked_cash_fact"}) == 1
                      and rows() == committed)
                check("new cash invalidates earlier independent reconciliation", not get("/reconciliation?account=" + account_id)["latest"]["current_facts"])
                for currency, direction, amount, source in (("HKD", "deposit", "300.01", "cash-ui-in-HKD"),
                        ("USD", "deposit", "200.01", "cash-ui-in-USD"), ("CNY", "withdrawal", "100", "cash-ui-out-CNY")):
                    before_count = len(cash_posts())
                    fill(currency, direction, amount, source)
                    panel.get_by_role("button", name="保存已发生的资金事实", exact=True).click(click_count=2)
                    expect(panel.get_by_role("button", name="录入已到账或已转出资金", exact=True)).to_be_enabled(timeout=30000)
                    check(currency + " " + direction + " double click sends one cash command", len(cash_posts()) == before_count + 1)
                funded = rows()
                expected = {"CNY": "900.01", "HKD": "300.01", "USD": "200.01"}
                actual = {r["currency"]: r["balance"] for r in funded["account_projections"] if r["ledger_account"] == "cash_settled"}
                capital = {r["currency"]: r["balance"] for r in funded["account_projections"] if r["ledger_account"] == "external_capital"}
                check("three currencies and withdrawal have exact cash and opposite external capital", actual == expected
                      and capital == {c: "-" + v for c, v in expected.items()} and len(funded["ledger_events"]) == 4 and len(funded["postings"]) == 8)
                check("cash never changes profile, funding, research, AI jobs, securities or authority", all(funded[t] == frozen[t] for t in protected)
                      and all(not funded[t] for t in tables[4:]))
                statement("FICTIONAL FUNDED INDEPENDENT STATEMENT", yesterday, expected)
                current = get("/reconciliation?account=" + account_id)
                check("fresh independent three-currency statement matches without financial mutation", current["latest"]["current_facts"]
                      and current["latest"]["status"] == "matched" and rows()["ledger_events"] == funded["ledger_events"]
                      and rows()["postings"] == funded["postings"])
                before_read = len(cash_posts())
                go("/workbench/accounts")
                check("funded account reload reaches networkidle without an abandoned response")
                fresh = get("/reconciliation?account=" + account_id)
                check("reload independently returns current account and session-bound reconciliation", fresh["account_id"] == account_id
                      and fresh["session_binding"] == session["session_binding"] and fresh["latest"]["current_facts"])
                expect(panel.get_by_role("button", name="录入已到账或已转出资金", exact=True)).to_be_enabled(timeout=30000)
                expect(reconciliation).to_contain_text("本次资料匹配")
                check("authenticated reload preserves matches and never resubmits cash", len(cash_posts()) == before_read
                      and get("/reconciliation?account=" + account_id)["latest"]["current_facts"])
                capture("cash-funded-reconciled")
                if args.with_securities:
                    go("/workbench/ledger")
                    expect(page.get_by_label("ETF 名称", exact=True)).to_be_enabled(timeout=30000)
                    page.get_by_label("ETF 名称", exact=True).fill("FICTIONAL UI ETF")
                    page.get_by_label("上市市场", exact=True).select_option("CN")
                    page.get_by_label("交易所", exact=True).fill("FICTIONAL-EXCHANGE")
                    page.get_by_label("上市代码", exact=True).fill("TEST-CN")
                    page.get_by_label("交易币种", exact=True).select_option("CNY")
                    page.get_by_label("资产类别", exact=True).select_option("equity")
                    page.get_by_label("来源与核实依据", exact=True).fill("FICTIONAL SOFTWARE TEST IDENTITY ONLY; NOT AN ISSUER OR BUYABILITY CERTIFICATE")
                    page.get_by_role("button", name="登记证券", exact=True).click()
                    expect(page.get_by_text("证券已登记为待核验，可使用上市标识导入真实持仓；没有创建交易建议。", exact=True)).to_be_visible(timeout=30000)
                    identities = get("/trade-recording?account=" + account_id)["listings"]
                    assert len(identities) == 1 and identities[0]["ticker"] == "TEST-CN" and identities[0]["currency"] == "CNY"
                    listing_id = identities[0]["id"]
                    check("explicit invented identity registration creates no security quantity or order", not rows()["position_movements"])
                    go("/workbench/accounts")
                    trade = page.locator('section[aria-label="人工成交回录"]')

                    def actual_postings():
                        return {r["ledger_account"]: r["balance"] for r in rows()["account_projections"] if r["currency"] == "CNY"}

                    def position():
                        positions = [r for r in rows()["position_projections"] if r["listing_id"] == listing_id]
                        assert len(positions) == 1
                        return positions[0]["quantity"], positions[0]["cost_amount"]

                    def trade_common(source, settlement=False):
                        trade.get_by_label("实际交收日期" if settlement else "实际成交日期", exact=True).fill(yesterday)
                        trade.get_by_label(re.compile(r"^资料时区")).select_option("Asia/Shanghai")
                        trade.get_by_label("来源标识（与后续 CSV 保持一致）", exact=True).fill("FICTIONAL-SECURITY-UI")
                        trade.get_by_label("原始成交或交收唯一编号", exact=True).fill(source)
                        trade.get_by_label("独立资料编号或说明", exact=True).fill("FICTIONAL INDEPENDENT SECURITY DOCUMENT " + source)
                        trade.get_by_role("checkbox").check()

                    def settled(payment, source, related):
                        trade.get_by_role("button", name="录入实际交收", exact=True).click()
                        expect(trade.get_by_label(re.compile(r"^本次实际交收现金"))).to_be_enabled(timeout=30000)
                        expect(trade.get_by_label(re.compile(r"^本次实际交收现金"))).to_have_value("")
                        related_field = trade.get_by_label(re.compile(r"^关联的未完成交收成交"))
                        expect(related_field).to_have_value("")
                        related_field.select_option(related)
                        trade.get_by_label(re.compile(r"^本次实际交收现金")).fill(payment)
                        trade_common(source, settlement=True)
                        trade.get_by_role("button", name="确认回录实际交收", exact=True).click()
                        expect(trade.get_by_role("button", name="录入实际交收", exact=True)).to_be_enabled(timeout=30000)

                    for side, quantity, principal, fee, source, payments, expected_position, expected_cash, trade_balance in (
                        ("buy", "10", "100", "1", "ui-buy", ("40", "61"), ("10", "100"), "799.01", "trade_payable"),
                        ("sell", "4", "44", "0.5", "ui-sell", ("10.5", "33"), ("6", "60"), "842.51", "trade_receivable"),
                    ):
                        prior_cash = actual_postings()["cash_settled"]
                        trade.get_by_role("button", name="录入已发生成交", exact=True).click()
                        expect(trade.get_by_label("实际成交数量", exact=True)).to_be_enabled(timeout=30000)
                        expect(trade.get_by_label("实际成交数量", exact=True)).to_have_value("")
                        expect(trade.get_by_label(re.compile(r"^成交本金"))).to_have_value("")
                        expect(trade.get_by_label(re.compile(r"^实际成交方向"))).to_have_value("")
                        trade.get_by_label(re.compile(r"^实际成交方向")).select_option(side)
                        trade.get_by_label(re.compile(r"^证券（不按名称猜测身份）")).select_option(listing_id)
                        trade.get_by_label("实际成交数量", exact=True).fill(quantity)
                        trade.get_by_label(re.compile(r"^成交本金")).fill(principal)
                        trade.get_by_label("实际费用总额（已核对无费用才填 0）", exact=True).fill(fee)
                        trade_common(source)
                        if side == "buy":
                            capture("securities-filled-trade")
                        trade.get_by_role("button", name="确认回录已发生成交", exact=True).click()
                        expect(trade.get_by_role("button", name="录入已发生成交", exact=True)).to_be_enabled(timeout=30000)
                        check(side + " records quantity and principal without automatically settling cash", position() == expected_position
                              and actual_postings()["cash_settled"] == prior_cash)
                        pending = get("/trade-recording?account=" + account_id)["unsettled_trades"]
                        assert len(pending) == 1 and pending[0]["direction"] == side
                        for index, payment in enumerate(payments):
                            settled(payment, source + "-payment-" + str(index), pending[0]["event_id"])
                            check(side + " settlement " + str(index + 1) + " does not duplicate security quantity", position() == expected_position)
                        check(side + " final settlement clears only its exact receivable or payable", actual_postings()[trade_balance] == "0"
                              and actual_postings()["cash_settled"] == expected_cash
                              and not get("/trade-recording?account=" + account_id)["unsettled_trades"])
                    check("new security facts invalidate the earlier cash-only statement", not get("/reconciliation?account=" + account_id)["latest"]["current_facts"])
                    statement("FICTIONAL CASH AND SECURITIES STATEMENT", yesterday, {"CNY": "842.51", "HKD": "300.01", "USD": "200.01"},
                              {"FICTIONAL UI ETF · TEST-CN · CN · CNY": "6"})
                    check("independent cash and six-unit security statement matches current facts", get("/reconciliation?account=" + account_id)["latest"]["current_facts"])
                    settled_rows = rows()
                    check("recorded trades and settlement never create strategy approval, execution reports or AI jobs", all(settled_rows[t] == frozen[t] for t in protected)
                          and all(not settled_rows[t] for t in ("approval_events", "activations", "reservations", "execution_reports")))
                    go("/workbench/accounts")
                    expect(reconciliation).to_contain_text("本次资料匹配")
                    check("funded securities reload never repeats a trade or settlement", rows()["ledger_events"] == settled_rows["ledger_events"]
                          and position() == ("6", "60"))
                    expect(page.get_by_text("对账完成后，还需生成完整的人民币估值。", exact=True)).to_be_visible(timeout=30000)
                    check("missing valuation never turns reconciled securities into a fabricated NAV")
                    capture("securities-settled-reconciled")
                    if args.with_valuation:
                        cutoff = get("/reconciliation?account=" + account_id)["latest"]["cutoff_at"]
                        observed = (datetime.fromisoformat(cutoff.replace("Z", "+00:00")) - timedelta(hours=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                        now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

                        def document(identity, scope, kind, observations):
                            return {"schema_version": "market-batch-v1", "batch": {"id": identity, "scope": scope, "source_id": "FICTIONAL",
                                "batch_type": kind, "expected_pages": 1, "expected_rows": len(observations), "expected_publication_revision": 0,
                                "source_mode": "manual_verified", "source_evidence": "FICTIONAL SOFTWARE TEST ONLY, NOT PROVIDER EVIDENCE"},
                                "pages": [{"page_number": 1, "observations": [{"id": identity + ":row:" + str(index), "batch_id": identity,
                                    "source_id": "FICTIONAL", "ingested_at": now, "observed_at": observed, "published_at": observed,
                                    "source_timezone": "Asia/Shanghai", "time_precision": "second", "revision_id": "fictional-v1",
                                    "raw_hash": sha256(json.dumps(item, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
                                    "parser_version": "fictional-v1", "provenance": "live_observed", **item} for index, item in enumerate(observations)]}]}

                        prices = document("browser:prices", "browser:CN", "prices", [{"listing_id": listing_id, "series_key": listing_id,
                            "metric": "close", "price_basis": "unadjusted", "unit": "CNY", "value": "10"}])
                        rates = document("browser:fx", "browser:FX", "fx", [{"series_key": "FX:" + currency, "metric": "fx_cny_per_unit",
                            "price_basis": "not_applicable", "unit": "CNY_per_unit_currency", "value": rate} for currency, rate in (("HKD", "0.9"), ("USD", "7"))])
                        request = {"portfolio_id": get("/accounts")["link"]["document"]["portfolio_id"], "now": now, "cutoff": cutoff,
                            "documents": [prices, rates], "rules": {"schema_version": "valuation-rules-v1", "approved": True,
                                "approval_evidence": "FICTIONAL SOFTWARE TEST ONLY, NOT PROVIDER EVIDENCE", "price_scope_by_market": {"CN": "browser:CN"},
                                "expected_sessions": {"CN": yesterday}, "corporate_actions_complete": {listing_id: True},
                                "fx_scope": "browser:FX", "max_fx_age_seconds": 86400}}
                        child = subprocess.run([args.worker_python, "-m", "tests.investor.holdings_fixture", "--db", str(db)], cwd=root,
                            input=json.dumps(request), capture_output=True, text=True, timeout=60,
                            env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "TMPDIR": tempfile.gettempdir(),
                                 "WORKBENCH_DATA_DIR": str(db.parent / "auth")})
                        (output / "valuation-fixture.log").write_text(child.stdout + child.stderr)
                        assert child.returncode == 0, "FICTIONAL_PYTHON_VALUATION_FAILED"
                        valuation = json.loads(child.stdout)
                        check("actual Python valuation includes six units and all three currency cash balances", valuation["quality"] == "complete"
                              and valuation["nav_cny"] == "2572.589" and valuation["real_provider_called"] is False)
                        holdings = page.locator('section[aria-label="真实组合对照"]')
                        holdings.get_by_role("button", name="复核对照", exact=True).click()
                        expect(holdings.get_by_role("heading", name="已核对的记录快照（非实时账户同步）", exact=True)).to_be_visible(timeout=30000)
                        expect(holdings.get_by_text("¥ 2,572.59", exact=True)).to_be_visible()
                        snapshot = get("/holdings")
                        check("real holdings HTTP and hydrated UI verify the exact NAV without fabricating a target or order", snapshot["snapshot"]["nav_cny"] == "2572.589"
                              and snapshot["comparison"] is None and snapshot["execution_authorized"] is False
                              and any(c["category"] == "security" and c["settled_quantity"] == "6" for c in snapshot["snapshot"]["components"]))
                        check("valuation calculation and display never rewrite recorded facts or strategy authority", rows()["ledger_events"] == settled_rows["ledger_events"]
                              and rows()["postings"] == settled_rows["postings"] and all(rows()[t] == frozen[t] for t in protected))
                        capture("securities-valued")
                        fill("CNY", "deposit", "1", "ui-after-valuation")
                        panel.get_by_role("button", name="保存已发生的资金事实", exact=True).click()
                        expect(panel.get_by_role("button", name="录入已到账或已转出资金", exact=True)).to_be_enabled(timeout=30000)
                        expect(holdings.get_by_role("heading", name="已核对的记录快照（非实时账户同步）", exact=True)).to_have_count(0)
                        stale = get("/holdings")
                        check("a later actual fact hides the old NAV and requires new independent reconciliation", stale["snapshot"] is None
                              and "RECONCILIATION_FACTS_CHANGED" in stale["gaps"] and len(rows()["valuation_runs"]) == 1
                              and actual_postings()["cash_settled"] == "843.51" and position() == ("6", "60"))
                        capture("securities-new-fact")
                check("no JavaScript page errors", not errors)
                report["financial_counts"] = {t: len(rows()[t]) for t in tables}
                report["actions"] = [r["body"]["action"] for r in requests if r["body"]]
                report["status"] = "PASS"
            except Exception:
                if "page" in locals() and not page.is_closed():
                    page.screenshot(path=str(output / "failure.png"), full_page=True)
                    (output / "failure.txt").write_text(page.url + "\n" + page.locator("body").inner_text())
                raise
            finally:
                browser.close()
    except BaseException as error:
        report["status"] = "INTERRUPTED" if isinstance(error, KeyboardInterrupt) else "FAIL"
        report["error"] = str(error)
        raise
    finally:
        report["page_errors"] = errors
        report["source_end_sha256"] = sources()
        report["source_changed_during_run"] = sorted(key for key in set(report["source_sha256"]) | set(report["source_end_sha256"])
            if report["source_sha256"].get(key) != report["source_end_sha256"].get(key))
        if report["status"] == "PASS" and report["source_changed_during_run"]:
            report["status"] = "STALE"
        (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({"status": report["status"], "checks": len(checks), "output": str(output)}, ensure_ascii=False))
        if report["status"] == "STALE":
            raise ValueError("SOURCE_CHANGED_DURING_BROWSER_CHECK")


if __name__ == "__main__":
    main()
