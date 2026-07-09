"""Read the current portal account profile from the shared portal DB.

Portal JWTs are minted at login, so profile edits made later can leave services
showing stale names/avatars. nptoy runs in the same portal container and data
volume, so it can read the portal SQLite DB as the source of truth.
"""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

MANAGER_COLOR = os.environ.get("MANAGER_COLOR", "#111827")


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


def current(payload: dict) -> dict:
    """Return latest profile fields for this portal token payload.

    Falls back to the payload if the portal DB is unavailable, which keeps local
    dev and tests working.
    """
    out = dict(payload or {})
    db = _db_path()
    if not db.is_file():
        return out
    uid = str(payload.get("sub") or "").strip()
    email = (payload.get("email") or "").strip()
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        try:
            row = None
            if uid.isdigit():
                row = con.execute(
                    "SELECT username, display_name, email, role, profile_color, profile_shape "
                    "FROM users WHERE id=? AND is_active=1",
                    (int(uid),),
                ).fetchone()
            if row is None and email:
                row = con.execute(
                    "SELECT username, display_name, email, role, profile_color, profile_shape "
                    "FROM users WHERE email=? AND is_active=1",
                    (email,),
                ).fetchone()
            if row is None:
                return out
            role = row["role"] or out.get("role") or out.get("prole") or "user"
            out.update({
                "username": row["username"] or out.get("username"),
                "email": row["email"] or out.get("email"),
                "name": row["display_name"] or row["username"] or row["email"] or out.get("name"),
                "role": role,
                "prole": role,
                "color": MANAGER_COLOR if role == "manager" else (row["profile_color"] or ""),
                "shape": row["profile_shape"] or "",
            })
            return out
        finally:
            con.close()
    except Exception:
        return out
