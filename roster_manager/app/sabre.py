"""Sabre (CIA) roster retrieval with a headless Chromium.

Rules from the spec, enforced here:
* Runs only when started from the Capture/Test button. No polling, no schedules, no retries.
* One run at a time. Every run has a hard overall time limit.
* A failed run never touches stored rosters or the calendar: it only returns an error.

The login is handled as a small state machine, because Sabre's exact pages haven't been seen
yet: Microsoft (email -> password -> Authenticator -> "Stay signed in?") then the Sabre login,
then the roster page. Every step is recorded (screenshot + cleaned page + URL without query
string) into a diagnostics folder so the roster reader can be finished from real pages.
"""

import asyncio
import json
import os
import re
import shutil
import time
import uuid
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright, TimeoutError as PWTimeout

import store

EXTRACT_JS = (Path(__file__).parent / "extract.js").read_text()
MS_HOSTS = ("login.microsoftonline.com", "login.microsoft.com", "login.live.com", "login.windows.net") + tuple(
    h for h in os.environ.get("MS_HOSTS_EXTRA", "").split(",") if h)  # extra hosts for local testing only
OVERALL_LIMIT = 300      # seconds for the whole run
MFA_LIMIT = 180          # seconds to wait for Authenticator / code
STUCK_LIMIT = 45         # seconds on an unrecognised page before giving up
DEBUG_DIR = store.DATA / "debug"
KEEP_DEBUG_RUNS = 6


class Job:
    def __init__(self, mode, period):
        self.id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        self.mode = mode            # 'capture' or 'test'
        self.period = period
        self.state = "running"      # running | waiting_mfa | waiting_code | done | failed | cancelled
        self.steps = []
        self.prompt = None          # {kind:'number'|'code'|'approve', value, text}
        self.result = None
        self.error = None
        self.started = time.time()
        self.finished = None
        self.cancelled = False
        self.code = None            # code typed in by the user for an MFA code prompt
        self.shot = None            # latest screenshot file name
        self.dir = DEBUG_DIR / self.id

    def step(self, msg):
        self.steps.append({"t": round(time.time() - self.started, 1), "msg": msg})

    def public(self):
        return {
            "id": self.id, "mode": self.mode, "state": self.state, "steps": self.steps, "prompt": self.prompt,
            "error": self.error, "hasResult": self.result is not None, "shot": self.shot,
            "elapsed": round((self.finished or time.time()) - self.started), "period": self.period,
        }


current: Job | None = None


def busy():
    return current is not None and current.state in ("running", "waiting_mfa", "waiting_code")


def start(mode, period, settings, secrets):
    global current
    if busy():
        raise RuntimeError("A Sabre run is already in progress.")
    current = Job(mode, period)
    asyncio.get_running_loop().create_task(_run(current, settings, secrets))
    return current


def _strip_url(u):
    p = urlparse(u)
    return f"{p.scheme}://{p.netloc}{p.path}"


async def _visible(page, selector):
    try:
        loc = page.locator(selector).first
        return await loc.count() > 0 and await loc.is_visible()
    except Exception:
        return False


async def _text(page, selector):
    try:
        loc = page.locator(selector).first
        if await loc.count() and await loc.is_visible():
            return (await loc.inner_text()).strip()
    except Exception:
        pass
    return ""


class Recorder:
    def __init__(self, job):
        self.job = job
        self.n = 0
        job.dir.mkdir(parents=True, exist_ok=True)
        self.index = []

    async def snap(self, page, label):
        self.n += 1
        base = f"{self.n:02d}-{re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')[:40]}"
        entry = {"n": self.n, "label": label, "url": _strip_url(page.url), "t": round(time.time() - self.job.started, 1)}
        try:
            await page.screenshot(path=str(self.job.dir / f"{base}.png"), full_page=True, timeout=15000)
            entry["screenshot"] = f"{base}.png"
            self.job.shot = f"{base}.png"
        except Exception as e:
            entry["screenshotError"] = str(e)[:200]
        try:
            entry["title"] = await page.title()
            data = await page.evaluate(EXTRACT_JS)
            (self.job.dir / f"{base}.json").write_text(json.dumps(data))
            entry["page"] = f"{base}.json"
        except Exception as e:
            entry["pageError"] = str(e)[:200]
        self.index.append(entry)
        (self.job.dir / "steps.json").write_text(json.dumps({"job": self.job.public(), "snapshots": self.index}, indent=1))


