"""Per-user input library — named saves of individual slots and full presets, browsed
in the Setup 'file' menu like the Files tab. Layout (per user):

    user/<key>/library/<kind>/<name>              (slot kinds — one file each)
    user/<key>/library/preset/<name>/<slot files> (a full set)

Slot kinds: physics, detector, reaction, crosssection, analysis. `preset` is a set of
all of them. Saving copies the current WORKING inputs; loading writes them back.

A preset may also carry a viewer `style` blob ({styles, hidden}) as `style.json`
inside its folder. There is no server-side "current style" (it lives in the browser),
so the client passes it on save and applies the returned blob on load.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import config
import inputs

SLOT_KINDS = ["physics", "detector", "reaction", "crosssection", "analysis"]
KINDS = SLOT_KINDS + ["preset"]
# shared presets live in one common area with an owner recorded per preset
SHARED_DIR = config.DATA_ROOT / "shared-presets"


def _san(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.\- ]", "_", (name or "").strip())[:80].strip() or "untitled"


def _lib(user_key: str) -> Path:
    return config.USERS_ROOT / user_key / "library"


def _kind_dir(user_key: str, kind: str) -> Path:
    if kind not in KINDS:
        raise ValueError("unknown kind")
    return _lib(user_key) / kind


def list_kind(user_key: str, kind: str) -> list[str]:
    d = _kind_dir(user_key, kind)
    if not d.exists():
        return []
    if kind == "preset":
        return sorted(p.name for p in d.iterdir() if p.is_dir())
    return sorted(p.name for p in d.iterdir() if p.is_file())


def exists(user_key: str, kind: str, name: str) -> bool:
    return (_kind_dir(user_key, kind) / _san(name)).exists()


def _read_slot(user_key: str, kind: str) -> str:
    return inputs.read_cs(user_key) if kind == "crosssection" else inputs.read_slot(user_key, kind)


def _write_slot(user_key: str, kind: str, content: str) -> None:
    if kind == "crosssection":
        inputs.write_cs(user_key, content)
    else:
        inputs.write_slot(user_key, kind, content)


def _read_style(d: Path) -> dict | None:
    """The viewer style blob stored alongside a preset, if any."""
    try:
        return json.loads((d / "style.json").read_text())
    except (FileNotFoundError, ValueError, OSError):
        return None


def _write_style(d: Path, style: dict | None) -> None:
    if style is not None:
        (d / "style.json").write_text(json.dumps(style))


def save(user_key: str, kind: str, name: str, overwrite: bool = False, style: dict | None = None) -> str:
    """Save the current working slot (or full set) under `name`. Raises FileExistsError
    if it exists and overwrite is False (the UI confirms, then retries with overwrite).
    For presets, an optional `style` blob is stored beside the slots."""
    name = _san(name)
    d = _kind_dir(user_key, kind)
    d.mkdir(parents=True, exist_ok=True)
    dest = d / name
    if dest.exists() and not overwrite:
        raise FileExistsError(name)
    if kind == "preset":
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        for k in SLOT_KINDS:
            try:
                (dest / k).write_text(_read_slot(user_key, k))
            except Exception:  # noqa: BLE001 — a missing slot just isn't included
                pass
        _write_style(dest, style)
    else:
        dest.write_text(_read_slot(user_key, kind))
    return name


def preset_style(user_key: str, kind: str, name: str) -> dict | None:
    """The style blob saved with a user preset (None for slot kinds / no style)."""
    if kind != "preset":
        return None
    return _read_style(_kind_dir(user_key, kind) / _san(name))


def load(user_key: str, kind: str, name: str) -> str:
    """Write a saved slot (or set) back into the working inputs."""
    name = _san(name)
    src = _kind_dir(user_key, kind) / name
    if not src.exists():
        raise FileNotFoundError(name)
    if kind == "preset":
        for k in SLOT_KINDS:
            f = src / k
            if f.exists():
                try:
                    _write_slot(user_key, k, f.read_text())
                except Exception:  # noqa: BLE001
                    pass
    else:
        _write_slot(user_key, kind, src.read_text())
    return name


def delete(user_key: str, kind: str, name: str) -> None:
    p = _kind_dir(user_key, kind) / _san(name)
    if p.is_dir():
        shutil.rmtree(p)
    elif p.exists():
        p.unlink()


# ── shared presets (visible to everyone; only the owner may overwrite/delete) ──
# Namespaced per owner: shared-presets/<owner>/<name>. So two accounts can each have a
# preset with the same name — no cross-account collisions or overwrites. `owner` is a
# filesystem-safe slug of the user_key; the real key + display name live in meta.json.
def _owner_slug(user_key: str) -> str:
    return (re.sub(r"[^A-Za-z0-9_.-]", "_", user_key or "")[:64]) or "u"


def _shared_meta(d: Path) -> dict:
    try:
        return json.loads((d / "meta.json").read_text())
    except Exception:  # noqa: BLE001
        return {}


def _shared_dir(owner: str, name: str) -> Path:
    return SHARED_DIR / _owner_slug(owner) / _san(name)


def list_shared(user_key: str) -> list[dict]:
    if not SHARED_DIR.exists():
        return []
    out = []
    for od in sorted(SHARED_DIR.iterdir()):
        if not od.is_dir():
            continue
        for d in sorted(od.iterdir()):
            if not d.is_dir():
                continue
            m = _shared_meta(d)
            out.append({"owner": od.name, "name": d.name, "owner_name": m.get("owner_name", ""),
                        "mine": m.get("owner_key") == user_key})
    return out


def save_shared(user_key: str, user_name: str, name: str, overwrite: bool = False,
                style: dict | None = None) -> str:
    """Publish the current inputs as a shared preset under the caller's own namespace.
    If I already have one by this name and overwrite is False → FileExistsError."""
    name = _san(name)
    od = SHARED_DIR / _owner_slug(user_key)
    od.mkdir(parents=True, exist_ok=True)
    dest = od / name
    if dest.exists():
        # only my own presets live here; guard against a slug collision just in case
        if _shared_meta(dest).get("owner_key") not in (None, user_key):
            raise PermissionError(name)
        if not overwrite:
            raise FileExistsError(name)
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for k in SLOT_KINDS:
        try:
            (dest / k).write_text(_read_slot(user_key, k))
        except Exception:  # noqa: BLE001
            pass
    _write_style(dest, style)
    (dest / "meta.json").write_text(json.dumps({"owner_key": user_key, "owner_name": user_name}))
    return name


def shared_style(user_key: str, owner: str, name: str) -> dict | None:
    """The style blob saved with a shared preset, if any."""
    return _read_style(_shared_dir(owner, name))


def load_shared(user_key: str, owner: str, name: str) -> str:
    src = _shared_dir(owner, name)
    if not src.exists():
        raise FileNotFoundError(name)
    for k in SLOT_KINDS:
        f = src / k
        if f.exists():
            try:
                _write_slot(user_key, k, f.read_text())
            except Exception:  # noqa: BLE001
                pass
    return _san(name)


def delete_shared(user_key: str, owner: str, name: str) -> None:
    d = _shared_dir(owner, name)
    if not d.exists():
        return
    if _shared_meta(d).get("owner_key") != user_key:
        raise PermissionError(name)
    shutil.rmtree(d)
