"""Per-slot personal library — save/load a single input file (physics, detector,
reaction, cross-section, analysis) under a name, INDEPENDENTLY of full presets, with
optional cross-user sharing.

Mirrors saves.py's ownership/share model but one file per entry:
    user/<key>/slotlib/<slot>/<id>/{meta.json, data}   (owner's copy)
    common/shared-slots/<slot>/<id>/{meta.json, data}   (mirror when shared)
"""
from __future__ import annotations

import json
import re
import shutil
import uuid
from pathlib import Path

import config

SLOTS = {"physics", "detector", "reaction", "crosssection", "analysis"}
_DATA = "data"
_META = "meta.json"


def _slug(s: str, n: int = 32) -> str:
    out = re.sub(r"[^A-Za-z0-9_-]+", "-", (s or "").strip()).strip("-")
    return out[:n] or "untitled"


def _check(slot: str) -> None:
    if slot not in SLOTS:
        raise KeyError(slot)


def _lib_root(user_key: str, slot: str) -> Path:
    return config.USERS_ROOT / user_key / "slotlib" / slot


def _shared_root(slot: str) -> Path:
    return config.COMMON_ROOT / "shared-slots" / slot


def _read_meta(d: Path) -> dict | None:
    try:
        return json.loads((d / _META).read_text())
    except (OSError, ValueError):
        return None


def _entry(m: dict, mine: bool) -> dict:
    return {"id": m["id"], "name": m.get("name", ""), "mine": mine,
            "shared": bool(m.get("shared")), "owner_name": m.get("owner_name", "")}


def list_for(user_key: str, slot: str) -> list[dict]:
    """Own entries + entries shared by OTHER users, for this slot."""
    _check(slot)
    out: list[dict] = []
    mine = _lib_root(user_key, slot)
    if mine.exists():
        for d in sorted(mine.iterdir()):
            m = _read_meta(d)
            if m:
                out.append(_entry(m, True))
    sh = _shared_root(slot)
    if sh.exists():
        for d in sorted(sh.iterdir()):
            m = _read_meta(d)
            if m and m.get("owner") != user_key:
                out.append(_entry(m, False))
    return out


def _entry_dir(user_key: str, slot: str, sid: str) -> Path:
    return _lib_root(user_key, slot) / sid


def _mirror(user_key: str, slot: str, sid: str, shared: bool) -> None:
    dst = _shared_root(slot) / sid
    if shared:
        src = _entry_dir(user_key, slot, sid)
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src / _DATA, dst / _DATA)
        shutil.copyfile(src / _META, dst / _META)
    else:
        shutil.rmtree(dst, ignore_errors=True)


def save(user_key: str, owner_name: str, slot: str, name: str, content: str,
         shared: bool = False) -> dict:
    _check(slot)
    sid = f"{_slug(name)}.{_slug(owner_name)}.{uuid.uuid4().hex[:6]}"
    d = _entry_dir(user_key, slot, sid)
    d.mkdir(parents=True, exist_ok=True)
    (d / _DATA).write_text(content)
    meta = {"id": sid, "name": (name or "").strip()[:80] or sid, "slot": slot,
            "owner": user_key, "owner_name": owner_name, "shared": bool(shared)}
    (d / _META).write_text(json.dumps(meta, indent=2))
    if shared:
        _mirror(user_key, slot, sid, True)
    return _entry(meta, True)


def load(user_key: str, slot: str, sid: str) -> str:
    _check(slot)
    d = _entry_dir(user_key, slot, sid)
    if not (d / _DATA).exists():
        d = _shared_root(slot) / sid          # maybe a shared entry from another user
    if not (d / _DATA).exists():
        raise KeyError(sid)
    return (d / _DATA).read_text()


def set_shared(user_key: str, slot: str, sid: str, shared: bool) -> dict:
    _check(slot)
    d = _entry_dir(user_key, slot, sid)
    m = _read_meta(d)
    if not m:
        raise KeyError(sid)
    if m.get("owner") != user_key:
        raise PermissionError("not owner")
    m["shared"] = bool(shared)
    (d / _META).write_text(json.dumps(m, indent=2))
    _mirror(user_key, slot, sid, bool(shared))
    return _entry(m, True)


def delete(user_key: str, slot: str, sid: str) -> None:
    _check(slot)
    d = _entry_dir(user_key, slot, sid)
    if not _read_meta(d):
        raise KeyError(sid)
    _mirror(user_key, slot, sid, False)       # drop any shared mirror first
    shutil.rmtree(d, ignore_errors=True)