def _prune_debug():
    runs = sorted([p for p in DEBUG_DIR.glob("*") if p.is_dir()], reverse=True)
    for old in runs[KEEP_DEBUG_RUNS:]:
        shutil.rmtree(old, ignore_errors=True)


async def _settle(page):
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
        await page.wait_for_load_state("networkidle", timeout=6000)
    except PWTimeout:
        pass


async def _click_submit(page):
    for sel in ("#idSIButton9", "input[type=submit]", "button[type=submit]"):
        if await _visible(page, sel):
            await page.locator(sel).first.click()
            return True
    await page.keyboard.press("Enter")
    return True


async def _fill(page, selector, value):
    loc = page.locator(selector).first
    await loc.click()
    await loc.fill(value)


async def _sabre_user_field(page):
    """The visible text-like input just before the password field (Sabre login form)."""
    handle = await page.evaluate_handle("""() => {
      const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const pw = [...document.querySelectorAll('input[type=password]')].find(vis);
      if (!pw) return null;
      const scope = pw.form || document;
      const ins = [...scope.querySelectorAll('input[type=text],input[type=email],input[type=tel],input[type=number],input:not([type])')].filter(vis);
      const before = ins.filter(i => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
      return before[before.length - 1] || ins[0] || null;
    }""")
    return handle.as_element()


