"""The single global worker (PLAN §4.2 / §7).

One background thread runs at most one job at a time: it promotes the oldest
`queued` job to `running`, launches the simulator as its own process group, and
enforces the per-job timeout by killing the whole tree. Because there is exactly
one loop, FIFO ordering and "one job at a time" hold across all users without any
lock beyond the DB.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

import config
import db
import inputs
import params as params_mod
import session as session_mod
import settings
import workspace

# Shared state between the worker loop and the cancel endpoint. Only the worker
# writes `_current`; the API thread reads it and records cancel requests.
_current_lock = threading.Lock()
_current_job_id: str | None = None
_current_proc: subprocess.Popen | None = None
_cancel_requested: set[str] = set()
_started = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def request_cancel(job_id: str) -> str:
    """Cancel a job the caller owns. A queued job is cancelled in place; the
    running job (if it is this one) gets its process tree killed. Returns the
    resulting status hint ('cancelled' / 'queued-cancelled' / 'not-cancellable')."""
    session = db.Session()
    try:
        job = session.get(db.Job, job_id)
        if not job or job.status in db.TERMINAL:
            return "not-cancellable"
        with _current_lock:
            if job_id == _current_job_id and _current_proc is not None:
                _cancel_requested.add(job_id)
                _kill_tree(_current_proc)
                return "cancelled"
        # Still queued — mark terminal so the worker skips it when reached.
        job.status = db.STATUS_CANCELLED
        job.finished_at = _now()
        job.error = "cancelled while queued"
        session.commit()
        return "queued-cancelled"
    finally:
        session.close()


def _kill_tree(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _next_queued(session) -> db.Job | None:
    return (
        session.query(db.Job)
        .filter(db.Job.status == db.STATUS_QUEUED)
        .order_by(db.Job.created_at.asc())
        .first()
    )


def _run_job(session, job: db.Job) -> None:
    global _current_job_id, _current_proc

    job.status = db.STATUS_RUNNING
    job.started_at = _now()
    session.commit()

    # Real nptool batch run IN PLACE against the user's live inputs/ (cwd=inputs),
    # ROOT + geometry + log written to outputs/{project}_{run}.{user}.sim.* (run_name
    # assigned at submit; falls back to job_<id> for pre-existing jobs). Own process
    # group so a timeout/cancel kills the whole Geant4 subtree.
    ins, _outs, man = inputs.prepare_inplace(job.user_key)
    rp = inputs.run_paths(job.user_key, job.run_name or f"job_{job.id}")
    try:
        rp["live_stream"].unlink()
    except FileNotFoundError:
        pass
    # macro lives in outputs/ (referenced relative to cwd=inputs): export geometry
    # once, then the fixed beamOn macro. Stream first N events for the viewer.
    rp["mac"].write_text(
        f"/det/export_geometry {rp['geom_rel']}\n" + params_mod.build_macro(job.params))
    cmd = session_mod.nptool_cmd(man, rp["name"], batch_macro=rp["mac_rel"],
                                 online=config.ONLINE_EVENTS)
    logf = open(rp["log"], "w")
    proc = subprocess.Popen(
        ["bash", "-lc", cmd], cwd=str(ins),
        stdout=logf, stderr=subprocess.STDOUT, start_new_session=True,
    )
    with _current_lock:
        _current_job_id, _current_proc = job.id, proc

    timeout_sec = settings.job_timeout_sec(job.user_key)
    timed_out = False
    try:
        proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_tree(proc)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass

    with _current_lock:
        cancelled = job.id in _cancel_requested
        _cancel_requested.discard(job.id)
        _current_job_id, _current_proc = None, None

    logf.close()
    # persist the transient live stream next to the job's other artifacts
    try:
        if rp["live_stream"].exists():
            rp["live_stream"].replace(rp["stream"])
    except OSError:
        pass
    job.exit_code = proc.returncode
    job.finished_at = _now()
    job.size_bytes = sum(p.stat().st_size for k in ("root", "gdml", "geom", "stream", "log", "mac")
                         if (p := rp[k]).exists())
    if cancelled:
        job.status = db.STATUS_CANCELLED
        job.error = "cancelled"
    elif timed_out:
        job.status = db.STATUS_TIMEOUT
        job.error = f"exceeded {timeout_sec}s timeout"
    elif proc.returncode == 0:
        job.status = db.STATUS_DONE
    else:
        job.status = db.STATUS_FAILED
        job.error = f"simulator exited with code {proc.returncode}"
    session.commit()


def _loop() -> None:
    while True:
        session = db.Session()
        try:
            job = _next_queued(session)
            if job is not None:
                _run_job(session, job)
                continue  # immediately look for the next one
        except Exception as exc:  # keep the worker alive across job failures
            print(f"[nptoy worker] error: {exc}", file=sys.stderr)
        finally:
            session.close()
        time.sleep(config.WORKER_POLL_SEC)


def start() -> None:
    global _started
    if _started:
        return
    _started = True
    db.recover_orphans()
    threading.Thread(target=_loop, name="nptoy-worker", daemon=True).start()
