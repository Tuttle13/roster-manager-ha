"""Roster Manager HA app: web server behind Home Assistant ingress (port 8099)."""

import json
import os
from pathlib import Path

from aiohttp import web

import google_api
import sabre
import store

WWW = Path(__file__).parent / "www"
VERSION = "0.4.2"
# Home Assistant's ingress proxy. Nothing else may talk to this app.
ALLOWED_PEERS = {"172.30.32.2"} | ({"127.0.0.1", "::1"} if os.environ.get("DEV") else set())

DEFAULT_SETTINGS = {
    "sabreUrl": "https://cia.virginaustralia.com/cia/index.page",
    "rosterUrl": "",
    "msEmail": "piran.gartner@virginaustralia.com",
    "sabreUserId": "21032",
    "browserTz": "Australia/Sydney",
}


def settings():
    s = dict(DEFAULT_SETTINGS)
    s.update(store.kv_get("settings", {}) or {})
    return s


@web.middleware
async def guard(request, handler):
    if request.remote not in ALLOWED_PEERS:
        return web.Response(status=403, text="Forbidden")
    try:
        resp = await handler(request)
    except web.HTTPException:
        raise
    except google_api.AuthError as e:
        return web.json_response({"error": str(e), "auth": True}, status=401)
    except (ValueError, RuntimeError) as e:
        return web.json_response({"error": str(e)}, status=400)
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


routes = web.RouteTableDef()


@routes.get("/")
async def index(_):
    return web.FileResponse(WWW / "index.html")


# ---------- kv / captures / log ----------
@routes.get("/api/kv")
async def kv_all(_):
    return web.json_response(store.kv_all())


@routes.get("/api/kv/{key}")
async def kv_get(r):
    v = store.kv_get(r.match_info["key"])
    return web.json_response({"value": v})


@routes.put("/api/kv/{key}")
async def kv_put(r):
    key = r.match_info["key"]
    if any(s in key.lower() for s in ("token", "secret", "password")):
        raise ValueError("Use the credentials endpoint for secrets.")
    store.kv_set(key, (await r.json())["value"])
    return web.json_response({"ok": True})


@routes.delete("/api/kv/{key}")
async def kv_del(r):
    store.kv_del(r.match_info["key"])
    return web.json_response({"ok": True})


@routes.get("/api/captures")
async def caps(_):
    return web.json_response(store.cap_list())


@routes.get("/api/captures/{id}")
async def cap_get(r):
    c = store.cap_get(r.match_info["id"])
    return web.json_response(c) if c else web.json_response({"error": "not found"}, status=404)


@routes.put("/api/captures/{id}")
async def cap_put(r):
    c = await r.json()
    if c.get("id") != r.match_info["id"]:
        raise ValueError("id mismatch")
    store.cap_put(c)
    return web.json_response({"ok": True})


@routes.delete("/api/captures/{id}")
async def cap_del(r):
    store.cap_del(r.match_info["id"])
    return web.json_response({"ok": True})


@routes.get("/api/log")
async def log_list(_):
    return web.json_response(store.log_list())


@routes.post("/api/log")
async def log_add(r):
    e = await r.json()
    e.pop("id", None); e.pop("at", None)
    return web.json_response(store.log_add(e))


@routes.get("/api/export")
async def export(_):
    return web.json_response(store.export_all())


@routes.post("/api/import")
async def import_(r):
    store.import_all(await r.json(), replace=r.query.get("replace") == "1")
    return web.json_response({"ok": True})


@routes.post("/api/wipe")
async def wipe(_):
    await google_api.disconnect(settings())
    store.wipe()
    return web.json_response({"ok": True})


# ---------- credentials (write-only) ----------
@routes.get("/api/creds")
async def creds_status(_):
    return web.json_response(store.secrets_status())


@routes.put("/api/creds")
async def creds_set(r):
    body = await r.json()
    allowed = {k: body[k] for k in ("msPassword", "sabrePassword", "googleClientSecret") if k in body}
    store.secrets_set(**allowed)
    store.log_add({"kind": "settings", "ok": True, "message": "Updated saved " + ", ".join(
        {"msPassword": "Microsoft password", "sabrePassword": "Sabre password", "googleClientSecret": "Google client secret"}[k] for k in allowed)})
    return web.json_response(store.secrets_status())


