"""Opt-in headless full-window analysis check, restricted to an empty temporary fixture."""

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
    db, output = Path(args.db).resolve(strict=True), Path(args.output).resolve()
    root = Path(__file__).resolve().parents[2]
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

    original = facts()
    assert all(value == 0 for value in original.values())
    checks, errors, curve_requests, posts = [], [], [], []
    report = {"status": "RUNNING", "synthetic_fixture_only": True, "headless": True,
              "playwright_version": importlib.metadata.version("playwright"), "checks": checks,
              "production_changed": False, "real_provider_called": False}
    base = "http://127.0.0.1:3147"

    def check(name, condition):
        assert condition, name
        checks.append(name)

    def seed(mode):
        result = subprocess.run([str(root / "web" / "node_modules" / ".bin" / "tsx"),
                                 "scripts/seed-investor-browser-research.ts", str(db), mode], cwd=root / "web",
                                check=False, capture_output=True, text=True, timeout=120,
                                env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"],
                                     "TMPDIR": tempfile.gettempdir(), "WORKBENCH_TEST_PYTHON": args.worker_python})
        if result.returncode:
            (output / f"seed-{mode}-error.log").write_text(result.stderr)
            raise ValueError("FICTIONAL_BROWSER_SEED_FAILED:" + mode)
        return json.loads(result.stdout)

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                report["browser_version"] = browser.version
                context = browser.new_context(viewport={"width": 1440, "height": 1000})
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("request", lambda request: curve_requests.append(request.url)
                        if "/api/workbench/investor/funded-analysis?" in request.url else None)
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
                page.get_by_role("button", name="保存偏好并检查研究条件", exact=True).click()
                expect(page.locator("section[aria-labelledby=funding-plan-title]")).to_be_visible(timeout=30000)
                session = context.request.get(base + "/api/auth/session").json()
                headers = {"X-Workbench-Session-Binding": session["session_binding"], "Origin": base}

                def state():
                    response = context.request.get(base + "/api/workbench/investor", headers=headers)
                    assert response.status == 200
                    return response.json()

                initial = state()
                response = context.request.post(base + "/api/workbench/investor", headers=headers, data={
                    "action": "save_funding_plan", "expected_revision": initial["revision"], "idempotency_key": "fictional-browser-funding",
                    "funding_plan": {"schema_version": "investor-funding-plan-v1", "start_date": "2026-01-01", "horizon_years": 1,
                                     "evaluation_timezone": "Asia/Shanghai", "initial_capital_cny": "1200", "annual_contribution_cny": "300",
                                     "first_annual_date": "2026-12-31", "entry_method": "three_tranches_60_days", "actual_arrivals_confirmed": False,
                                     "execution_authorized": False, "live_advice_eligible": False}})
                assert response.status == 200
                seed("funded-evidence")
                page.get_by_role("button", name="刷新状态", exact=True).click()
                expect(page.get_by_role("button", name="比较及时投入与有限分期", exact=True)).to_be_enabled()
                page.get_by_role("button", name="比较及时投入与有限分期", exact=True).click()
                expect(page.get_by_role("button", name="刷新状态", exact=True)).to_be_enabled()
                seed("funded-worker")
                page.get_by_role("button", name="刷新状态", exact=True).click()
                panel = page.locator("section[aria-labelledby=funded-comparison-title]")
                expect(panel).to_be_visible(timeout=30000)
                page.get_by_role("button", name="查看已登记的比较结果", exact=True).click()
                expect(panel.locator("article")).to_have_count(3, timeout=60000)
                check("all frozen candidates remain visible", panel.locator("article").count() == 3)
                check("analysis is not requested automatically", not curve_requests)
                candidate = panel.locator("article").first
                load = candidate.get_by_role("button", name="查看完整窗口曲线与持有对照", exact=True)
                before, n = state(), len(posts)
                load.click()
                wealth = candidate.get_by_role("img", name="整个历史窗口的本金、候选净资产、待释放现金与持有对照曲线", exact=True)
                expect(wealth).to_be_visible(timeout=75000)
                check("one selected analysis request only", len(curve_requests) == 1)
                with page.expect_response(lambda response: response.url == base + "/api/workbench/investor"
                                          and response.request.method == "GET", timeout=15000) as poll:
                    pass
                assert poll.value.status == 200
                expect(wealth).to_be_visible()
                check("ordinary background refresh preserves expanded results", len(curve_requests) == 1)
                check("historical holding baseline is not preregistered", "不是过去预注册的独立基准" in candidate.inner_text())
                check("rolling sample is not future probability", "不是未来亏损概率" in candidate.inner_text())
                check("short window is not fabricated", candidate.get_by_text("没有完整观测窗口，不补造结果", exact=True).count() == 6)
                expect(candidate).to_contain_text("1,500.00")
                for label, width, height in (("desktop", 1440, 1000), ("mobile", 390, 844)):
                    page.set_viewport_size({"width": width, "height": height})
                    page.evaluate("() => { scrollTo(0, 0); return new Promise(requestAnimationFrame); }")
                    page.screenshot(path=str(output / f"funded-{label}.png"), full_page=True)
                    page.screenshot(path=str(output / f"candidate-{label}.png"), full_page=True, clip=candidate.bounding_box())
                    check(label + " has no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                    check(label + " chart labels retain readable sizing", wealth.evaluate("svg => Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) < 3"))
                page.set_viewport_size({"width": 1440, "height": 1000})
                candidate.get_by_role("button", name="累计盈亏", exact=True).click()
                expect(candidate.get_by_role("img", name="扣已识别成本后的累计盈亏曲线，追加本金不是收益", exact=True)).to_be_visible()
                check("profit view is separate from principal", True)
                candidate.get_by_role("button", name="单位回撤", exact=True).click()
                expect(candidate.get_by_role("img", name="日末单位回撤曲线，精确最深回撤按所有估值点计算", exact=True)).to_be_visible()
                check("risk calculation explains full observations", "个估值点用于风险" in candidate.inner_text())
                candidate.locator("input[type=range]").fill("0")
                expect(candidate).to_contain_text("查看候选某个估值日：2024-01-01")
                check("first observed day is inspectable", True)
                candidate.locator("select").select_option("staged")
                expect(candidate.locator("svg")).to_have_count(0)
                check("changing displayed path hides previous curve", True)
                load.click()
                expect(wealth).to_be_visible(timeout=75000)
                check("selected path is staged without saving funding", "path=staged" in curve_requests[-1])
                check("curve controls produce no investment POST", len(posts) == n)
                after = state()
                check("funding and unknown personal risk unchanged", after["funding"] == before["funding"]
                      and after["profile"] == before["profile"] and after["revision"] == before["revision"])
                check("financial facts remain empty", facts() == original)

                def corrupt(route):
                    result = route.fetch().json()
                    result["analysis"]["comparison"]["ending_nav_difference_cny"] = "999"
                    route.fulfill(status=200, content_type="application/json", body=json.dumps(result))

                page.route(base + "/api/workbench/investor/funded-analysis?*", corrupt)
                load.click()
                expect(candidate.get_by_role("alert")).to_contain_text("未显示旧结果", timeout=75000)
                expect(candidate.locator("svg")).to_have_count(0)
                page.unroute(base + "/api/workbench/investor/funded-analysis?*", corrupt)
                check("resealed wrong comparison is not rendered", True)
                load.click()
                expect(wealth).to_be_visible(timeout=75000)
                seed("funded-withdraw")
                page.get_by_role("button", name="刷新状态", exact=True).click()
                expect(page.locator("section[aria-labelledby=funded-comparison-title]")).to_have_count(0)
                check("withdrawal and state refresh hide old analysis", True)
                check("no browser runtime errors", not errors)
                report.update(status="PASS", browser_errors=errors, financial_counts=facts(), analysis_requests=len(curve_requests),
                              risk_unconfirmed=state()["profile"]["document"]["loss_tolerance"] is None)
                context.close()
            finally:
                browser.close()
    except Exception as error:
        report.update(status="FAIL", error_type=type(error).__name__, error=str(error), browser_errors=errors)
        raise
    finally:
        (output / "browser-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "checks": len(checks), "headless": True}))


if __name__ == "__main__":
    main()
