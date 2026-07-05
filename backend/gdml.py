"""GDML → Scene-JSON geometry (PLAN §4.4 automation).

Geometry-agnostic: parse a Geant4 `G4GDMLParser`-style `.gdml` and emit the same
flat `geometry` list the viewer already renders, so ANY example's geometry follows
automatically instead of being hand-transcribed. Supports the solids a toy needs
(box, tube→cylinder, orb/sphere), physvol placements (position + rotation), and the
volume hierarchy (transforms composed down to world-absolute coordinates).

GDML conventions handled:
  • solid extents are FULL lengths (unlike G4Box half-lengths);
  • `<position>` default unit mm, `<rotation>` default unit deg (`unit`/`aunit`);
  • placements given inline (`<position>`/`<rotation>`) or by ref
    (`<positionref>`/`<rotationref>` → `<define>`).
Unsupported solids are skipped (logged into the result's `skipped` list) — the
renderer just won't show them; tracks/points still do.
"""
from __future__ import annotations

import math
import xml.etree.ElementTree as ET
from pathlib import Path

# ── tiny 3×3 rotation helpers (Euler XYZ, R = Rz·Ry·Rx) ───────────────────────
def _matmul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def _matvec(A, v):
    return [sum(A[i][k] * v[k] for k in range(3)) for i in range(3)]


def _euler_to_mat(rx, ry, rz):  # radians
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
    Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
    return _matmul(Rz, _matmul(Ry, Rx))


def _mat_to_euler_deg(R):  # inverse of the above
    sy = -R[2][0]
    sy = max(-1.0, min(1.0, sy))
    ry = math.asin(sy)
    if abs(sy) < 0.9999:
        rx = math.atan2(R[2][1], R[2][2])
        rz = math.atan2(R[1][0], R[0][0])
    else:  # gimbal lock
        rx = math.atan2(-R[1][2], R[1][1])
        rz = 0.0
    return [math.degrees(rx), math.degrees(ry), math.degrees(rz)]


_IDENT = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

# nptool-internal volumes that carry no visual meaning — skip them. `sample_log`
# is a 1 µm invisible cube nptool parks in the world corner (~10 m) for each
# material to build energy-loss/cross-section tables (MaterialManager). GDML
# doesn't carry the "invisible" vis flag, so we filter by name instead.
SKIP_VOLUMES = {"sample_log"}


def _lscale(unit: str | None) -> float:
    return {"m": 1000.0, "cm": 10.0, "mm": 1.0, "um": 1e-3, None: 1.0}.get((unit or "mm"), 1.0)


def _ascale(unit: str | None) -> float:
    return math.pi / 180.0 if (unit or "deg") in ("deg", "degree") else 1.0


# material name → RGB (0..1); fallback palette by index. Only cosmetic.
_MAT_COLOR = {
    "G4_Galactic": [0.5, 0.55, 0.65], "G4_AIR": [0.5, 0.55, 0.65],
    "CF4": [0.55, 0.8, 1.0], "G4_MYLAR": [0.95, 0.7, 0.4],
    "G4_Si": [0.7, 0.9, 0.5], "G4_Pb": [0.7, 0.6, 0.9],
}
_PALETTE = [[0.55, 0.8, 1.0], [0.95, 0.7, 0.4], [0.7, 0.9, 0.5],
            [0.9, 0.6, 0.85], [0.6, 0.85, 0.85]]


