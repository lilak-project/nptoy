"""Interactive nptool sessions — live `npsimulation -N` + a Run button.

`npsimulation … -N` opens a Geant4 UI terminal that reads commands from stdin
(`Idle>` prompt). We keep that process alive per user and push `/run/beamOn <n>`
into its stdin one at a time, streaming its stdout back to the web. Each beamOn
accumulates into the same open ROOT output tree.

SECURITY (critical): a Geant4 terminal accepts ANY command on stdin, including
`/control/shell …` (a shell escape). So user text is NEVER forwarded — the backend
only ever writes the fixed string `/run/beamOn <validated int>` (and `exit`).
Projects are a whitelist (config.PROJECTS); no arbitrary paths/commands.

One session per user, with a global cap (config.MAX_SESSIONS). Each session runs in
an isolated per-user copy of the project so outputs never collide.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone

import config
import inputs
import settings
import sim_client

# states
STARTING = "starting"   # process up, Geant4 still initialising (no Idle> yet)
IDLE = "idle"           # ready for a command
RUNNING = "running"     # a /run/beamOn is in progress
STOPPED = "stopped"     # process gone

_LOG_CAP = 4000         # keep the last N stdout lines


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── shared nptool helpers (used by sessions AND batch jobs) ────────────────────
def nptool_cmd(man: dict, output_name: str, *, batch_macro: str | None = None,
               online: int = 0) -> str:
    """The bash command to launch npsimulation with the nptool env sourced. Runs with
    cwd = the user's inputs/ dir: `-D detector.txt -E reaction.txt`. `output_name` is
    the `-O` basename (project.config's SimulationOutput=../outputs prepends the dir,
    so ROOT lands in outputs/). Interactive (`-N`) when no macro, batch (`-B <macro>`)
    otherwise. `online>0` streams the first N events/run to online_stream.dat."""
    mode = f"-B {batch_macro}" if batch_macro else "-N"
    stream = f" --online-data-streaming {online}" if online > 0 else ""
    return (
        f'source "{config.NPTOOL_SETUP}" >/dev/null 2>&1 && '
        f'exec npsimulation -D {man["detector"]} -E {man["reaction"]} '
        f'-O {output_name} {mode} --record-track{stream}'
    )


class Session:
    def __init__(self, user_key: str, user_name: str = ""):
        self.id = uuid.uuid4().hex[:12]
        self.user_key = user_key
        self.user_name = user_name
        self.example = ""
        self.project = ""                   # setup name (output {project}_…)
        self.run = 0                         # this session's run number
        self.output = ""                     # output basename {project}_{run}.{user}.sim
        self.state = STARTING
        self.runs = 0                       # number of beamOn issued
        self.created_at = _now()
        self.lines: list[str] = []
        self._lock = threading.Lock()
        self._io_lock = threading.Lock()   # serialize stdin writes
        self._gdml_sent = False
        self._proc: subprocess.Popen | None = None
        self._start()

    # ── lifecycle ─────────────────────────────────────────────────────────────
    def _start(self) -> None:
        # Run IN PLACE against the user's live inputs/ (no per-session copy). ROOT +
        # geometry go to outputs/ (project.config redirects there).
        ins, _outs, man = inputs.prepare_inplace(self.user_key)
        self.example = man.get("example", "")
        self.workdir = ins
        # Name outputs {project}_{run}.{user}.sim.root with a per-project run number
        # that never collides with a previous run of the same project.
        ri = inputs.next_run(self.user_key, self.user_name)
        self.project, self.run, self.output = ri["project"], ri["run"], ri["run_id"]
        self.paths = inputs.run_paths(self.user_key, ri["run_id"])
        # Keep ONE persistent geometry dump in outputs/ (fixed name) — each new run
        # overwrites it, so exactly one geometry file is ever kept (the latest).
        self.paths["geom"] = _outs / inputs.GEOM_NAME
        self.paths["geom_rel"] = f"../outputs/{inputs.GEOM_NAME}"
        for p in (self.paths["live_stream"], self.paths["geom"]):
            try:
                p.unlink()                      # clear any stale artifacts
            except FileNotFoundError:
                pass
        cmd = nptool_cmd(man, self.paths["name"], online=config.ONLINE_EVENTS)
        self._proc = subprocess.Popen(
            ["bash", "-lc", cmd], cwd=str(ins),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            start_new_session=True, bufsize=0,
        )
        threading.Thread(target=self._reader, name=f"sess-{self.id}", daemon=True).start()

    def _set(self, state: str) -> None:
        with self._lock:
            if self.state != STOPPED:
                self.state = state

    def _add(self, line: str) -> None:
        with self._lock:
            self.lines.append(line)
            if len(self.lines) > _LOG_CAP:
                del self.lines[: len(self.lines) - _LOG_CAP]

    def _reader(self) -> None:
        fd = self._proc.stdout.fileno()
        buf = ""
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk.decode(errors="replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                self._add(line.rstrip("\r"))
            # The `Idle> ` prompt has no trailing newline → detect on the tail.
            if buf.rstrip().endswith("Idle>"):
                self._set(IDLE)
                # Once ready, export the flat geometry JSON one time (the viewer
                # reads it). `/det/export_geometry` handles nested assemblies that
                # `/det/export_gdml` crashes on, and carries exact global rotations.
                if not self._gdml_sent and self.alive():
                    self._gdml_sent = True
                    self._send(f"/det/export_geometry {self.paths['geom_rel']}")
        self._set(STOPPED)

    def _send(self, command: str) -> None:
        """Write a fixed command to the live G4 terminal (stdin). NEVER user text."""
        with self._io_lock:
            try:
                self._proc.stdin.write(f"{command}\n".encode())
                self._proc.stdin.flush()
            except (BrokenPipeError, OSError):
                pass

    # ── commands ──────────────────────────────────────────────────────────────
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def run_beamon(self, n: int) -> None:
        if self.state != IDLE:
            raise RuntimeError("session is not idle")
        # ONLY ever a fixed command with a validated integer — never user text.
        self._add(f"» /run/beamOn {n}")
        with self._lock:
            self.runs += 1
            self.state = RUNNING
        self._send(f"/run/beamOn {n}")

    def set_tracking_verbose(self, on: bool) -> None:
        """Toggle Geant4 per-step tracking output on the live terminal. Only ever the
        fixed `/tracking/verbose 0|1` command — never user text. Applies to the next
        /run/beamOn (queued in stdin if sent mid-run)."""
        if self.alive():
            self._add(f"» /tracking/verbose {1 if on else 0}")
            self._send(f"/tracking/verbose {1 if on else 0}")

    def _created_files(self) -> list[str]:
        """Output files this session left in outputs/ (names only), for the stop notice."""
        out = inputs.outputs_dir(self.user_key)
        return [n for n in (f"{self.output}.root", inputs.GEOM_NAME) if (out / n).exists()]

    def stop(self, force: bool = False) -> list[str]:
        if self.alive():
            if force:
                # abort a long/heavy run NOW — SIGKILL the process group, no graceful wait
                try:
                    os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            else:
                try:
                    self._proc.stdin.write(b"exit\n")
                    self._proc.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
                try:
                    self._proc.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
        self._set(STOPPED)
        # Drop only the transient live stream; KEEP the geometry dump + ROOT in outputs/.
        try:
            self.paths["live_stream"].unlink()
        except (FileNotFoundError, AttributeError, KeyError):
            pass
        return self._created_files()

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "id": self.id, "example": self.example, "state": self.state,
                "runs": self.runs, "created_at": self.created_at,
                "log_len": len(self.lines), "alive": self.alive(),
                "project": self.project, "run": self.run, "output": self.output,
            }

    def log_since(self, since: int) -> dict:
        with self._lock:
            since = max(0, min(since, len(self.lines)))
            return {"lines": self.lines[since:], "next": len(self.lines), "state": self.state}


class SciSession:
    """A session whose `npsimulation -N` process lives in the sci-runner container
    (server deploy) instead of locally — the portal has no nptool binary. Mirrors the
    Session interface the API depends on (to_dict / alive / run_beamon / log_since /
    stop / .paths) but proxies every operation over HTTP. The workspace is staged on
    the SHARED volume, so the geometry JSON + live stream the runner writes are read
    straight off disk by the scene endpoint — exactly like the batch path
    (worker._run_job_sci)."""

    def __init__(self, user_key: str, user_name: str = ""):
        self.id = uuid.uuid4().hex[:12]
        self.user_key = user_key
        self.user_name = user_name
        self.created_at = _now()
        self.runs = 0
        self.state = STARTING
        self._sid: str | None = None

        # Stage inputs/ (+ empty outputs/) on the shared volume — same layout the
        # local path runs against, so npsimulation's relative args resolve identically.
        ins, _outs, man = inputs.prepare_inplace(user_key)
        self.example = man.get("example", "")
        ri = inputs.next_run(user_key, user_name)
        self.project, self.run, self.output = ri["project"], ri["run"], ri["run_id"]
        rp = inputs.run_paths(user_key, ri["run_id"])

        self._stage = sim_client.staging_dir(f"sess-{self.id}")
        stage_in, stage_out = self._stage / "inputs", self._stage / "outputs"
        shutil.rmtree(self._stage, ignore_errors=True)
        shutil.copytree(ins, stage_in)
        stage_out.mkdir(parents=True, exist_ok=True)

        # Artifact paths the scene endpoint reads — on the shared volume (portal /sci),
        # where the runner (its /data mount of the same volume) writes them.
        # ONE persistent geometry dump (fixed name) — overwritten each run, persisted
        # into the user's real outputs/ on stop() (below).
        self.paths = {**rp,
                      "geom": stage_out / inputs.GEOM_NAME,
                      "geom_rel": f"../outputs/{inputs.GEOM_NAME}",
                      "live_stream": stage_in / inputs.STREAM_NAME}

        argv = ["npsimulation", "-D", man["detector"], "-E", man["reaction"],
                "-O", rp["name"], "-N", "--record-track"]
        if config.ONLINE_EVENTS > 0:
            argv += ["--online-data-streaming", str(config.ONLINE_EVENTS)]
        sub = sim_client.session_start(
            argv, cwd=sim_client.rel_to_shared(stage_in), name=ri["run_id"],
            geom_cmd=f"/det/export_geometry {self.paths['geom_rel']}")
        self._sid = sub["session_id"]

    def _set(self, state: str) -> None:      # SessionManager.get() calls this on a dead session
        if self.state != STOPPED:
            self.state = state

    def _status(self) -> dict:
        if self._sid is None:
            return {"state": self.state, "alive": False, "runs": self.runs}
        try:
            st = sim_client.session_status(self._sid)
            self.state = st.get("state", self.state)
            self.runs = st.get("runs", self.runs)
            return st
        except Exception:                          # runner unreachable → treat as gone
            return {"state": self.state, "alive": False, "runs": self.runs}

    def alive(self) -> bool:
        return bool(self._status().get("alive"))

    def run_beamon(self, n: int) -> None:
        try:
            st = sim_client.session_beamon(self._sid, n)
        except Exception as exc:                   # 409 (not idle) or transport error
            raise RuntimeError(str(exc))
        self.state = st.get("state", RUNNING)
        self.runs = st.get("runs", self.runs)

    def set_tracking_verbose(self, on: bool) -> None:
        """Toggle Geant4 /tracking/verbose on the runner-hosted terminal (fixed command)."""
        if self._sid:
            sim_client.session_verbose(self._sid, on)

    def stop(self, force: bool = False) -> list[str]:
        if self._sid:
            try:
                sim_client.session_stop(self._sid, force)
            except Exception:
                pass
        # Persist the ROOT + geometry dump into the user's real outputs/ (the staged
        # copies are on the transient shared volume); then drop the staging dir.
        out = inputs.outputs_dir(self.user_key)
        created: list[str] = []
        for src in (self._stage / "outputs" / f"{self.output}.root",
                    self._stage / "outputs" / inputs.GEOM_NAME):
            try:
                if src.exists():
                    shutil.copy2(src, out / src.name)
                    created.append(src.name)
            except OSError:
                pass
        shutil.rmtree(self._stage, ignore_errors=True)
        self.state = STOPPED
        return created

    def to_dict(self) -> dict:
        st = self._status()
        return {
            "id": self.id, "example": self.example, "state": self.state,
            "runs": self.runs, "created_at": self.created_at,
            "log_len": 0, "alive": bool(st.get("alive")),
            "project": self.project, "run": self.run, "output": self.output,
        }

    def log_since(self, since: int) -> dict:
        if self._sid is None:
            return {"lines": [], "next": since, "state": self.state}
        try:
            r = sim_client.session_log(self._sid, since)
            self.state = r.get("state", self.state)
            return r
        except Exception:
            return {"lines": [], "next": since, "state": self.state}


class SessionManager:
    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def get(self, user_key: str) -> Session | None:
        with self._lock:
            s = self._sessions.get(user_key)
            if s and not s.alive():
                s._set(STOPPED)
            return s

    def _live_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.alive())

    def start(self, user_key: str, user_name: str = "") -> Session:
        with self._lock:
            existing = self._sessions.get(user_key)
            if existing and existing.alive():
                return existing               # one session per user
            if self._live_count() >= settings.max_sessions():
                raise RuntimeError("server session limit reached — try again later")
            # Server deploy delegates to sci-runner (which has nptool); dev runs locally.
            impl = SciSession if config.RUNNER == "sci" else Session
            s = impl(user_key, user_name)
            self._sessions[user_key] = s
            return s

    def stop(self, user_key: str, force: bool = False) -> list[str] | None:
        """Stop the user's session and return the output files it left (names), or None
        if there was no session. `force` SIGKILLs immediately (abort a heavy run)."""
        with self._lock:
            s = self._sessions.pop(user_key, None)
        if s:
            return s.stop(force) or []
        return None


manager = SessionManager()
