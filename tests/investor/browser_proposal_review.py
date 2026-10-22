"""Opt-in real Next/HTTPS expired-proposal review; fictional data, actual wall clock."""

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
    found = re.findall(r'Synthetic fixture directory: (.+)', Path(args.fixture_log).read_text())
    if len(found) != 1:
        raise ValueError('ONE_RUNNING_SYNTHETIC_FIXTURE_REQUIRED')
    directory = Path(found[0]).resolve()
    if directory.parent != Path(tempfile.gettempdir()).resolve() or not re.fullmatch('etf-browser-fixture-[A-Za-z0-9]+', directory.name):
        raise ValueError('ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED')
    marker = json.loads((directory / 'execution-fixture.json').read_text())
    assert marker['synthetic_fixture_only'] and not marker['broker_or_provider_verified'] and not marker['production_changed']
    output = Path(args.output).resolve(); output.mkdir(mode=0o700)
    base = 'https://127.0.0.1:3147'
    tables = ('ledger_events', 'postings', 'position_movements', 'ledger_heads', 'accounts', 'account_projections', 'position_projections',
        'activations', 'policy_versions', 'strategy_versions', 'investor_trial_intents', 'investor_trial_results', 'risk_runs')

    def sources():
        paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=root, text=True).splitlines()
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in paths if name.startswith(('web/src/', 'web/scripts/', 'web/tests/', 'scripts/', 'tests/investor/', 'migrations/', 'contracts/'))
            and (root / name).is_file() and (root / name).suffix in ('.ts', '.tsx', '.mjs', '.py', '.json', '.sql')}

    def snapshot():
        code = '''import Database from 'better-sqlite3';
const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});
try {const result=db.transaction(()=>({tables:Object.fromEntries(%s.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()])),
reservation:db.prepare('SELECT amount,quantity,status FROM reservations WHERE proposal_item_id=?').get(process.argv[2]),
cancellations:db.prepare("SELECT count(*) n FROM approval_events WHERE proposal_id=? AND action='cancel_remainder'").get(process.argv[3]).n})).deferred();console.log(JSON.stringify(result));}finally{db.close();}
''' % json.dumps(tables)
        return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', code, str(directory / 'workbench.db'), marker['proposal_item_id'], marker['proposal_id']],
            cwd=root / 'web', text=True, timeout=30))

    before, source_before = snapshot(), sources()
    report = {'status': 'RUNNING', 'synthetic_fixture_only': True, 'headless': True, 'production_changed': False,
        'real_provider_called': False, 'real_ai_called': False, 'approval_prepare_native_verified': False,
        'tls_scope': 'self_signed_loopback_only_not_public_certificate_verification', 'checks': [], 'source_sha256': source_before}
    errors, forbidden, commands = [], [], []
    lost = {'read': False, 'cancel': False}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, ignore_https_errors=True)
        page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))

        def route_request(route):
            request = route.request; url = urlsplit(request.url)
            if url.scheme != 'https' or url.netloc != '127.0.0.1:3147':
                forbidden.append({'method': request.method, 'path': url.path}); route.abort(); return
            if request.method == 'GET' and url.path == '/api/workbench/investor/proposal-review' and not lost['read']:
                response = route.fetch(); assert response.status == 200
                lost['read'] = True; route.abort('failed'); return
            if request.method in ('GET', 'HEAD') or url.path in ('/api/auth/login', '/api/auth/logout'):
                route.continue_(); return
            if request.method == 'POST' and url.path == '/api/workbench/investor':
                body = request.post_data_json
                if body.get('action') == 'review_linked_proposal' and body.get('operation') == 'cancel_remainder':
                    commands.append(body)
                    if not lost['cancel']:
                        response = route.fetch(); assert response.status == 200
                        lost['cancel'] = True; route.abort('failed'); return
                    route.continue_(); return
            forbidden.append({'method': request.method, 'path': url.path}); route.abort()

        context.route('**/*', route_request)
        try:
            assert context.request.get(base + '/api/workbench/investor/proposal-review').status == 401
            page.goto(base + '/workbench/accounts', wait_until='networkidle')
            page.locator('input[name="password"]').fill('SYNTHETIC-ETF-FIXTURE-ONLY-2026')
            page.get_by_role('button', name='登录', exact=True).click(); page.wait_for_url(base + '/workbench')
            page.goto(base + '/workbench/accounts', wait_until='networkidle')
            panel = page.get_by_role('region', name='账户级清单复核', exact=True)
            expect(panel).to_be_visible(); panel.get_by_role('button', name='核对账户级待审清单', exact=True).click()
            expect(panel.get_by_role('alert')).to_be_visible()
            assert snapshot() == before
            panel.get_by_role('button', name='核对账户级待审清单', exact=True).click()
            select = panel.get_by_role('combobox', name='选择整张账户级清单', exact=True)
            expect(select).to_have_value(''); select.select_option(marker['proposal_id'])
            operation = panel.get_by_role('combobox', name='本次只执行哪一步', exact=True)
            expect(operation).to_have_value('')
            expect(operation.locator('option[value="approve"]')).to_have_count(0)
            expect(operation.locator('option[value="prepare"]')).to_have_count(0)
            expect(operation.locator('option[value="expire"]')).to_have_count(1)
            expect(page.get_by_role('button', name='核对账户资料', exact=True)).to_be_disabled()
            expect(page.get_by_role('button', name='录入已发生成交', exact=True)).to_be_disabled()
            assert snapshot() == before
            page.screenshot(path=str(output / 'desktop-expired-review.png'), full_page=True)
            page.set_viewport_size({'width': 390, 'height': 844})
            assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
            page.screenshot(path=str(output / 'mobile-expired-review.png'), full_page=True)
            operation.select_option('cancel_remainder'); panel.get_by_role('checkbox').check()
            panel.get_by_role('button', name='确认此步骤，不发送券商订单', exact=True).click()
            expect(page.get_by_role('heading', name='这次提交仍待核对', exact=True)).to_be_visible()
            interim = snapshot(); assert interim['tables'] == before['tables']
            assert interim['reservation'] == {'amount': '0', 'quantity': '0', 'status': 'released'} and interim['cancellations'] == 1
            page.get_by_role('button', name='核对并重试原请求', exact=True).click()
            expect(page.get_by_role('heading', name='这次提交仍待核对', exact=True)).to_have_count(0)
            expect(panel.get_by_role('button', name='核对账户级待审清单', exact=True)).to_be_enabled()
            assert len(commands) == 2 and commands[0] == commands[1] and snapshot() == interim
            panel.get_by_role('button', name='核对账户级待审清单', exact=True).click()
            expect(panel.get_by_text('当前没有待审或仍有剩余预占的账户级清单。研究方案仍可独立观察；这里不会补造目标、现金、策略准入或订单。', exact=True)).to_be_visible()
            state = context.request.get(base + '/api/workbench/investor').json()
            (directory / 'auth/RESTORE_PENDING_REVIEW').write_text('SYNTHETIC RECOVERY TEST ONLY\n')
            assert context.request.post(base + '/api/workbench/investor', data=commands[0], headers={'Origin': base,
                'X-Workbench-Session-Binding': state['session_binding']}).status == 423
            assert snapshot() == interim
            assert context.request.post(base + '/api/auth/logout', headers={'Origin': base}, max_redirects=0).status == 303
            assert context.request.get(base + '/api/workbench/investor/proposal-review').status == 401
            assert not errors and not forbidden and sources() == source_before
            report.update(status='PASS', page_error_count=0, forbidden_request_count=0, financial_rows_unchanged=True,
                checks=['zero-write reads and explicit recovery after dropped GET', 'expired approved list has no approval or prepare option',
                    'desktop/mobile 390px whole-book draft interlocks', 'committed cancellation response loss and exactly-once immutable retry',
                    'recovery barrier rejects original receipt replay and logout returns401'], source_unchanged=True)
        except Exception as error:
            report.update(status='FAIL', error_type=type(error).__name__, page_errors=errors, forbidden_requests=forbidden)
            (output / 'private-error.log').write_text(str(error)); raise
        finally:
            (output / 'browser-result.json').write_text(json.dumps(report, indent=2) + '\n')
            context.close(); browser.close()
    print(json.dumps({name: value for name, value in report.items() if name != 'source_sha256'}))


if __name__ == '__main__':
    main()
