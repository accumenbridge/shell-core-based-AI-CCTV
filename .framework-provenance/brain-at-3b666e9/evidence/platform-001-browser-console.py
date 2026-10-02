from __future__ import annotations
import json, os, queue, re, shutil, subprocess, tempfile, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
out_path = root / '.local' / 'platform-001-validation' / 'browser-console.json'
chrome = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
result = {"status": "FAILED", "checks": {}, "browser": str(chrome)}
proc = None
browser = None
pairing_code = None
lines: queue.Queue[str] = queue.Queue()
reader = None

try:
    if not chrome.is_file():
        result = {"status": "BLOCKED_PREREQUISITE_MISSING", "reason": "Installed Chrome executable not found"}
    else:
        with tempfile.TemporaryDirectory(prefix='qb-platform-001-browser-') as temp:
            env = os.environ.copy()
            env['QB_CONTROL_PLANE_DB'] = str(Path(temp) / 'operator.sqlite')
            env['QB_STUDIO_PORT'] = '0'
            proc = subprocess.Popen(['node', 'apps/control-plane/dist/main.js'], cwd=root, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            def drain():
                assert proc and proc.stdout
                for line in proc.stdout:
                    lines.put(line.rstrip())
            reader = threading.Thread(target=drain, daemon=True)
            reader.start()
            url = None
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and (url is None or pairing_code is None):
                try:
                    line = lines.get(timeout=max(0.1, min(1.0, deadline - time.monotonic())))
                except queue.Empty:
                    if proc.poll() is not None:
                        break
                    continue
                match = re.search(r'Quadbridge Product Studio 0\.3: (http://127\.0\.0\.1:\d+)', line)
                if match:
                    url = match.group(1)
                match = re.search(r'Pairing code \(local developer access\): ([A-Za-z0-9_-]+)', line)
                if match:
                    pairing_code = match.group(1)
            if not url or not pairing_code:
                result = {"status": "FAILED", "reason": "Control plane did not report its ephemeral address and pairing code"}
            else:
                try:
                    with sync_playwright() as p:
                        browser = p.chromium.launch(headless=True, executable_path=str(chrome), timeout=15000)
                        page = browser.new_page()
                        response = page.goto(url, wait_until='domcontentloaded', timeout=15000)
                        if not response or response.status != 200:
                            raise RuntimeError('Local entry page did not return HTTP 200')
                        page.get_by_role('heading', name='Connect Studio').wait_for(timeout=10000)
                        result['checks']['initial_login'] = True
                        page.get_by_label('Pairing code').fill('invalid-code')
                        page.get_by_role('button', name='Connect local Studio').click()
                        page.get_by_role('alert').get_by_text('Invalid pairing code').wait_for(timeout=10000)
                        result['checks']['bad_code_error'] = True
                        page.get_by_label('Pairing code').fill(pairing_code)
                        page.get_by_role('button', name='Connect local Studio').click()
                        page.get_by_role('button', name='Products').wait_for(timeout=10000)
                        result['checks']['valid_pairing'] = True
                        page.get_by_role('button', name='Products').click()
                        rows = page.locator('.table tbody tr').count()
                        if rows < 1:
                            raise RuntimeError('Products view did not show stored source rows')
                        result['checks']['stored_products'] = rows
                        page.get_by_role('button', name='Operations').click()
                        text = page.locator('body').inner_text()
                        required = ['Build executor', 'Artifact registry', 'Deployment controller', 'Model serving']
                        normalized = text.lower()
                        result['checks']['operations_text'] = text
                        if any(label.lower() not in normalized for label in required) or normalized.count('not-attached') < len(required):
                            raise RuntimeError('Operations view did not truthfully show all four unattached capabilities')
                        result['checks']['unattached_operations'] = required
                        page.get_by_role('button', name='Disconnect').click()
                        page.get_by_role('heading', name='Connect Studio').wait_for(timeout=10000)
                        session_status = page.evaluate("async () => (await fetch('/platform-api/session', {credentials:'same-origin'})).status")
                        if session_status != 401:
                            raise RuntimeError('Logout left the browser session authenticated')
                        result['checks']['logout'] = True
                    result['status'] = 'PASSED'
                except Exception as error:
                    message = str(error).replace(pairing_code or '\0', '[redacted]')
                    if 'Executable doesn\'t exist' in message or 'BrowserType.launch' in message or 'net::ERR_BLOCKED' in message:
                        result = {"status": "BLOCKED_BROWSER", "reason": message[:500], "checks": result.get('checks', {})}
                    else:
                        result = {"status": "FAILED", "reason": message[:500], "checks": result.get('checks', {})}
                finally:
                    pairing_code = None
                    if browser is not None:
                        try: browser.close()
                        except Exception: pass
                        browser = None
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
            if reader is not None:
                reader.join(timeout=1)
except Exception as error:
    result = {"status": "FAILED", "reason": str(error)[:500], "checks": result.get('checks', {})}
finally:
    if pairing_code:
        pairing_code = None
    if browser is not None:
        try: browser.close()
        except Exception: pass
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(timeout=5)
    out_path.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, indent=2))



