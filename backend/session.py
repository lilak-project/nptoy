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
import simgate

def _human_size(n: int) -> str:
    x = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if x < 1024 or unit == "GB":
            return (f"{int(x)} {unit}" if unit in ("B", "KB") else f"{x:.1f} {unit}")
        x /= 1024


def _describe_output(dst, staged_src) -> str:
    """`name · 256 KB · 1000 events` — size always, event count for a .root when the
    sci-runner can read it (best-effort; falls back to size only)."""
    try:
        label = f"{dst.name} · {_human_size(dst.stat().st_size)}"
    except OSError:
        return dst.name
    if dst.suffix == ".root":
        try:
            n = sim_client.count_entries(sim_client.rel_to_shared(staged_src))
            if isinstance(n, int) and n >= 0:
                label += f" · {n} events"
        except Exception:
            pass
    return label


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
        # A session is a VIEWER run: its ROOT/geometry go to the disposable outputs/viewer/
        # dir under fixed names (overwritten each session), so they never collide with a
        # run number and never clutter the Files-tab output list. Real, kept data comes
        # from batch runs instead.
        self.project = inputs._sanitize(inputs.setup_name(self.user_key))
        self.run, self.output = None, inputs.VIEWER_SUBDIR   # viewer run → no run number
        self.paths = inputs.viewer_run_paths(self.user_key)
        self.paths["dir"].mkdir(parents=True, exist_ok=True)
        for p in (self.paths["live_stream"], self.paths["geom"]):
            try:
                p.unlink()                      # clear any stale artifacts
            except FileNotFoundError:
                pass
        cmd = nptool_cmd(man, self.paths["name"], online=config.online_events_for(man))
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
        """A viewer session leaves only disposable artifacts in outputs/viewer/, so it
        reports nothing to keep — the stop notice stays quiet (batch runs report files)."""
        return []

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
        # Persist the transient live stream beside the ROOT; KEEP geometry + ROOT in outputs/.
        try:
            if self.paths["live_stream"].exists():
                shutil.copy2(self.paths["live_stream"], self.paths["stream"])
        except (OSError, AttributeError, KeyError):
            pass
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
        # A session is a VIEWER run (see Session._start): disposable output, no run
        # number, never persisted to the user's outputs/.
        self.project = inputs._sanitize(inputs.setup_name(user_key))
        self.run, self.output = None, inputs.VIEWER_SUBDIR   # viewer run → no run number

        self._stage = sim_client.staging_dir(f"sess-{self.id}")
        stage_in, stage_out = self._stage / "inputs", self._stage / "outputs"
        shutil.rmtree(self._stage, ignore_errors=True)
        shutil.copytree(ins, stage_in)
        stage_out.mkdir(parents=True, exist_ok=True)

        # Disposable viewer artifacts, flat in the staged outputs dir on the shared
        # volume (portal /sci ↔ runner /data). The scene endpoint reads geom + the live
        # stream off disk while the session runs; staging is torn down on stop() and
        # nothing is copied into the user's real outputs/.
        self.paths = {
            "geom": stage_out / "live.geom.json",
            "geom_rel": "../outputs/live.geom.json",
            "live_stream": stage_in / inputs.STREAM_NAME,
        }

        argv = ["npsimulation", "-D", man["detector"], "-E", man["reaction"],
                "-O", "live.root", "-N", "--record-track"]
        online = config.online_events_for(man)
        if online > 0:
            argv += ["--online-data-streaming", str(online)]
        sub = sim_client.session_start(
            argv, cwd=sim_client.rel_to_shared(stage_in), name=self.output,
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
        # Viewer session: nothing to keep. Drop the staged workspace (its disposable
        # ROOT/geometry/stream go with it) and report no created files.
        shutil.rmtree(self._stage, ignore_errors=True)
        self.state = STOPPED
        return []

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
        self._held: set[str] = set()          # user_keys currently holding a simgate slot
        self._lock = threading.Lock()

    def get(self, user_key: str) -> Session | None:
        with self._lock:
            s = self._sessions.get(user_key)
            if s and not s.alive():
                s._set(STOPPED)
            return s

    def _reap_locked(self) -> None:
        """Drop dead sessions and hand their sim slots back to simgate. Caller
        holds self._lock. Keeps slots from leaking when a session dies without an
        explicit stop() (browser closed, runner killed the process)."""
        for uk, s in list(self._sessions.items()):
            if not s.alive():
                s._set(STOPPED)
                self._sessions.pop(uk, None)
                if uk in self._held:
                    self._held.discard(uk)
                    simgate.release()

    def _live_count(self) -> int:
        return sum(1 for s in self._sessions.values() if s.alive())

    def start(self, user_key: str, user_name: str = "") -> Session:
        with self._lock:
            self._reap_locked()               # free slots of any dead sessions first
            existing = self._sessions.get(user_key)
            if existing and existing.alive():
                return existing               # one session per user
            if self._live_count() >= settings.max_sessions():
                raise RuntimeError("server session limit reached — try again later")
            # Global heavy-sim ceiling shared with batch jobs (guards host memory).
            if not simgate.try_acquire():
                raise RuntimeError("동시 시뮬레이션 한도에 도달했습니다 — 잠시 후 다시 시도하세요.")
            # Server deploy delegates to sci-runner (which has nptool); dev runs locally.
            impl = SciSession if config.RUNNER == "sci" else Session
            try:
                s = impl(user_key, user_name)
            except Exception:
                simgate.release()             # launch failed → don't strand the slot
                raise
            self._sessions[user_key] = s
            self._held.add(user_key)
            return s

    def stop(self, user_key: str, force: bool = False) -> list[str] | None:
        """Stop the user's session and return the output files it left (names), or None
        if there was no session. `force` SIGKILLs immediately (abort a heavy run)."""
        with self._lock:
            s = self._sessions.pop(user_key, None)
            if user_key in self._held:        # return its global sim slot
                self._held.discard(user_key)
                simgate.release()
        if s:
            return s.stop(force) or []
        return None


manager = SessionManager()