async def _run(job: Job, settings, secrets):
    rec = Recorder(job)
    ctx = None
    try:
        _prune_debug()
        url = settings.get("sabreUrl") or "https://cia.virginaustralia.com/cia/index.page"
        email = settings.get("msEmail") or ""
        user_id = settings.get("sabreUserId") or ""
        ms_pw = secrets.get("msPassword") or ""
        sabre_pw = secrets.get("sabrePassword") or ""
        async with async_playwright() as p:
            job.step("Starting browser")
            kwargs = dict(headless=True, viewport={"width": 1280, "height": 1600}, locale="en-AU",
                          timezone_id=settings.get("browserTz") or "Australia/Sydney")
            if os.environ.get("CHROME_PATH"):
                kwargs["executable_path"] = os.environ["CHROME_PATH"]
            ctx = await p.chromium.launch_persistent_context(str(store.DATA / "browser"), **kwargs)
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            page.set_default_timeout(30000)

            job.step("Opening Sabre")
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            except PWTimeout:
                raise RuntimeError("Sabre didn't respond within 60 seconds. It may be down or overloaded. Try again later.")
            except Exception as e:
                raise RuntimeError(f"Couldn't reach Sabre: {str(e).splitlines()[0]}")

            counts = {}
            last_sig, sig_since = None, time.time()
            while True:
                if job.cancelled:
                    raise RuntimeError("Cancelled.")
                if time.time() - job.started > OVERALL_LIMIT:
                    raise RuntimeError("Gave up after 5 minutes. Sabre or Microsoft didn't finish loading.")
                await _settle(page)
                host = urlparse(page.url).hostname or ""
                sig = None

                if host in MS_HOSTS:
                    err = await _text(page, "#usernameError, #passwordError, #idTD_Error, .alert-error, [role=alert]")
                    if await _visible(page, "input[name=loginfmt]:not([type=hidden]), input[type=email]"):
                        sig = "ms-email"
                        if sig == last_sig and err:
                            raise RuntimeError(f"Microsoft rejected the email: {err}")
                        if counts.get(sig, 0) >= 2:
                            raise RuntimeError(f"Microsoft keeps asking for the email. {err}".strip())
                        if not email:
                            raise RuntimeError("Microsoft email isn't set. Add it in Settings.")
                        await rec.snap(page, "microsoft-email")
                        job.step("Microsoft: entering email")
                        await _fill(page, "input[name=loginfmt]:not([type=hidden]), input[type=email]", email)
                        await _click_submit(page)
                    elif await _visible(page, "input[name=passwd], input[type=password]"):
                        sig = "ms-password"
                        if counts.get(sig, 0) >= 1:
                            await rec.snap(page, "microsoft-password-again")
                            raise RuntimeError(f"Microsoft didn't accept the password{': ' + err if err else ''}. Update it in Settings (it may have rotated).")
                        if not ms_pw:
                            await rec.snap(page, "microsoft-password-needed")
                            raise RuntimeError("Microsoft is asking for your password, but none is saved. Add it in Settings → Work logins.")
                        await rec.snap(page, "microsoft-password")
                        job.step("Microsoft: entering password")
                        await _fill(page, "input[name=passwd], input[type=password]", ms_pw)
                        await _click_submit(page)
                    elif await _visible(page, "#idRichContext_DisplaySign, .displaySign"):
                        sig = "ms-number"
                        number = await _text(page, "#idRichContext_DisplaySign, .displaySign")
                        await rec.snap(page, "microsoft-authenticator-number")
                        job.prompt = {"kind": "number", "value": number, "text": "Open Microsoft Authenticator on your phone and enter this number."}
                        job.state = "waiting_mfa"
                        job.step(f"Microsoft: waiting for Authenticator (number {number})")
                        await _wait_leave(page, job, "#idRichContext_DisplaySign, .displaySign")
                    elif await _visible(page, "input[name=otc], input[autocomplete=one-time-code]"):
                        sig = "ms-code"
                        await rec.snap(page, "microsoft-code")
                        if counts.get(sig, 0) >= 1 and err:
                            raise RuntimeError(f"Microsoft rejected the code: {err}")
                        job.prompt = {"kind": "code", "text": (await _text(page, "#idDiv_SAOTCC_Description, .text-title, #idDiv_SAOTCC_Title")) or "Enter the code from Microsoft Authenticator."}
                        job.state = "waiting_code"
                        job.code = None
                        job.step("Microsoft: waiting for you to enter the code")
                        code = await _wait_code(job)
                        job.state, job.prompt = "running", None
                        await _fill(page, "input[name=otc], input[autocomplete=one-time-code]", code)
                        await _click_submit(page)
                    elif await _visible(page, "#KmsiCheckboxField, #KmsiDescription, input[name=DontShowAgain]") or "Stay signed in" in (await _text(page, "body"))[:2000]:
                        sig = "ms-kmsi"
                        await rec.snap(page, "microsoft-stay-signed-in")
                        job.step("Microsoft: choosing 'Stay signed in'")
                        if await _visible(page, "#KmsiCheckboxField, input[name=DontShowAgain]"):
                            await page.locator("#KmsiCheckboxField, input[name=DontShowAgain]").first.check()
                        await _click_submit(page)
                    else:
                        body = (await _text(page, "body"))[:300]
                        sig = "ms-other:" + body[:60]
                        if any(w in body for w in ("Approve sign in", "Approve sign-in", "Check your Authenticator", "Open your Authenticator")):
                            if job.state != "waiting_mfa":
                                await rec.snap(page, "microsoft-approve")
                            job.prompt = {"kind": "approve", "text": "Approve the sign-in request in Microsoft Authenticator on your phone."}
                            job.state = "waiting_mfa"
                            job.step("Microsoft: waiting for you to approve in Authenticator")
                            await _wait_leave_text(page, job, body[:40])
                        elif time.time() - sig_since > STUCK_LIMIT and sig == last_sig:
                            await rec.snap(page, "microsoft-unknown-page")
                            raise RuntimeError(f"Stuck on a Microsoft page the app doesn't recognise yet: “{body[:120]}”. Send the diagnostics file to get this handled.")
                        else:
                            await asyncio.sleep(2)
                elif await _visible(page, "input[type=password]"):
                    sig = "sabre-login"
                    if counts.get(sig, 0) >= 1:
                        await rec.snap(page, "sabre-login-again")
                        err = await _text(page, ".error, .errorMessage, .alert, [role=alert], .msg-error, #errorMessage, font[color=red]")
                        raise RuntimeError(f"Sabre login failed{': ' + err if err else ''}. Check the Sabre User ID and password in Settings.")
                    if not sabre_pw:
                        await rec.snap(page, "sabre-password-needed")
                        raise RuntimeError("Sabre is asking for your password, but none is saved. Add it in Settings → Work logins.")
                    await rec.snap(page, "sabre-login")
                    job.step("Sabre: logging in")
                    uf = await _sabre_user_field(page)
                    if uf and user_id:
                        await uf.fill(user_id)
                    await page.locator("input[type=password]").first.fill(sabre_pw)
                    if not await _click_submit_in_form(page):
                        await page.keyboard.press("Enter")
                else:
                    break  # signed in: no login form on screen

                if job.state == "waiting_mfa":
                    job.state, job.prompt = "running", None
                if sig is not None:
                    counts[sig] = counts.get(sig, 0) + 1
                if sig != last_sig:
                    last_sig, sig_since = sig, time.time()
                await asyncio.sleep(1)

            job.step("Signed in")
            await rec.snap(page, "signed-in")
            roster_url = (settings.get("rosterUrl") or "").strip()
            if job.mode == "test":
                job.result = {"ok": True}
                job.step("Login test passed")
            else:
                if roster_url:
                    job.step("Opening the roster page")
                    await page.goto(roster_url, wait_until="domcontentloaded", timeout=60000)
                    await _settle(page)
                    await rec.snap(page, "roster-page")
                job.step("Reading the roster")
                data = await page.evaluate(EXTRACT_JS)
                data["period"] = job.period
                data["debugRun"] = job.id
                job.result = data
                (job.dir / "capture.json").write_text(json.dumps(data))
                job.step(f"Captured {sum(len(f.get('tables', [])) for f in data.get('frames', []))} table(s) from “{data.get('title', '')}”")
            job.state = "done"
            store.log_add({"kind": "sabre", "ok": True, "message": f"Sabre {job.mode}: {job.steps[-1]['msg']}"})
    except Exception as e:
        job.error = str(e) or e.__class__.__name__
        job.state = "cancelled" if job.cancelled else "failed"
        job.step(("Cancelled" if job.cancelled else "Failed: ") + ("" if job.cancelled else job.error))
        store.log_add({"kind": "sabre", "ok": False, "message": f"Sabre {job.mode} failed: {job.error}"})
    finally:
        job.prompt = None
        job.finished = time.time()
        try:
            (job.dir / "steps.json").write_text(json.dumps({"job": job.public(), "snapshots": rec.index}, indent=1))
        except Exception:
            pass
        if ctx:
            try:
                await ctx.close()
            except Exception:
                pass


