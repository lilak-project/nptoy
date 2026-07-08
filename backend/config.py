"""nptoy backend configuration.

All runtime state lives under the portal data root (PLAN §6 / SERVICE_CONTRACT §9):
`<PORTAL_DATA_ROOT>/nptoy/`. No absolute paths are baked in — the portal injects
`PORTAL_DATA_ROOT` when it spawns this as a managed service; a sensible local
default is used for standalone dev.
"""
from __future__ import annotations

import os
from pathlib import Path

# ── Identity / JWT ────────────────────────────────────────────────────────────
# Same scheme as the portal (HS256). The portal forwards the user's portal JWT in
# the Authorization header (identity.accepts_portal_token = true) and shares the
# secret via env, so we validate with the exact same key + fallbacks the portal
# uses (service_manager/app/config.py).
SECRET_KEY = (
    os.environ.get("PORTAL_SECRET_KEY")
    or os.environ.get("ELOG_SECRET_KEY")
    or "lilak-dev-secret-CHANGE-in-production"
)
ALGORITHM = "HS256"

# ── Execution backend (pluggable) ─────────────────────────────────────────────
# 'local' — run npsimulation directly on this host (Mac dev / local toolchain).
# 'sci'   — delegate heavy jobs to the sci-runner container (server deploy).
# Auto: sci when SCI_RUNNER_URL is set, else local. Override with NPTOY_RUNNER.
RUNNER = os.environ.get("NPTOY_RUNNER") or ("sci" if os.environ.get("SCI_RUNNER_URL") else "local")

# ── Paths ─────────────────────────────────────────────────────────────────────
SERVICE_NAME = os.environ.get("PORTAL_SERVICE", "nptoy")
_DEFAULT_DATA_ROOT = Path(__file__).resolve().parent.parent.parent / "data"
PORTAL_DATA_ROOT = Path(os.environ.get("PORTAL_DATA_ROOT", _DEFAULT_DATA_ROOT))
DATA_ROOT = PORTAL_DATA_ROOT / SERVICE_NAME          # <data>/nptoy/
# Per-user tree: <data>/nptoy/user/<key>/{inputs, outputs, saves}
USERS_ROOT = DATA_ROOT / "user"
# Shared, read-only-ish: preset workspaces + stashed ROOT scripts + shared saves.
#   <data>/nptoy/common/<PRESET>/{detector.txt, reaction.txt, PhysicsListOption.txt, …}
#   <data>/nptoy/common/scripts/  (draw_sim.C, rootlogon.C, SimulatedTree.*)
#   <data>/nptoy/common/shared/<id>/  (user presets shared cross-user)
COMMON_ROOT = DATA_ROOT / "common"
SETTINGS_PATH = DATA_ROOT / "settings.json"          # live, manager-editable limits
DB_PATH = Path(os.environ.get("NPTOY_DB", DATA_ROOT / "nptoy.db"))

# Frontend served by this backend through the portal proxy (base-path aware).
PUBLIC_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"

# ── Limits (DEFAULTS) ─────────────────────────────────────────────────────────
# These are the *initial* values; the live values live in settings.json and are
# adjustable by a manager at runtime (see settings.py). Env overrides the default.
JOB_TIMEOUT_SEC = int(os.environ.get("NPTOY_JOB_TIMEOUT_SEC", "300"))   # per-job wall clock (5 min)
USER_QUOTA_BYTES = int(os.environ.get("NPTOY_USER_QUOTA_BYTES", str(1024 * 1024 * 1024)))  # 1 GB
WORKER_POLL_SEC = float(os.environ.get("NPTOY_WORKER_POLL_SEC", "1.0"))

# ── nptool toolchain (the only simulation engine) ─────────────────────────────
# Everything runs the real nptool `npsimulation`: batch jobs via `-B <macro>` and
# live sessions via `-N`. Paths are env-configurable so the SAME code runs on the
# Mac dev box (defaults below) and in the sci-runner container (NPTOY_NPTOOL_ROOT=
# /opt/nptool). See sci-runner/DEPLOY.md.
NPTOOL_ROOT = os.environ.get("NPTOY_NPTOOL_ROOT", "/Users/jungwoo/Research/nptool_cens")
NPTOOL_SETUP = os.environ.get("NPTOY_NPTOOL_SETUP", f"{NPTOOL_ROOT}/nptool.sh")

# Whitelisted projects (never arbitrary paths/commands). Used by both batch jobs
# and interactive sessions.
# Example templates the input workspace can be seeded from (inputs.py discovers the
# detector/reaction files inside each).
_NP = os.environ.get("NPTOY_PROJECTS_DIR", f"{NPTOOL_ROOT}/Projects")
PROJECTS = {
    "ATOMX_12C": {"label": "ATOMX_12C", "dir": f"{_NP}/jungwoo/simulation_12C",
                  "drop_detector": ["Gas_ReactionZ"]},
    "ATOMX_34Ar": {"label": "ATOMX_34Ar", "dir": f"{_NP}/jungwoo/simulation_34Ar",
                   "drop_detector": ["Gas_ReactionZ"]},
    "ELARK": {"label": "ELARK", "dir": f"{_NP}/ko2520/sim_ko2520",
              "detector": ".tmp/stark_ko2520_21Na.det", "reaction": ".tmp/21Na_elastic.reac"},
    "STARK": {"label": "STARK", "dir": f"{_NP}/STARK",
              "detector": "detectors/stark_full.det", "reaction": "sources/alpha.source"},
    "ScintPMT": {"label": "ScintPMT", "dir": f"{_NP}/CSSU/ScintPMT",
                 "detector": "detector.txt", "reaction": "reaction.txt"},
    "HPGe": {"label": "HPGe", "dir": f"{_NP}/CSSU/HPGe",
             "detector": "hpge.detector", "reaction": "background_plus_co60_x-800.reaction"},
    "GasCF4": {"label": "GasCF4", "dir": f"{_NP}/CSSU/GasCF4",
               "detector": "detector.txt", "reaction": "reaction_alpha_am241.txt"},
    "W1Mask": {"label": "W1 mask", "dir": f"{_NP}/CSSU/W1Mask",
               "detector": "detector.txt", "reaction": "reaction_am241_gd148.txt"},
    "Plunger": {"label": "Plunger", "dir": f"{_NP}/Plunger"},
}
DEFAULT_PROJECT = next(iter(PROJECTS))
MAX_SESSIONS = int(os.environ.get("NPTOY_MAX_SESSIONS", "4"))     # global live cap
# How many events per /run/beamOn nptool streams to the live viewer text file
# (`--online-data-streaming N`). Small = light + fast live update.
ONLINE_EVENTS = int(os.environ.get("NPTOY_ONLINE_EVENTS", "10"))
SESSION_MAX_BEAMON = int(os.environ.get("NPTOY_SESSION_MAX_BEAMON", "100000"))


def ensure_dirs() -> None:
    DATA_ROOT.mkdir(parents=True, exist_ok=True)
    USERS_ROOT.mkdir(parents=True, exist_ok=True)
    COMMON_ROOT.mkdir(parents=True, exist_ok=True)
