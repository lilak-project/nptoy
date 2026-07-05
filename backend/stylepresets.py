"""Named viewer style presets (per-user, shareable).

A style preset is a small JSON blob — the SimulationTab `styles` map (per-volume
display overrides: mode / edge / fill / opacity / width / label / highlight). Stored
per-user at `user/<key>/styles/<id>.json`; when shared, mirrored to
`common/styles_shared/<id>.json` so other users can load it. Much lighter than
saves.py (no workspace snapshot) — just the style dict + a little metadata.
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import config

SHARED_DIR = config.COMMON_ROOT / "styles_shared"


def _slug(s: str, n: int = 32) -> str:
    """Filename/URL-safe slug (ASCII); non-ASCII names fall back to 'untitled'."""
    out = re.sub(r"[^A-Za-z0-9_-]+", "-", (s or "").strip()).strip("-")
    return out[:n] or "untitled"


def _new_id(name: str, owner_name: str) -> str:
    """Human-readable storage id: `{name}.{user}.{hex}` (hex keeps it unique)."""
    return f"{_slug(name)}.{_slug(owner_name)}.{uuid.uuid4().hex[:6]}"


def _user_dir(user_key: str) -> Path:
    return config.USERS_ROOT / user_key / "styles"


def _read(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, ValueError, OSError):
        return None


def _meta(m: dict, mine: bool) -> dict:
    """Public listing shape (never leaks the style data itself)."""
    return {
        "id": m["id"], "name": m.get("name", ""), "owner": m.get("owner"),
        "owner_name": m.get("owner_name", ""), "shared": bool(m.get("shared")),
        "created": m.get("created", ""), "mine": mine,
    }


def list_for(user_key: str) -> list[dict]:
    out = []
    d = _user_dir(user_key)
    if d.exists():                                     # my own presets
        for p in d.glob("*.json"):
            m = _read(p)
            if m:
                out.append(_meta(m, True))
    if SHARED_DIR.exists():                            # others' shared presets
        for p in SHARED_DIR.glob("*.json"):
            m = _read(p)
            if m and m.get("owner") != user_key:
                out.append(_meta(m, False))
    out.sort(key=lambda m: m.get("created", ""), reverse=True)
    return out


def save(user_key: str, owner_name: str, name: str, data: dict, shared: bool) -> dict:
    d = _user_dir(user_key)
    d.mkdir(parents=True, exist_ok=True)
    sid = _new_id(name, owner_name)
    m = {
        "id": sid, "name": (name or "untitled").strip()[:80],
        "owner": user_key, "owner_name": owner_name, "shared": bool(shared),
        "created": datetime.now(timezone.utc).isoformat(), "data": data or {},
    }
    (d / f"{sid}.json").write_text(json.dumps(m, indent=2))
    if shared:
        SHARED_DIR.mkdir(parents=True, exist_ok=True)
        (SHARED_DIR / f"{sid}.json").write_text(json.dumps(m, indent=2))
    return _meta(m, True)


def load(user_key: str, sid: str) -> dict:
    """The style dict for a preset the user may load (own or shared)."""
    m = _read(_user_dir(user_key) / f"{sid}.json")
    if not m:
        m = _read(SHARED_DIR / f"{sid}.json")
    if not m:
        raise KeyError(sid)
    return m.get("data", {})


def set_shared(user_key: str, sid: str, shared: bool) -> dict:
    p = _user_dir(user_key) / f"{sid}.json"
    m = _read(p)
    if not m or m.get("owner") != user_key:
        raise PermissionError("not owner")
    m["shared"] = bool(shared)
    p.write_text(json.dumps(m, indent=2))
    sp = SHARED_DIR / f"{sid}.json"
    if shared:
        SHARED_DIR.mkdir(parents=True, exist_ok=True)
        sp.write_text(json.dumps(m, indent=2))
    else:
        sp.unlink(missing_ok=True)
    return _meta(m, True)


def delete(user_key: str, sid: str) -> None:
    p = _user_dir(user_key) / f"{sid}.json"
    m = _read(p)
    if not m or m.get("owner") != user_key:
        raise PermissionError("not owner")
    p.unlink(missing_ok=True)
    (SHARED_DIR / f"{sid}.json").unlink(missing_ok=True)