async def _click_submit_in_form(page):
    return await page.evaluate("""() => {
      const pw = document.querySelector('input[type=password]');
      const scope = (pw && pw.form) || document;
      const b = scope.querySelector('button[type=submit], input[type=submit], button:not([type]), input[type=image]');
      if (b) { b.click(); return true; }
      return false;
    }""")


async def _wait_leave(page, job, selector):
    end = time.time() + MFA_LIMIT
    while time.time() < end:
        if job.cancelled:
            raise RuntimeError("Cancelled.")
        await asyncio.sleep(2)
        if not await _visible(page, selector):
            return
    raise RuntimeError("Authenticator wasn't approved within 3 minutes.")


async def _wait_leave_text(page, job, marker):
    end = time.time() + MFA_LIMIT
    while time.time() < end:
        if job.cancelled:
            raise RuntimeError("Cancelled.")
        await asyncio.sleep(2)
        try:
            if marker not in (await page.locator("body").inner_text())[:400]:
                return
        except Exception:
            return
    raise RuntimeError("Sign-in wasn't approved within 3 minutes.")


async def _wait_code(job):
    end = time.time() + MFA_LIMIT
    while time.time() < end:
        if job.cancelled:
            raise RuntimeError("Cancelled.")
        if job.code:
            c = job.code
            job.code = None
            return c
        await asyncio.sleep(1)
    raise RuntimeError("No code entered within 3 minutes.")


def debug_zip(job_id=None):
    runs = sorted([p for p in DEBUG_DIR.glob("*") if p.is_dir()], reverse=True)
    if job_id:
        runs = [r for r in runs if r.name == job_id]
    if not runs:
        return None, None
    run = runs[0]
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(run.iterdir()):
            z.write(f, f"{run.name}/{f.name}")
    return f"roster-diagnostics-{run.name}.zip", buf.getvalue()


def debug_file(job_id, name):
    if not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{6}", job_id or "") or not re.fullmatch(r"[0-9a-z\-]+\.png", name or ""):
        return None
    p = DEBUG_DIR / job_id / name
    return p if p.exists() else None
