"""
Client for the sci-runner container (ROOT + Geant4 + nptool).

nptoy's web backend stays LIGHT inside the portal container; the heavy simulation
work runs in the separate `sci-runner` container. nptoy submits a job here and reads
its outputs from the shared volume (mounted at /sci in the portal, /data in the
runner). See web_service/sci-runner/runner.py.

This is a thin stub — wire it into the real param-editor / job-queue endpoints as
nptoy grows. Uses only urllib so it needs no extra deps.
"""
from __future__ import annotations

import json
import os
import shutil
import urllib.error
import urllib.request
from pathlib import Path

SCI_URL = os.environ.get("SCI_RUNNER_URL", "http://sci-runner:8100").rstrip("/")
SCI_SHARED_DIR = Path(os.environ.get("SCI_SHARED_DIR", "/sci"))     # results live under jobs/<id>/
SCI_TOKEN = os.environ.get("SCI_TOKEN", "").strip()
STAGING_DIR = SCI_SHARED_DIR / "staging"     # a job's inputs are staged here; the runner
                                             # sees the same files (same shared volume).


def _headers() -> dict:
    return {"Content-Type": "application/json", **({"Authorization": f"Bearer {SCI_TOKEN}"} if SCI_TOKEN else {})}


def _http_error_message(exc: urllib.error.HTTPError) -> str:
    body = exc.read().decode(errors="replace")
    if body:
        try:
            payload = json.loads(body)
            detail = payload.get("detail")
            if detail:
                return str(detail)
        except json.JSONDecodeError:
            pass
        return body
    return f"sci-runner HTTP {exc.code}"


def staging_dir(job_id) -> Path:
    """Where nptoy stages a job's self-contained workspace on the shared volume."""
    return STAGING_DIR / str(job_id)


def rel_to_shared(p) -> str:
    """A path inside the shared volume as a POSIX path relative to its root. The SAME
    string addresses it inside the runner (its own mount of the volume), so it's what
    we hand the runner as its `cwd`."""
    return Path(p).resolve().relative_to(SCI_SHARED_DIR.resolve()).as_posix()


def submit(argv: list[str], name: str | None = None, timeout: int | None = None,
           cwd: str | None = None) -> dict:
    """Queue a simulation/analysis job on the runner. argv[0] must be an nptool tool
    (npsimulation / npanalysis / root). `cwd` is a path relative to the shared volume
    to run in (see rel_to_shared). Returns {"job_id": ...}."""
    body = json.dumps({"argv": argv, "name": name, "timeout": timeout, "cwd": cwd}).encode()
    req = urllib.request.Request(f"{SCI_URL}/jobs", data=body, headers=_headers(), method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def status(job_id: str) -> dict:
    req = urllib.request.Request(f"{SCI_URL}/jobs/{job_id}", headers=_headers())
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def result_dir(job_id: str) -> Path:
    """Where this job's output files landed on the shared volume."""
    return SCI_SHARED_DIR / "jobs" / job_id


def rbrowser_open(user_key: str) -> dict:
    return _post("/rbrowser/open", {"user_key": user_key})


def rbrowser_http_url(token: str, path: str, query: str = "") -> str:
    url = f"{SCI_URL}/rbrowser/proxy/{token}/{path}"
    if query:
        url += "?" + query
    return url


def rbrowser_ws_url(token: str, path: str, query: str = "") -> str:
    base = SCI_URL
    if base.startswith("https://"):
        base = "wss://" + base[len("https://"):]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://"):]
    url = f"{base}/rbrowser/proxy/{token}/{path}"
    if query:
        url += "?" + query
    return url


# ── interactive sessions (persistent `npsimulation -N` hosted in the runner) ──
def _get(path: str) -> dict:
    req = urllib.request.Request(f"{SCI_URL}{path}", headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_http_error_message(exc)) from exc


def _post(path: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{SCI_URL}{path}", data=data, headers=_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_http_error_message(exc)) from exc


def session_start(argv: list[str], cwd: str | None = None, name: str | None = None,
                  geom_cmd: str | None = None) -> dict:
    """Start a persistent interactive session in the runner. `cwd` is a path relative
    to the shared volume (the caller stages the workspace there). `geom_cmd` is the
    `/det/export_geometry <rel>` command the runner sends once the G4 terminal is
    ready. Returns {"session_id": ...}."""
    return _post("/session", {"argv": argv, "cwd": cwd, "name": name, "geom_cmd": geom_cmd})


def session_status(sid: str) -> dict:
    return _get(f"/session/{sid}")


def session_log(sid: str, since: int = 0) -> dict:
    return _get(f"/session/{sid}/log?since={int(since)}")


def session_beamon(sid: str, n: int) -> dict:
    return _post(f"/session/{sid}/beamon", {"n": int(n)})


def session_verbose(sid: str, on: bool) -> dict:
    return _post(f"/session/{sid}/verbose", {"on": bool(on)})


def session_stop(sid: str, force: bool = False) -> dict:
    return _post(f"/session/{sid}/stop", {"force": bool(force)})


# ── server-side ROOT draw (browser viewer can't stream nptool's unsplit objects) ──
RENDER_DIR = SCI_SHARED_DIR / "render"     # .root files staged here for the runner to draw


def stage_file_for_render(user_key, abspath) -> str:
    """Copy a user's .root onto the shared volume (cached by size+mtime) so the runner
    can read it, and return the path RELATIVE to the shared volume (what the runner
    addresses as its `file`)."""
    src = Path(abspath)
    st = src.stat()
    dest = RENDER_DIR / str(user_key) / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not (dest.exists() and dest.stat().st_size == st.st_size
            and dest.stat().st_mtime >= st.st_mtime):
        shutil.copy2(src, dest)
    return dest.resolve().relative_to(SCI_SHARED_DIR.resolve()).as_posix()


def root_draw(rel: str, tree: str, expr: str, cut: str = "", hist: str = "") -> str:
    """Ask the runner to TTree::Draw `expr` (1D "varx" or 2D "vary:varx") from the
    staged file — with an optional selection `cut` and explicit `hist` binning — and
    return the resulting histogram as a JSON string (JSROOT parses+draws it)."""
    body = json.dumps({"file": rel, "tree": tree, "expr": expr, "cut": cut, "hist": hist}).encode()
    req = urllib.request.Request(f"{SCI_URL}/root/draw", data=body, headers=_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.read().decode()
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_http_error_message(exc)) from exc


def root_save(rel: str, tree: str, expr: str, cut: str, hist: str, name: str, opt: str,
              out_rel: str) -> str:
    """Ask the runner to run the same TTree::Draw and WRITE the histogram + a TCanvas
    into a .root file at `out_rel` (relative to the shared volume). Returns out_rel; the
    caller copies that file back into the user's root/ dir."""
    body = json.dumps({"file": rel, "tree": tree, "expr": expr, "cut": cut, "hist": hist,
                       "name": name, "opt": opt, "out": out_rel}).encode()
    req = urllib.request.Request(f"{SCI_URL}/root/save", data=body, headers=_headers(), method="POST")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            json.loads(r.read().decode())
            return out_rel
    except urllib.error.HTTPError as exc:
        raise RuntimeError(_http_error_message(exc)) from exc


def render_out_path(rel: str) -> Path:
    """Absolute path (on the shared volume) of a runner output addressed relative to it."""
    return (SCI_SHARED_DIR / rel).resolve()