# ---------- Sabre ----------
@routes.post("/api/sabre/start")
async def sabre_start(r):
    body = await r.json()
    mode = "test" if body.get("mode") == "test" else "capture"
    job = sabre.start(mode, body.get("period"), settings(), store.secrets_get())
    return web.json_response(job.public())


@routes.get("/api/sabre/status")
async def sabre_status(_):
    j = sabre.current
    return web.json_response(j.public() if j else {"state": "idle"})


@routes.get("/api/sabre/result")
async def sabre_result(_):
    j = sabre.current
    if not j or j.result is None:
        return web.json_response({"error": "No result"}, status=404)
    return web.json_response(j.result)


@routes.post("/api/sabre/code")
async def sabre_code(r):
    j = sabre.current
    code = str((await r.json()).get("code", "")).strip()
    if not j or j.state != "waiting_code" or not code.isdigit():
        raise ValueError("No code is being asked for, or the code isn't a number.")
    j.code = code
    return web.json_response({"ok": True})


@routes.post("/api/sabre/decide")
async def sabre_decide(r):
    j = sabre.current
    action = (await r.json()).get("action")
    if not j or j.state != "waiting_ack" or action not in ("ack", "stop"):
        raise ValueError("Nothing is waiting for a decision.")
    j.decision = action
    return web.json_response({"ok": True})


@routes.post("/api/sabre/cancel")
async def sabre_cancel(_):
    if sabre.current:
        sabre.current.cancelled = True
    return web.json_response({"ok": True})


@routes.get("/api/sabre/debug.zip")
async def sabre_debug(r):
    name, data = sabre.debug_zip(r.query.get("id"))
    if not data:
        return web.json_response({"error": "No diagnostics yet"}, status=404)
    return web.Response(body=data, content_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})


@routes.get("/api/sabre/shot/{job}/{name}")
async def sabre_shot(r):
    p = sabre.debug_file(r.match_info["job"], r.match_info["name"])
    return web.FileResponse(p) if p else web.Response(status=404)


@routes.post("/api/sabre/forget-session")
async def sabre_forget(_):
    if sabre.busy():
        raise RuntimeError("Wait for the current run to finish.")
    import shutil
    shutil.rmtree(store.DATA / "browser", ignore_errors=True)
    store.cookies_clear()
    store.log_add({"kind": "settings", "ok": True, "message": "Cleared the remembered Microsoft/Sabre browser session"})
    return web.json_response({"ok": True})


# ---------- Google ----------
@routes.get("/api/google/status")
async def g_status(_):
    return web.json_response(google_api.status(settings()))


@routes.post("/api/google/auth-url")
async def g_auth(r):
    body = await r.json()
    return web.json_response({"url": google_api.auth_url(settings(), body.get("returnUrl", ""))})


@routes.post("/api/google/exchange")
async def g_exchange(r):
    body = await r.json()
    return web.json_response(await google_api.exchange(settings(), body.get("code", ""), body.get("state", "")))


@routes.post("/api/google/disconnect")
async def g_disconnect(_):
    await google_api.disconnect(settings())
    store.log_add({"kind": "google", "ok": True, "message": "Disconnected Google account"})
    return web.json_response({"ok": True})


@routes.route("*", "/api/gproxy/{tail:.*}")
async def g_proxy(r):
    body = await r.read() if r.can_read_body else None
    status, ctype, data = await google_api.proxy(settings(), r.method, r.match_info["tail"], r.query_string, body, r.headers.get("Content-Type"))
    return web.Response(status=status, body=data, content_type=(ctype or "application/json").split(";")[0])


@routes.get("/api/version")
async def version(_):
    return web.json_response({"version": VERSION})


def make_app():
    app = web.Application(middlewares=[guard], client_max_size=50 * 1024 * 1024)
    app.add_routes(routes)
    app.router.add_static("/", WWW, show_index=False)
    return app


if __name__ == "__main__":
    store.DATA.mkdir(parents=True, exist_ok=True)
    web.run_app(make_app(), host="0.0.0.0", port=int(os.environ.get("PORT", 8099)), access_log=None)
