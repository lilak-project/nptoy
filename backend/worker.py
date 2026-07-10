"""The single global worker (PLAN §4.2 / §7).

One background thread runs at most one job at a time: it promotes the oldest
`queued` job to `running`, launches the simulator as its own process group, and
enforces the per-job timeout by killing the whole tree. Because there is exactly
one loop, FIFO ordering and "one job at a time" hold across all users without any
lock beyond the DB.
"""
from __future__ import annotations

import os
import shutil
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
import sim_client
import simgate
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
            if job_id == _current_job_id:
                # Flag it; the local path kills the process tree, the sci path's
                # poll loop notices the flag and stops waiting on the remote job.
                _cancel_requested.add(job_id)
                if _current_proc is not None:
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
    # Hold one global sim slot for the whole run, so batch jobs + interactive
    # sessions together never exceed NPTOY_MAX_CONCURRENT_SIMS live simulators
    # (host-memory guard). Blocks here while interactive sessions saturate the
    # gate; the job stays QUEUED until a slot frees.
    with simgate.slot():
        # A job cancelled while we were blocked on the gate must not still run.
        try:
            session.refresh(job)
        except Exception:
            pass
        if job.status in db.TERMINAL:
            return
        _run_job_impl(session, job)


def _run_job_impl(session, job: db.Job) -> None:
    # Server deploy: delegate to the sci-runner container (ROOT+Geant4+nptool),
    # which the portal container lacks. Everything else (queue, statuses, outputs)
    # is identical either way.
    if config.RUNNER == "sci":
        _run_job_sci(session, job)
        return

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
                                 online=config.online_events_for(man))
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


def _run_job_sci(session, job: db.Job) -> None:
    """Run a job on the sci-runner container instead of locally (server deploy).

    Stage a self-contained workspace on the SHARED volume (inputs/ + outputs/, the
    same layout the local path runs against), submit an `npsimulation` argv with the
    runner's cwd set to that staged inputs/ dir, poll to completion, then copy the
    artifacts back into the user's real outputs/ so the viewer/download/save code is
    unchanged. Because the shared volume is the SAME on both sides (portal `/sci`,
    runner `/data`), a path relative to it addresses the same files in both — so the
    sim's relative args (`-D detector.txt`, `-B ../outputs/x.mac`) resolve identically."""
    global _current_job_id

    job.status = db.STATUS_RUNNING
    job.started_at = _now()
    session.commit()

    ins, outs, man = inputs.prepare_inplace(job.user_key)
    rp = inputs.run_paths(job.user_key, job.run_name or f"job_{job.id}")

    # 1) stage inputs/ (+ empty outputs/) on the shared volume.
    stage = sim_client.staging_dir(job.id)
    stage_in, stage_out = stage / "inputs", stage / "outputs"
    shutil.rmtree(stage, ignore_errors=True)
    shutil.copytree(ins, stage_in)
    stage_out.mkdir(parents=True, exist_ok=True)
    (stage_out / rp["mac"].name).write_text(
        f"/det/export_geometry {rp['geom_rel']}\n" + params_mod.build_macro(job.params))

    # 2) submit — the same npsimulation flags as the local path, as an argv (the
    #    runner's env already has ROOT+Geant4+nptool sourced), cwd = staged inputs/.
    argv = ["npsimulation", "-D", man["detector"], "-E", man["reaction"],
            "-O", rp["name"], "-B", rp["mac_rel"], "--record-track"]
    online = config.online_events_for(man)
    if online > 0:
        argv += ["--online-data-streaming", str(online)]
    timeout_sec = settings.job_timeout_sec(job.user_key)
    try:
        sub = sim_client.submit(argv, name=rp["name"], timeout=timeout_sec,
                                cwd=sim_client.rel_to_shared(stage_in))
        runner_id = sub["job_id"]
    except Exception as exc:                      # runner unreachable → fail, don't hang
        shutil.rmtree(stage, ignore_errors=True)
        job.status = db.STATUS_FAILED
        job.error = f"sci-runner unreachable: {exc}"
        job.finished_at = _now()
        session.commit()
        return

    with _current_lock:
        _current_job_id = job.id

    # 3) poll to completion (respect cancels; give up if the runner goes silent past
    #    the timeout so a network partition can't hang the queue forever).
    st: dict = {}
    cancelled = False
    missing = 0
    deadline = time.monotonic() + timeout_sec + 60
    while True:
        time.sleep(config.WORKER_POLL_SEC)
        with _current_lock:
            if job.id in _cancel_requested:
                cancelled = True
                break
        if time.monotonic() > deadline:
            st = {"status": "timeout"}
            break
        try:
            st = sim_client.status(runner_id)
        except Exception:
            continue                              # transient; keep waiting
        s = st.get("status")
        if s == "notfound":                       # runner restarted and lost the job
            missing += 1
            if missing >= 2:                      # confirmed gone → stop waiting
                st = {"status": "error", "error": "sci-runner lost the job (it restarted)"}
                break
            continue
        missing = 0
        if s in ("done", "error", "timeout"):
            break

    # Stop the REMOTE process on cancel or our own deadline. The runner now keeps a
    # killable handle per job, so this actually frees the runner's CPU/RAM instead
    # of leaving npsimulation burning until its own timeout (which under-counted
    # load on the shared runner and risked OOM-killing other users' sims).
    if cancelled or st.get("status") == "timeout":
        try:
            sim_client.job_cancel(runner_id)
        except Exception:
            pass

    with _current_lock:
        _cancel_requested.discard(job.id)
        _current_job_id = None

    # 4) copy the produced artifacts back into the user's outputs/ (skip on cancel).
    if not cancelled:
        try:
            for f in stage_out.iterdir():
                if f.is_file():
                    shutil.copy2(f, outs / f.name)
        except OSError:
            pass
        try:                                      # live-stream file nptool wrote in cwd
            live = stage_in / inputs.STREAM_NAME
            if live.exists():
                shutil.copy2(live, rp["stream"])
        except OSError:
            pass
        try:                                      # the runner's stdout log
            rlog = sim_client.result_dir(runner_id) / "run.log"
            if rlog.exists():
                shutil.copy2(rlog, rp["log"])
            elif st.get("log_tail"):
                rp["log"].write_text(st["log_tail"])
        except OSError:
            pass

    # 5) finalize (mirror the local path's status logic).
    job.exit_code = st.get("rc")
    job.finished_at = _now()
    job.size_bytes = sum(p.stat().st_size for k in ("root", "gdml", "geom", "stream", "log", "mac")
                         if (p := rp[k]).exists())
    if cancelled:
        job.status = db.STATUS_CANCELLED
        job.error = "cancelled"
    elif st.get("status") == "timeout":
        job.status = db.STATUS_TIMEOUT
        job.error = f"exceeded {timeout_sec}s timeout"
    elif st.get("status") == "done" and st.get("rc") == 0:
        job.status = db.STATUS_DONE
    else:
        job.status = db.STATUS_FAILED
        job.error = st.get("error") or f"simulator exited with code {st.get('rc')}"
    session.commit()

    shutil.rmtree(stage, ignore_errors=True)


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
