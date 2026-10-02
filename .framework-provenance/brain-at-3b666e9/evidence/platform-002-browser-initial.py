import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT=Path.cwd()
OUT=ROOT/'.local'/'platform-002-validation'
CHROME=Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
NODE=shutil.which('node.exe') or shutil.which('node')
result={'status':'NOT_RUN','assertions':[],'notes':[]}
safe_lines=[]
temp_root=Path(tempfile.mkdtemp(prefix='qb-platform-002-browser-'))
server=None
browser=None

def record(name):
    result['assertions'].append(name)

def fail(message):
    raise RuntimeError(message)

def read_server_ready(process, timeout=90):
    deadline=time.time()+timeout
    pairing=None
    while time.time()<deadline:
        line=process.stdout.readline()
        if not line:
            fail(f'Local server exited before startup: {process.poll()}')
        if 'Pairing code (local developer access):' in line:
            pairing=line.split(':',1)[1].strip()
            safe_lines.append('Pairing code: [redacted]')
            continue
        if line.startswith('{'):
            try: value=json.loads(line)
            except json.JSONDecodeError:
                safe_lines.append(line.rstrip())
                continue
            if value.get('type')=='QB_BROWSER_SERVER':
                safe_lines.append(json.dumps({'type':value['type'],'url':value['url']}))
                if not pairing: fail('Pairing code was not captured in memory before the startup marker')
                value['pairingCode']=pairing
                return value
        safe_lines.append(line.rstrip())
    fail('Local server startup exceeded its bounded wait')

