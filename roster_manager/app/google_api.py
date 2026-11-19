"""Google OAuth (server-side, long-lived refresh token stored encrypted) and a narrow proxy
for the Calendar/Drive calls the panel makes. Only the app-created calendar and app-created
Drive files are reachable, because those are the only permissions requested."""

import base64
import json
import secrets as pysecrets
import time
from urllib.parse import urlencode

import os

import aiohttp

import store

SCOPES = [
    "https://www.googleapis.com/auth/calendar.app.created",
    "https://www.googleapis.com/auth/drive.file",
]
DEFAULT_RELAY = "https://tuttle13.github.io/roster-manager/oauth-relay.html"
API_BASE = os.environ.get("GOOGLE_API_BASE", "https://www.googleapis.com")  # override for local tests only
TOKEN_URL = os.environ.get("GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token")
ALLOWED_PREFIXES = ("calendar/v3/", "drive/v3/", "upload/drive/v3/")

_access = {"token": None, "exp": 0}
_pending = {}  # state -> created time


class AuthError(Exception):
    pass


def relay_uri(settings):
    return (settings.get("googleRedirectUri") or DEFAULT_RELAY).strip()


def status(settings):
    s = store.secrets_get()
    return {
        "clientId": bool(settings.get("googleClientId")),
        "clientSecret": bool(s.get("googleClientSecret")),
        "connected": bool(s.get("googleRefreshToken")),
        "redirectUri": relay_uri(settings),
        "account": settings.get("googleAccount") or "",
    }


def auth_url(settings, return_url):
    cid = settings.get("googleClientId")
    if not cid:
        raise ValueError("Add the Google Client ID in Settings first.")
    if not store.secrets_get().get("googleClientSecret"):
        raise ValueError("Add the Google Client secret in Settings first.")
    token = pysecrets.token_urlsafe(18)
    now = time.time()
    for k in [k for k, t in _pending.items() if now - t > 900]:
        _pending.pop(k, None)
    _pending[token] = now
    ret = base64.urlsafe_b64encode((return_url or "").encode()).decode().rstrip("=")
    q = {
        "client_id": cid, "redirect_uri": relay_uri(settings), "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent",
        "include_granted_scopes": "true", "state": f"{token}.{ret}",
    }
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(q)


async def exchange(settings, code, state):
    token = (state or "").split(".")[0]
    if not token or token not in _pending:
        raise ValueError("This sign-in link has expired or didn't come from this app. Start Connect Google again.")
    _pending.pop(token, None)
    s = store.secrets_get()
    data = {
        "code": code, "client_id": settings.get("googleClientId"), "client_secret": s.get("googleClientSecret"),
        "redirect_uri": relay_uri(settings), "grant_type": "authorization_code",
    }
    async with aiohttp.ClientSession() as http:
        async with http.post(TOKEN_URL, data=data, timeout=aiohttp.ClientTimeout(total=30)) as r:
            j = await r.json(content_type=None)
    if "refresh_token" not in j:
        raise ValueError(f"Google didn't return a long-term token: {j.get('error_description') or j.get('error') or j}")
    granted = set((j.get("scope") or "").split())
    missing = [x.rsplit("/", 1)[-1] for x in SCOPES if x not in granted]
    store.secrets_set(googleRefreshToken=j["refresh_token"])
    _access.update(token=j.get("access_token"), exp=time.time() + int(j.get("expires_in", 3600)) - 60)
    store.log_add({"kind": "google", "ok": not missing, "message": "Connected Google account" + (f" (missing: {', '.join(missing)})" if missing else "")})
    return {"missing": missing}


async def _token(settings, force=False):
    if not force and _access["token"] and time.time() < _access["exp"]:
        return _access["token"]
    s = store.secrets_get()
    if not s.get("googleRefreshToken"):
        raise AuthError("Google isn't connected. Settings → Connect Google.")
    data = {
        "client_id": settings.get("googleClientId"), "client_secret": s.get("googleClientSecret"),
        "refresh_token": s["googleRefreshToken"], "grant_type": "refresh_token",
    }
    async with aiohttp.ClientSession() as http:
        async with http.post(TOKEN_URL, data=data, timeout=aiohttp.ClientTimeout(total=30)) as r:
            j = await r.json(content_type=None)
    if "access_token" not in j:
        if j.get("error") in ("invalid_grant", "unauthorized_client", "invalid_client"):
            store.secrets_set(googleRefreshToken="")
            raise AuthError("Google access was revoked or expired. Settings → Connect Google again.")
        raise RuntimeError(f"Google token refresh failed: {j.get('error_description') or j.get('error')}")
    _access.update(token=j["access_token"], exp=time.time() + int(j.get("expires_in", 3600)) - 60)
    return _access["token"]


async def disconnect(settings):
    s = store.secrets_get()
    rt = s.get("googleRefreshToken")
    store.secrets_set(googleRefreshToken="")
    _access.update(token=None, exp=0)
    if rt:
        try:
            async with aiohttp.ClientSession() as http:
                await http.post("https://oauth2.googleapis.com/revoke", data={"token": rt}, timeout=aiohttp.ClientTimeout(total=15))
        except Exception:
            pass


async def proxy(settings, method, tail, query, body, content_type):
    if not tail.startswith(ALLOWED_PREFIXES) or ".." in tail:
        return 403, "application/json", json.dumps({"error": {"message": "Not allowed"}}).encode()
    url = f"{API_BASE}/{tail}" + (f"?{query}" if query else "")
    for attempt in range(2):
        tok = await _token(settings, force=attempt == 1)
        headers = {"Authorization": f"Bearer {tok}"}
        if content_type:
            headers["Content-Type"] = content_type
        async with aiohttp.ClientSession() as http:
            async with http.request(method, url, data=body or None, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as r:
                data = await r.read()
                if r.status == 401 and attempt == 0:
                    continue
                return r.status, r.headers.get("Content-Type", "application/json"), data
    return 401, "application/json", json.dumps({"error": {"message": "Google session invalid"}}).encode()