def parse(path: Path) -> dict:
    root = ET.parse(path).getroot()

    def tag(e):  # strip namespace
        return e.tag.rsplit("}", 1)[-1]

    define = next((c for c in root if tag(c) == "define"), None)
    solids = next((c for c in root if tag(c) == "solids"), None)
    structure = next((c for c in root if tag(c) == "structure"), None)
    setup = next((c for c in root if tag(c) == "setup"), None)

    # named <define> positions / rotations
    named_pos, named_rot = {}, {}
    if define is not None:
        for e in define:
            if tag(e) == "position":
                s = _lscale(e.get("unit"))
                named_pos[e.get("name")] = [float(e.get("x", 0)) * s, float(e.get("y", 0)) * s,
                                            float(e.get("z", 0)) * s]
            elif tag(e) == "rotation":
                s = _ascale(e.get("unit"))
                named_rot[e.get("name")] = [float(e.get("x", 0)) * s, float(e.get("y", 0)) * s,
                                            float(e.get("z", 0)) * s]

    # solids → {name: {type, dims...}}
    sol = {}
    skipped = []
    if solids is not None:
        for e in solids:
            t, name, s = tag(e), e.get("name"), _lscale(e.get("lunit"))
            if t == "box":
                sol[name] = {"type": "box",
                             "size": [float(e.get("x")) * s, float(e.get("y")) * s, float(e.get("z")) * s]}
            elif t == "tube":
                sol[name] = {"type": "cylinder", "rmax": float(e.get("rmax")) * s,
                             "height": float(e.get("z")) * s}
            elif t in ("orb", "sphere"):
                r = float(e.get("rmax") if e.get("rmax") else e.get("r")) * s
                sol[name] = {"type": "sphere", "radius": r}
            else:
                skipped.append(f"{name}:{t}")

    # volumes → {name: {solidref, materialref, physvols:[{vol,pos,rotdeg}]}}
    vols = {}
    assemblies: set[str] = set()
    if structure is not None:
        for v in structure:
            # <assembly> is a container with physvols but no solid of its own —
            # treat it like a volume so detector arrays/imprints expand.
            if tag(v) not in ("volume", "assembly"):
                continue
            name = v.get("name")
            if tag(v) == "assembly":
                assemblies.add(name)
            entry = {"solidref": None, "materialref": None, "physvols": []}
            for c in v:
                ct = tag(c)
                if ct == "solidref":
                    entry["solidref"] = c.get("ref")
                elif ct == "materialref":
                    entry["materialref"] = c.get("ref")
                elif ct == "physvol":
                    pv = {"vol": None, "pos": [0, 0, 0], "rotdeg": [0, 0, 0]}
                    for pc in c:
                        pct = tag(pc)
                        if pct == "volumeref":
                            pv["vol"] = pc.get("ref")
                        elif pct == "position":
                            s = _lscale(pc.get("unit"))
                            pv["pos"] = [float(pc.get("x", 0)) * s, float(pc.get("y", 0)) * s,
                                         float(pc.get("z", 0)) * s]
                        elif pct == "positionref":
                            pv["pos"] = named_pos.get(pc.get("ref"), [0, 0, 0])
                        elif pct == "rotation":
                            s = _ascale(pc.get("unit"))
                            pv["rotdeg"] = [math.degrees(float(pc.get("x", 0)) * s),
                                            math.degrees(float(pc.get("y", 0)) * s),
                                            math.degrees(float(pc.get("z", 0)) * s)]
                        elif pct == "rotationref":
                            r = named_rot.get(pc.get("ref"), [0, 0, 0])
                            pv["rotdeg"] = [math.degrees(a) for a in r]
                    entry["physvols"].append(pv)
            vols[name] = entry

    world = None
    if setup is not None:
        w = next((c for c in setup if tag(c) == "world"), None)
        if w is not None:
            world = w.get("ref")
    if world is None and vols:
        world = next(iter(vols))

    # flatten the hierarchy → world-absolute placed solids
    out: list[dict] = []
    counter = {"i": 0}
    name_idx: dict[str, int] = {}   # per-name copy counter → unique id

    def short(name: str) -> str:
        # strip Geant4's "0x...." pointer suffix for display/grouping.
        return name.split("0x", 1)[0] or name

    def emit(volname, pos, rot, is_world, group):
        v = vols.get(volname)
        if not v:
            return
        sref = v.get("solidref")
        if sref in sol and short(volname) not in SKIP_VOLUMES:
            s = sol[sref]
            mat = v.get("materialref")
            color = _MAT_COLOR.get(mat) or _PALETTE[counter["i"] % len(_PALETTE)]
            counter["i"] += 1
            sn = short(volname)
            idx = name_idx.get(sn, 0)
            name_idx[sn] = idx + 1
            g = {"type": s["type"], "id": f"{sn}#{idx}", "copy": idx,
                 "name": sn, "group": group,
                 "pos": [round(x, 4) for x in pos],
                 "rot": [round(a, 3) for a in _mat_to_euler_deg(rot)],
                 "color": color, "opacity": 0.10,
                 "wireframe": is_world, "visible": not is_world}
            if s["type"] == "box":
                g["size"] = s["size"]
            elif s["type"] == "cylinder":
                g["rmax"], g["height"] = s["rmax"], s["height"]
            elif s["type"] == "sphere":
                g["radius"] = s["radius"]
            out.append(g)
        # Children of an assembly are tagged with that assembly's name so the UI
        # can group/collapse the imprinted copies together.
        child_group = short(volname) if volname in assemblies else group
        for pv in v["physvols"]:
            rx, ry, rz = (math.radians(a) for a in pv["rotdeg"])
            child_rot = _matmul(rot, _euler_to_mat(rx, ry, rz))
            child_pos = [pos[k] + _matvec(rot, pv["pos"])[k] for k in range(3)]
            emit(pv["vol"], child_pos, child_rot, False, child_group)

    if world:
        emit(world, [0, 0, 0], _IDENT, True, "")
    return {"geometry": out, "skipped": skipped, "world": world}


def geometry(path: Path) -> list[dict]:
    """Just the geometry list (what scene.py needs)."""
    return parse(path)["geometry"]
