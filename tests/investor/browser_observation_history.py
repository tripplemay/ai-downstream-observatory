"""Opt-in real Next archive journey. Uses only the launcher's fresh fictional fixture."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture-log', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(__file__).resolve().parents[2]
    found = re.findall(r'Synthetic fixture directory: (.+)', Path(args.fixture_log).resolve().read_text())
    assert len(found) == 1
    directory = Path(found[0]).resolve()
    assert directory.parent == Path(tempfile.gettempdir()).resolve() and re.fullmatch('etf-browser-fixture-[A-Za-z0-9]+', directory.name)
    marker = json.loads((directory / 'history-fixture.json').read_text())
    assert marker['synthetic_fixture_only'] and not marker['production_changed'] and not marker['broker_or_provider_verified']
    output = Path(args.output).resolve(); output.mkdir(mode=0o700)
    base = 'https://127.0.0.1:3147'

    def sources():
        names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=root, text=True).splitlines()
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names
            if name.startswith(('web/src/', 'web/scripts/', 'web/tests/', 'scripts/', 'tests/investor/', 'migrations/', 'contracts/'))
            and (root / name).is_file() and (root / name).suffix in ('.ts', '.tsx', '.mjs', '.py', '.json', '.sql')}

    def protected():
        tables = ('investor_workspaces', 'investor_profiles', 'investor_observations', 'investor_decisions', 'investor_commands', 'audit_events',
            'ledger_events', 'ledger_heads', 'postings', 'position_movements', 'accounts', 'approval_events', 'reservations', 'execution_reports', 'job_runs', 'outbox')
        code = """import Database from 'better-sqlite3';const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});
