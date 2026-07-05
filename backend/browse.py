"""Sandboxed, read-only file browser over a user's data folder (the Files tab).

Everything is confined to `<data>/nptoy/user/<user_key>/` — paths are resolved
and checked so a relative path can never escape that root. Directory listings
carry the whole-folder usage (+ quota); file reads return metadata and, for text
files, an inline (size-capped) preview. Downloads are streamed by main.py.
"""
from __future__ import annotations

import shutil
from pathlib import Path

import config
import settings
import workspace

# Extensions treated as text outright; anything else is sniffed (see read_file).
# .root is binary and deliberately excluded; .gdml/.geom.json/.dat are text.
TEXT_EXT = {
    ".txt", ".mac", ".config", ".json", ".reaction", ".detector", ".det",
    ".source", ".log", ".csv", ".tsv", ".md", ".c", ".cc", ".cpp", ".hh", ".h",
    ".py", ".sh", ".dat", ".gdml", ".xml", ".cfg", ".ini", ".yaml", ".yml",
}
TEXT_MAX = 512 * 1024        # cap the inline preview at 512 KB


def _base(user_key: str) -> Path:
    return config.USERS_ROOT / user_key


def resolve(user_key: str, rel: str) -> Path:
    """Resolve a user-relative path, refusing anything outside the user's folder."""
    base = _base(user_key).resolve()
    p = (base / (rel or "")).resolve()
    if p != base and base not in p.parents:
        raise ValueError("path escapes user folder")
    return p


def _rel(user_key: str, p: Path) -> str:
    base = _base(user_key).resolve()
    return "" if p == base else str(p.relative_to(base))


def list_dir(user_key: str, rel: str) -> dict:
    base = _base(user_key)
    base.mkdir(parents=True, exist_ok=True)
    d = resolve(user_key, rel)
    if not d.is_dir():
        raise FileNotFoundError(rel)
    entries = []
    for f in sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        try:
            st = f.stat()
        except OSError:
            continue
        is_dir = f.is_dir()
        entries.append({
            "name": f.name,
            "path": _rel(user_key, f),
            "is_dir": is_dir,
            "size": workspace.dir_size(f) if is_dir else st.st_size,
            "mtime": st.st_mtime,
        })
    return {
        "path": _rel(user_key, d),
        "entries": entries,
        "usage": workspace.user_usage(user_key),
        "quota": settings.user_quota_bytes(user_key),
    }


def _looks_text(p: Path, size: int) -> bool:
    if p.suffix.lower() in TEXT_EXT:
        return True
    if size > TEXT_MAX:
        return False
    try:
        sample = p.read_bytes()[:4096]
    except OSError:
        return False
    if b"\x00" in sample:
        return False
    try:
        sample.decode("utf-8")
        return True
    except ValueError:
        return False


def delete_paths(user_key: str, rels: list[str]) -> int:
    """Delete the given files/folders (each sandboxed). Never deletes the root
    itself. Returns bytes freed."""
    base = _base(user_key).resolve()
    freed = 0
    for rel in rels:
        try:
            p = resolve(user_key, rel)
        except ValueError:
            continue
        if p == base or not p.exists():
            continue
        sz = workspace.dir_size(p) if p.is_dir() else p.stat().st_size
        try:
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            else:
                p.unlink()
            freed += sz
        except OSError:
            pass
    return freed


def read_file(user_key: str, rel: str) -> dict:
    p = resolve(user_key, rel)
    if not p.is_file():
        raise FileNotFoundError(rel)
    st = p.stat()
    info = {
        "name": p.name, "path": _rel(user_key, p), "size": st.st_size,
        "mtime": st.st_mtime, "ext": p.suffix.lstrip("."),
        "is_text": False, "content": None, "truncated": False,
    }
    if _looks_text(p, st.st_size):
        try:
            raw = p.read_bytes()
            info["truncated"] = len(raw) > TEXT_MAX
            info["content"] = raw[:TEXT_MAX].decode("utf-8", errors="replace")
            info["is_text"] = True
        except OSError:
            pass
    return info
