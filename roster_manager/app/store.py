"""On-disk storage in the app's /data folder: settings (kv), captures, activity log, and
encrypted secrets. JSON files written atomically so a crash can't leave half a file."""

import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

DATA = Path(os.environ.get("DATA_DIR", "/data"))
STATE = DATA / "state"
CAPS = STATE / "captures"
_lock = threading.RLock()

SECRET_FIELDS = ("msPassword", "sabrePassword", "googleClientSecret", "googleRefreshToken")


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def _read_json(path: Path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


# ---------------- kv ----------------
def kv_all():
    with _lock:
        return _read_json(STATE / "kv.json", {})


def kv_get(key, default=None):
    return kv_all().get(key, default)


def kv_set(key, value):
    with _lock:
        d = kv_all()
        d[key] = value
        _write_json(STATE / "kv.json", d)


def kv_del(key):
    with _lock:
        d = kv_all()
        d.pop(key, None)
        _write_json(STATE / "kv.json", d)


# ---------------- captures ----------------
def _safe_id(cid: str) -> str:
    if not cid or not all(c.isalnum() or c == "-" for c in cid) or len(cid) > 64:
        raise ValueError("bad id")
    return cid


def cap_list():
    with _lock:
        out = [_read_json(p, None) for p in CAPS.glob("*.json")]
    out = [c for c in out if c]
    out.sort(key=lambda c: c.get("createdAt", ""), reverse=True)
    return out


def cap_get(cid):
    return _read_json(CAPS / f"{_safe_id(cid)}.json", None)


def cap_put(c):
    with _lock:
        _write_json(CAPS / f"{_safe_id(c['id'])}.json", c)


def cap_del(cid):
    with _lock:
        try:
            (CAPS / f"{_safe_id(cid)}.json").unlink()
        except FileNotFoundError:
            pass


# ---------------- log ----------------
def log_add(entry: dict):
    e = {"id": str(uuid.uuid4()), "at": now_iso(), **entry}
    with _lock:
        STATE.mkdir(parents=True, exist_ok=True)
        with open(STATE / "log.jsonl", "a") as f:
            f.write(json.dumps(e) + "\n")
    return e


def log_list(limit=500):
    try:
        with open(STATE / "log.jsonl") as f:
            lines = f.readlines()[-limit:]
    except FileNotFoundError:
        return []
    out = []
    for line in reversed(lines):
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return out


# ---------------- export / import / wipe (never includes secrets) ----------------
def export_all():
    settings = {k: v for k, v in kv_all().items() if not any(s in k.lower() for s in ("token", "secret", "password"))}
    return {"format": "prm-backup", "version": 1, "exportedAt": now_iso(), "settings": settings,
            "captures": cap_list(), "log": log_list(5000)}


def import_all(data, replace=False):
    if not isinstance(data, dict) or data.get("format") != "prm-backup":
        raise ValueError("Not a Roster Manager backup file.")
    with _lock:
        if replace:
            wipe(keep_secrets=True)
        kv = kv_all()
        for k, v in (data.get("settings") or {}).items():
            if any(s in k.lower() for s in ("token", "secret", "password")):
                continue
            kv[k] = v
        _write_json(STATE / "kv.json", kv)
        for c in data.get("captures") or []:
            if isinstance(c, dict) and c.get("id"):
                cap_put(c)
        existing = {e["id"] for e in log_list(100000)}
        with open(STATE / "log.jsonl", "a") as f:
            for e in reversed(data.get("log") or []):
                if isinstance(e, dict) and e.get("id") not in existing:
                    f.write(json.dumps(e) + "\n")


def wipe(keep_secrets=False):
    with _lock:
        for p in CAPS.glob("*.json"):
            p.unlink()
        for name in ("kv.json", "log.jsonl"):
            try:
                (STATE / name).unlink()
            except FileNotFoundError:
                pass
        if not keep_secrets:
            for name in ("secrets.enc", "browser-cookies.enc"):
                try:
                    (DATA / name).unlink()
                except FileNotFoundError:
                    pass


# ---------------- secrets (Fernet-encrypted, key in /data/secret.key) ----------------
def _fernet():
    key_path = DATA / "secret.key"
    if not key_path.exists():
        DATA.mkdir(parents=True, exist_ok=True)
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(Fernet.generate_key())
    return Fernet(key_path.read_bytes())


def secrets_get():
    path = DATA / "secrets.enc"
    if not path.exists():
        return {}
    try:
        return json.loads(_fernet().decrypt(path.read_bytes()))
    except (InvalidToken, json.JSONDecodeError):
        return {}


def secrets_set(**updates):
    with _lock:
        s = secrets_get()
        for k, v in updates.items():
            if k not in SECRET_FIELDS:
                continue
            if v is None or v == "":
                s.pop(k, None)
            else:
                s[k] = v
        token = _fernet().encrypt(json.dumps(s).encode())
        path = DATA / "secrets.enc"
        fd, tmp = tempfile.mkstemp(dir=DATA, prefix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(token)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)


def secrets_status():
    s = secrets_get()
    return {k + "Set": bool(s.get(k)) for k in SECRET_FIELDS}


# ---------------- remembered browser sign-in (encrypted cookie jar) ----------------
# Virgin's Microsoft sign-in has no "Stay signed in", so its sign-in cookie only lives as long as the
# browser session. Keeping the cookies (session ones included) between runs is what a never-closed
# browser (like Safari on the iPad) does. Encrypted, and excluded from all backups.
def cookies_get():
    path = DATA / "browser-cookies.enc"
    if not path.exists():
        return []
    try:
        return json.loads(_fernet().decrypt(path.read_bytes()))
    except (InvalidToken, json.JSONDecodeError):
        return []


def cookies_set(cookies):
    with _lock:
        token = _fernet().encrypt(json.dumps(cookies).encode())
        path = DATA / "browser-cookies.enc"
        fd, tmp = tempfile.mkstemp(dir=DATA, prefix=".tmp")
        with os.fdopen(fd, "wb") as f:
            f.write(token)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)


def cookies_clear():
    try:
        (DATA / "browser-cookies.enc").unlink()
    except FileNotFoundError:
        pass
