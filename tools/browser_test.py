"""Normal local-browser acceptance runner. Does not bypass browser or network policies.

Requires Python 3.11+, playwright Python package and an installed Chromium browser.
Runs the actual maintained shell and source modules against real localhost APIs/SQLite.
Credentials and state are temporary, are not logged, and are deleted after shutdown.
"""
from __future__ import annotations
import json
from contextlib import nullcontext
import os
import shutil
import signal
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence"
EVIDENCE.mkdir(exist_ok=True)
PORT = int(os.environ.get("QB_BROWSER_BASE_PORT", "4450"))
report: dict = {"at": datetime.now(timezone.utc).isoformat(), "status": "NOT_RUN", "tests": [],
                "scope": "Real local DOM/browser, API and worker; not enterprise authorization or Veyviz integration"}
process = None
log = None
browser = None
temp = None

def ready(port: int) -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as result:
            return result.status == 200
    except Exception:
        return False

def record(name: str) -> None:
    report["tests"].append({"name": name, "status": "PASSED"})

try:
    from playwright.sync_api import sync_playwright, expect
    with nullcontext(tempfile.mkdtemp(prefix="qb-browser-")) as temp:
        # Launcher log contains temporary credentials; intentionally not copied to evidence.
        log = open(Path(temp) / "private-launcher.log", "wb")
        flags = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        process = subprocess.Popen(["node", str(ROOT / "tools/demo.mjs"), "--base-port", str(PORT), "--data-root", temp], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, **flags)
        deadline = time.monotonic() + 25
        while not all(ready(PORT + delta) for delta in (0, 10, 20, 30)):
            if process.poll() is not None:
                raise RuntimeError("Local demo exited before readiness; inspect the launcher in a local coding environment")
            if time.monotonic() > deadline:
                raise TimeoutError("Local reference products did not become ready")
            time.sleep(.15)
        report["actualApiReadiness"] = "PASSED_FOR_FOUR_LOCAL_PRODUCTS"
        credentials = json.loads((Path(temp) / "developer-credentials.json").read_text())
        with sync_playwright() as playwright:
            executable = os.environ.get("QB_CHROMIUM") or shutil.which("chromium")
            launch = {"headless": True}
            if executable:
                launch["executable_path"] = executable
            browser = playwright.chromium.launch(**launch)
            context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = context.new_page()
            def login(port: int, account: str = "admin"):
                page.goto(f"http://127.0.0.1:{port}", wait_until="networkidle")
                page.get_by_label("Username", exact=True).fill(account)
                page.get_by_label("Password", exact=True).fill(credentials[account])
                page.get_by_role("button", name="Sign in", exact=True).click()
                expect(page.get_by_role("button", name="Sign out", exact=True)).to_be_visible()
            login(PORT)
            expect(page.get_by_text("The shell is running without a domain.", exact=True)).to_be_visible()
            record("Neutral browser startup with no domain modules")
            login(PORT + 10)
            page.get_by_label("Title", exact=True).fill("Browser acceptance request")
            page.get_by_label("Details", exact=True).fill("Persist this through owner APIs")
            page.get_by_role("button", name="Create request", exact=True).click()
            expect(page.get_by_role("heading", name="Browser acceptance request", exact=True)).to_be_visible()
            page.reload(wait_until="networkidle")
            expect(page.get_by_role("heading", name="Browser acceptance request", exact=True)).to_be_visible()
            record("Service Desk create and reload use durable owner records")
            page.get_by_role("link", name="Request overview", exact=True).click()
            expect(page.get_by_role("heading", name="Request overview", exact=True)).to_be_visible()
            expect(page.locator(".request-overview")).to_contain_text("Browser acceptance request")
            record("Named overview workspace loads its lazy helper and declared stylesheet")
            page.get_by_role("link", name="Service requests", exact=True).click()

            page.get_by_label("Tenant", exact=True).select_option("customer-b")
            expect(page.get_by_text("No requests in this tenant.", exact=True)).to_be_visible()
            expect(page.get_by_role("heading", name="Browser acceptance request", exact=True)).to_have_count(0)
            record("Tenant switch removes other tenant's records")
            page.get_by_role("button", name="Sign out", exact=True).click()
            login(PORT + 10, "viewer")
            expect(page.get_by_role("button", name="Create request", exact=True)).to_have_count(0)
            record("Read-only principal has no write contribution")
            login(PORT + 20)
            page.get_by_role("link", name="Knowledge library", exact=True).click()
            page.get_by_label("Document title", exact=True).fill("Browser handbook")
            page.get_by_label("Document text", exact=True).fill("Nebula repair instructions for framework testing.")
            page.get_by_role("button", name="Save and index", exact=True).click()
            article = page.locator("article").filter(has=page.get_by_role("heading", name="Browser handbook", exact=True))
            expect(article).to_contain_text("READY", timeout=15000)
            doc_id = article.locator(".receipt").inner_text()
            page.get_by_label("Search documents", exact=True).fill("Nebula")
            page.get_by_role("button", name="Search", exact=True).click()
            expect(page.get_by_text("Search coverage: indexed documents only.", exact=True)).to_be_visible()
            record("Knowledge save, separate worker indexing and FTS search")
            page.get_by_role("link", name="Cross-product handoffs", exact=True).click()
            page.get_by_label("Source document", exact=True).select_option(doc_id)
            page.get_by_label("Reason for the service request", exact=True).fill("Review browser handbook")
            page.get_by_role("button", name="Request Service Desk action", exact=True).click()
            expect(page.locator("article").first).to_contain_text("Destination confirmed", timeout=15000)
            record("Cross-product handoff displays the real destination receipt")
            login(PORT + 30)
            page.get_by_role("link", name="Service requests", exact=True).click()
            expect(page.get_by_role("heading", name="Service requests", exact=True)).to_be_visible()
            page.get_by_role("link", name="Knowledge library", exact=True).click()
            expect(page.get_by_role("heading", name="Knowledge library", exact=True)).to_be_visible()
            record("Combined product hosts distinct domains under maintained shell")
            page.set_viewport_size({"width": 390, "height": 844})
            if page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"):
                raise AssertionError("Unexpected document horizontal overflow at mobile width")
            record("Mobile reference layout remains within viewport")
            page.get_by_role("button", name="Sign out", exact=True).click()
            expect(page.get_by_label("Password", exact=True)).to_be_visible()
            expect(page.locator(".workspace")).to_have_count(0)
            record("Logout removes selected workspace")
            browser.close()
            browser = None
        report["status"] = "PASSED_FOR_LOCAL_BROWSER_SCOPE"
except Exception as error:
    message = str(error)
    if "ERR_BLOCKED_BY_ADMINISTRATOR" in message:
        report["status"] = "BLOCKED_BY_ENVIRONMENT"
        report["reason"] = "Chromium refused ordinary navigation to localhost (ERR_BLOCKED_BY_ADMINISTRATOR). No policy bypass attempted."
    else:
        report["status"] = "FAILED_OR_UNAVAILABLE"
        # Credentials are never interpolated into an exception by this runner.
        report["reason"] = message[:1200]
finally:
    if browser:
        try:
            browser.close()
        except Exception:
            pass
    if process and process.poll() is None:
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
            else:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=8)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    if log:
        log.close()
    if temp:
        shutil.rmtree(temp, ignore_errors=True)
    (EVIDENCE / "browser_run.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
raise SystemExit(0 if report["status"] == "PASSED_FOR_LOCAL_BROWSER_SCOPE" else 2)
