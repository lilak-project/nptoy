"""Shared preset workspaces under `<data>/nptoy/common/`.

Each whitelisted project in `config.PROJECTS` is extracted ONCE from the nptool
source tree into a clean, normalized preset:

    common/<PRESET>/detector.txt
    common/<PRESET>/reaction.txt
    common/<PRESET>/PhysicsListOption.txt
    common/<PRESET>/project.config          (SimulationOutput → ../outputs)
    common/<PRESET>/<crosssection>.txt       (if the reaction references one)
    common/<PRESET>/manifest.json

Only the files a run actually needs are copied — the analysis/helper clutter
(`clean.sh`, `make_scripts.py`, …) is dropped, and the ROOT scripts we don't use
yet (`draw_sim.C`, `rootlogon.C`, `SimulatedTree.*`) are stashed in
`common/scripts/` for later. Seeding a user (inputs.py) then just copies a preset —
no runtime dependency on the nptool source layout (Docker-friendly).
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import config

# normalized filenames inside every workspace (preset + user inputs)
DETECTOR = "detector.txt"
REACTION = "reaction.txt"
PHYSICS = "PhysicsListOption.txt"     # nptool reads this by fixed name from cwd
PROJECT_CONFIG = "project.config"     # nptool reads this by fixed name from cwd
ANALYSIS = "analysis.json"            # Files-tab pre-drawn plots (structured slot)
MANIFEST = "manifest.json"

# project.config points nptool's output here, relative to the run cwd (= inputs/):
#   user/<key>/inputs/ + ../outputs → user/<key>/outputs/
OUTPUTS_REL = "../outputs"

SCRIPTS_DIR = config.COMMON_ROOT / "scripts"
SHARED_DIR = config.COMMON_ROOT / "shared"
_STASH_SCRIPTS = ["draw_sim.C", "rootlogon.C", "SimulatedTree.C", "SimulatedTree.h"]
_RESERVED = {"scripts", "shared"}     # common/ subdirs that are NOT presets

# Pre-built presets committed WITH the code (relative paths only → relocatable), so a
# deploy has them even when the nptool project SOURCES aren't on the box. Regenerate
# with backend/refresh_preset_seed.sh after changing a preset's nptool source.
SEED_DIR = Path(__file__).resolve().parent / "preset_seed"

# Written when a source project lacks PhysicsListOption.txt (optional in nptool).
DEFAULT_PHYSICS = """\
EmPhysicsList                   Option4 % INCLXX_EM Option1 Option2 Option3 Option4 Standard Livermore Penelope

DefaultCutOff                   1 % mm
IonBinaryCascadePhysics         0
NPIonInelasticPhysics           0
EmExtraPhysics                  0
HadronElasticPhysics            0
StoppingPhysics                 0
OpticalPhysics                  0
DriftElectronPhysics            0

HadronPhysicsQGSP_BIC_HP        0
HadronPhysicsQGSP_BERT_HP       0
HadronPhysicsINCLXX             0
HadronPhysicsQGSP_INCLXX_HP     0
HadronPhysicsQGSP_INCLXX        0
HadronPhysicsFTFP_INCLXX_HP     0
HadronPhysicsFTFP_INCLXX        0
Decay                           0

