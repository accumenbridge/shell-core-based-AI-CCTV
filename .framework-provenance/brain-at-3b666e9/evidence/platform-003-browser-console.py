import json
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from urllib.parse import urljoin

from playwright.sync_api import expect, sync_playwright

ROOT=Path.cwd()
OUT=ROOT/'.local'/'platform-003-validation'
CHROME=Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
NODE=shutil.which('node.exe') or shutil.which('node')
result={'status':'NOT_RUN','assertions':[],'blockedGates':[{
    'gate':'controlled delayed CSP/session-race instrumentation','status':'BLOCKED_CSP',
    'detail':'This ordinary browser journey does not use evaluation, injected scripts, or request interception. The separate controlled-delay gate remains blocked by page CSP.'
}]}
safe_lines=[]
server_lines=queue.Queue()
temp_root=Path(tempfile.mkdtemp(prefix='q3c-'))
server=None
browser=None
safe_to_remove=False

def record(name):
    result['assertions'].append(name)

def fail(message):
    raise RuntimeError(message)

def read_ready(process,timeout=90):
    deadline=time.time()+timeout
    pairing=None
    while time.time()<deadline:
        try: line=server_lines.get(timeout=max(0.01,deadline-time.time()))
        except queue.Empty: fail('Local server startup exceeded its bounded wait')
        if line is None:
            fail(f'Local server exited before startup: {process.poll()}')
        if 'Pairing code (local developer access):' in line:
            pairing=line.split(':',1)[1].strip()
            safe_lines.append('Pairing code: [redacted]')
            continue
        if line.startswith('{'):
            try: value=json.loads(line)
            except json.JSONDecodeError:
                safe_lines.append('[non-JSON server startup output]')
                continue
            if value.get('type')=='QB_CP3_BROWSER_SERVER':
                if not pairing: fail('Pairing code was not captured in memory before the startup marker')
                safe_lines.append(json.dumps({key:value.get(key) for key in ('type','url','sourceFingerprint','maintainedFingerprint','nodeVersion','hostIdentity')}))
                value['pairingCode']=pairing
                return value
        safe_lines.append(line.rstrip())
    fail('Local server startup exceeded its bounded wait')

def pair(page,code,heading='Overview'):
    submit=page.get_by_role('button',name='Connect local Studio')
    expect(submit).to_be_enabled(timeout=10000)
    page.locator('#pairing-code').fill(code)
    submit.click()
    expect(page.locator('[data-logout]')).to_be_visible(timeout=15000)
    if heading:
        expect(page.get_by_role('heading',name=heading)).to_be_visible(timeout=15000)

