"""Opt-in actual-browser journey with invented evidence and an isolated empty DB."""

import argparse
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--worker-python", required=True)
    parser.add_argument("--strict-zero-tolerance", action="store_true", help="Keep the original zero tolerance and inspect nonzero subcent deltas")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    db, output = Path(args.db).resolve(strict=True), Path(args.output).resolve()
    if (db.parent.parent != Path(tempfile.gettempdir()).resolve() or not db.parent.name.startswith("etf-browser-fixture-")
            or db.name != "workbench.db"):
        raise ValueError("ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED")
    if not output.is_relative_to(root / "artifacts" / "verification"):
        raise ValueError("PRIVATE_VERIFICATION_OUTPUT_REQUIRED")
    output.mkdir(parents=True, exist_ok=True)
    tables = ("portfolios", "accounts", "ledger_events", "postings", "position_movements", "approval_events", "activations", "reservations", "execution_reports")

    def facts():
        child = subprocess.run([args.worker_python, "-c",
            "import json,sqlite3,sys; c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); "
            "print(json.dumps({t:c.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in json.loads(sys.argv[2])})); c.close()",
            str(db), json.dumps(tables)], capture_output=True, text=True, timeout=15, check=True)
        return json.loads(child.stdout)

    def sources():
        directories = ("contracts", "migrations", "worker/investor", "worker/research", "web/src", "web/scripts", "tests/investor")
        files = [file for name in directories for file in (root / name).rglob("*")
                 if file.is_file() and file.suffix in (".py", ".ts", ".tsx", ".mjs", ".json", ".sql")]
        files.extend(root / name for name in ("web/tsconfig.json", "web/package.json", "web/next.config.ts"))
        return {str(file.relative_to(root)): sha256(file.read_bytes()).hexdigest() for file in sorted(set(files))}

    assert all(value == 0 for value in facts().values())
    checks, errors, posts = [], [], []
    report = {"status": "RUNNING", "synthetic_fixture_only": True, "headless": True, "http_responses_mocked": False,
              "playwright_version": importlib.metadata.version("playwright"), "checks": checks,
              "source_sha256": sources(), "production_changed": False, "real_provider_called": False,
              "external_ai_called": False, "personal_profile_changed": False,
              "strict_zero_tolerance": args.strict_zero_tolerance,
              "limits": ["invented owner reviews and stub SDK data, not real market or licence acceptance",
                         "loopback self-signed HTTPS is not public TLS, container, native-browser or production acceptance",
                         "empty account transcription is not a complete funded securities/account execution loop"]}
    base = "https://127.0.0.1:3147"

    def check(label, condition):
        assert condition, label
        checks.append(label)

    def seed(mode):
        child = subprocess.run([str(root / "web/node_modules/.bin/tsx"), "scripts/seed-investor-browser-research.ts", str(db), mode],
            cwd=root / "web", capture_output=True, text=True, timeout=180,
            env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "TMPDIR": tempfile.gettempdir(), "WORKBENCH_TEST_PYTHON": args.worker_python})
        (output / ("seed-" + mode + ".log")).write_text(child.stdout + child.stderr)
        assert child.returncode == 0, "SYNTHETIC_SEED_FAILED:" + mode
        return json.loads(child.stdout)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                report["browser_version"] = browser.version
                report["build_id"] = (root / "web/.next-fixture-production/BUILD_ID").read_text().strip()
                context = browser.new_context(viewport={"width": 1440, "height": 1000}, ignore_https_errors=True)
                page = context.new_page()
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("request", lambda request: posts.append(json.loads(request.post_data)["action"])
                        if request.method == "POST" and request.url == base + "/api/workbench/investor" else None)

                def go(path):
                    page.goto(base + path)
                    page.wait_for_load_state("networkidle")
                    page.wait_for_selector("[data-hydrated=true]")

                def capture(name):
                    for label, width, height in (("desktop", 1440, 1000), ("mobile", 390, 844)):
                        page.set_viewport_size({"width": width, "height": height})
                        page.evaluate("() => new Promise(requestAnimationFrame)")
                        check(name + " " + label + " has no horizontal overflow", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
                        page.screenshot(path=str(output / (name + "-" + label + ".png")), full_page=True)
                    page.set_viewport_size({"width": 1440, "height": 1000})

                page.goto(base + "/workbench")
                page.wait_for_load_state("networkidle")
                assert page.get_by_label("工作台密码").is_visible(), page.locator("body").inner_text()
                page.get_by_label("工作台密码").fill("SYNTHETIC-ETF-FIXTURE-ONLY-2026")
                page.get_by_role("button", name="登录", exact=True).click()
                page.wait_for_load_state("networkidle")
                page.wait_for_selector("[data-hydrated=true]")
                page.locator("input[name=horizon]").fill("12")
                page.locator("select[name=liquidity]").select_option("none_in_horizon")
                for market in ("A 股", "港股", "美股"):
                    page.get_by_label(market, exact=True).check()
                page.get_by_role("button", name="保存偏好并检查研究条件", exact=True).click()
                expect(page.get_by_role("button", name="重新检查研究条件", exact=True)).to_be_enabled(timeout=30000)
                session = context.request.get(base + "/api/auth/session").json()
                check("production session uses host-only secure cookie", any(cookie["name"] == "__Host-workbench-session" and cookie["secure"]
                    and cookie["httpOnly"] and cookie["sameSite"] == "Strict" for cookie in context.cookies()))
                headers = {"X-Workbench-Session-Binding": session["session_binding"]}

                def state():
                    response = context.request.get(base + "/api/workbench/investor", headers=headers)
                    assert response.status == 200
                    return response.json()

                check("unknown risk preserved and no account prerequisite", state()["profile"]["document"]["loss_tolerance"] is None and all(n == 0 for n in facts().values()))
                seed("bounded-zero-tolerance-evidence" if args.strict_zero_tolerance else "bounded-policy-evidence")
                page.get_by_role("button", name="重新检查研究条件", exact=True).click()
                expect(page.get_by_role("button", name="刷新状态", exact=True)).to_be_enabled()
                seed("core")
                go("/workbench/plan")
                risk = page.locator("section[aria-labelledby=risk-review-title]")
                expect(risk).to_contain_text("已登记候选的风险对照", timeout=30000)
                check("train-only candidates do not silently select personal risk", state()["profile"]["document"]["loss_tolerance"] is None and state()["plan"] is None)
                capture("risk-options")
                risk.locator('input[name="risk-budget"][value="0.30"]').check()
                risk.get_by_role("checkbox").check()
                risk.get_by_role("button", name="确认风险预算并重新研究", exact=True).click()
                expect(page.get_by_role("button", name="刷新状态", exact=True)).to_be_enabled()
                seed("core")
                page.get_by_role("button", name="刷新状态", exact=True).click()
                save = page.get_by_role("button", name="保存为观察中的研究方案", exact=True)
                expect(save).to_be_enabled(timeout=30000)
                check("bounded source produces actual persisted reference", "+bounded-close-v1+fixed-policy-v2" in state()["plan"]["document"]["strategy_version"])
                save.click()
                expect(page.get_by_role("button", name="已保存为观察方案", exact=True)).to_be_visible()
                check("saving registers only model observation", state()["model_watch"] is not None and all(n == 0 for n in facts().values()))
                seed("monitor")
                go("/workbench")
                if args.strict_zero_tolerance:
                    expect(page.get_by_role("heading", name="需要你做决定", exact=True, level=2)).to_be_visible()
                    expect(page.get_by_role("note")).to_contain_text("部分模型差值小于分币显示精度，不是零")
                    expect(page.get_by_text("研究变化：+<0.01 CNY", exact=True).first).to_be_visible()
                    page.get_by_text("查看未舍入的模型差值", exact=True).click()
                    check("strict frozen tolerance is not silently widened", state()["effective_outcome"] == "decision_required")
                    report["subcent_model_changes"] = state()["latest"]["document"]["model_change"]["changes"]
                    capture("subcent-decision")
                else:
                    expect(page.get_by_role("heading", name="继续观察", exact=True, level=2)).to_be_visible()
                    capture("observe")
                fold = page.get_by_test_id("overview-research-details")
                policy_heading = fold.get_by_role("heading", name="本次低频规则复核", exact=True)
                expect(policy_heading).not_to_be_visible()
                fold.locator("summary").first.click()
                expect(policy_heading).to_be_visible()
                fold.locator("summary").first.click()
                check("overview keeps rule diagnostics collapsed behind the portfolio", True)
                seed("funding")
                page.get_by_role("button", name="刷新状态", exact=True).click()
                defer = page.get_by_role("button", name="暂缓", exact=True)
                expect(defer).to_be_enabled(timeout=30000)
                capture("funding-decision")
                defer.click()
                expect(page.get_by_role("button", name="刷新状态", exact=True)).to_be_enabled()
                go("/workbench/observations")
                expect(page.get_by_text("你的决定：暂缓", exact=False).first).to_be_visible()
                check("human decision survives route navigation without financial writes", state()["decisions"][0]["decision"] == "defer" and all(n == 0 for n in facts().values()))
                capture("history")
                go("/workbench/accounts")
                expect(page.get_by_label("账本名称", exact=True)).to_be_enabled(timeout=30000)
                page.get_by_label("账本名称", exact=True).fill("FICTIONAL UI BOOK")
                page.get_by_label("账户别名", exact=True).fill("FICTIONAL UI ACCOUNT")
                page.get_by_label("券商名称", exact=True).fill("FICTIONAL BROKER")
                page.get_by_role("button", name="仅建档并关联，不生成现金或持仓", exact=True).click()
                reconciliation = page.locator('section[aria-label="独立对账"]')
                expect(reconciliation.get_by_role("button", name="录入独立资料", exact=True)).to_be_enabled(timeout=30000)
                counts = facts()
                check("explicit account creation adds metadata, not money or approvals", counts["portfolios"] == counts["accounts"] == 1 and all(counts[t] == 0 for t in tables[2:]))
                reconciliation.get_by_role("button", name="录入独立资料", exact=True).click()
                reconciliation.get_by_label("独立资料编号或说明", exact=True).fill("FICTIONAL EMPTY ACCOUNT STATEMENT")
                yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()
                reconciliation.get_by_label("账单截至日期（完整当地日）", exact=True).fill(yesterday)
                reconciliation.get_by_label("账单时区", exact=True).select_option("Asia/Shanghai")
                reconciliation.get_by_label("已结算现金", exact=True).fill("0")
                reconciliation.get_by_role("checkbox").nth(0).check()
                reconciliation.get_by_role("checkbox").nth(1).check()
                reconciliation.get_by_role("button", name="保存独立资料并对账", exact=True).click()
                expect(reconciliation).to_contain_text("本次资料匹配", timeout=30000)
                check("independent empty statement is saved without financial facts", all(facts()[t] == 0 for t in tables[2:]))
                capture("accounts")
                check("no JavaScript page errors", not errors)
                check("research phases and review commands reached real HTTP", all(action in posts for action in ("save_profile", "evaluate", "save_plan", "review", "create_account_book", "reconcile_linked_account")) and posts.count("save_profile") == 2)
                report["financial_counts"] = facts()
                report["actions"] = posts
                report["status"] = "PASS"
            except Exception:
                if "page" in locals() and not page.is_closed():
                    page.screenshot(path=str(output / "failure.png"), full_page=True)
                    (output / "failure.txt").write_text(page.url + "\n" + page.locator("body").inner_text())
                raise
            finally:
                browser.close()
    except Exception as error:
        report["status"] = "FAIL"
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