IonGasModels                    0
pai                             0
Menate_R                        0
NeutronHP                       0
Shielding                       0
"""


def preset_dir(key: str) -> Path:
    return config.COMMON_ROOT / key


def presets() -> list[dict]:
    """Available presets = common/ subdirs with a manifest (excluding reserved)."""
    out = []
    if config.COMMON_ROOT.exists():
        for d in sorted(config.COMMON_ROOT.iterdir()):
            if d.is_dir() and d.name not in _RESERVED and (d / MANIFEST).exists():
                out.append({"key": d.name, "label": d.name})
    return out


def default_preset() -> str:
    ps = presets()
    return ps[0]["key"] if ps else config.DEFAULT_PROJECT


# ── project.config normalization ──────────────────────────────────────────────
def set_output_dir(pc: Path, rel: str = OUTPUTS_REL) -> None:
    """Point SimulationOutput/AnalysisOutput at `rel` (create the lines if absent)."""
    if not pc.exists():
        pc.write_text(f"Project user\n    SimulationOutput = {rel}\n    AnalysisOutput = {rel}\n")
        return
    lines = pc.read_text().splitlines()
    seen = {"SimulationOutput": False, "AnalysisOutput": False}
    for i, ln in enumerate(lines):
        key = ln.strip().split("=", 1)[0].strip().lstrip("%").strip()
        if key in seen:
            lines[i] = f"    {key} = {rel}"
            seen[key] = True
    for key, ok in seen.items():
        if not ok:
            lines.append(f"    {key} = {rel}")
    pc.write_text("\n".join(lines) + "\n")


def _default_cs() -> str:
    """A flat (isotropic) dσ/dΩ table, 0..180° — placeholder so a preset runs."""
    return "".join(f"{a:.1f}\t1.0\n" for a in range(0, 181))


def _drop_keys(text: str, keys: list[str]) -> str:
    """Remove any `Key = …` line whose leading token is in `keys` (e.g. drop the
    `Gas_ReactionZ` reaction-Z-range line from a preset detector)."""
    ks = set(keys)
    out = [ln for ln in text.splitlines()
           if not (ln.strip() and ln.strip().replace("=", " ").split()[0] in ks)]
    return "\n".join(out) + "\n"


def _cs_token(reaction_text: str) -> str:
    for ln in reaction_text.splitlines():
        s = ln.strip()
        if s.startswith("CrossSectionPath") and "=" in s:
            toks = s.split("=", 1)[1].split()
            return toks[0] if toks else ""
    return ""


def _histo_token(reaction_text: str) -> str:
    """`EnergyDistribution= FromHisto` samples energies from an external ROOT file
    named on an `EnergyDistributionHist= <file> <hist>` line — return `<file>`."""
    for ln in reaction_text.splitlines():
        s = ln.strip()
        if s.startswith("EnergyDistributionHist") and "=" in s:
            toks = s.split("=", 1)[1].split()
            return toks[0] if toks else ""
    return ""


def _find(src: Path, explicit: str | None, *pats: str) -> Path | None:
    if explicit:
        p = src / explicit
        return p if p.exists() else None
    inp = src / "input"
    base = inp if inp.exists() else src
    for pat in pats:
        hits = sorted(base.glob(pat))
        if hits:
            return hits[0]
    return None


def build_one(key: str, proj: dict) -> bool:
    """Extract one preset from its nptool source dir. Returns False if unavailable."""
    src = Path(proj["dir"])
    if not src.exists():
        return False
    det = _find(src, proj.get("detector"), "*.detector", "*.det")
    rea = _find(src, proj.get("reaction"), "*.reaction", "*.reac", "*.source")
    if not det or not rea:
        return False

    dst = preset_dir(key)
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True)

    det_text = det.read_text()
    drop = proj.get("drop_detector") or []      # detector keys to omit from the preset
    if drop:
        det_text = _drop_keys(det_text, drop)
    (dst / DETECTOR).write_text(det_text)
    rea_text = rea.read_text()

    # cross-section: normalize the reference to a basename and make sure the file
    # exists next to the reaction (copy from source, or seed a default flat table
    # so the preset is runnable out of the box).
    tok = _cs_token(rea_text)
    if tok:
        base = Path(tok).name
        cs_src = _find(src, tok, base)
        if cs_src and cs_src.exists():
            shutil.copyfile(cs_src, dst / base)
        elif not (dst / base).exists():
            (dst / base).write_text(_default_cs())
        rea_text = re.sub(r"(CrossSectionPath\s*=\s*)\S+", rf"\g<1>{base}", rea_text, count=1)

    # FromHisto energy sampling references an external ROOT spectrum file — copy it
    # in and normalize every reference to its basename so the preset runs standalone.
    htok = _histo_token(rea_text)
    if htok:
        hbase = Path(htok).name
        h_src = _find(src, htok, hbase)
        if h_src and h_src.exists():
            shutil.copyfile(h_src, dst / hbase)
            rea_text = re.sub(r"(EnergyDistributionHist\s*=\s*)\S+", rf"\g<1>{hbase}", rea_text)
    (dst / REACTION).write_text(rea_text)

    phys = src / PHYSICS
    (dst / PHYSICS).write_text(phys.read_text() if phys.exists() else DEFAULT_PHYSICS)

    pc = src / PROJECT_CONFIG
    if pc.exists():
        shutil.copyfile(pc, dst / PROJECT_CONFIG)
    set_output_dir(dst / PROJECT_CONFIG)

    # analysis setup (pre-drawn plots for the Files tab) — copy from source if present,
    # else start empty; carried by the preset so it seeds into the user workspace.
    asrc = src / ANALYSIS
    (dst / ANALYSIS).write_text(asrc.read_text() if asrc.exists() else '{"plots": []}\n')

    (dst / MANIFEST).write_text(json.dumps(
        {"example": key, "detector": DETECTOR, "reaction": REACTION, "physics": PHYSICS,
         "analysis": ANALYSIS},
        indent=2))
    return True


def _stash_scripts() -> None:
    """Copy the (currently unused) ROOT analysis scripts into common/scripts/ once."""
    if SCRIPTS_DIR.exists():
        return
    for proj in config.PROJECTS.values():
        src = Path(proj["dir"])
        found = {name: src / name for name in _STASH_SCRIPTS if (src / name).exists()}
        if found:
            SCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
            for name, p in found.items():
                shutil.copyfile(p, SCRIPTS_DIR / name)
            break


def _preset_complete(key: str) -> bool:
    """True only if the preset has its manifest AND the input files the manifest names.
    A manifest-only husk (e.g. a legacy/interrupted build — as Plunger once shipped)
    must NOT count as built, or the idempotent guard below would protect it forever."""
    d = preset_dir(key)
    man = d / MANIFEST
    if not man.exists():
        return False
    try:
        m = json.loads(man.read_text())
    except (OSError, ValueError):
        return False
    needed = (m.get("detector", DETECTOR), m.get("reaction", REACTION), m.get("physics", PHYSICS))
    return all((d / name).exists() for name in needed)


def _seed_preset(key: str) -> bool:
    """Install a committed pre-built preset from preset_seed/ into common/ — the
    fallback when the nptool project SOURCE isn't present to build from (deploy)."""
    src = SEED_DIR / key
    if not (src / MANIFEST).exists():
        return False
    dst = preset_dir(key)
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)
    return True


def build_common(force: bool = False) -> list[str]:
    """Ensure every preset exists in common/. Idempotent. Prefer building from the
    nptool project SOURCE (dev, stays fresh); fall back to the committed seed when
    the source isn't on this machine (deploy)."""
    config.COMMON_ROOT.mkdir(parents=True, exist_ok=True)
    built = []
    for key, proj in config.PROJECTS.items():
        if not force and _preset_complete(key):
            continue
        if build_one(key, proj) or _seed_preset(key):
            built.append(key)
    _stash_scripts()
    return built
