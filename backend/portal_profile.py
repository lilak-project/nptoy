"""Fetch the current portal account profile from the portal's /api/introspect.

Portal JWTs are minted at login, so a later role change or profile edit can leave
services showing a stale role/name/avatar. This asks the portal for the LIVE
identity of a token instead of trusting the claim — the one canonical mechanism the
portal exposes for every service (see service_manager .../accounts.py introspect).

Previously this read the portal SQLite file directly, which coupled nptoy to the
portal's private `users` schema (a column rename silently broke it). The endpoint
decouples that; on any failure we fall back to the token payload so local dev and a
briefly-unreachable portal keep working.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.error
import urllib.request
from pathlib import Path

MANAGER_COLOR = os.environ.get("MANAGER_COLOR", "#111827")
_PORTAL_PORT = os.environ.get("PORTAL_PORT")
_INTROSPECT_TTL = 20                          # seconds; caps portal calls per token
_cache: dict[str, tuple[float, dict]] = {}    # token -> (expiry_monotonic, fresh)


def _introspect(token: str | None) -> dict | None:
    """LIVE profile for a portal token via the portal's /api/introspect, cached
    briefly. None if there's no token/port or the portal is unreachable."""
    if not token or not _PORTAL_PORT:
        return None
    now = time.monotonic()
    hit = _cache.get(token)
    if hit and hit[0] > now:
        return hit[1]
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{_PORTAL_PORT}/api/introspect",
            headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=2) as r:
            fresh = json.loads(r.read())
    except Exception:
        return None
    if len(_cache) > 512:                     # bound the map (tokens rotate daily)
        for k, (exp, _) in list(_cache.items()):
            if exp <= now:
                _cache.pop(k, None)
    _cache[token] = (now + _INTROSPECT_TTL, fresh)
    return fresh


def _db_path() -> Path:
    root = Path(os.environ.get("PORTAL_DATA_ROOT", "/app/data"))
    return root / "_portal" / "portal.db"


def list_accounts() -> list[dict]:
    """All active portal accounts as [{email, username, display_name}]. Lets callers
    map a workspace user_key (derived from email) back to a human identity. Returns []
    if the portal DB is unavailable."""
    db = _db_path()
    if not db.is_file():
        return []
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                "SELECT email, username, display_name FROM users WHERE is_active=1"
            ).fetchall()
            return [{"email": r["email"], "username": r["username"],
                     "display_name": r["display_name"]} for r in rows]
        finally:
            con.close()
    except Exception:
        return []


def current(payload: dict, token: str | None = None) -> dict:
    """Return the LIVE profile for this portal token, merged over the token payload.

    Asks the portal's /api/introspect (the canonical source); falls back to the raw
    token claims when there's no token or the portal is unreachable, so local dev and
    a briefly-down portal keep working. The endpoint already applies the manager
    colour, so `color` is used as-is.
    """
    out = dict(payload or {})
    fresh = _introspect(token)
    if not fresh:
        return out
    role = fresh.get("role") or fresh.get("prole") or out.get("prole") or out.get("role") or "user"
    out.update({
        "username": fresh.get("username") or out.get("username"),
        "email": fresh.get("email") or out.get("email"),
        "name": fresh.get("name") or out.get("name"),
        "role": role,
        "prole": role,
        "color": fresh.get("color") or "",
        "shape": fresh.get("shape") or "",
    })
    return out
