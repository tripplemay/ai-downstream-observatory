"""Opt-in real Next/HTTPS execution-followup journey using fictional records only."""

import argparse
from email import policy
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture-log', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    root = Path(__file__).resolve().parents[2]
    log = Path(args.fixture_log).resolve().read_text()
    found = re.findall(r'Synthetic fixture directory: (.+)', log)
    if len(found) != 1:
        raise ValueError('ONE_RUNNING_SYNTHETIC_FIXTURE_REQUIRED')
    directory = Path(found[0]).resolve()
    if directory.parent != Path(tempfile.gettempdir()).resolve() or not re.fullmatch('etf-browser-fixture-[A-Za-z0-9]+', directory.name):
        raise ValueError('ONLY_TEMPORARY_BROWSER_FIXTURE_ALLOWED')
    marker = json.loads((directory / 'execution-fixture.json').read_text())
    assert marker['synthetic_fixture_only'] and not marker['broker_or_provider_verified'] and not marker['production_changed']
    db_path = directory / 'workbench.db'
    output = Path(args.output).resolve(); output.mkdir(mode=0o700)
    base = 'https://127.0.0.1:3147'
    tables = ('ledger_events', 'postings', 'position_movements', 'ledger_heads', 'accounts', 'account_projections', 'position_projections',
        'activations', 'approval_events', 'policy_versions', 'strategy_versions', 'investor_trial_intents', 'investor_trial_results')

    def sources():
        paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=root, text=True).splitlines()
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in paths if name.startswith(('web/src/', 'web/scripts/', 'web/tests/', 'scripts/', 'tests/investor/', 'migrations/', 'contracts/'))
            and (root / name).is_file() and (root / name).suffix in ('.ts', '.tsx', '.mjs', '.py', '.json', '.sql')}

    def snapshot():
        # Use the application's SQLite VFS for a cold WAL fixture, never immutable on a live DB.
        code = '''import Database from 'better-sqlite3';
const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});
try { const result=db.transaction(()=>({tables:Object.fromEntries(%s.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()])),
reservation:db.prepare('SELECT amount,quantity,status FROM reservations WHERE proposal_item_id=?').get(process.argv[2]),
links:db.prepare("SELECT count(*) n FROM audit_events WHERE action='execution_fact_link'").get().n,
reports:db.prepare('SELECT count(*) n FROM execution_reports').get().n})).deferred();console.log(JSON.stringify(result)); } finally { db.close(); }
''' % json.dumps(tables)
        return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', code, str(db_path), marker['proposal_item_id']], cwd=root / 'web', text=True, timeout=30))

    def records():
        return snapshot()['tables']

    def reservation():
        return snapshot()['reservation']

    protected = records(); source_before = sources()
    report = {'status': 'RUNNING', 'synthetic_fixture_only': True, 'headless': True, 'production_changed': False,
        'real_provider_called': False, 'real_ai_called': False, 'checks': [], 'source_sha256': source_before,
        'tls_scope': 'self_signed_loopback_only_not_public_certificate_verification'}
    errors, forbidden, upload_requests, link_requests = [], [], [], []
    lost = {'upload': False, 'link': False}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, ignore_https_errors=True)
        page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))

        def route_request(route):
            request = route.request; url = urlsplit(request.url)
            if url.scheme != 'https' or url.netloc != '127.0.0.1:3147':
                forbidden.append({'method': request.method, 'path': url.path}); route.abort(); return
            if request.method in ('GET', 'HEAD') or url.path in ('/api/auth/login', '/api/auth/logout'):
                route.continue_(); return
            if request.method == 'POST' and url.path == '/api/workbench/investor/execution-evidence':
                message = BytesParser(policy=policy.default).parsebytes(('Content-Type: ' + request.headers['content-type'] + '\r\n\r\n').encode() + request.post_data_buffer)
                parts = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True) for part in message.iter_parts()}
                upload_requests.append({name: hashlib.sha256(value).hexdigest() if name == 'file' else value.decode() for name, value in parts.items()})
                response = route.fetch(); assert response.status == 200
                if not lost['upload']:
                    lost['upload'] = True; route.abort('failed')
                else:
                    route.fulfill(response=response)
                return
            if request.method == 'POST' and url.path == '/api/workbench/investor':
                body = request.post_data_json
                if body.get('action') in ('link_recorded_execution_fact', 'record_linked_execution_report'):
                    if body['action'] == 'link_recorded_execution_fact':
                        link_requests.append(body)
                        if not lost['link']:
                            response = route.fetch(); assert response.status == 200
                            lost['link'] = True; route.abort('failed'); return
                    route.continue_(); return
            forbidden.append({'method': request.method, 'path': url.path}); route.abort()

        context.route('**/*', route_request)
        try:
            for _ in range(50):
                try:
                    if context.request.get(base + '/login').status == 200:
                        break
                except Exception:
                    pass
                time.sleep(0.1)
            else:
                raise RuntimeError('SYNTHETIC_SERVER_NOT_READY')
            for endpoint in ('execution-followup?account=' + marker['account_id'],):
                assert context.request.get(base + '/api/workbench/investor/' + endpoint).status == 401
            page.goto(base + '/workbench/accounts', wait_until='networkidle')
            page.locator('input[name="password"]').fill('SYNTHETIC-ETF-FIXTURE-ONLY-2026')
            page.get_by_role('button', name='登录', exact=True).click()
            page.wait_for_url(base + '/workbench'); page.goto(base + '/workbench/accounts', wait_until='networkidle')
            expect(page.get_by_role('heading', name='账户资料', exact=True)).to_be_visible()
            assert any(row['secure'] and row['httpOnly'] and row['sameSite'] == 'Strict' for row in context.cookies())
            panel = page.get_by_role('region', name='人工执行跟进', exact=True)
            expect(panel).to_be_visible(); panel.get_by_role('button', name='关联已入账成交', exact=True).click()
            expect(panel.get_by_role('combobox', name='对应的历史清单明细', exact=True)).to_have_value('')
            panel.get_by_role('combobox', name='对应的历史清单明细', exact=True).select_option(marker['proposal_item_id'])
            panel.get_by_role('combobox', name='已经入账的实际成交', exact=True).select_option(marker['event_id'])
            panel.get_by_role('combobox', name='独立原件（关联时重核字节和账户范围）', exact=True).select_option(marker['attachment_id'])
            expect(page.get_by_role('button', name='录入已发生成交', exact=True)).to_be_disabled()
            expect(page.get_by_role('button', name='核对账户资料', exact=True)).to_be_disabled()
            original_bytes = b'\xef\xbb\xbfsource,FICTIONAL\r\n1,NOT_REAL_BROKER_EVIDENCE\r\n'
            panel.get_by_label('存证另一份 UTF-8 CSV / JSON 原件（最多 4 MiB）', exact=True).set_input_files({'name': 'private-original.csv', 'mimeType': 'text/csv', 'buffer': original_bytes})
            panel.get_by_role('button', name='仅存证此原件，不导入事实', exact=True).click()
            expect(panel.get_by_role('button', name='核对并重试原件上传原请求', exact=True)).to_be_enabled()
            assert records() == protected and reservation()['quantity'] == '600'
            panel.get_by_role('button', name='核对并重试原件上传原请求', exact=True).click()
            expect(panel.get_by_role('button', name='仅存证此原件，不导入事实', exact=True)).to_be_visible()
            expect(panel.get_by_role('checkbox')).not_to_be_checked()
            assert len(upload_requests) == 2 and upload_requests[0] == upload_requests[1]
            assert upload_requests[0]['file'] == hashlib.sha256(original_bytes).hexdigest()
            uploaded_id = panel.get_by_role('combobox', name='独立原件（关联时重核字节和账户范围）', exact=True).input_value()
            assert uploaded_id != marker['attachment_id']
            panel.get_by_role('checkbox').check()
            page.screenshot(path=str(output / 'desktop-link-review.png'), full_page=True)
            panel.get_by_role('button', name='确认关联已入账成交', exact=True).click()
            expect(page.get_by_role('heading', name='这次提交仍待核对', exact=True)).to_be_visible()
            assert records() == protected and reservation() == {'amount': '40000', 'quantity': '400', 'status': 'active'}
            page.get_by_role('button', name='核对并重试原请求', exact=True).click()
            expect(page.get_by_role('heading', name='这次提交仍待核对', exact=True)).to_have_count(0)
            expect(panel.get_by_role('button', name='登记券商状态回报', exact=True)).to_be_enabled()
            assert len(link_requests) == 2 and link_requests[0] == link_requests[1]
            report['checks'].append('desktop real committed upload/link response loss, original immutable retries and exactly-once reservation consumption')
            panel.get_by_role('button', name='登记券商状态回报', exact=True).click()
            panel.get_by_role('combobox', name='对应的历史清单明细', exact=True).select_option(marker['proposal_item_id'])
            panel.get_by_role('combobox', name='独立原件（关联时重核字节和账户范围）', exact=True).select_option(uploaded_id)
            for label, value in (('原回报状态', 'filled'), ('原回报数量（不是新增成交数量）', '600'), ('来源标识', 'FICTIONAL-BROWSER'),
                    ('原回报唯一编号', 'report-1'), ('原回报说明', 'FICTIONAL STATUS ONLY, NOT AN EXECUTION FACT')):
                target = panel.get_by_role('combobox', name=label, exact=True) if label == '原回报状态' else panel.get_by_label(label, exact=True)
                target.select_option(value) if label == '原回报状态' else target.fill(value)
            panel.get_by_role('checkbox').check(); panel.get_by_role('button', name='仅保存券商状态回报', exact=True).click()
            expect(panel.get_by_role('button', name='核对执行记录', exact=True)).to_be_enabled()
            page.set_viewport_size({'width': 390, 'height': 1000}); page.reload(wait_until='networkidle')
            panel.get_by_role('button', name='核对执行记录', exact=True).click()
            panel.locator('summary').get_by_text('已登记的关联与回报（不是当前行动建议）', exact=True).click()
            expect(panel.get_by_text('非成交事实，不计持仓或收益。', exact=True)).to_be_visible()
            assert records() == protected and reservation()['quantity'] == '400'
            assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
            page.screenshot(path=str(output / 'mobile-history.png'), full_page=True)
            panel.get_by_role('button', name='关联已入账成交', exact=True).click()
            panel.get_by_role('combobox', name='对应的历史清单明细', exact=True).select_option(marker['proposal_item_id'])
            panel.get_by_role('combobox', name='已经入账的实际成交', exact=True).select_option(marker['event_id'])
            panel.get_by_role('combobox', name='独立原件（关联时重核字节和账户范围）', exact=True).select_option(uploaded_id)
            panel.get_by_role('checkbox').check(); panel.get_by_role('button', name='确认关联已入账成交', exact=True).click()
            expect(panel.get_by_role('button', name='核对执行记录', exact=True)).to_be_enabled()
            assert records() == protected and reservation()['quantity'] == '400'
            report['checks'].append('mobile persisted report/history, filled status never books a trade, duplicate association never consumes twice')
            final = snapshot(); assert final['links'] == 1 and final['reports'] == 1
            state = context.request.get(base + '/api/workbench/investor').json(); session_binding = state['session_binding']
            (directory / 'auth/RESTORE_PENDING_REVIEW').write_text('SYNTHETIC RECOVERY TEST ONLY\n')
            page.get_by_role('button', name='刷新状态', exact=True).click()
            expect(panel.get_by_role('button', name='关联已入账成交', exact=True)).to_be_disabled()
            assert context.request.post(base + '/api/workbench/investor', data=link_requests[0], headers={'Origin': base,
                'X-Workbench-Session-Binding': session_binding}).status == 423
            assert records() == protected
            report['checks'].append('recovery write barrier rejects even an already committed original request; financial rows remain unchanged')
            assert context.request.post(base + '/api/auth/logout', headers={'Origin': base}, max_redirects=0).status == 303
            assert context.request.get(base + '/api/workbench/investor').status == 401
            assert not errors and not forbidden and sources() == source_before
            report.update(status='PASS', page_error_count=0, forbidden_request_count=0, financial_rows_unchanged=True,
                remaining_reserved_quantity='400', old_link_count=1, source_unchanged=True)
        except Exception as error:
            report.update(status='FAIL', error_type=type(error).__name__, page_errors=errors, forbidden_requests=forbidden)
            (output / 'private-error.log').write_text(str(error))
            raise
        finally:
            (output / 'browser-result.json').write_text(json.dumps(report, indent=2) + '\n')
            context.close(); browser.close()
    print(json.dumps({name: value for name, value in report.items() if name != 'source_sha256'}))


if __name__ == '__main__':
    main()
