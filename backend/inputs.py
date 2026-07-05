"""Per-user editable input workspace.

Layout (per user):
    user/<key>/inputs/    ← the live, editable working set (what the web edits AND
                            what runs execute against, in place — no per-run copy)
    user/<key>/outputs/   ← ROOT + geometry + logs land here (project.config's
                            SimulationOutput = ../outputs points nptool at it)
    user/<key>/saves/     ← named snapshots of inputs/ (see saves.py)

The UI exposes only THREE editable slots with friendly names; the files carry fixed,
normalized names (detector.txt / reaction.txt / PhysicsListOption.txt) so the run
command and manifest are constant. `project.config` is managed (Project = account
name, output → ../outputs) and is not user-editable. Workspaces are seeded by
copying a preset from `common/<PRESET>/` (see common.py).
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import common
import config

DEFAULT_PHYSICS = common.DEFAULT_PHYSICS   # back-compat re-export
DEFAULT_SETUP_NAME = "user setup"          # shown until a preset/save is loaded

# The only editable files, shown by friendly label (key → label).
SLOTS = [
    {"key": "physics", "label": "Physics list"},
    {"key": "detector", "label": "Detector"},
    {"key": "reaction", "label": "Reaction"},
]
_SLOT_KEYS = {s["key"] for s in SLOTS}
# files that are NOT user cross-section candidates
_NON_CS = {common.PHYSICS, common.DETECTOR, common.REACTION, common.MANIFEST, "export.txt"}


def root(user_key: str) -> Path:
    return config.USERS_ROOT / user_key / "inputs"


def outputs_dir(user_key: str) -> Path:
    return config.USERS_ROOT / user_key / "outputs"


def saves_dir(user_key: str) -> Path:
    return config.USERS_ROOT / user_key / "saves"


def _manifest_path(user_key: str) -> Path:
    return root(user_key) / common.MANIFEST


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", (name or "user").strip()) or "user"


def _patch_project_config(ws: Path, project_name: str) -> None:
    """Set `Project <name>` in project.config (leave output redirect intact)."""
    pc = ws / common.PROJECT_CONFIG
    if not pc.exists():
        return
    lines = pc.read_text().splitlines()
    for i, ln in enumerate(lines):
        if ln.strip().startswith("Project"):
            lines[i] = f"Project {project_name}"
            break
    else:
        lines.insert(0, f"Project {project_name}")
    pc.write_text("\n".join(lines) + "\n")


def examples() -> list[dict]:
    """Preset choices for the UI (built from common/)."""
    common.build_common()
    return common.presets()


def seed(user_key: str, example_key: str, project_name: str | None = None,
         name: str | None = None) -> dict:
    """(Re)create the workspace by copying a preset from common/."""
    common.build_common()
    src = common.preset_dir(example_key)
    if not (src / common.MANIFEST).exists():
        raise KeyError(example_key)
    ws = root(user_key)
    if ws.exists():
        shutil.rmtree(ws)
    shutil.copytree(src, ws)
    outputs_dir(user_key).mkdir(parents=True, exist_ok=True)
    common.set_output_dir(ws / common.PROJECT_CONFIG)          # ensure ../outputs
    _patch_project_config(ws, _sanitize(project_name or user_key))
    man = manifest(user_key)
    man["example"] = example_key
    man["name"] = name or DEFAULT_SETUP_NAME
    _manifest_path(user_key).write_text(json.dumps(man, indent=2))
    return man


def setup_name(user_key: str) -> str:
    try:
        return manifest(user_key).get("name") or DEFAULT_SETUP_NAME
    except (FileNotFoundError, ValueError):
        return DEFAULT_SETUP_NAME


def set_setup_name(user_key: str, name: str) -> None:
    man = manifest(user_key)
    man["name"] = (name or DEFAULT_SETUP_NAME).strip()[:80] or DEFAULT_SETUP_NAME
    _manifest_path(user_key).write_text(json.dumps(man, indent=2))


def ensure(user_key: str, project_name: str | None = None) -> dict:
    if not _manifest_path(user_key).exists():
        return seed(user_key, common.default_preset(), project_name)
    outputs_dir(user_key).mkdir(parents=True, exist_ok=True)
    return manifest(user_key)


def manifest(user_key: str) -> dict:
    return json.loads(_manifest_path(user_key).read_text())


def project_name(user_key: str) -> str:
    pc = root(user_key) / common.PROJECT_CONFIG
    if pc.exists():
        for ln in pc.read_text().splitlines():
            if ln.strip().startswith("Project") and len(ln.split()) > 1:
                return ln.strip().split(None, 1)[1]
    return ""


def _resolve(user_key: str, slot: str) -> Path:
    if slot not in _SLOT_KEYS:
        raise ValueError("unknown slot")
    rel = manifest(user_key).get(slot)
    if not rel:
        raise ValueError("slot has no file")
    ws = root(user_key).resolve()
    p = (ws / rel).resolve()
    if not str(p).startswith(str(ws) + "/"):
        raise ValueError("path escapes workspace")
    return p


def read_slot(user_key: str, slot: str) -> str:
    return _resolve(user_key, slot).read_text()


def write_slot(user_key: str, slot: str, content: str) -> None:
    _resolve(user_key, slot).write_text(content)


# ── run setup (in-place; no per-run copy) ─────────────────────────────────────
STREAM_NAME = "online_stream.dat"      # nptool writes this in cwd (= inputs/); transient


def prepare_inplace(user_key: str) -> tuple[Path, Path, dict]:
    """Ensure the workspace + outputs dir exist and return (inputs_dir, outputs_dir,
    manifest). Runs execute with cwd = inputs_dir and write ROOT into outputs_dir."""
    ensure(user_key)
    ins, outs = root(user_key), outputs_dir(user_key)
    outs.mkdir(parents=True, exist_ok=True)
    return ins, outs, manifest(user_key)


def next_run_number(user_key: str, project_slug: str, user_slug: str) -> int:
    """1 + the highest run number already used for this (project, user) in outputs/
    (filenames `{project}_{N}.{user}.sim.*`) — so a new run never collides."""
    o = outputs_dir(user_key)
    hi = 0
    if o.exists():
        pat = re.compile(rf"^{re.escape(project_slug)}_(\d+)\.{re.escape(user_slug)}\.sim\.")
        for f in o.iterdir():
            m = pat.match(f.name)
            if m:
                hi = max(hi, int(m.group(1)))
    return hi + 1


def next_run(user_key: str, user_name: str) -> dict:
    """The next run identity used to name a run's outputs:
    `{project}_{run}.{user}.sim`  →  ROOT `{project}_{run}.{user}.sim.root`.
    project = the loaded setup name (top-bar name); user = the account name."""
    proj = _sanitize(setup_name(user_key))
    usr = _sanitize(user_name or user_key)
    n = next_run_number(user_key, proj, usr)
    return {"project": proj, "user": usr, "run": n, "run_id": f"{proj}_{n}.{usr}.sim"}


def run_paths(user_key: str, run_id: str) -> dict:
    """Per-run artifact paths under outputs/. `run_id` is e.g. `session_<id>` or
    `job_<id>`. The ROOT basename (run_id.root) is what `-O` gets; nptool prepends
    SimulationOutput (../outputs) so it lands here."""
    o = outputs_dir(user_key)
    return {
        "name": f"{run_id}.root",                    # -O basename (relative to ../outputs)
        "root": o / f"{run_id}.root",
        "gdml": o / f"{run_id}.gdml",
        "gdml_rel": f"../outputs/{run_id}.gdml",     # for /det/export_gdml (cwd=inputs)
        "geom": o / f"{run_id}.geom.json",           # flat geometry JSON (viewer)
        "geom_rel": f"../outputs/{run_id}.geom.json",  # for /det/export_geometry (cwd=inputs)
        "stream": o / f"{run_id}.stream",            # persisted copy of online_stream.dat
        "log": o / f"{run_id}.log",
        "mac": o / f"{run_id}.mac",
        "mac_rel": f"../outputs/{run_id}.mac",       # for -B (cwd=inputs)
        "live_stream": root(user_key) / STREAM_NAME, # live file nptool writes (cwd)
    }


# ── cross-section file (referenced by the reaction's CrossSectionPath) ────────
def _cs_token(user_key: str) -> str:
    try:
        rea = read_slot(user_key, "reaction")
    except Exception:
        return ""
    for ln in rea.splitlines():
        s = ln.strip()
        if s.startswith("CrossSectionPath") and "=" in s:
            toks = s.split("=", 1)[1].split()
            return toks[0] if toks else ""
    return ""


def cs_info(user_key: str) -> dict:
    return {"label": "Cross-section", "path": _cs_token(user_key) or "flat.txt"}


def _cs_file(user_key: str) -> Path:
    return _named_cs_file(user_key, _cs_token(user_key) or "flat.txt")


def _named_cs_file(user_key: str, name: str) -> Path:
    ws = root(user_key).resolve()
    p = (ws / name).resolve()
    if not str(p).startswith(str(ws) + "/"):
        raise ValueError("path escapes workspace")
    return p


def cs_candidates(user_key: str) -> list[str]:
    """Cross-section files available in the workspace (for the reaction dropdown)."""
    ws = root(user_key)
    out = set()
    cur = _cs_token(user_key)
    if cur:
        out.add(cur)
    if ws.exists():
        for f in ws.rglob("*.txt"):
            if f.name not in _NON_CS:
                out.add(str(f.relative_to(ws)))
    return sorted(out)


def read_cs(user_key: str, name: str | None = None) -> str:
    p = _named_cs_file(user_key, name) if name else _cs_file(user_key)
    return p.read_text() if p.exists() else ""


def write_cs(user_key: str, content: str, name: str | None = None) -> None:
    p = _named_cs_file(user_key, name) if name else _cs_file(user_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
