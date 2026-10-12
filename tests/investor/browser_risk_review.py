"""Opt-in headless interaction test; only an empty temporary browser fixture is accepted."""

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--worker-python", required=True)
    args = parser.parse_args()
    db = Path(args.db).resolve(strict=True)
    root = Path(__file__).resolve().parents[2]
    output = Path(args.output).resolve()
    if (db.parent.parent != Path(tempfile.gettempdir()).resolve()
            or not db.parent.name.startswith("etf-browser-fixture-") or db.name != "workbench.db"):
        raise ValueError("ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED")
    if not output.is_relative_to(root / "artifacts" / "verification"):
        raise ValueError("PRIVATE_VERIFICATION_OUTPUT_REQUIRED")
    output.mkdir(parents=True, exist_ok=True)
    tables = ("portfolios", "accounts", "ledger_events", "postings", "position_movements",
              "approval_events", "activations", "reservations", "execution_reports")

    def facts():
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as connection:
            return {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in tables}

    assert all(value == 0 for value in facts().values())
    checks = []
    errors = []
    posts = []
    report = {"status": "RUNNING", "synthetic_fixture_only": True, "headless": True,
              "playwright_version": importlib.metadata.version("playwright"), "checks": checks,
              "production_changed": False, "real_provider_called": False}
    base = "http://127.0.0.1:3147"

    def check(name, condition):
        assert condition, name
        checks.append(name)

    def seed(mode):
        result = subprocess.run([str(root / "web" / "node_modules" / ".bin" / "tsx"),
                                 "scripts/seed-investor-browser-research.ts", str(db), mode],
                                cwd=root / "web", check=True, capture_output=True, text=True, timeout=90,
                                env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"],
                                     "TMPDIR": tempfile.gettempdir(), "WORKBENCH_TEST_PYTHON": args.worker_python})
        return json.loads(result.stdout)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                report["browser_version"] = browser.version
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("request", lambda request: posts.append(request.post_data)
                        if request.method == "POST" and request.url == base + "/api/workbench/investor" else None)
                page.goto(base + "/workbench")
                page.wait_for_load_state("networkidle")
                page.get_by_label("工作台密码").fill("SYNTHETIC-ETF-FIXTURE-ONLY-2026")
                page.get_by_role("button", name="登录", exact=True).click()
                page.wait_for_load_state("networkidle")
                page.wait_for_selector("[data-hydrated=true]")
                page.locator("input[name=horizon]").fill("12")
                page.locator("select[name=liquidity]").select_option("none_in_horizon")
                for market in ("A 股", "港股", "美股"):
                    page.get_by_label(market, exact=True).check()
                page.get_by_text("可选：计划投入金额，仅作示意", exact=True).click()
                page.locator("input[name=budget]").fill("2500")
                page.locator("input[name=annual]").fill("300")
                page.get_by_role("button", name="保存偏好并检查研究条件", exact=True).click()
                panel = page.locator("section[aria-labelledby=risk-review-title]")
                expect(panel).to_be_visible(timeout=30000)
                session = context.request.get(base + "/api/auth/session").json()

                def state():
                    response = context.request.get(base + "/api/workbench/investor",
                                                   headers={"X-Workbench-Session-Binding": session["session_binding"]})
                    assert response.status == 200
                    return response.json()

                before = state()
                check("unknown risk remains null", before["profile"]["document"]["loss_tolerance"] is None)
                check("no default risk choice", panel.locator("input[name=risk-budget]:checked").count() == 0)
                amount = panel.locator("input[inputmode=decimal]")
                expect(amount).to_have_value("2500")
                amount.fill("1200")
                expect(panel).to_contain_text("-360.00")
                expect(panel).to_contain_text("840.00")
                check("hypothetical amount not saved", state()["profile"]["document"] == before["profile"]["document"])
                n = len(posts)
                panel.locator('input[name=risk-budget][value="0.20"]').check()
                button = panel.get_by_role("button", name="确认风险预算并重新研究", exact=True)
                expect(button).to_be_disabled()
                panel.get_by_role("button", name="暂不确定，保持未确认", exact=True).click()
                check("cancel produces no POST", len(posts) == n)
                check("cancel keeps risk unknown", state()["profile"]["document"]["loss_tolerance"] is None)
                amount.fill("1.001")
                expect(panel.get_by_role("alert")).to_be_visible()
                expect(panel).not_to_contain_text("假设金额变动")
                amount.fill("1200")
                seed("register")
                page.get_by_role("button", name="刷新状态", exact=True).click()
                page.get_by_role("button", name="重新检查研究条件", exact=True).click()
                expect(page.get_by_role("button", name="刷新状态", exact=True)).to_be_enabled()
                seed("compute")
                page.get_by_role("button", name="刷新状态", exact=True).click()
                expect(panel.get_by_role("heading", name="已登记候选的风险对照", exact=True)).to_be_visible()
                check("all three synthetic candidates visible", panel.locator("article").count() == 3)
                check("synthetic boundary visible", "合成数据软件测试" in panel.inner_text())
                amount.fill("1200")
                for label, width, height in (("desktop", 1440, 1000), ("mobile", 390, 844)):
                    page.set_viewport_size({"width": width, "height": height})
                    page.evaluate("() => { scrollTo(0, 0); return new Promise(requestAnimationFrame); }")
                    page.screenshot(path=str(output / f"risk-{label}.png"), full_page=True)
                    check(label + " has no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                page.set_viewport_size({"width": 1440, "height": 1000})
                panel.locator('input[name=risk-budget][value="0.20"]').check()
                panel.locator('input[type=checkbox]').check()
                expect(button).to_be_enabled()
                endpoint = base + "/api/workbench/investor"

                def reject_once(route):
                    if route.request.method == "POST":
                        route.fulfill(status=400, content_type="application/json", body='{"error":"INVESTOR_INPUT_INVALID"}')
                    else:
                        route.continue_()

                page.route(endpoint, reject_once)
                button.click()
                expect(page.get_by_role("alert").filter(has_text="请检查投资期限")).to_be_visible()
                expect(button).to_be_enabled()
                page.unroute(endpoint, reject_once)
                check("definitive rejection unlocks retry without mutation", state()["profile"]["document"]["loss_tolerance"] is None)

                def uncertain_once(route):
                    if route.request.method == "POST":
                        route.fulfill(status=503, content_type="application/json", body='{"error":"INVESTOR_UNAVAILABLE"}')
                    else:
                        route.continue_()

                page.route(endpoint, uncertain_once)
                n = len(posts)
                button.evaluate("button => { button.click(); button.click(); }")
                retry = page.get_by_role("button", name="核对并重试原请求", exact=True)
                expect(retry).to_be_enabled()
                check("double click creates only one uncertain request", len(posts) == n + 1)
                check("uncertain submission disables a new choice", panel.locator('input[name=risk-budget][value="0.30"]').is_disabled())
                uncertain_body = posts[-1]
                page.unroute(endpoint, uncertain_once)
                retry.click()
                expect(panel).to_contain_text("已记录 20.00%", timeout=30000)
                check("retry uses identical body and idempotency key", posts[-1] == uncertain_body)
                after = state()
                expected = {**before["profile"]["document"], "loss_tolerance": "0.20"}
                check("only risk answer changed", after["profile"]["document"] == expected)
                check("research requeued without weights", after["research_task"]["status"] == "queued" and after["plan"] is None)
                check("all financial facts remain empty", all(value == 0 for value in facts().values()))
                check("no runtime page errors", not errors)
                page.reload()
                page.wait_for_load_state("networkidle")
                expect(panel).to_contain_text("已记录 20.00%")
                check("reload retains choice with no new POST", posts[-1] == uncertain_body)
                page.get_by_role("button", name="退出登录", exact=True).click()
                page.wait_for_load_state("networkidle")
                expect(page.get_by_label("工作台密码")).to_be_visible()
                report["financial_counts"] = facts()
                report["fixture_summary"] = seed("summary")
                report["status"] = "PASS"
                context.close()
            finally:
                browser.close()
    except Exception as error:
        report["status"] = "FAIL"
        report["error"] = str(error)
        raise
    finally:
        report["page_errors"] = errors
        (output / "browser-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "checks": len(checks), "report": str(output / "browser-report.json")}))


if __name__ == "__main__":
    main()
