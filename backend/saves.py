"""User presets (named snapshots of the input workspace) + cross-user sharing.

A save is a snapshot of the user's `inputs/`, stored per-user under
`user/<key>/saves/<id>/{meta.json, files/}`. When shared, a mirror is written to
`common/shared/<id>/` so other users can load it like a preset. Loading a save (own
or shared) copies its `files/` back into the loader's `inputs/`.

Replaces the old top-level `configs/` store; same UI shape (id / name / mine /
shared / owner_name), just relocated into the per-user + common layout.
"""
from __future__ import annotations

import json
import re
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

import common
import config
import inputs

# transient run artifacts that must never end up inside a snapshot
_IGNORE = shutil.ignore_patterns("online_stream.dat", "*.root", "*.gdml", ".DS_Store")


def _slug(s: str, n: int = 32) -> str:
    """Filename/URL-safe slug (ASCII); non-ASCII names fall back to 'untitled'."""
    out = re.sub(r"[^A-Za-z0-9_-]+", "-", (s or "").strip()).strip("-")
    return out[:n] or "untitled"


def _new_id(name: str, owner_name: str) -> str:
    """Human-readable storage id: `{name}.{user}.{hex}` — the hex keeps it unique
    across duplicate names and cross-user shares. Used verbatim as the dir name."""
    return f"{_slug(name)}.{_slug(owner_name)}.{uuid.uuid4().hex[:6]}"


def _saves_root(user_key: str) -> Path:
    return inputs.saves_dir(user_key)


def _save_dir(user_key: str, sid: str) -> Path:
    return _saves_root(user_key) / sid


def _shared_dir(sid: str) -> Path:
    return common.SHARED_DIR / sid


def _read_meta(p: Path) -> dict | None:
    try:
        return json.loads((p / "meta.json").read_text())
    except (FileNotFoundError, ValueError, OSError):
        return None


def _copy_snapshot(src_files: Path, dst_dir: str, owner_key: str, owner_name: str, m: dict) -> None:
    """Write meta.json + files/ into dst_dir (a save or shared dir)."""
    d = Path(dst_dir)
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    shutil.copytree(src_files, d / "files", ignore=_IGNORE)
    (d / "meta.json").write_text(json.dumps(m, indent=2))


def save(user_key: str, owner_name: str, name: str, shared: bool) -> dict:
    inputs.ensure(user_key, owner_name)
    sid = _new_id(name, owner_name)
    meta = {
        "id": sid, "name": (name or "untitled").strip()[:80],
        "owner": user_key, "owner_name": owner_name, "shared": bool(shared),
        "created": datetime.now(timezone.utc).isoformat(),
    }
    _copy_snapshot(inputs.root(user_key), str(_save_dir(user_key, sid)),
                   user_key, owner_name, meta)
    if shared:
        _copy_snapshot(inputs.root(user_key), str(_shared_dir(sid)),
                       user_key, owner_name, meta)
    inputs.set_setup_name(user_key, meta["name"])   # top bar reflects the saved name
    return meta


def list_for(user_key: str) -> list[dict]:
    out = []
    root = _saves_root(user_key)
    if root.exists():                                   # my own saves
        for d in root.iterdir():
            m = _read_meta(d)
            if m:
                out.append({**m, "mine": True})
    if common.SHARED_DIR.exists():                      # others' shared saves
        for d in common.SHARED_DIR.iterdir():
            m = _read_meta(d)
            if m and m.get("owner") != user_key:
                out.append({**m, "mine": False, "shared": True})
    out.sort(key=lambda m: m.get("created", ""), reverse=True)
    return out


def shared_sources() -> list[dict]:
    """Users who have shared inputs, each with their shared items — for the loader's
    project/user dropdown. [{owner, owner_name, items:[{id,name}]}]."""
    groups: dict[str, dict] = {}
    if common.SHARED_DIR.exists():
        for d in common.SHARED_DIR.iterdir():
            m = _read_meta(d)
            if m:
                g = groups.setdefault(m["owner"], {
                    "owner": m["owner"], "owner_name": m.get("owner_name", ""), "items": []})
                g["items"].append({"id": m["id"], "name": m["name"]})
    for g in groups.values():
        g["items"].sort(key=lambda i: i["name"])
    return sorted(groups.values(), key=lambda g: g["owner_name"] or g["owner"])


def _locate(user_key: str, sid: str) -> tuple[Path, dict]:
    """Return (files_dir, meta) for a save the user may load (own or shared)."""
    own = _save_dir(user_key, sid)
    m = _read_meta(own)
    if m:
        return own / "files", m
    sh = _shared_dir(sid)
    m = _read_meta(sh)
    if m:
        return sh / "files", m
    raise KeyError(sid)


def load(user_key: str, owner_name: str, sid: str) -> dict:
    src, m = _locate(user_key, sid)
    dst = inputs.root(user_key)
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    inputs.outputs_dir(user_key).mkdir(parents=True, exist_ok=True)
    common.set_output_dir(dst / common.PROJECT_CONFIG)
    inputs._patch_project_config(dst, inputs._sanitize(owner_name or user_key))
    inputs.set_setup_name(user_key, m.get("name", ""))   # top bar shows the loaded name
    return inputs.manifest(user_key)


def set_shared(user_key: str, sid: str, shared: bool) -> dict:
    d = _save_dir(user_key, sid)
    m = _read_meta(d)
    if not m or m["owner"] != user_key:
        raise PermissionError("not owner")
    m["shared"] = bool(shared)
    (d / "meta.json").write_text(json.dumps(m, indent=2))
    if shared:
        _copy_snapshot(d / "files", str(_shared_dir(sid)), user_key, m["owner_name"], m)
    else:
        shutil.rmtree(_shared_dir(sid), ignore_errors=True)
    return m


def delete(user_key: str, sid: str) -> None:
    d = _save_dir(user_key, sid)
    m = _read_meta(d)
    if not m or m["owner"] != user_key:
        raise PermissionError("not owner")
    shutil.rmtree(d, ignore_errors=True)
    shutil.rmtree(_shared_dir(sid), ignore_errors=True)
