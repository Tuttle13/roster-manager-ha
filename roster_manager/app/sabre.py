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


import hmac
import hashlib
import struct
import base64


def totp_code(secret, at=None, digits=6, period=30):
    """Standard RFC 6238 TOTP (the same 6-digit codes an authenticator app shows)."""
    clean = re.sub(r"\s+", "", secret or "").upper()
    if not clean:
        return None
    pad = "=" * ((8 - len(clean) % 8) % 8)
    try:
        key = base64.b32decode(clean + pad)
    except Exception:
        return None
    counter = int((at if at is not None else time.time()) // period)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    val = (struct.unpack(">I", digest[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(val).zfill(digits)


def totp_valid(secret):
    return totp_code(secret) is not None


def _fresh_totp(secret):
    """Return a code that has at least a few seconds of life left, so it isn't rejected at a boundary."""
    if int(time.time()) % 30 >= 27:
        time.sleep(30 - (int(time.time()) % 30) + 1)
    return totp_code(secret)


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
        self.decision = None        # 'ack' or 'stop' for a Notice Board prompt
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
    return current is not None and current.state in ("running", "waiting_mfa", "waiting_code", "waiting_ack")


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


REAL_VISIBLE_JS = """(sel) => {
  const ok = e => {
    if (e.closest('[aria-hidden=true], .moveOffScreen')) return false;
    if (e.type === 'hidden') return false;
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = e.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < innerWidth;
  };
  return [...document.querySelectorAll(sel)].find(ok) || null;
}"""


async def _real(page, selector):
    """First element matching selector that a person could actually see and use (Microsoft keeps
    off-screen copies of its inputs, e.g. class 'moveOffScreen', which must be ignored)."""
    try:
        h = await page.evaluate_handle(REAL_VISIBLE_JS, selector)
        return h.as_element()
    except Exception:
        return None


async def _visible(page, selector):
    return await _real(page, selector) is not None


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
        el = await _real(page, sel)
        if el:
            try:
                await el.click(timeout=5000)
            except Exception:
                await el.evaluate("e => e.click()")  # something overlaps it (e.g. Microsoft's footer)
            return True
    await page.keyboard.press("Enter")
    return True


async def _fill(page, selector, value):
    el = await _real(page, selector)
    if not el:
        raise RuntimeError(f"Expected field not found on the page ({selector}).")
    await el.fill(value, timeout=10000)


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
        totp = secrets.get("totpSecret") or ""
        async with async_playwright() as p:
            job.step("Starting browser")
            launch = {"executable_path": os.environ["CHROME_PATH"]} if os.environ.get("CHROME_PATH") else {}
            # Identify as ordinary desktop Chrome rather than "HeadlessChrome".
            try:
                probe = await p.chromium.launch(headless=True, **launch)
                version = probe.version
                await probe.close()
            except Exception:
                version = "140.0.0.0"
            ua = f"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36"
            kwargs = dict(headless=True, viewport={"width": 1280, "height": 1600}, locale="en-AU", user_agent=ua,
                          timezone_id=settings.get("browserTz") or "Australia/Sydney", **launch)
            ctx = await p.chromium.launch_persistent_context(str(store.DATA / "browser"), **kwargs)
            try:
                saved = store.cookies_get()
                if saved:
                    restored = 0
                    for ck in saved:
                        try:
                            await ctx.add_cookies([ck])
                            restored += 1
                        except Exception:
                            pass
                    job.step(f"Restored remembered sign-in ({restored} cookies)")
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
                        if await _visible(page, "input[name=passwd], input[type=password]"):
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
                        elif await _visible(page, "input[name=loginfmt]:not([type=hidden]), input[type=email]"):
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
                        elif await _visible(page, "#idRichContext_DisplaySign, .displaySign"):
                            sig = "ms-number"
                            if totp and await _switch_to_code(page):
                                job.step("Microsoft: switching to a verification code")
                                await asyncio.sleep(1)
                                continue
                            number = await _text(page, "#idRichContext_DisplaySign, .displaySign")
                            await rec.snap(page, "microsoft-authenticator-number")
                            job.prompt = {"kind": "number", "value": number, "text": "Open Microsoft Authenticator on your phone and enter this number."}
                            job.state = "waiting_mfa"
                            job.step(f"Microsoft: waiting for Authenticator (number {number})")
                            await _wait_leave(page, job, "#idRichContext_DisplaySign, .displaySign")
                        elif await _visible(page, "input[name=otc], input[autocomplete=one-time-code]"):
                            sig = "ms-code"
                            await rec.snap(page, "microsoft-code")
                            if totp:
                                if counts.get(sig, 0) >= 2:
                                    raise RuntimeError(f"Microsoft rejected the generated code{': ' + err if err else ''}. Check the authenticator key in Settings.")
                                job.step("Microsoft: entering the generated verification code")
                                await _fill(page, "input[name=otc], input[autocomplete=one-time-code]", _fresh_totp(totp))
                                await _click_submit(page)
                            else:
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
                            cb = await _real(page, "#KmsiCheckboxField, input[name=DontShowAgain]")
                            if cb:
                                try:
                                    await cb.check(timeout=5000)
                                except Exception:
                                    pass
                            await _click_submit(page)
                        elif "Pick an account" in (await _text(page, "body"))[:600]:
                            sig = "ms-picker"
                            if counts.get(sig, 0) >= 2:
                                await rec.snap(page, "microsoft-picker-again")
                                raise RuntimeError("Microsoft keeps showing 'Pick an account'. Try Settings → Forget remembered sign-in, then capture again.")
                            await rec.snap(page, "microsoft-pick-account")
                            tile = await page.evaluate_handle("""(email) => {
                              const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
                              const want = (email || '').toLowerCase();
                              const tiles = [...document.querySelectorAll('[data-test-id], .table[role=button], [role=button], [role=listitem], .tile, div.table, small, div')].filter(vis);
                              if (want) {
                                const byId = [...document.querySelectorAll('[data-test-id]')].find(e => (e.getAttribute('data-test-id') || '').toLowerCase() === want && vis(e));
                                if (byId) return byId;
                                const hit = tiles.filter(e => (e.innerText || '').toLowerCase().includes(want));
                                if (hit.length) { hit.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length); return hit[0].closest('[role=button], .table, [data-test-id], [tabindex]') || hit[0]; }
                              }
                              const other = [...document.querySelectorAll('[role=button], div, a')].filter(vis).find(e => /^\\s*use another account\\s*$/i.test(e.innerText || ''));
                              return other || null;
                            }""", email)
                            el = tile.as_element()
                            if not el:
                                raise RuntimeError("Microsoft showed 'Pick an account' but the app couldn't find your account or 'Use another account'. Send the diagnostics file.")
                            job.step("Microsoft: choosing your account")
                            try:
                                await el.click(timeout=5000)
                            except Exception:
                                await el.evaluate("e => e.click()")
                        else:
                            body = (await _text(page, "body"))[:300]
                            sig = "ms-other:" + body[:60]
                            if any(w in body for w in ("Approve sign in", "Approve sign-in", "Check your Authenticator", "Open your Authenticator", "Verify your identity", "How would you like")):
                                if totp and counts.get("ms-switch", 0) < 2 and await _switch_to_code(page):
                                    counts["ms-switch"] = counts.get("ms-switch", 0) + 1
                                    job.step("Microsoft: switching to a verification code")
                                    await asyncio.sleep(1)
                                    continue
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
                        await _fill(page, "input[type=password]", sabre_pw)
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
                if job.mode == "test":
                    job.result = {"ok": True}
                    job.step("Login test passed")
                else:
                    data = await _roster_report(page, job, rec, settings)
                    data["period"] = job.period
                    data["debugRun"] = job.id
                    job.result = data
                    (job.dir / "capture.json").write_text(json.dumps(data))
            finally:
                await _save_cookies(ctx)
            job.state = "done"
            store.log_add({"kind": "sabre", "ok": True, "message": f"Sabre {job.mode}: {job.steps[-1]['msg']}"})
    except Exception as e:
        msg = str(e) or e.__class__.__name__
        if "Call log:" in msg or "\n" in msg:  # Playwright internals: keep only the headline
            msg = "The page didn't respond as expected: " + msg.split("Call log:")[0].splitlines()[0].strip()
        job.error = msg
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


async def _switch_to_code(page):
    """On a 'number matching'/push screen, move to the 'enter a verification code' method.
    Clicks links such as 'I can't use my Microsoft Authenticator app right now' /
    'Use a verification code' / 'Sign in another way', and picks the code option if a list appears."""
    clicked = await page.evaluate("""() => {
      const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const rx = /verification code|use a code|different method|another way|can.?t use|other ways? to sign in|use.*authenticator app instead/i;
      const els = [...document.querySelectorAll('a, button, [role=button], div.table, [data-value], span')].filter(vis);
      const hit = els.find(e => rx.test((e.innerText || e.textContent || '').trim()));
      if (hit) { (hit.closest('a,button,[role=button],.table,[data-value]') || hit).click(); return true; }
      return false;
    }""")
    if not clicked:
        return False
    await _settle(page)
    # A method list may appear: choose the verification-code option. Optional, and the click above
    # may already be navigating, so ignore a destroyed-context error here.
    try:
        await page.evaluate("""() => {
          const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const rx = /verification code|code from.*authenticator|use a code|totp|one-time/i;
          const els = [...document.querySelectorAll('[role=button], .table, [data-value], button, a, li, div')].filter(vis);
          const hit = els.find(e => rx.test((e.innerText || e.textContent || '').trim()));
          if (hit) (hit.closest('[role=button],.table,[data-value],button,a,li') || hit).click();
        }""")
        await _settle(page)
    except Exception:
        pass
    return True


async def _save_cookies(ctx):
    """Keep the sign-in for next time, including session cookies a closing browser would drop."""
    try:
        cks = [c for c in await ctx.cookies() if c.get("domain")]
        if cks:
            store.cookies_set(cks)
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


# ---------------- Sabre AirCentre Crew Connection: Notice Board -> Reports -> Roster Report ----------------
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
NOTICE_LABELS = ["Notice Board", "Manual Notification", "Roster Change Notifications", "Not Notified", "Notified",
                 "Broadcast Messages", "Nothing found to display", "Acknowledge", "Print"]

FIND_JS = """([texts, clickableOnly]) => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const want = texts.map(norm);
  const els = [...document.querySelectorAll('a, button, input[type=button], input[type=submit], input[type=image], span, td, div, li')];
  let fallback = null;
  for (const e of els) {
    const v = norm(e.tagName === 'INPUT' ? (e.value || e.alt || e.title) : e.innerText);
    if (!want.includes(v)) continue;
    if (['A', 'BUTTON', 'INPUT'].includes(e.tagName)) return e;
    if (!clickableOnly && !fallback) fallback = e;
  }
  return fallback;
}"""

SET_DATES_JS = """([from, to]) => {
  const ins = [...document.querySelectorAll('input')].filter(i => !['hidden', 'button', 'submit', 'image', 'checkbox', 'radio', 'password'].includes((i.type || 'text').toLowerCase()));
  const labelOf = i => {
    const row = i.closest('tr');
    let t = row ? row.innerText : '';
    if (!t) { let p = i.previousSibling; while (p && !t) { t = (p.textContent || '').trim(); p = p.previousSibling; } }
    return (t + ' ' + (i.name || '') + ' ' + (i.id || '')).toLowerCase();
  };
  let f = ins.find(i => /from/.test(labelOf(i)));
  let t = ins.find(i => i !== f && /\\bto\\b|to:|todate|to_date|dateto/.test(labelOf(i)));
  if (!f || !t) { if (ins.length >= 2) { f = f || ins[0]; t = t || ins[1]; } else return false; }
  const set = (el, v) => {
    const ro = el.readOnly; el.readOnly = false;
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, v);
    ['input', 'change', 'keyup', 'blur'].forEach(n => el.dispatchEvent(new Event(n, { bubbles: true })));
    el.readOnly = ro;
  };
  set(f, from); set(t, to);
  return [f.value, t.value];
}"""


def _sabre_date(iso):
    y, m, d = iso.split("-")
    return f"{d}{MONTHS[int(m) - 1]}{y[2:]}"


async def _all_text(page):
    out = []
    for fr in page.frames:
        try:
            out.append(await fr.evaluate("() => document.body ? document.body.innerText : ''"))
        except Exception:
            pass
    return "\n".join(out)


async def _find(page, texts, clickable_only=True):
    for fr in page.frames:
        try:
            h = await fr.evaluate_handle(FIND_JS, [texts, clickable_only])
            el = h.as_element()
            if el:
                return fr, el
        except Exception:
            pass
    return None, None


async def _click(page, texts, what, clickable_only=True):
    fr, el = await _find(page, texts, clickable_only)
    if not el:
        raise RuntimeError(f"Couldn't find “{what}” on the Sabre page. Send the diagnostics file so this can be adjusted.")
    try:
        await el.click(timeout=5000)
    except Exception:
        await el.evaluate("e => e.click()")
    await _settle(page)


async def _wait_text(page, pattern, timeout, job):
    end = time.time() + timeout
    rx = re.compile(pattern, re.I)
    while time.time() < end:
        if job.cancelled:
            raise RuntimeError("Cancelled.")
        txt = await _all_text(page)
        m = rx.search(txt)
        if m:
            return m, txt
        await asyncio.sleep(1.5)
    return None, await _all_text(page)


async def _notice_board(page, job, rec):
    txt = await _all_text(page)
    if "Notice Board" not in txt:
        return None
    fr, ack = await _find(page, ["Acknowledge"])
    if not ack:
        return None
    body = txt.split("Notice Board", 1)[1].split("Acknowledge", 1)[0]
    rest = body
    for lab in NOTICE_LABELS:
        rest = rest.replace(lab, " ")
    rest = re.sub(r"\s+", " ", rest).strip()
    await rec.snap(page, "notice-board")
    if rest:
        notice = re.sub(r"[ \t]+", " ", body).strip()
        job.prompt = {"kind": "notice", "text": notice[:3000]}
        job.state = "waiting_ack"
        job.decision = None
        job.step("Sabre Notice Board has notices: waiting for you to read and acknowledge")
        end = time.time() + 600
        while time.time() < end and not job.decision:
            if job.cancelled:
                raise RuntimeError("Cancelled.")
            await asyncio.sleep(1)
        job.state, job.prompt = "running", None
        if job.decision != "ack":
            raise RuntimeError("Stopped at the Notice Board without acknowledging.")
        job.step("Acknowledging notices (approved by you)")
    else:
        job.step("Notice Board empty: acknowledging")
    try:
        await ack.click(timeout=5000)
    except Exception:
        await ack.evaluate("e => e.click()")
    await _settle(page)
    return rest or ""


async def _roster_report(page, job, rec, settings):
    notices = await _notice_board(page, job, rec)

    job.step("Opening Reports → Roster Report")
    fr, link = await _find(page, ["Roster Report"])
    if not link:
        await _click(page, ["Reports"], "Reports menu", clickable_only=False)
    await _click(page, ["Roster Report"], "Roster Report")
    await rec.snap(page, "roster-report-form")

    start, end = job.period["start"], job.period["end"]
    f, t = _sabre_date(start), _sabre_date(end)
    job.step(f"Requesting {f} to {t}")
    done = False
    for fr in page.frames:
        try:
            r = await fr.evaluate(SET_DATES_JS, [f, t])
            if r:
                done = True
                break
        except Exception:
            pass
    if not done:
        raise RuntimeError("Couldn't find the From/To date boxes on the Roster Report page.")
    await _click(page, ["Query"], "Query button")

    m, txt = await _wait_text(page, rf"Roster Report from\s+{f}\s+to\s+{t}", 120, job)
    if not m:
        await rec.snap(page, "roster-report-not-loaded")
        raise RuntimeError("Sabre didn't show the roster for those dates within 2 minutes. It may be busy. Try again later.")
    await rec.snap(page, "roster-report")
    job.step("Roster loaded")

    data = await page.evaluate(EXTRACT_JS)
    warnings = []
    pm = re.search(r"Page\s+(\d+)\s+of\s+(\d+)", txt)
    total = int(pm.group(2)) if pm else 1
    for k in range(2, total + 1):
        job.step(f"Reading page {k} of {total}")
        fr, nxt = await _find(page, ["Next", ">", ">>", str(k)])
        if not nxt:
            warnings.append(f"Sabre shows {total} pages but the app couldn't find the link to page {k}. Only part of the roster was read.")
            break
        try:
            await nxt.click(timeout=5000)
        except Exception:
            await nxt.evaluate("e => e.click()")
        m2, _ = await _wait_text(page, rf"Page\s+{k}\s+of\s+{total}", 60, job)
        if not m2:
            warnings.append(f"Page {k} of {total} didn't load. Only part of the roster was read.")
            break
        await rec.snap(page, f"roster-report-page-{k}")
        more = await page.evaluate(EXTRACT_JS)
        data["frames"].extend(more.get("frames", []))
    data["requested"] = {"from": f, "to": t}
    data["notices"] = notices
    data["warnings"] = warnings
    rows = sum(len(tb["rows"]) for fr_ in data.get("frames", []) for tb in fr_.get("tables", []))
    job.step(f"Captured the roster ({rows} table rows)")
    return data
