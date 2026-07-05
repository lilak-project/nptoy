"""One-time migration from the old layout to the new one.

Old: <data>/nptoy/users/<key>/{inputs(with input/*.detector, junk scripts), sessions/, jobs/}
     <data>/nptoy/configs/<id>/{meta.json, files/}
New: <data>/nptoy/user/<key>/{inputs(normalized), outputs/, saves/}
     <data>/nptoy/common/shared/<id>/ (shared saves)

Runs once (guarded by a marker file). The old `users/` and `configs/` trees are
renamed to `*.pre_v2` backups rather than deleted, so nothing is lost.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import common
import config
import inputs

_MARKER = config.DATA_ROOT / ".migrated_v2"
_OLD_USERS = config.DATA_ROOT / "users"
_OLD_CONFIGS = config.DATA_ROOT / "configs"


def _first(base: Path, *pats: str) -> Path | None:
    for pat in pats:
        hits = sorted(base.glob(pat))
        if hits:
            return hits[0]
    return None


def _convert_user(key: str, old_inputs: Path) -> None:
    """Build a normalized new inputs/ from an old workspace."""
    ws = inputs.root(key)
    if ws.exists():
        shutil.rmtree(ws)
    ws.mkdir(parents=True)

    man = {}
    mp = old_inputs / "manifest.json"
    if mp.exists():
        try:
            man = json.loads(mp.read_text())
        except (ValueError, OSError):
            man = {}

    search = old_inputs / "input" if (old_inputs / "input").exists() else old_inputs
    det = (old_inputs / man["detector"]) if man.get("detector") else None
    rea = (old_inputs / man["reaction"]) if man.get("reaction") else None
    if not det or not det.exists():
        det = _first(search, "*.detector", "*.det")
    if not rea or not rea.exists():
        rea = _first(search, "*.reaction", "*.reac", "*.source")

    if not det or not rea or not det.exists() or not rea.exists():
        # can't recover — reseed from the recorded example (or default)
        shutil.rmtree(ws, ignore_errors=True)
        inputs.seed(key, man.get("example") if man.get("example") in
                    {p["key"] for p in common.presets()} else common.default_preset(), key)
        return

    shutil.copyfile(det, ws / common.DETECTOR)
    shutil.copyfile(rea, ws / common.REACTION)
    phys = old_inputs / common.PHYSICS
    (ws / common.PHYSICS).write_text(phys.read_text() if phys.exists() else common.DEFAULT_PHYSICS)
    pc = old_inputs / common.PROJECT_CONFIG
    if pc.exists():
        shutil.copyfile(pc, ws / common.PROJECT_CONFIG)
    common.set_output_dir(ws / common.PROJECT_CONFIG)
    inputs._patch_project_config(ws, inputs._sanitize(key))
    # bring over any cross-section .txt files (not the physics file)
    for f in old_inputs.glob("*.txt"):
        if f.name != common.PHYSICS:
            shutil.copyfile(f, ws / f.name)

    (ws / common.MANIFEST).write_text(json.dumps(
        {"example": man.get("example", common.default_preset()),
         "detector": common.DETECTOR, "reaction": common.REACTION, "physics": common.PHYSICS},
        indent=2))
    inputs.outputs_dir(key).mkdir(parents=True, exist_ok=True)
    inputs.saves_dir(key).mkdir(parents=True, exist_ok=True)


def _migrate_configs() -> None:
    """Old top-level configs/ → per-user saves/ (+ common/shared for shared ones)."""
    if not _OLD_CONFIGS.exists():
        return
    for d in _OLD_CONFIGS.iterdir():
        meta = d / "meta.json"
        files = d / "files"
        if not meta.exists() or not files.exists():
            continue
        try:
            m = json.loads(meta.read_text())
        except (ValueError, OSError):
            continue
        owner = m.get("owner")
        sid = m.get("id") or d.name
        if not owner:
            continue
        dst = inputs.saves_dir(owner) / sid
        if not dst.exists():
            dst.mkdir(parents=True)
            shutil.copytree(files, dst / "files")
            (dst / "meta.json").write_text(json.dumps(m, indent=2))
        if m.get("shared"):
            sh = common.SHARED_DIR / sid
            if not sh.exists():
                sh.mkdir(parents=True)
                shutil.copytree(files, sh / "files")
                (sh / "meta.json").write_text(json.dumps(m, indent=2))


def run() -> bool:
    """Perform the migration once. Returns True if it ran."""
    if _MARKER.exists() or not _OLD_USERS.exists():
        if _OLD_USERS.exists() and not _MARKER.exists():
            pass  # fall through to migrate
        else:
            return False
    common.build_common()
    for ud in _OLD_USERS.iterdir():
        if not ud.is_dir():
            continue
        old_inputs = ud / "inputs"
        if old_inputs.exists():
            try:
                _convert_user(ud.name, old_inputs)
            except Exception as exc:   # never let one user break startup
                print(f"[nptoy migrate] {ud.name}: {exc}")
    _migrate_configs()
    # back up (don't delete) the old trees
    for old in (_OLD_USERS, _OLD_CONFIGS):
        if old.exists():
            bak = old.with_name(old.name + ".pre_v2")
            if not bak.exists():
                old.rename(bak)
    _MARKER.parent.mkdir(parents=True, exist_ok=True)
    _MARKER.write_text("migrated\n")
    return True
