"""Sends upcoming rostered flights to the Pilot Logbook integration on this Home Assistant.

The logbook app uses them to pre-fill a new entry (route + planned flight time) while you're
flying that sector, even offline. Only flights are sent: flight number, ports, planned times,
aircraft code and planned flight time. Nothing else from the roster leaves this app.

Runs on its own: shortly after start-up, whenever a capture is saved or changed, and every
6 hours. If the Pilot Logbook isn't installed, it quietly does nothing.
"""

import asyncio
import json
import logging
import os
import re
from datetime import date, timedelta
from pathlib import Path

import store

_LOG = logging.getLogger("logbook_feed")
URL = "http://supervisor/core/api/pilot_logbook/roster"
TZ_JS = Path(__file__).parent / "www" / "js" / "tz.js"
SECTOR_TYPES = {"FLIGHT", "POSITIONING"}
PAST_DAYS, FUTURE_DAYS = 3, 21
CHECK_EVERY = 60            # seconds between looks for changed captures
RESEND_EVERY = 6 * 3600     # resend anyway, in case Home Assistant restarted
RETRY_EVERY = 5 * 60        # after a failed send (e.g. Home Assistant was restarting), try again this soon

_status = {"lastSent": None, "lastResult": None, "sectors": 0}


def status():
    return dict(_status)


def _airport_tz():
    """Airport -> time zone, read from the same table the panel uses (tz.js), plus your overrides."""
    table = {}
    try:
        text = TZ_JS.read_text(encoding="utf-8")
        body = text.split("AIRPORT_TZ", 1)[1].split("};", 1)[0]
        table = {k: v for k, v in re.findall(r"\b([A-Z]{3})\s*:\s*'([^']+)'", body)}
    except Exception:  # noqa: BLE001
        pass
    settings = store.kv_get("settings", {}) or {}
    for k, v in (settings.get("tzOverrides") or {}).items():
        if k and v:
            table[str(k).strip().upper()] = str(v).strip()
    return table


def _stamp(s, tz):
    if not s or not s.get("dt"):
        return None
    port = (s.get("port") or "").strip().upper()
    basis = s.get("basis") or "local"
    zone = tz.get(port) if basis == "local" else "UTC"
    if not zone:
        return None
    return {"dt": s["dt"][:16], "basis": basis, "port": port, "tz": zone}


def build_sectors(today=None):
    """Flights from your captures; for each day, the newest capture that covers it wins."""
    today = today or date.today()
    lo, hi = (today - timedelta(days=PAST_DAYS)).isoformat(), (today + timedelta(days=FUTURE_DAYS)).isoformat()
    caps = [c for c in store.cap_list() if c and c.get("duties")]
    caps.sort(key=lambda c: c.get("createdAt") or "")
    by_day = {}
    for c in caps:
        per = c.get("period") or {}
        days = {d.get("date") for d in c["duties"] if d.get("date")}
        if per.get("start") and per.get("end"):
            d0 = date.fromisoformat(per["start"])
            while d0.isoformat() <= per["end"]:
                days.add(d0.isoformat())
                d0 += timedelta(days=1)
        for day in days:
            if lo <= day <= hi:
                by_day[day] = [d for d in c["duties"] if d.get("date") == day]
    tz = _airport_tz()
    out = []
    for day in sorted(by_day):
        for d in by_day[day]:
            if d.get("type") not in SECTOR_TYPES or not d.get("dep") or not d.get("arr"):
                continue
            dep, arr = _stamp(d.get("start"), tz), _stamp(d.get("end"), tz)
            if not dep or not arr:
                continue
            out.append({
                "date": day, "flight": d.get("flightNumber") or "", "pax": d.get("type") == "POSITIONING",
                "from": d["dep"].upper(), "to": d["arr"].upper(), "dep": dep, "arr": arr,
                "aircraft": d.get("aircraft") or "", "flightTime": d.get("flightTime") or "",
            })
    return out


async def push():
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return
    sectors = await asyncio.get_running_loop().run_in_executor(None, build_sectors)
    try:
        import aiohttp
        async with aiohttp.ClientSession() as http:
            async with http.post(URL, json={"source": "roster_manager", "sectors": sectors},
                                 headers={"Authorization": f"Bearer {token}"},
                                 timeout=aiohttp.ClientTimeout(total=30)) as r:
                _status.update(lastSent=store.now_iso(), sectors=len(sectors),
                               lastResult="ok" if r.status == 200 else ("logbook not installed" if r.status == 404 else f"HTTP {r.status}"))
    except Exception as err:  # noqa: BLE001 - never disturb the roster app
        _status.update(lastSent=store.now_iso(), lastResult=f"error: {err or type(err).__name__}")
    ok = _status["lastResult"] == "ok"
    print(f"Pilot Logbook: sent {len(sectors)} rostered flights" if ok else
          f"Pilot Logbook: could not send rostered flights ({_status['lastResult']}), trying again in {RETRY_EVERY // 60} min", flush=True)
    return ok


def _fingerprint():
    try:
        return sorted((p.name, p.stat().st_mtime_ns) for p in store.CAPS.glob("*.json")) + \
               [json.dumps((store.kv_get("settings", {}) or {}).get("tzOverrides") or {}, sort_keys=True)]
    except Exception:  # noqa: BLE001
        return None


async def _loop():
    await asyncio.sleep(45)          # let Home Assistant finish starting
    seen, last, ok = None, 0.0, True
    loop = asyncio.get_running_loop()
    while True:
        try:
            fp = _fingerprint()
            wait = RESEND_EVERY if ok else RETRY_EVERY
            if fp != seen or loop.time() - last >= wait:
                ok = await push() is not False
                seen, last = fp, loop.time()
        except Exception:  # noqa: BLE001
            ok, last = False, loop.time()
        await asyncio.sleep(CHECK_EVERY)


def start_background():
    asyncio.get_event_loop().create_task(_loop())
