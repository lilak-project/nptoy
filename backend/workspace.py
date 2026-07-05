"""Per-user disk accounting + quota + cleanup.

Layout: <data>/nptoy/user/<user_key>/{inputs, outputs, saves}. The quota now counts
the WHOLE user dir (inputs + outputs + saves), and the gate applies to BOTH batch
jobs and interactive sessions (session start / beamOn). The live quota value comes
from settings.py (manager-editable).
"""
from __future__ import annotations

import shutil
from pathlib import Path

import config
import settings


def user_dir(user_key: str) -> Path:
    return config.USERS_ROOT / user_key


def outputs_dir(user_key: str) -> Path:
    return user_dir(user_key) / "outputs"


def dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def user_usage(user_key: str) -> int:
    return dir_size(user_dir(user_key))


def quota(user_key: str | None = None) -> int:
    return settings.user_quota_bytes(user_key)


def over_quota(user_key: str) -> bool:
    return user_usage(user_key) >= quota(user_key)


# ── cleanup ───────────────────────────────────────────────────────────────────
def clean_outputs(user_key: str) -> int:
    """Delete everything under the user's outputs/. Returns bytes freed."""
    out = outputs_dir(user_key)
    freed = dir_size(out)
    if out.exists():
        for child in out.iterdir():
            try:
                shutil.rmtree(child) if child.is_dir() else child.unlink()
            except OSError:
                pass
    out.mkdir(parents=True, exist_ok=True)
    return freed


def clean_all_outputs() -> dict:
    """Purge every user's outputs/. Returns {users_cleaned, bytes_freed}."""
    users, freed = 0, 0
    if config.USERS_ROOT.exists():
        for d in config.USERS_ROOT.iterdir():
            if d.is_dir():
                f = clean_outputs(d.name)
                if f:
                    users += 1
                    freed += f
    return {"users_cleaned": users, "bytes_freed": freed}


def list_runs(user_key: str) -> list[dict]:
    """Group the user's outputs/ files by run id (the filename stem). Each run may
    have .root / .gdml / .stream / .log / .mac artifacts."""
    o = outputs_dir(user_key)
    runs: dict[str, dict] = {}
    if o.exists():
        for f in sorted(o.iterdir()):
            if not f.is_file():
                continue
            st = f.stat()
            r = runs.setdefault(f.stem, {"run": f.stem, "files": [], "bytes": 0, "mtime": 0})
            r["files"].append({"name": f.name, "ext": f.suffix.lstrip("."), "bytes": st.st_size})
            r["bytes"] += st.st_size
            r["mtime"] = max(r["mtime"], st.st_mtime)
    return sorted(runs.values(), key=lambda r: r["mtime"], reverse=True)


def _safe_output(user_key: str, name: str) -> Path:
    o = outputs_dir(user_key).resolve()
    p = (o / name).resolve()
    if not str(p).startswith(str(o) + "/"):
        raise ValueError("path escapes outputs")
    return p


def output_file(user_key: str, name: str) -> Path:
    p = _safe_output(user_key, name)
    if not p.is_file():
        raise FileNotFoundError(name)
    return p


def delete_run(user_key: str, run: str) -> int:
    """Delete every artifact of one run. Returns bytes freed."""
    run = run.replace("/", "").replace("..", "")
    o = outputs_dir(user_key)
    freed = 0
    for f in o.glob(run + ".*"):
        try:
            freed += f.stat().st_size
            f.unlink()
        except OSError:
            pass
    return freed


def usage_summary() -> list[dict]:
    """Per-user disk usage (for the admin panel)."""
    out = []
    if config.USERS_ROOT.exists():
        for d in sorted(config.USERS_ROOT.iterdir()):
            if d.is_dir():
                out.append({
                    "user_key": d.name,
                    "bytes": dir_size(d),
                    "outputs_bytes": dir_size(d / "outputs"),
                })
    out.sort(key=lambda u: u["bytes"], reverse=True)
    return out
