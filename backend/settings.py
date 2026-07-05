"""Live, manager-editable service limits — global defaults + per-user overrides.

Persisted as `<data>/nptoy/settings.json`:
    {"job_timeout_sec": 300, "user_quota_bytes": ..., "max_sessions": 4,
     "users": {"<user_key>": {"user_quota_bytes": ..., "job_timeout_sec": ...}}}

`config.py` holds the initial defaults (env-overridable). A per-user override wins
over the global default for that user. Read by the worker (job timeout, keyed by the
job's owner) and the quota gate (per-user disk cap).
"""
from __future__ import annotations

import json
import threading

import config

_lock = threading.Lock()

# knob → (default, min, max) — bounds keep a fat-fingered edit from bricking things.
_SPEC = {
    "job_timeout_sec": (config.JOB_TIMEOUT_SEC, 10, 24 * 3600),
    "user_quota_bytes": (config.USER_QUOTA_BYTES, 16 * 1024 * 1024, 1024 * 1024 * 1024 * 1024),
    "max_sessions": (config.MAX_SESSIONS, 1, 64),
}


def _defaults() -> dict:
    return {k: d for k, (d, _, _) in _SPEC.items()}


def _clamp(key: str, v) -> int | None:
    _, lo, hi = _SPEC[key]
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return None


def _load_raw() -> dict:
    try:
        return json.loads(config.SETTINGS_PATH.read_text())
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _write_raw(raw: dict) -> None:
    config.SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.SETTINGS_PATH.write_text(json.dumps(raw, indent=2))


def _globals(raw: dict | None = None) -> dict:
    raw = _load_raw() if raw is None else raw
    out = _defaults()
    out.update({k: v for k, v in raw.items() if k in _SPEC})
    return out


def all() -> dict:
    with _lock:
        return _globals()


def user_overrides() -> dict:
    with _lock:
        return _load_raw().get("users", {}) or {}


def effective(key: str, user_key: str | None = None) -> int:
    with _lock:
        raw = _load_raw()
        if user_key:
            u = (raw.get("users", {}) or {}).get(user_key, {})
            if u.get(key) is not None:
                c = _clamp(key, u[key])
                if c is not None:
                    return c
        return _globals(raw).get(key, _defaults()[key])


def job_timeout_sec(user_key: str | None = None) -> int:
    return int(effective("job_timeout_sec", user_key))


def user_quota_bytes(user_key: str | None = None) -> int:
    return int(effective("user_quota_bytes", user_key))


def max_sessions() -> int:
    return int(effective("max_sessions"))


def update(patch: dict) -> dict:
    """Update the GLOBAL defaults."""
    with _lock:
        raw = _load_raw()
        for k, v in patch.items():
            if k in _SPEC:
                c = _clamp(k, v)
                if c is not None:
                    raw[k] = c
        _write_raw(raw)
        return _globals(raw)


def set_user_limit(user_key: str, patch: dict) -> dict:
    """Set (or clear, with None) a per-user override. Returns the user's overrides."""
    with _lock:
        raw = _load_raw()
        users = raw.setdefault("users", {})
        u = users.setdefault(user_key, {})
        for k, v in patch.items():
            if k not in _SPEC:
                continue
            if v is None or v == "":
                u.pop(k, None)
            else:
                c = _clamp(k, v)
                if c is not None:
                    u[k] = c
        if not u:
            users.pop(user_key, None)
        _write_raw(raw)
        return users.get(user_key, {})