try {console.log(JSON.stringify(db.transaction(()=>Object.fromEntries(%s.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]))).deferred()));}finally{db.close();}""" % json.dumps(tables)
        raw = subprocess.check_output(['node', '--input-type=module', '-e', code, str(directory / 'workbench.db')], cwd=root / 'web', text=True, timeout=30)
        return hashlib.sha256(raw.encode()).hexdigest()

    baseline, source_before = protected(), sources()
    report = {'status': 'RUNNING', 'synthetic_fixture_only': True, 'production_changed': False, 'real_provider_called': False,
        'real_ai_called': False, 'source_sha256': source_before, 'checks': []}
    errors, forbidden, requests = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True, viewport={'width': 1440, 'height': 1000})
        page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
        lost = {'armed': False, 'done': False}

        def intercept(route):
            request = route.request; url = urlsplit(request.url)
            if url.scheme != 'https' or url.netloc != '127.0.0.1:3147' or request.method not in ('GET', 'HEAD') and url.path not in ('/api/auth/login', '/api/auth/logout'):
                forbidden.append({'method': request.method, 'path': url.path}); route.abort(); return
            if url.path == '/api/workbench/investor/history':
                requests.append(request.url)
                if lost['armed'] and not lost['done']:
                    response = route.fetch(); assert response.status == 200
                    lost['done'] = True; route.abort('failed'); return
            route.continue_()

        context.route('**/*', intercept)
        history_response = lambda response: urlsplit(response.url).path == '/api/workbench/investor/history'
        try:
            assert context.request.get(base + '/api/workbench/investor/history').status == 401
            page.goto(base + '/workbench/observations', wait_until='networkidle')
            page.locator('input[name="password"]').fill('SYNTHETIC-ETF-FIXTURE-ONLY-2026')
            page.get_by_role('button', name='登录', exact=True).click(); page.wait_for_url(base + '/workbench')
            with page.expect_response(history_response) as pending:
                page.goto(base + '/workbench/observations', wait_until='networkidle')
            first = pending.value.json(); assert pending.value.status == 200
            panel = page.get_by_role('region', name='观察归档', exact=True)
            assert page.get_by_role('button', name='刷新状态', exact=True).count() == 0
            expect(panel.locator('article')).to_have_count(20)
            assert any(cookie['secure'] and cookie['httpOnly'] and cookie['sameSite'] == 'Strict' for cookie in context.cookies())
            assert first['historical_only'] and not first['is_current_conclusion'] and not first['live_advice_eligible']
            binding = first['session_binding']
            assert context.request.get(base + '/api/workbench/investor/history?owner=foreign', headers={'X-Workbench-Session-Binding': binding}).status == 400
            lost['armed'] = True; panel.get_by_role('button', name='更早记录', exact=True).click()
            expect(panel.get_by_role('alert')).to_contain_text('暂未通过核对')
            count = len(requests); page.wait_for_timeout(500); assert len(requests) == count
            with page.expect_response(history_response) as pending:
                panel.get_by_role('button', name='刷新记录', exact=True).click()
            data = pending.value.json(); ids = [row['id'] for row in data['entries']]
            while data['next_cursor']:
                with page.expect_response(history_response) as pending:
                    panel.get_by_role('button', name='更早记录', exact=True).click()
                data = pending.value.json(); ids.extend(row['id'] for row in data['entries'])
            assert len(ids) == marker['observation_count'] == len(set(ids)) and marker['observation_id'] in ids
            expect(panel.get_by_role('button', name='更早记录', exact=True)).to_be_disabled()
            target = panel.locator('#research-observation-' + marker['observation_id'])
            with page.expect_response(history_response) as pending:
                target.get_by_role('link', name='查看这次观察的全部人工决定', exact=True).click()
            data = pending.value.json(); assert data['observation_id'] == marker['observation_id'] and data['mode'] == 'decisions'
            expect(panel.get_by_role('heading', name='按本次观察核对的人工决定', exact=True)).to_be_visible()
            decisions = [row['id'] for row in data['decisions']]
            while data['next_cursor']:
                with page.expect_response(history_response) as pending:
                    panel.get_by_role('button', name='更早记录', exact=True).click()
                data = pending.value.json(); decisions.extend(row['id'] for row in data['decisions'])
            assert len(decisions) == marker['decision_count'] == len(set(decisions))
            page.evaluate('window.scrollTo(0,0)'); page.screenshot(path=str(output / 'desktop-history.png'))
            report['checks'].append('desktop: all 67 observations and 55 independently bound decisions, lost GET explicit recovery, no automatic retry or mutation')
            page.set_viewport_size({'width': 390, 'height': 844})
            with page.expect_response(history_response):
                page.reload(wait_until='networkidle')
            expect(panel.get_by_role('heading', name='这次观察与完整人工决定', exact=True)).to_be_visible()
            details = panel.locator('details').first; details.locator('summary').focus(); page.keyboard.press('Enter'); expect(details).to_have_attribute('open', '')
            assert page.get_by_role('button', name='采纳思路', exact=True).count() == 0
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            page.evaluate('window.scrollTo(0,0)'); page.screenshot(path=str(output / 'mobile-history.png'))
            marker_file = directory / 'auth' / 'RESTORE_PENDING_REVIEW'
            with marker_file.open('x') as stream:
                stream.write('SYNTHETIC RECOVERY ONLY\n')
            with page.expect_response(history_response):
                page.reload(wait_until='networkidle')
            expect(page.get_by_text('恢复只读模式：可查看证据，暂不能保存偏好、复核或记录决定。', exact=True)).to_be_visible()
            expect(panel.locator('article')).to_have_count(1); expect(panel.get_by_role('button', name='更早记录', exact=True)).to_be_enabled()
            report['checks'].append('390px: targeted historical record reload, keyboard evidence fold, no current decision action, recovery mode permits read-only archive')
            assert protected() == baseline
            page.get_by_role('button', name='退出登录', exact=True).click(); page.wait_for_url(base + '/login')
            assert context.request.get(base + '/api/workbench/investor/history').status == 401
            assert not errors and not forbidden and sources() == source_before and protected() == baseline
            report.update(status='PASS', page_error_count=0, forbidden_request_count=0, protected_rows_unchanged=True,
                observation_count=len(ids), decision_count=len(decisions), source_unchanged=True, tls_scope='self_signed_loopback_only_not_public_certificate_verification')
        except Exception as error:
            report.update(status='FAIL', error_type=type(error).__name__, message=str(error), page_errors=errors, forbidden_requests=forbidden)
            page.screenshot(path=str(output / 'failure.png'), full_page=True)
            raise
        finally:
            (output / 'browser-result.json').write_text(json.dumps(report, indent=2) + '\n')
            context.close(); browser.close()
    print(json.dumps({key: value for key, value in report.items() if key != 'source_sha256'}))


if __name__ == '__main__':
    main()
