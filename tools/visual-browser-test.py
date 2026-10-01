from pathlib import Path
import json
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
report={'scope':'Standalone HTML preview with in-memory sample data, not backend or React integration','checks':[]}
try:
 with sync_playwright() as p:
  import os, shutil
  launch={'headless':True}
  executable=os.environ.get('QB_CHROMIUM') or shutil.which('chromium')
  if executable: launch['executable_path']=executable
  browser=p.chromium.launch(**launch)
  page=browser.new_page(viewport={'width':1440,'height':1080},device_scale_factor=1)
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto((root/'OPEN_PLATFORM.html').as_uri(),wait_until='load',timeout=15000)
  page.screenshot(path=str(root/'evidence/visual/01-overview.png'),full_page=True)
  report['checks'].append('Standalone opening page rendered')
  page.get_by_role('button',name='Product composer',exact=True).click()
  page.screenshot(path=str(root/'evidence/visual/02-composer.png'),full_page=True)
  page.get_by_label('Product name',exact=True).fill('Facility Operations')
  page.get_by_label('Product ID',exact=True).fill('facility')
  page.locator('[data-module="handoff"]').check()
  with page.expect_download() as dl:
   page.get_by_role('button',name='Export product.json',exact=True).click()
  path=dl.value.path()
  product=json.loads(Path(path).read_text())
  assert product['id']=='facility' and len(product['modules'])==3 and len(product['bindings'])==2
  report['checks'].append('Composer exports the selected local product definition')
  page.get_by_role('button',name='Service Desk',exact=True).click()
  page.get_by_role('button',name='New sample request',exact=True).click()
  page.get_by_label('Title',exact=True).fill('Preview regression request')
  page.get_by_label('Details',exact=True).fill('This stays only in preview memory.')
  page.get_by_role('button',name='Create sample request',exact=True).click()
  assert page.get_by_text('Preview regression request',exact=True).count()==1
  page.screenshot(path=str(root/'evidence/visual/03-service-desk.png'),full_page=True)
  report['checks'].append('Sample request form updates only the preview')
  page.get_by_role('button',name='Knowledge',exact=True).click()
  page.get_by_label('Search sample documents',exact=True).fill('onboarding')
  assert page.locator('.doc-card').count()==1
  page.get_by_label('Search sample documents',exact=True).fill('')
  page.screenshot(path=str(root/'evidence/visual/04-knowledge.png'),full_page=True)
  report['checks'].append('Sample document search filters visible cards')
  page.get_by_role('button',name='Cross-product',exact=True).click()
  page.get_by_role('button',name='Create sample handoff',exact=True).click()
  page.get_by_role('button',name='Simulate a lost reply',exact=True).click()
  assert page.get_by_text('Unknown',exact=True).count()==1
  page.get_by_role('button',name='Check original receipt',exact=True).click()
  assert page.get_by_text('Committed',exact=True).count()==1
  page.screenshot(path=str(root/'evidence/visual/05-handoff.png'),full_page=True)
  report['checks'].append('Simulated unknown acceptance reconciles without resending')
  page.get_by_role('button',name='Architecture',exact=True).click()
  page.locator('[data-action="node:worker-host"]').click()
  assert page.locator('.inspector h3').inner_text()=='Worker host'
  page.screenshot(path=str(root/'evidence/visual/06-architecture.png'),full_page=True)
  report['checks'].append('Architecture components open their source responsibilities')
  for width in [390,768,1280]:
   page.set_viewport_size({'width':width,'height':900})
   for name in ['overview','composer','modules','desk','knowledge','handoff','architecture']:
    page.goto((root/'OPEN_PLATFORM.html').as_uri()+'#/'+name,wait_until='load')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'),(width,name)
   report['checks'].append(f'All seven views fit {width}px without page overflow')
  page.set_viewport_size({'width':390,'height':844})
  page.goto((root/'OPEN_PLATFORM.html').as_uri(),wait_until='load')
  page.screenshot(path=str(root/'evidence/visual/07-mobile.png'),full_page=True)
  assert not errors, errors
  report['errors']=errors
  report['status']='PASSED'
  browser.close()
except Exception as e:
 report['status']='BLOCKED_BY_ENVIRONMENT' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(e) else 'FAILED'
 report['error']=str(e)
(root/'evidence/visual-preview.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