try:
    if not NODE: fail('Node executable was not found on PATH')
    if not CHROME.is_file(): fail('The recorded installed Chrome executable is missing')
    server=subprocess.Popen([NODE,str(OUT/'browser-server.mjs'),str(temp_root)],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
    ready=read_server_ready(server)
    url=ready['url']; code=ready['pairingCode']
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=str(CHROME),args=[])
        page=browser.new_page()
        page.goto(url,wait_until='domcontentloaded',timeout=15000)
        expect(page.get_by_role('heading',name='Connect Studio')).to_be_visible(timeout=10000)
        record('initial login view')

        page.locator('#pairing-code').fill('known-bad-code-value')
        page.get_by_role('button',name='Connect local Studio').click()
        expect(page.get_by_role('alert')).to_contain_text('Invalid pairing code',timeout=10000)
        record('invalid pairing code shows bounded error')
        page.locator('#pairing-code').fill(code)
        page.get_by_role('button',name='Connect local Studio').click()
        expect(page.get_by_role('heading',name='Overview')).to_be_visible(timeout=10000)
        record('valid local pairing')

        page.locator('[data-route="products"]').click()
        expect(page.locator('#compose-form')).to_be_visible(timeout=10000)
        def compose_and_save(version):
            page.locator('#compose-form [name="id"]').fill('browser-proof')
            page.locator('#compose-form [name="title"]').fill('Browser Journey Proof')
            page.locator('#compose-form [name="version"]').fill(version)
            page.locator('#compose-form input[name="selected"][value="service-desk"]').check()
            page.get_by_role('button',name='Preview composition').click()
            expect(page.get_by_role('heading',name='Composition preview')).to_be_visible(timeout=10000)
            expect(page.locator('.result-card')).to_contain_text(f'@{version}')
            page.get_by_role('button',name='Save immutable version').click()
            expect(page.get_by_role('alert')).to_contain_text('Product version saved.',timeout=10000)
            expect(page.locator('tbody tr').filter(has_text='browser-proof').filter(has_text=version)).to_have_count(1,timeout=10000)
        compose_and_save('1.0.0')
        compose_and_save('2.0.0')
        expect(page.locator('tbody tr').filter(has_text='browser-proof')).to_have_count(2,timeout=10000)
        record('two immutable product versions saved through canonical preview')

        page.locator('[data-route="builds"]').click()
        build_v2=page.locator('[data-request-build="browser-proof"][data-version="2.0.0"]')
        expect(build_v2).to_have_count(1,timeout=10000)
        v1_card=page.locator('.build-request-card').filter(has_text='browser-proof@1.0.0')
        v2_card=build_v2.locator('xpath=ancestor::article[1]')
        expect(v1_card.locator('[data-build-confirm]')).not_to_be_checked()
        v2_card.locator('[data-build-confirm]').check()
        build_v2.click()
        expect(page.get_by_role('alert')).to_contain_text('Build request admitted.',timeout=15000)
        accepted_card=page.locator('.build-card').filter(has_text='browser-proof@2.0.0')
        expect(accepted_card).to_be_visible(timeout=10000)
        record('exact version 2 build confirmation and durable admission')

        page.locator('[data-logout]').click()
        expect(page.get_by_role('heading',name='Connect Studio')).to_be_visible(timeout=10000)
        record('logout after admission')
        page.locator('#pairing-code').fill(code)
        page.get_by_role('button',name='Connect local Studio').click()
        expect(page.get_by_role('heading',name='Builds')).to_be_visible(timeout=10000)
        accepted_card=page.locator('.build-card').filter(has_text='browser-proof@2.0.0')
        expect(accepted_card.locator('.status')).to_have_text('SUCCEEDED',timeout=120000)
        record('accepted build continues after logout and succeeds')
        accepted_card.locator('[data-result]').click()
        expect(accepted_card.locator('.detail')).to_contain_text('VERIFIED LOCAL EXPORT',timeout=20000)
        record('browser inspects verified export')

        build_v1=page.locator('[data-request-build="browser-proof"][data-version="1.0.0"]')
        v1_card=build_v1.locator('xpath=ancestor::article[1]')
        v1_card.locator('[data-build-confirm]').check()
        build_v1.click()
        expect(page.get_by_role('alert')).to_contain_text('Build request admitted.',timeout=15000)
        cancel_card=page.locator('.build-card').filter(has_text='browser-proof@1.0.0')
        cancel=cancel_card.locator('[data-cancel]')
        expect(cancel).to_be_visible(timeout=15000)
        cancel.click()
        expect(cancel_card.locator('.status')).to_have_text('CANCELLED',timeout=30000)
        record('browser requests and observes cancellation')

        page.locator('[data-route="operations"]').click()
        expect(page.get_by_text('not-attached',exact=True)).to_have_count(2,timeout=10000)
        expect(page.locator('body')).to_contain_text('deployment-controller')
        expect(page.locator('body')).to_contain_text('model-serving')
        record('operations labels deployment and model-serving unattached')

        page.locator('[data-logout]').click()
        expect(page.get_by_role('heading',name='Connect Studio')).to_be_visible(timeout=10000)
        record('logout returns to pairing view')
        result['status']='PASS'
except Exception as error:
    message=str(error)
    if any(marker in message.lower() for marker in ['navigation blocked','net::err','access denied','not allowed by policy','navigation policy']):
        result['status']='BLOCKED'
    else:
        result['status']='FAIL'
    result['error']=message[:1200]
finally:
    if browser:
        try: browser.close()
        except Exception: pass
    if server and server.poll() is None:
        try:
            server.stdin.write('\n');server.stdin.flush();server.wait(timeout=20)
        except Exception:
            server.terminate()
            try: server.wait(timeout=5)
            except Exception: server.kill()
    if server and server.stdout:
        for line in server.stdout:
            if 'Pairing code (local developer access):' in line:
                safe_lines.append('Pairing code: [redacted]')
            else:
                safe_lines.append(line.rstrip())
    try:
        shutil.rmtree(temp_root)
    except Exception as error:
        result['cleanupError']=str(error)[:500]
    result['serverExit']=server.returncode if server else None
    (OUT/'browser-console-platform-002.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
    (OUT/'browser-console-platform-002.log').write_text('\n'.join(safe_lines)+'\n',encoding='utf8')
print(json.dumps(result,indent=2))
sys.exit(0 if result['status']=='PASS' else 1)
