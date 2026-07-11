"""Janitor for the shared /sci volume (sci mode).

Three things accumulated there without bound:
  • staging/<job|sess> — a job/session's staged inputs. The happy AND error paths
    already delete their own, but a HARD crash (portal OOM/kill) mid-job leaks it.
  • render/<user>/<file>.root — the server-side-draw cache; every .root a user ever
    viewed was copied here and NEVER evicted.
  • jobs/<id>/run.log — the runner writes these; cleaned by the runner's own janitor
    (see sci-runner/runner.py), not here.

Design:
  • Staging is swept ONCE at startup, when nothing is running yet (the worker loop
    and sessions start after), so it's safe to remove everything — that reclaims any
    crash leftover. During normal operation the per-job/-session cleanup keeps it
    bounded, so no periodic staging sweep is needed (and a periodic one could race a
    live long session whose staging dir looks old).
  • Render is a pure cache, so a background thread evicts entries not used within
    RENDER_TTL. stage_file_for_render() bumps a file's mtime on every hit, making the
    TTL last-USE based (LRU); an evicted file is simply re-copied on next view.
"""
from __future__ import annotations

import os
import shutil
import threading
import time

import sim_client

RENDER_TTL = int(os.environ.get("NPTOY_RENDER_TTL_SEC", str(7 * 24 * 3600)))   # 7 days
JANITOR_INTERVAL = int(os.environ.get("NPTOY_JANITOR_INTERVAL_SEC", str(3600)))  # hourly

_STAGING = sim_client.STAGING_DIR
_RENDER = sim_client.RENDER_DIR


def sweep_staging_all() -> int:
    """Remove EVERY staging entry. Only call at startup, before the worker loop and
    any session start — nothing is in use then, so this only reclaims crash leftovers."""
    if not _STAGING.exists():
        return 0
    n = 0
    for p in _STAGING.iterdir():
        shutil.rmtree(p, ignore_errors=True)
        n += 1
    return n


def evict_render(now: float | None = None) -> int:
    """Delete render-cache files not used within RENDER_TTL, then prune empty dirs."""
    if not _RENDER.exists():
        return 0
    now = now if now is not None else time.time()
    removed = 0
    for f in _RENDER.rglob("*"):
        if f.is_file():
            try:
                if now - f.stat().st_mtime > RENDER_TTL:
                    f.unlink()
                    removed += 1
            except OSError:
                pass
    for d in sorted((p for p in _RENDER.rglob("*") if p.is_dir()), reverse=True):
        try:
            d.rmdir()          # only succeeds if empty
        except OSError:
            pass
    return removed


def _loop() -> None:
    while True:
        time.sleep(JANITOR_INTERVAL)
        try:
            evict_render()
        except Exception:      # a janitor must never take the service down
            pass


def start() -> int:
    """Startup: sweep stale staging now, then evict render on a background timer."""
    swept = sweep_staging_all()
    try:
        evict_render()
    except Exception:
        pass
    threading.Thread(target=_loop, name="nptoy-janitor", daemon=True).start()
    return swept
