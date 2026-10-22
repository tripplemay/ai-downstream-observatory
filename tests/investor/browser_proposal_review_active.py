"""Real Next/HTTPS positive review using disposable current-time fictional records."""

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
    marker = json.loads((directory / 'proposal-fixture.json').read_text())
    assert marker['synthetic_fixture_only'] and marker['formal_gates_are_synthetic']
    assert not marker['broker_or_provider_verified'] and not marker['production_changed'] and not marker['clock_modified']
    output = Path(args.output).resolve(); output.mkdir(mode=0o700)
    base = 'https://127.0.0.1:3147'
    tables = ('ledger_events', 'postings', 'position_movements', 'ledger_heads', 'accounts', 'account_projections', 'position_projections',
        'activations', 'policy_versions', 'strategy_versions', 'investor_trial_intents', 'investor_trial_results')

    def sources():
        paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=root, text=True).splitlines()
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in paths if name.startswith(('web/src/', 'web/scripts/', 'web/tests/', 'scripts/', 'tests/investor/', 'migrations/', 'contracts/'))
            and (root / name).is_file() and (root / name).suffix in ('.ts', '.tsx', '.mjs', '.py', '.json', '.sql')}

    def snapshot():
        code = '''import Database from 'better-sqlite3';
const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});
try {const result=db.transaction(()=>({tables:Object.fromEntries(%s.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()])),
reservations:db.prepare('SELECT proposal_item_id,amount,quantity,status FROM reservations ORDER BY proposal_item_id').all(),
approvals:db.prepare("SELECT proposal_id,action FROM approval_events ORDER BY rowid").all(),
risk_count:db.prepare('SELECT count(*) n FROM risk_runs').get().n})).deferred();console.log(JSON.stringify(result));}finally{db.close();}
''' % json.dumps(tables)
        return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', code, str(directory / 'workbench.db')], cwd=root / 'web', text=True, timeout=30))

    before, source_before = snapshot(), sources()
    report = {'status': 'RUNNING', 'synthetic_fixture_only': True, 'headless': True, 'production_changed': False,
        'real_provider_called': False, 'real_ai_called': False, 'formal_admission_verified': False, 'clock_modified': False,
        'tls_scope': 'self_signed_loopback_only_not_public_certificate_verification', 'checks': [], 'source_sha256': source_before}
    errors, forbidden, commands, reads = [], [], [], []
    lost = {'approval': False}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, ignore_https_errors=True)
        page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))

        def route_request(route):
            request = route.request; url = urlsplit(request.url)
            if url.scheme != 'https' or url.netloc != '127.0.0.1:3147':
                forbidden.append({'method': request.method, 'path': url.path}); route.abort(); return
            if request.method == 'GET' and url.path == '/api/workbench/investor/proposal-review':
                reads.append(request.url)
            if request.method in ('GET', 'HEAD') or url.path in ('/api/auth/login', '/api/auth/logout'):
                route.continue_(); return
            if request.method == 'POST' and url.path == '/api/workbench/investor':
                body = request.post_data_json
                if body.get('action') == 'review_linked_proposal' and body.get('operation') in ('risk_check', 'approve', 'prepare', 'cancel_remainder'):
                    commands.append(body)
                    if body['operation'] == 'approve' and not lost['approval']:
                        response = route.fetch(); assert response.status == 200
                        lost['approval'] = True; route.abort('failed'); return
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
            read = panel.get_by_role('button', name='核对账户级待审清单', exact=True)
            expect(read).to_be_enabled(); assert not reads and snapshot() == before

            def choose(proposal):
                read.click()
                selector = panel.get_by_role('combobox', name='选择整张账户级清单', exact=True)
                expect(selector).to_have_value(''); selector.select_option(proposal)
                operation = panel.get_by_role('combobox', name='本次只执行哪一步', exact=True)
                expect(operation).to_have_value('')
                expect(page.get_by_role('button', name='核对账户资料', exact=True)).to_be_disabled()
                expect(page.get_by_role('button', name='录入已发生成交', exact=True)).to_be_disabled()
                assert snapshot()['tables'] == before['tables']
                return operation

            def submit(operation, value):
                operation.select_option(value); panel.get_by_role('checkbox').check()
                panel.get_by_role('button', name='确认此步骤，不发送券商订单', exact=True).click()

            def settled():
                expect(page.get_by_role('heading', name='这次提交仍待核对', exact=True)).to_have_count(0)
                expect(read).to_be_enabled(); assert snapshot()['tables'] == before['tables']

            first = marker['proposal_id']; second = marker['mobile_proposal_id']
            operation = choose(first)
            detail = panel.locator('details').filter(has=page.get_by_text('查看风控依据与版本', exact=True))
            assert not detail.evaluate('(element) => element.open')
            panel.get_by_text('查看风控依据与版本', exact=True).focus(); page.keyboard.press('Enter')
            expect(panel.get_by_text('确定性风控在本次核对时通过。', exact=True)).to_be_visible()
            page.keyboard.press('Enter'); assert not detail.evaluate('(element) => element.open')
            submit(operation, 'risk_check'); settled()
            assert snapshot()['risk_count'] == before['risk_count'] + 1
            operation = choose(first); operation.select_option('approve'); panel.get_by_role('checkbox').check()
            panel.get_by_label('复核备注（可选）', exact=True).fill('FICTIONAL REVIEW ONLY')
            expect(panel.get_by_role('checkbox')).not_to_be_checked()
            expect(panel.get_by_role('button', name='确认此步骤，不发送券商订单', exact=True)).to_be_disabled()
            panel.get_by_role('checkbox').check(); panel.get_by_role('button', name='确认此步骤，不发送券商订单', exact=True).click()
            expect(page.get_by_role('heading', name='这次提交仍待核对', exact=True)).to_be_visible()
            committed = snapshot(); assert committed['tables'] == before['tables']
            assert committed['reservations'] == [{'proposal_item_id': marker['proposal_item_id'], 'amount': '60000', 'quantity': '600', 'status': 'active'}]
            assert committed['approvals'] == [{'proposal_id': first, 'action': 'approve'}]
            page.get_by_role('button', name='核对并重试原请求', exact=True).click(); settled()
            approved = [value for value in commands if value['operation'] == 'approve']
            assert len(approved) == 2 and approved[0] == approved[1] and snapshot() == committed
            operation = choose(first)
            expect(operation.locator('option[value="approve"]')).to_have_count(0)
            expect(operation.locator('option[value="prepare"]')).to_have_count(1)
            page.screenshot(path=str(output / 'desktop-approved-review.png'), full_page=True)
            panel.screenshot(path=str(output / 'desktop-proposal-panel.png'))
            panel.evaluate('(element) => window.scrollTo(0, Math.max(0, window.scrollY + element.getBoundingClientRect().top - 96))')
            page.screenshot(path=str(output / 'desktop-proposal-viewport.png'))
            submit(operation, 'prepare'); settled()

            page.set_viewport_size({'width': 390, 'height': 844})
            operation = choose(second); submit(operation, 'risk_check'); settled()
            operation = choose(second); submit(operation, 'approve'); settled()
            operation = choose(second)
            expect(operation.locator('option[value="prepare"]')).to_have_count(1)
            assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
            page.screenshot(path=str(output / 'mobile-approved-review.png'), full_page=True)
            panel.screenshot(path=str(output / 'mobile-proposal-panel.png'))
            panel.evaluate('(element) => window.scrollTo(0, Math.max(0, window.scrollY + element.getBoundingClientRect().top - 96))')
            page.screenshot(path=str(output / 'mobile-proposal-viewport.png'))
            submit(operation, 'prepare'); settled()
            operation = choose(first)
            expect(operation.locator('option[value="prepare"]')).to_have_count(0)
            expect(panel.get_by_text(re.compile('最近执行前复核：'))).to_be_visible()
            expect(panel.get_by_text(re.compile('输入已变化，不能沿用'))).to_be_visible()
            submit(operation, 'cancel_remainder'); settled()
            operation = choose(second)
            expect(operation.locator('option[value="prepare"]')).to_have_count(0)
            submit(operation, 'cancel_remainder'); settled()
            final = snapshot(); assert final['tables'] == before['tables']
            assert len(final['reservations']) == 2 and all(row['status'] == 'released' and row['amount'] == row['quantity'] == '0' for row in final['reservations'])
            for action in ('approve', 'prepare_execution', 'cancel_remainder'):
                assert len([row for row in final['approvals'] if row['action'] == action]) == 2
            read.click()
            expect(panel.get_by_text(re.compile('当前没有待审或仍有剩余预占'))).to_be_visible()
            state = context.request.get(base + '/api/workbench/investor').json()
            (directory / 'auth/RESTORE_PENDING_REVIEW').write_text('SYNTHETIC RECOVERY TEST ONLY\n')
            assert context.request.post(base + '/api/workbench/investor', data=approved[0], headers={'Origin': base,
                'X-Workbench-Session-Binding': state['session_binding']}).status == 423
            assert snapshot() == final
            assert context.request.post(base + '/api/auth/logout', headers={'Origin': base}, max_redirects=0).status == 303
            assert context.request.get(base + '/api/workbench/investor/proposal-review').status == 401
            assert not errors and not forbidden and sources() == source_before
            report.update(status='PASS', page_error_count=0, forbidden_request_count=0, financial_rows_unchanged=True, source_unchanged=True,
                checks=['current-time synthetic records with no process clock change', 'desktop and390px explicit risk/approve/prepare journeys',
                    'acknowledgement reset and sibling writer interlocks', 'committed approval response loss and exact once-only immutable retry',
                    'other remaining reservations invalidate an old execution-preparation basis', 'explicit release leaves no remaining grants',
                    'recovery blocks original approval receipt replay; logout returns401'])
        except Exception as error:
            report.update(status='FAIL', error_type=type(error).__name__, page_errors=errors, forbidden_requests=forbidden)
            (output / 'private-error.log').write_text(str(error)); raise
        finally:
            (output / 'browser-result.json').write_text(json.dumps(report, indent=2) + '\n')
            context.close(); browser.close()
    print(json.dumps({name: value for name, value in report.items() if name != 'source_sha256'}))


if __name__ == '__main__':
    main()
