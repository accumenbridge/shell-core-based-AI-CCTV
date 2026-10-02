"""Verify the exact offline atlas through ordinary local Chromium navigation."""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
import hashlib, json, re, sys, threading

html_path=Path(sys.argv[1]).resolve()
focus_node=sys.argv[3] if len(sys.argv)>3 else 'M-05'
out=Path(sys.argv[2]).resolve(); out.mkdir(parents=True,exist_ok=True)
data=html_path.read_bytes()
assert not re.search(rb'<script\b',data,re.I), 'Generated artifact contains a script'
security_prefix='http://gc.kis.v2.scr.kaspersky-labs.com/'
report={'schema':'brain.atlas-browser-check.v1','startedAt':datetime.now(timezone.utc).isoformat(),
        'htmlPath':str(html_path),'htmlSha256':hashlib.sha256(data).hexdigest(),
        'status':'NOT_RUN','checks':[],'screenshots':[],'limitations':[
            'Only the read-only atlas page is covered; no platform runtime, provider, full UX design or production qualification.',
            'The Codex browser connector failed before initialization (missing kernel assets); ordinary repository Playwright/Chrome is used without a policy bypass.']}
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0]!='/atlas':
            self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def log_message(self,*args):pass
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
browser=None
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
        page=browser.new_page(viewport={'width':1440,'height':1000})
        errors=[];requests=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('request',lambda request:requests.append(request.url))
        url=f'http://127.0.0.1:{server.server_port}/atlas'
        report['stage']='ordinary-navigation'
        response=page.goto(url,wait_until='networkidle',timeout=15000)
        report['navigation']={'status':response.status,'title':page.title(),'url':page.url,'scriptCount':page.locator('script').count()}
        report['browserScripts']=page.locator('script').evaluate_all('(items)=>items.map(e=>({type:e.type,id:e.id,src:e.src,text:e.textContent.slice(0,1200)}))')
        report['responseSha256']=hashlib.sha256(response.body()).hexdigest()
        injected=report['browserScripts']
        assert all(s['src'].startswith(security_prefix) and not s['text'] for s in injected), 'Unidentified browser script; qualification stopped'
        if injected:
            report['limitations'].append('Installed Kaspersky injects its own external script into the browser response. It is absent from the exact generated artifact; no antivirus, CSP or browser policy was changed.')
        assert response.status==200, f'Navigation returned HTTP {response.status}'
        report['checks'].append({'name':'generated artifact has zero scripts; browser injection identified separately','result':'PASSED','injectedScriptCount':len(injected)})
        report['stage']='anchor-integrity'
        checks=page.evaluate('''() => {
          const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);
          const links=[...document.querySelectorAll('a[href^="#"]')].map(e=>e.getAttribute('href').slice(1));
          return {ids:ids.length,uniqueIds:new Set(ids).size,links:links.length,
            missing:links.filter(id=>!document.getElementById(id))};
        }''')
        assert checks['ids']==checks['uniqueIds'] and not checks['missing'],checks
        report['checks'].append({'name':'unique anchors and all internal links','result':'PASSED',**checks})
        assert 'Planning focus' in page.locator('body').inner_text()
        assert focus_node in page.locator('#planning-focus').inner_text()
        for width,height in [(1440,1000),(390,844),(320,844)]:
            page.set_viewport_size({'width':width,'height':height})
            page.goto(url,wait_until='networkidle')
            dimensions=page.evaluate('({scroll:document.documentElement.scrollWidth,viewport:innerWidth})')
            assert dimensions['scroll']<=dimensions['viewport']+1,dimensions
            screenshot=out/f'atlas-{width}.png';page.screenshot(path=str(screenshot))
            report['screenshots'].append({'path':str(screenshot),'sha256':hashlib.sha256(screenshot.read_bytes()).hexdigest(),'width':width,'height':height})
            page.locator(f'a[href="#node-{focus_node}"]').first.click()
            assert page.evaluate('location.hash')=='#node-'+focus_node
            assert page.locator('#node-'+focus_node).evaluate('(e)=>Math.abs(e.getBoundingClientRect().top)<250')
            report['checks'].append({'name':f'{width}px layout and focus-node navigation','result':'PASSED',**dimensions})
            if width in (1440,390):
                for section in ('planning-focus','map'):
                    page.locator('#'+section).scroll_into_view_if_needed()
                    page.evaluate('(id)=>document.getElementById(id).scrollIntoView({block:"start"})',section)
                    screenshot=out/f'atlas-{width}-{section}.png';page.screenshot(path=str(screenshot))
                    report['screenshots'].append({'path':str(screenshot),'sha256':hashlib.sha256(screenshot.read_bytes()).hexdigest(),'width':width,'height':height,'section':section})
        page.goto(url,wait_until='networkidle')
        page.keyboard.press('Tab')
        href=page.evaluate('document.activeElement.getAttribute("href")')
        assert href and href.startswith('#'),href
        page.keyboard.press('Enter')
        assert page.evaluate('location.hash')==href
        report['checks'].append({'name':'keyboard first-link navigation','result':'PASSED','target':href})
        assert not errors,errors
        external=[request for request in requests if not request.startswith(url)]
        assert all(request.startswith(security_prefix) for request in external),external
        report['environmentRequests']=external
        report['checks'].append({'name':'no page script errors or unidentified external resource requests','result':'PASSED'})
        report['browserVersion']=browser.version
        report['status']='PASSED_WITH_ENVIRONMENT_INJECTION' if injected else 'PASSED'
        browser.close();browser=None
except Exception as error:
    report['status']='BLOCKED_BY_POLICY' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(error) else 'FAILED_OR_UNAVAILABLE'
    report['error']=type(error).__name__+': '+str(error)[:1500]
    if 'page' in locals():
        try:
            report['failureBody']=page.locator('body').inner_text(timeout=3000)[:1500]
            page.screenshot(path=str(out/'failure.png'))
            if 'blocked' in report['failureBody'].lower() and ('administrator' in report['failureBody'].lower() or 'policy' in report['failureBody'].lower()):
                report['status']='BLOCKED_BY_POLICY'
        except Exception as capture_error:report['captureError']=str(capture_error)[:300]
finally:
    if browser:
        try:browser.close()
        except Exception:pass
    server.shutdown();server.server_close()
    report['finishedAt']=datetime.now(timezone.utc).isoformat()
    (out/'result.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,indent=2))
sys.exit(0 if report['status'].startswith('PASSED') else 1)
