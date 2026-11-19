"""Background scheduler for the automatic Friday capture, plus the unattended capture+sync+backup
orchestration. The manual flow (Capture tab, review, sync) is untouched; this runs the same steps
without a browser open and only ever creates/updates calendar events (never deletes)."""

import asyncio
import json
import os
import subprocess
import tempfile
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import google_api
import sabre
import schedule_calc as sc
import store

APP_DIR = Path(__file__).parent
_task = None
_last_result = None
_auto_active = False


def _settings():
    import server
    return server.settings()


def tz(settings):
    try:
        return ZoneInfo(settings.get("browserTz") or "Australia/Sydney")
    except Exception:
        return ZoneInfo("Australia/Sydney")


def now_local(settings):
    return datetime.now(tz(settings)).replace(tzinfo=None)


async def notify(settings, title, message):
    """Send a Home Assistant notification, if a notify service is configured."""
    svc = (settings.get("notifyService") or "").strip()
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not svc or not token:
        return
    try:
        import aiohttp
        url = f"http://supervisor/core/api/services/notify/{svc}"
        async with aiohttp.ClientSession() as http:
            await http.post(url, json={"title": title, "message": message},
                            headers={"Authorization": f"Bearer {token}"},
                            timeout=aiohttp.ClientTimeout(total=20))
    except Exception:
        pass


def _state():
    return store.kv_get("autoState", {}) or {}


def _save_state(**patch):
    st = _state()
    st.update(patch)
    store.kv_set("autoState", st)
    return st


async def run_auto(period, cycle, trigger="schedule"):
    """One unattended attempt: capture -> server-side sync -> Drive backup. Returns a result dict."""
    global _last_result, _auto_active
    if _auto_active or sabre.busy():
        return {"ok": False, "skipped": True, "error": "A capture is already running."}
    _auto_active = True
    try:
        return await _run_auto(period, cycle, trigger)
    finally:
        _auto_active = False


