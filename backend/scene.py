"""Scene JSON for the 3D viewer (PLAN §4.4).

Geometry is GDML-driven (gdml.py) — when a run exports a `geometry.gdml` it is
parsed into box/cylinder/sphere volumes automatically. nptool's `npsimulation`
does not export GDML out of the box yet, so geometry is empty until that is added.

Tracks / energy points are extracted from the nptool ROOT output
(`SimulatedTree`: `TrackInfo` = per-particle vertex+momentum, `InteractionCoordinates`
= detector hits). That extraction (via a ROOT macro) is the next step.
"""
from __future__ import annotations

import json
from pathlib import Path

import gdml


def _short(name: str) -> str:
    return name.split("0x")[0].rstrip("_") or name


def geometry_json(path: Path) -> list[dict]:
    """Flat geometry from nptool's `/det/export_geometry` JSON dump. Each item has a
    global rotation MATRIX (`rot`, 9 row-major) + translation (`pos`), so no Euler
    convention drift, and nested assemblies are already flattened."""
    out = []
    try:
        rows = json.loads(path.read_text())
    except (ValueError, OSError):
        return []
    for i, g in enumerate(rows):
        typ, dim = g.get("type"), g.get("dim", [0, 0, 0])
        nm = _short(g.get("name", f"v{i}"))
        # flat dump has no assembly hierarchy → group="" renders each volume as a
        # top-level row; the panel then collapses repeats into "name ×N". (Grouping
        # by name would nest a one-item "name" group under itself.)
        item = {"id": f"{nm}#{g.get('copy', 0)}#{i}", "name": nm, "short": nm,
                "group": "", "copy": g.get("copy", 0),
                "pos": g.get("pos", [0, 0, 0]), "rot": g.get("rot"),  # 9-matrix
                "color": g.get("color", [0.6, 0.7, 0.8]), "visible": True, "type": typ}
        if typ == "box":
            item["size"] = dim
        elif typ == "cylinder":
            item["rmax"] = dim[0]; item["height"] = dim[2]
            # inner radius + phi wedge (radians) for annular sectors (e.g. QQQ5).
            # Absent in older dumps → 0 / full circle, so old cylinders are unchanged.
            item["rmin"] = g.get("rmin", 0.0)
            item["phi0"] = g.get("phi0", 0.0)
            item["dphi"] = g.get("dphi", 0.0)
        elif typ == "sphere":
            item["radius"] = dim[0]
        elif typ == "mesh":
            # exact triangulated shape (local coords, 9 numbers/triangle) — used for
            # Boolean/other solids so cuts & notches render (e.g. the QQQ5 wafer).
            item["verts"] = g.get("verts", [])
            if not item["verts"]:
                continue
        else:
            continue
        out.append(item)
    return out


def geometry(geom_path: Path | None = None) -> list[dict]:
    """Geometry for this run: the flat JSON dump (`.geom.json`) if present, else a
    legacy `.gdml`, else empty."""
    if geom_path is not None and geom_path.exists():
        try:
            if geom_path.suffix == ".json" or geom_path.name.endswith(".geom.json"):
                return geometry_json(geom_path)
            return gdml.geometry(geom_path)
        except Exception:
            pass
    return []


def empty(gdml_path: Path | None = None, n_events: int = 0) -> dict:
    """Geometry (if exported) but no tracks/points yet."""
    return {
        "meta": {"units": "mm", "energy_unit": "MeV", "n_events": n_events,
                 "n_points": 0, "energy_max": 0.0, "pending": True},
        "geometry": geometry(gdml_path),
        "tracks": [],
        "edep": [],
    }


# Render caps for the live stream. A scintillator run makes thousands of optical
# photons per event; we keep every charged track, then the neutral tracks that
# travel FARTHEST (the escaping photons) up to MAX_TRACKS — otherwise the interesting
# escaping light loses its slot to the dense short-lived swarm inside the crystal.
# Return a superset (sorted most-interesting-first); the viewer renders one 500-track
# page at a time (so drawing stays fast) and lets the user page through the rest.
MAX_TRACKS = 2000
MAX_POINTS = 40000
POINTS_PER_TRACK = 60   # subsample bouncy photon polylines to keep the payload light


