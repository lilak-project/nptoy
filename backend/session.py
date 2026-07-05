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

    def stop(self) -> None:
        if self.alive():
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
        # Drop the transient live stream + the viewer geometry dump (geom.json is only
        # needed while the 3D viewer is live; the ROOT result is what's kept).
        for k in ("live_stream", "geom"):
            try:
                self.paths[k].unlink()
            except (FileNotFoundError, AttributeError, KeyError):
                pass

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
            s = Session(user_key, user_name)
            self._sessions[user_key] = s
            return s

    def stop(self, user_key: str) -> bool:
        with self._lock:
            s = self._sessions.pop(user_key, None)
        if s:
            s.stop()
            return True
        return False


manager = SessionManager()