async def _run_auto(period, cycle, trigger):
    global _last_result
    settings = _settings()
    secrets = store.secrets_get()
    res = {"at": store.now_iso(), "cycle": cycle, "period": period, "trigger": trigger, "ok": False, "stage": "capture"}

    # Capture (unattended): requires a stored password; the authenticator key avoids needing a phone.
    if not secrets.get("sabrePassword") or not secrets.get("msPassword"):
        res["error"] = "Work passwords aren't saved."
        res["retryable"] = False
        _last_result = res
        return res

    job = sabre.start("capture", period, settings, secrets, auto=True)
    while job.state in ("running", "waiting_mfa", "waiting_code", "waiting_ack"):
        await asyncio.sleep(2)
    if job.state != "done" or not job.result:
        res["error"] = job.error or "Capture failed."
        res["retryable"] = sc.is_retryable(res["error"])
        store.log_add({"kind": "auto", "ok": False, "message": f"Auto capture failed: {res['error']}"})
        _last_result = res
        return res

    capture = job.result
    res["notices"] = capture.get("notices") or ""
    res["stage"] = "sync"
    try:
        token = await google_api._token(settings)
    except Exception as e:
        res["error"] = f"Google not connected: {e}"
        res["retryable"] = False
        _last_result = res
        return res

    with tempfile.TemporaryDirectory() as tmp:
        cap_f = Path(tmp) / "capture.json"
        set_f = Path(tmp) / "settings.json"
        out_f = Path(tmp) / "out.json"
        cap_f.write_text(json.dumps(capture))
        set_f.write_text(json.dumps(settings))
        env = dict(os.environ, GOOGLE_TOKEN=token)
        if os.environ.get("GOOGLE_API_BASE"):
            env["GOOGLE_API_BASE"] = os.environ["GOOGLE_API_BASE"]
        try:
            proc = await asyncio.create_subprocess_exec(
                "node", str(APP_DIR / "autosync.mjs"), str(cap_f), str(set_f), str(out_f),
                cwd=str(APP_DIR), env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            _, err = await asyncio.wait_for(proc.communicate(), timeout=180)
        except asyncio.TimeoutError:
            res["error"] = "Calendar sync timed out."
            res["retryable"] = True
            _last_result = res
            return res
        try:
            sync = json.loads(out_f.read_text())
        except Exception:
            res["error"] = f"Sync failed: {(err or b'').decode()[:200]}"
            res["retryable"] = True
            _last_result = res
            return res

    res["sync"] = sync
    if sync.get("error") == "no-duties":
        res["error"] = "Roster not published yet (no duties)."
        res["retryable"] = True
        _last_result = res
        return res
    if not sync.get("ok"):
        res["error"] = sync.get("fatal") or f"{sync.get('failed', 0)} calendar change(s) failed."
        res["retryable"] = True
        _last_result = res
        return res

    # Persist calendar ids and the capture reference, exactly like the manual flow.
    patch = {}
    if sync.get("calendars"):
        patch["calendars"] = sync["calendars"]
    if sync.get("drive"):
        patch["drive"] = sync["drive"]
    if patch:
        s = _settings()
        s.update(patch)
        store.kv_set("settings", {k: v for k, v in s.items() if k not in ("_defaults",)})
    store.kv_set("lastCapture", {"start": period["start"], "end": period["end"], "at": res["at"], "auto": True})
    store.kv_set("lastSync", {"at": res["at"], "ok": True, "created": sync.get("created", 0),
                              "updated": sync.get("updated", 0), "removed": 0, "auto": True})
    store.kv_set("lastBackup", {"at": res["at"], "ok": bool(sync.get("backup")), "files": ["Original roster", "Processed roster"]})
    store.log_add({"kind": "auto", "ok": True,
                   "message": f"Auto roster {period['start']}–{period['end']}: {sync.get('created',0)} added, {sync.get('updated',0)} updated"})
    res["ok"] = True
    res["stage"] = "done"
    _last_result = res
    return res


async def _loop():
    # A short settle before the first decision, so the server is fully up.
    await asyncio.sleep(10)
    while True:
        try:
            settings = _settings()
            action, info = sc.decide(now_local(settings), settings, _state())
            if action == "sleep":
                await asyncio.sleep(max(5, min(float(info), 900)))
                continue
            if action == "done":
                await asyncio.sleep(900)
                continue
            if _auto_active or sabre.busy():
                await asyncio.sleep(30)
                continue
            # action == "run"
            cycle = info["cycle"]
            period = info["period"]
            _save_state(cycle=cycle, status="retrying", nextAttemptAt=None, lastStart=store.now_iso())
            await notify(settings, "Roster capture starting",
                         f"Fetching the {period['start']} to {period['end']} roster…")
            result = await run_auto(period, cycle, trigger="schedule")
            if result.get("skipped"):
                await asyncio.sleep(30)
                continue
            if result["ok"]:
                s = result["sync"]
                _save_state(cycle=cycle, status="done", nextAttemptAt=None, lastResultAt=result["at"])
                extra = []
                if s.get("wouldRemove"):
                    extra.append(f"{s['wouldRemove']} event(s) are on the calendar but not on this roster — open the app to review.")
                if capture_notices(result):
                    extra.append("Sabre had notice-board messages (auto-acknowledged) — check the app.")
                await notify(settings, "Roster added to calendar",
                             f"{period['start']} to {period['end']}: {s.get('created',0)} added, {s.get('updated',0)} updated. "
                             + " ".join(extra))
            elif result.get("retryable"):
                retry_min = int(settings.get("retryMinutes", 20))
                nxt = time.time() + retry_min * 60
                _save_state(cycle=cycle, status="retrying",
                            nextAttemptAt=datetime.fromtimestamp(nxt, tz(settings)).replace(tzinfo=None).isoformat(),
                            lastError=result.get("error"))
                store.log_add({"kind": "auto", "ok": False,
                               "message": f"Auto capture will retry in {retry_min} min: {result.get('error')}"})
            else:
                _save_state(cycle=cycle, status="failed", nextAttemptAt=None, lastError=result.get("error"))
                await notify(settings, "Roster capture needs you",
                             f"Couldn't fetch the {period['start']} roster automatically: {result.get('error')} "
                             "Open the app to do it manually.")
            await asyncio.sleep(10)
        except Exception as e:
            store.log_add({"kind": "auto", "ok": False, "message": f"Scheduler error: {e}"})
            await asyncio.sleep(300)


def capture_notices(result):
    return bool(result.get("notices"))


def status():
    settings = _settings()
    st = _state()
    nxt = sc.next_publication(now_local(settings), settings.get("autoAnchorPublish", "2026-12-11"),
                              int(settings.get("autoOffsetStart", 10))) if settings.get("autoAnchorPublish") else None
    first = None
    if nxt:
        try:
            first = sc.first_attempt_at(nxt["publish"], int(settings.get("autoStartHour", 15))).isoformat()
        except Exception:
            first = None
    return {"enabled": bool(settings.get("autoEnabled")), "state": st, "next": nxt,
            "nextFirstAttempt": first, "lastResult": _last_result,
            "notifyConfigured": bool(settings.get("notifyService")), "running": sabre.busy()}


def start_background():
    global _task
    if _task is None or _task.done():
        _task = asyncio.get_event_loop().create_task(_loop())
    return _task


async def run_now(settings=None):
    """Manual 'run the automatic capture now' (for the next publication's period)."""
    settings = settings or _settings()
    nxt = sc.current_cycle(now_local(settings), settings.get("autoAnchorPublish", "2026-12-11"),
                           int(settings.get("autoOffsetStart", 10)))
    if not nxt:
        nxt = sc.next_publication(now_local(settings), settings.get("autoAnchorPublish", "2026-12-11"),
                                  int(settings.get("autoOffsetStart", 10)))
    r = await run_auto(nxt["period"], nxt.get("cycle", nxt.get("publish")), trigger="manual")
    return r
