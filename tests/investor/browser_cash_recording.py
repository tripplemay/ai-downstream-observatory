"""Opt-in cash transcription journey against an isolated production-build fixture."""

import argparse
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import importlib.metadata
import json
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--worker-python", required=True)
    args = parser.parse_args()
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
            str(db), json.dumps(tables + protected + ("account_projections",))],
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
              "external_ai_called": False, "response_payloads_mocked": False,
              "transport_fault": "one real committed cash POST response discarded before the browser receives it",
              "limits": ["invented personal account documents, not real broker or market acceptance",
                         "loopback self-signed HTTPS is not public TLS, container or production acceptance",
                         "reload acceptance checks a fresh scoped response and hydrated UI, not global network quiescence; an abandoned reconciliation read prevented networkidle in a prior run",
                         "cash transcription and independent reconciliation are not a complete securities execution or valuation loop"]}
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
                        "raw_body": request.post_data if request.method == "POST" and request.url == base + endpoint else None,
                        "body": json.loads(request.post_data) if request.method == "POST" and request.url == base + endpoint else None})
                        if request.url.startswith(base + endpoint) else None)

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
                (output / "reconnaissance.txt").write_text(page.locator("body").inner_text())
                check("cash metadata is lazy and empty account creation creates no money", not any("/cash-recording?" in r["url"] for r in requests)
                      and not rows()["ledger_events"])
                account_id = get("/accounts")["accounts"][0]["id"]

                def statement(reference, date, amounts):
                    reconciliation.get_by_role("button", name="录入独立资料", exact=True).click()
                    reconciliation.get_by_label("独立资料编号或说明", exact=True).fill(reference)
                    reconciliation.get_by_label("账单截至日期（完整当地日）", exact=True).fill(date)
                    reconciliation.get_by_label("账单时区", exact=True).select_option("Asia/Shanghai")
                    for currency, amount in amounts.items():
                        group = reconciliation.get_by_role("heading", name=currency + " · 原件金额", exact=True).locator("..")
                        expect(group.get_by_label("已结算现金", exact=True)).to_have_value("")
                        group.get_by_label("已结算现金", exact=True).fill(amount)
                        group.get_by_role("checkbox").check()
                    reconciliation.get_by_role("checkbox").last.check()
                    reconciliation.get_by_role("button", name="保存独立资料并对账", exact=True).click()
                    expect(reconciliation).to_contain_text("本次资料匹配", timeout=30000)

                statement("FICTIONAL EMPTY INDEPENDENT STATEMENT", empty_day, {"CNY": "0"})
                check("independent empty statement matches without fabricating cash", get("/reconciliation?account=" + account_id)["latest"]["current_facts"]
                      and not rows()["ledger_events"])
                frozen = rows()

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
                page.goto(base + "/workbench/accounts", wait_until="domcontentloaded")
                page.wait_for_selector("[data-hydrated=true]")
                fresh = get("/reconciliation?account=" + account_id)
                check("reload independently returns current account and session-bound reconciliation", fresh["account_id"] == account_id
                      and fresh["session_binding"] == session["session_binding"] and fresh["latest"]["current_facts"])
                expect(panel.get_by_role("button", name="录入已到账或已转出资金", exact=True)).to_be_enabled(timeout=30000)
                expect(reconciliation).to_contain_text("本次资料匹配")
                check("authenticated reload preserves matches and never resubmits cash", len(cash_posts()) == before_read
                      and get("/reconciliation?account=" + account_id)["latest"]["current_facts"])
                capture("cash-funded-reconciled")
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