try:
    if not NODE: fail('Node executable was not found on PATH')
    if not CHROME.is_file(): fail('The recorded installed Chrome executable is missing')
    server=subprocess.Popen([NODE,str(OUT/'browser-server.mjs'),str(temp_root/'checkout')],cwd=ROOT,
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
    def capture_server_output():
        for line in server.stdout:
            server_lines.put(line)
        server_lines.put(None)
    threading.Thread(target=capture_server_output,name='owned-browser-server-output',daemon=True).start()
    ready=read_ready(server)
    result['fixture']={key:ready[key] for key in ('sourceFingerprint','maintainedFingerprint','nodeVersion','hostIdentity')}
    url=ready['url']; code=ready['pairingCode']; target_root=temp_root/'checkout'

    with sync_playwright() as playwright:
        browser=playwright.chromium.launch(headless=True,executable_path=str(CHROME),args=[])
        page=browser.new_page()
        page.goto(url,wait_until='domcontentloaded',timeout=20000)
        expect(page.get_by_role('heading',name='Connect Studio')).to_be_visible(timeout=15000)
        record('initial pairing view')
        page.locator('#pairing-code').fill('known-bad-code-value')
        page.get_by_role('button',name='Connect local Studio').click()
        expect(page.get_by_role('alert')).to_contain_text('Invalid pairing code',timeout=10000)
        record('invalid local pairing displays an error')
        pair(page,code)
        record('valid pairing opens the operator console')

        page.locator('[data-route="products"]').click()
        expect(page.locator('#compose-form')).to_be_visible(timeout=15000)
        module=page.locator('#compose-form input[name="selected"][value="service-desk"]')
        expect(module).to_be_visible(timeout=15000)
        for version in ('1.0.0','2.0.0'):
            page.locator('#compose-form [name="id"]').fill('browser-registry-proof')
            page.locator('#compose-form [name="title"]').fill('Browser Registry Proof')
            page.locator('#compose-form [name="version"]').fill(version)
            module.check()
            page.get_by_role('button',name='Preview composition').click()
            expect(page.get_by_role('heading',name='Composition preview')).to_be_visible(timeout=15000)
            expect(page.locator('.result-card')).to_contain_text(f'@{version}')
            page.get_by_role('button',name='Save immutable version').click()
            expect(page.get_by_role('alert')).to_contain_text('Product version saved.',timeout=15000)
        record('canonical preview saved two immutable product versions')

        page.locator('[data-route="builds"]').click()
        request_card=page.locator('.build-request-card').filter(has_text='browser-registry-proof@2.0.0')
        expect(request_card).to_have_count(1,timeout=15000)
        request_card.locator('[data-build-confirm]').check()
        request_card.locator('[data-request-build]').click()
        expect(page.get_by_role('alert')).to_contain_text('Build request admitted.',timeout=15000)
        build_card=page.locator('.build-card').filter(has_text='browser-registry-proof@2.0.0').last
        expect(build_card.locator('.status')).to_have_text('SUCCEEDED',timeout=180000)
        muted=build_card.locator('.muted').first.inner_text()
        build_match=re.search(r'([0-9a-f]{8}-[0-9a-f-]{27,})',muted,re.I)
        if not build_match: fail('The successful build card did not expose its local build reference')
        build_id=build_match.group(1)
        build_card.locator('[data-result]').click()
        expect(build_card.locator('.detail')).to_contain_text('VERIFIED LOCAL EXPORT',timeout=30000)
        record('successful browser-requested build exposes verified local export')

        page.locator('[data-route="artifacts"]').click()
        register_card=page.locator('.artifact-card').filter(has_text=f'Successful build {build_id}')
        expect(register_card).to_have_count(1,timeout=20000)
        register_card.locator('[data-register-confirm]').check()
        register_card.locator('[data-register-artifact]').click()
        expect(page.get_by_role('alert')).to_contain_text('The verified snapshot is registered locally.',timeout=60000)
        artifact_card=page.locator('.artifact-card').filter(has_text='browser-registry-proof@2.0.0')
        expect(artifact_card).to_have_count(1,timeout=20000)
        digest_match=re.search(r'Snapshot ([a-f0-9]{64})',artifact_card.inner_text())
        if not digest_match: fail('The registered artifact card did not expose its immutable digest')
        digest=digest_match.group(1)
        record('exact successful snapshot digest registered from the console')

        artifact_card.locator('[data-inspect-artifact]').click()
        expect(page.get_by_role('heading',name='Verified inventory: browser-registry-proof@2.0.0')).to_be_visible(timeout=30000)
        readme_row=page.locator('tr').filter(has_text='README.md')
        expect(readme_row).to_have_count(1)
        entry_response_fragment=f'/platform-api/artifacts/{digest}/entries/'
        download_url=urljoin(url,readme_row.locator('a.artifact-download').get_attribute('href'))
        with page.expect_download(timeout=20000) as download_info:
            readme_row.locator('a.artifact-download').click()
        download=download_info.value
        download_bytes=Path(download.path()).read_bytes()
        connection=sqlite3.connect(target_root/'.local'/'control-plane.sqlite')
        try:
            snapshot_ref=connection.execute('SELECT snapshot_ref FROM builds WHERE id=?',(build_id,)).fetchone()[0]
        finally:
            connection.close()
        source_readme=(target_root/'.local'/'platform-builds'/snapshot_ref/'README.md').read_bytes()
        if download_bytes!=source_readme: fail('The browser attachment bytes differ from the verified build snapshot')
        entry_response=page.request.get(download_url,timeout=20000)
        if entry_response.status!=200: fail('The browser did not observe a successful opaque entry response')
        if entry_response.body()!=source_readme: fail('The same-origin entry response differs from the verified build snapshot')
        headers={key.lower():value for key,value in entry_response.headers.items()}
        if 'attachment' not in headers.get('content-disposition','').lower(): fail('Verified artifact response was not an attachment')
        if 'application/octet-stream' not in headers.get('content-type','').lower(): fail('Verified artifact response did not use an opaque binary media type')
        if headers.get('x-content-type-options','').lower()!='nosniff': fail('Verified artifact response omitted nosniff')
        record('browser inventory download preserved exact bytes; same-origin entry probe confirmed safe headers')

        artifact_card=page.locator('.artifact-card').filter(has_text='browser-registry-proof@2.0.0')
        artifact_card.locator('[data-promote-confirm]').check()
        artifact_card.locator('[data-promote-artifact]').click()
        expect(page.get_by_role('alert')).to_contain_text('The immutable local release is promoted.',timeout=30000)
        release_rows=page.get_by_role('heading',name='Promoted local releases').locator('xpath=ancestor::section[1]').locator('tbody tr')
        release_rows=release_rows.filter(has_text='browser-registry-proof').filter(has_text='2.0.0')
        expect(release_rows).to_have_count(1,timeout=15000)
        record('operator explicitly promoted this exact product version and artifact')

        page.locator('[data-logout]').click()
        expect(page.get_by_role('heading',name='Connect Studio')).to_be_visible(timeout=15000)
        pair(page,code,None)
        page.locator('[data-route="artifacts"]').click()
        expect(page.get_by_role('heading',name='Artifacts',exact=True)).to_be_visible(timeout=15000)
        artifact_card=page.locator('.artifact-card').filter(has_text='browser-registry-proof@2.0.0')
        expect(artifact_card).to_be_visible(timeout=20000)
        release_rows=page.get_by_role('heading',name='Promoted local releases').locator('xpath=ancestor::section[1]').locator('tbody tr')
        expect(release_rows.filter(has_text='browser-registry-proof').filter(has_text='2.0.0')).to_have_count(1)
        artifact_card.locator('[data-promote-confirm]').check()
        artifact_card.locator('[data-promote-artifact]').click()
        expect(page.get_by_role('alert')).to_contain_text('The immutable local release is promoted.',timeout=30000)
        release_rows=page.get_by_role('heading',name='Promoted local releases').locator('xpath=ancestor::section[1]').locator('tbody tr')
        expect(release_rows.filter(has_text='browser-registry-proof').filter(has_text='2.0.0')).to_have_count(1)
        record('registered artifact and immutable release persist after logout and repeated promotion')
        page.locator('[data-logout]').click()
        expect(page.get_by_role('heading',name='Connect Studio')).to_be_visible(timeout=15000)
        record('final logout returns to local pairing view')
        browser.close()
        browser=None
        result['status']='PASS_ORDINARY_BROWSER_JOURNEY'
except Exception as error:
    # Exiting Playwright's context has already closed the browser when control reaches here.
    browser=None
    message=str(error)
    if any(marker in message.lower() for marker in ('navigation blocked','net::err','access denied','not allowed by policy','navigation policy')):
        result['status']='BLOCKED'
    else:
        result['status']='FAIL'
    result['error']=message[:1200]
    result['trace']=traceback.format_exc()[-2200:]
finally:
    if server and server.poll() is None:
        try:
            try:
                server.stdin.write('\n');server.stdin.flush()
            finally:
                server.stdin.close()
            server.wait(timeout=45)
            safe_to_remove=server.returncode==0
        except Exception as error:
            result['serverCloseError']=str(error)[:500]
    elif server:
        safe_to_remove=server.returncode==0
    if server and server.poll() is not None:
        while True:
            try: line=server_lines.get_nowait()
            except queue.Empty: break
            if line is None: break
            if 'Pairing code (local developer access):' in line:
                safe_lines.append('Pairing code: [redacted]')
            else:
                safe_lines.append(line.rstrip())
    if safe_to_remove:
        database=temp_root/'checkout'/'.local'/'control-plane.sqlite'
        if database.is_file():
            if result['status']=='PASS_ORDINARY_BROWSER_JOURNEY':
              try:
                connection=sqlite3.connect(database)
                try:
                    versions=connection.execute('SELECT version FROM product_versions WHERE id=? ORDER BY created,rowid',('browser-registry-proof',)).fetchall()
                    artifacts=connection.execute('SELECT digest FROM artifacts WHERE product_id=? AND version=?',('browser-registry-proof','2.0.0')).fetchall()
                    releases=connection.execute('SELECT artifact_digest FROM artifact_releases WHERE product_id=? AND version=?',('browser-registry-proof','2.0.0')).fetchall()
                    registered_audits=connection.execute("SELECT COUNT(*) FROM audit WHERE action='artifact.registered' AND subject=?",(artifacts[0][0],)).fetchone()[0] if artifacts else 0
                    promoted_audits=connection.execute("SELECT COUNT(*) FROM audit WHERE action='artifact.release.promoted' AND subject=?",('browser-registry-proof@2.0.0',)).fetchone()[0]
                finally:
                    connection.close()
                if {row[0] for row in versions}!={'1.0.0','2.0.0'}: raise RuntimeError('The reopened database did not preserve both saved product versions')
                if len(artifacts)!=1 or len(releases)!=1 or artifacts[0][0]!=releases[0][0]: raise RuntimeError('Artifact registration and release promotion are not durably bound to the same digest')
                if registered_audits!=1 or promoted_audits!=1: raise RuntimeError('The durable audit did not record exactly one registration and one promotion')
                record('reopened SQLite state binds the registered artifact, exact release and audit rows')
              except Exception as error:
                result['status']='FAIL';result['error']=f'Durable browser journey check failed: {error}'
        else:
            if result['status']=='PASS_ORDINARY_BROWSER_JOURNEY':
                result['status']='FAIL';result['error']='The browser fixture database is absent after owned server shutdown'
        try:
            shutil.rmtree(temp_root)
        except Exception as error:
            result['status']='FAIL';result['cleanupError']=str(error)[:500]
    else:
        result['retainedFixture']=str(temp_root)
        if result['status']=='PASS_ORDINARY_BROWSER_JOURNEY':
            result['status']='FAIL';result['error']='Owned local server shutdown was not positively observed; fixture retained'
    result['serverExit']=server.returncode if server else None
    result['serverClosedObserved']=safe_to_remove
    (OUT/'browser-final.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
    (OUT/'browser-final.log').write_text('\n'.join(safe_lines)+'\n',encoding='utf8')
print(json.dumps(result,indent=2))
sys.exit(0 if result['status']=='PASS_ORDINARY_BROWSER_JOURNEY' else 1)
