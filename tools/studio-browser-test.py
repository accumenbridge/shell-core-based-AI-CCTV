"""Normal Chromium acceptance for the paired local Studio; never bypasses navigation policy.
Uses a temporary source copy. No existing products/data are modified. Secrets stay in temp files.
"""
from pathlib import Path
import json, os, re, shutil, signal, subprocess, tempfile, time
from datetime import datetime, timezone
from urllib.request import urlopen
ROOT=Path(__file__).resolve().parents[1]
report={'at':datetime.now(timezone.utc).isoformat(),'status':'NOT_RUN','checks':[],
        'scope':'Real local Studio and browser, generated fixture module/product; not production or React'}
process=None; log=None; temp=Path(tempfile.mkdtemp(prefix='qb-studio-browser-'))
try:
 from playwright.sync_api import sync_playwright, expect
 source=temp/'source'
 shutil.copytree(ROOT,source,ignore=shutil.ignore_patterns('node_modules','.local','evidence','reference','__pycache__'))
 (source/'node_modules'/'@types').mkdir(parents=True)
 for name in ['typescript','@types/node','undici-types']:
  target=ROOT/'node_modules'/name
  if not target.exists(): raise RuntimeError('Install the pinned development tools before the generated-module browser test')
  os.symlink(target,source/'node_modules'/name,target_is_directory=True)
 for args in [['node','tools/link-workspaces.mjs'],['node','tools/factory.mjs','create-module','field-notes']]:
  subprocess.run(args,cwd=source,check=True,capture_output=True,timeout=20)
 log=open(temp/'private-launch.log','wb')
 flags={'creationflags':subprocess.CREATE_NEW_PROCESS_GROUP} if os.name=='nt' else {'start_new_session':True}
 process=subprocess.Popen(['node','tools/studio.mjs','--port','0'],cwd=source,stdout=log,stderr=subprocess.STDOUT,**flags)
 deadline=time.monotonic()+20
 while time.monotonic()<deadline:
  text=(temp/'private-launch.log').read_text(errors='replace')
  url=re.search(r'http://127\.0\.0\.1:\d+',text); code=re.search(r'Pairing code \(local developer access\): (\S+)',text)
  if url and code: break
  if process.poll() is not None: raise RuntimeError('Studio exited before startup')
  time.sleep(.1)
 else: raise TimeoutError('Studio did not print its local address')
 with urlopen(url.group(0),timeout=5) as r: assert r.status==200
 report['actualStudioHttpReadiness']='PASSED'
 with sync_playwright() as p:
  opts={'headless':True}
  executable=os.environ.get('QB_CHROMIUM') or shutil.which('chromium')
  if executable:opts['executable_path']=executable
  browser=p.chromium.launch(**opts)
  try:
   page=browser.new_page(viewport={'width':1440,'height':1000})
   page.goto(url.group(0),wait_until='networkidle',timeout=15000)
   page.locator('[data-action="run"]').click()
   page.get_by_label('Terminal pairing code',exact=True).fill(code.group(1))
   page.get_by_role('button',name='Pair this browser',exact=True).click()
   expect(page.get_by_text('LOCAL STUDIO · PAIRED',exact=True)).to_be_visible()
   report['checks'].append('Browser paired to the actual local operator')
   page.get_by_role('button',name='Module library',exact=True).click()
   expect(page.get_by_role('heading',name='Field Notes',exact=True)).to_be_visible()
   report['checks'].append('New source module discovered without editing the Studio')
   page.get_by_role('button',name='Product composer',exact=True).click()
   page.get_by_label('Product name',exact=True).fill('Browser-built application')
   page.get_by_label('Product ID',exact=True).fill('browser-facility')
   page.locator('[data-module="field-notes"]').check();page.locator('[data-module="handoff"]').check()
   page.get_by_role('button',name='Save to local source',exact=True).click()
   page.get_by_role('button',name='Create local source',exact=True).click()
   expect(page.get_by_role('heading',name='Build it. Run it. Verify the result.',exact=True)).to_be_visible()
   page.get_by_role('button',name='Compile & build',exact=True).click();page.get_by_role('button',name='Confirm',exact=True).click()
   expect(page.locator('.state-item').filter(has_text='Source build').locator('strong')).to_have_text('BUILT',timeout=120000)
   report['checks'].append('Actual source write, compile and immutable export completed')
   page.get_by_role('button',name='Start compiled app',exact=True).click();page.get_by_role('button',name='Confirm',exact=True).click()
   expect(page.get_by_role('link',name='Open actual application')).to_be_visible(timeout=25000)
   report['checks'].append('Managed compiled API instance became ready')
   (ROOT/'evidence/studio').mkdir(parents=True,exist_ok=True)
   page.screenshot(path=str(ROOT/'evidence/studio/build-and-run.png'),full_page=True)
   page.set_viewport_size({'width':390,'height':844})
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
   report['checks'].append('Build view fits a 390px viewport')
   # API and worker workflow is separately exercised by the complete Node integration suite.
   report['status']='PASSED_FOR_STUDIO_BROWSER_SCOPE'
  finally:browser.close()
except Exception as e:
 report['status']='BLOCKED_BY_ENVIRONMENT' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(e) else 'FAILED_OR_UNAVAILABLE'
 report['reason']='Chromium refused ordinary local navigation; no alternate transport or policy bypass attempted.' if report['status']=='BLOCKED_BY_ENVIRONMENT' else str(e)[:1000]
finally:
 if process and process.poll() is None:
  try:
   if os.name=='nt':subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],capture_output=True)
   else:os.killpg(process.pid,signal.SIGTERM)
   process.wait(timeout=8)
  except (ProcessLookupError,subprocess.TimeoutExpired):
   if os.name!='nt':
    try:os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError:pass
 if log:log.close()
 shutil.rmtree(temp,ignore_errors=True)
 (ROOT/'evidence').mkdir(exist_ok=True)
 (ROOT/'evidence/studio-browser.json').write_text(json.dumps(report,indent=2)+'\n')
 print(json.dumps(report,indent=2))
raise SystemExit(0 if report['status']=='PASSED_FOR_STUDIO_BROWSER_SCOPE' else 2)