def _thin(points: list, cap: int = POINTS_PER_TRACK) -> list:
    """Subsample a step polyline to at most `cap` points, keeping first + last."""
    n = len(points)
    if n <= cap:
        return points
    out = [points[(i * (n - 1)) // (cap - 1)] for i in range(cap)]
    out[-1] = points[-1]
    return out


def _thin_idx(n: int, cap: int = POINTS_PER_TRACK) -> list | None:
    """Indices that subsample a length-`n` polyline to `cap` points (keeping first+last),
    or None if it already fits. Used to thin a track's parallel points/times/edeps in step."""
    if n <= cap:
        return None
    idx = [(i * (n - 1)) // (cap - 1) for i in range(cap)]
    idx[-1] = n - 1
    return idx


def _reach2(points: list) -> float:
    """Squared max distance any step reaches from the origin. Photons that ESCAPE the
    detector reach farther out than the swarm trapped inside it, and they leave in a
    few steps (cheap to keep), so this ranks the interesting escaping light first."""
    return max(x * x + y * y + z * z for x, y, z in points) if points else 0.0


def from_online(stream: Path, gdml_path: Path | None = None,
                tracks_from: int = 0, tracks_count: int | None = None) -> dict:
    """Scene from nptool's live stream file `stream`
    (`evt trk parent pdg charge x y z edep`, mm/MeV) + GDML geometry.

    Tracks are grouped by (event, trackID) into step polylines; energy-deposit
    points are the steps with edep>0. The file is flushed per step and truncated
    each /run/beamOn, so this reads the latest run live — no ROOT close needed.

    Tracks are ordered charged-first then neutral by reach (escaping photons first);
    the viewer requests one page at a time (`tracks_from`/`tracks_count`) so every
    track is reachable by paging while each response stays small. `tracks_count=None`
    returns the first MAX_TRACKS (default for non-paging callers)."""
    tracks: dict[tuple, dict] = {}
    edep: list[list[float]] = []
    emax = 0.0
    events: set[int] = set()
    has_time = False                            # did the stream carry the time column?
    if stream.exists():
        for line in stream.read_text().splitlines():
            if not line or line[0] == "#":
                continue
            f = line.split()
            if len(f) not in (9, 10):           # 10th col = global time (ns), optional
                continue
            try:
                ev, trk, par, pdg = int(f[0]), int(f[1]), int(f[2]), int(f[3])
                charge = float(f[4])
                x, y, z, e = float(f[5]), float(f[6]), float(f[7]), float(f[8])
                tm = float(f[9]) if len(f) == 10 else None
            except ValueError:
                continue
            if tm is not None:
                has_time = True
            events.add(ev)
            key = (ev, trk)
            t = tracks.get(key)
            if t is None:                       # collect ALL tracks first, cap on output
                t = tracks[key] = {"eventID": ev, "trackID": trk, "parentID": par,
                                   "pdg": pdg, "charge": charge, "points": [], "times": [], "edeps": []}
            t["points"].append([x, y, z])
            # Fall back to point index as pseudo-time for streams without the time column,
            # so the viewer still animates in recorded order until nptool ships the time.
            t["times"].append(tm if tm is not None else float(len(t["points"]) - 1))
            t["edeps"].append(e)                # per-point energy deposit (0 if none) — the
                                                # animation reveals these dots in time WITH the track
            if e > 0 and len(edep) < MAX_POINTS:
                edep.append([x, y, z, e])
                if e > emax:
                    emax = e

    # Order charged-first, then neutral by reach (escaping photons first).
    all_tracks = list(tracks.values())
    charged = [t for t in all_tracks if t["charge"] != 0]
    neutral = [t for t in all_tracks if t["charge"] == 0]
    neutral.sort(key=lambda t: _reach2(t["points"]), reverse=True)
    ordered = charged + neutral
    total = len(ordered)

    if tracks_count is None:                    # non-paging caller: first MAX_TRACKS
        start, kept = 0, ordered[:MAX_TRACKS]
    else:                                       # one page for the viewer
        start = max(0, min(tracks_from, max(0, total - 1)))
        kept = ordered[start:start + max(1, tracks_count)]
    for t in kept:
        idx = _thin_idx(len(t["points"]))
        if idx is not None:
            t["points"] = [t["points"][i] for i in idx]
            t["times"] = [t["times"][i] for i in idx]
            t["edeps"] = [t["edeps"][i] for i in idx]

    return {
        "meta": {"units": "mm", "energy_unit": "MeV", "n_events": len(events),
                 "n_points": len(edep), "energy_max": emax, "has_time": has_time,
                 "n_tracks_total": total, "n_tracks_from": start, "n_tracks_shown": len(kept)},
        "geometry": geometry(gdml_path),
        "tracks": kept,
        "edep": edep,
    }
