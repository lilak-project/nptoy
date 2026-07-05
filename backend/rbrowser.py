"""Per-user, confined ROOT RBrowser sessions for viewing `.root` files.

One RBrowser process per user, scoped to that user's folder
(`<data>/nptoy/user/<user_key>/` — the same tree the Files tab browses, i.e.
inputs/ + outputs/). Opening any `.root` reuses the user's existing RBrowser; a
second file does NOT spawn a second process (the browser window is reused on the
frontend via a fixed window name, and the RBrowser already sees the whole folder).

Confinement (verified in isolation before wiring this in):
  • Linux (deploy)  → bubblewrap: a fresh mount namespace where ONLY the user's
    folder (mounted read-only at /data) plus the read-only ROOT/nptool runtime
    exist. Nothing else on the host is reachable, and /data can't be modified —
    so even RBrowser's `Enter command` box (arbitrary cling code) can't escape or
    delete data. This is the real security boundary.
  • macOS (dev)     → sandbox-exec, best-effort: RBrowser's file browser insists
    on walking the filesystem from '/', so it can't be hard-locked to one folder
    the way bwrap does (documented limitation). We open it AT the user's folder
    and deny obviously-sensitive paths. Dev convenience only — NOT a security
    boundary. Do not deploy nptoy on macOS as a multi-user host.

The launch URL returned here is the RBrowser's own loopback URL. That is directly
reachable when the browser and the server are the same machine (local dev). For a
remote Linux deployment the frontend must reach RBrowser through a reverse proxy
(HTTP + WebSocket) — see `TODO(proxy)` below; the process/confinement half lives
here and is deployment-independent.
"""
from __future__ import annotations

import os
import platform
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path

import config
import workspace

# ── tunables ──────────────────────────────────────────────────────────────────
IDLE_TIMEOUT_SEC = 20 * 60      # reap an RBrowser this long after its last "open"
_RUNTIME_DIR = Path(config.DATA_ROOT) / ".rbrowser"   # macros live here (host-readable)

# ── session registry ──────────────────────────────────────────────────────────
# user_key -> {"port": int, "key": str, "proc": Popen, "last_used": float}
_sessions: dict[str, dict] = {}
_lock = threading.Lock()
_reaper_started = False


def _free_port() -> int:
    """A free loopback TCP port; RBrowser re-binds it via WebGui.HttpPort. Small
    TOCTOU window between here and RBrowser binding — acceptable for a launcher."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _alive(sess: dict) -> bool:
    proc: subprocess.Popen = sess["proc"]
    return proc.poll() is None


def _kill(sess: dict) -> None:
    proc: subprocess.Popen = sess["proc"]
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
    _cleanup_files(sess.get("port"))


def _cleanup_files(port: int | None) -> None:
    if not port:
        return
    for f in (_RUNTIME_DIR / f"rb_{port}.C", _RUNTIME_DIR / f"confine_{port}.sb"):
        try:
            f.unlink()
        except FileNotFoundError:
            pass


# ── confinement macro + launch command (per platform) ─────────────────────────
def _write_macro(port: int, working_path: str) -> Path:
    """RBrowser bootstrap macro (kept OUTSIDE the confined tree so it stays readable).
    Event loop keeps the web server alive regardless of stdin."""
    _RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    macro = _RUNTIME_DIR / f"rb_{port}.C"
    macro.write_text(
        "{\n"
        f'  gEnv->SetValue("WebGui.HttpPort", {port});\n'
        '  gEnv->SetValue("WebGui.OnetimeKey", "no");\n'
        '  gEnv->SetValue("WebGui.SingleConnMode", "no");\n'
        '  auto b = new ROOT::RBrowser();\n'
        f'  b->SetWorkingPath("{working_path}");\n'
        "  while (true) { gSystem->ProcessEvents(); gSystem->Sleep(50); }\n"
        "}\n"
    )
    return macro


def _launch_cmd(user_key: str, port: int) -> tuple[str, str]:
    """Return (bash_command, process_cwd). The command sources nptool (so detector
    dictionaries are loaded → RBrowser can also *draw* branches, not just list them)
    and starts a confined RBrowser. RBrowser's `SetWorkingPath` is unreliable for
    deep paths, so we ALSO launch with cwd = the target folder — RBrowser opens at
    its working directory, which lands the initial view on the user's folder."""
    user_dir = str(workspace.user_dir(user_key).resolve())
    setup = config.NPTOOL_SETUP
    system = platform.system()

    if system == "Linux":
        # ── real confinement: bubblewrap ──────────────────────────────────────
        # /data = the user's folder (READ-ONLY). Runtime (ROOT + nptool + libs)
        # bound read-only. Fresh /tmp, /proc, /dev. Drop to nobody inside.
        root_prefix = _root_prefix()
        nptool_dir = str(Path(setup).resolve().parent)
        working = "/data"
        macro = _write_macro(port, working)
        ro = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/alternatives",
              root_prefix, nptool_dir, str(macro)]
        binds = " ".join(
            f'--ro-bind "{p}" "{p}"' for p in ro if Path(p).exists())
        cmd = (
            f'source "{setup}" >/dev/null 2>&1; '
            f'exec bwrap {binds} '
            f'--ro-bind "{user_dir}" /data '
            f'--tmpfs /tmp --proc /proc --dev /dev '
            f'--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup '
            f'--uid 65534 --gid 65534 --die-with-parent --chdir /data '
            f'root -l -b -q --web=server "{macro}"'
        )
        return cmd, "/"      # bwrap sets its own --chdir; host cwd is irrelevant

    # ── macOS dev (best-effort, NOT a security boundary) ──────────────────────
    working = user_dir
    macro = _write_macro(port, working)
    profile = _RUNTIME_DIR / f"confine_{port}.sb"
    home = str(Path.home())
    profile.write_text(
        "(version 1)\n(allow default)\n"
        f'(deny file-read* (subpath "{home}/.ssh"))\n'
        f'(deny file-read* (regex #"^{home}/\\.(zsh_history|bash_history|aws|gnupg)"))\n'
    )
    cmd = (
        f'source "{setup}" >/dev/null 2>&1; '
        f'exec sandbox-exec -f "{profile}" '
        f'root -l -b -q --web=server "{macro}"'
    )
    return cmd, working    # cwd = user_dir → RBrowser opens there


def _root_prefix() -> str:
    try:
        return subprocess.check_output(["root-config", "--prefix"], text=True).strip()
    except Exception:
        return "/opt/root"


def _read_key(proc: subprocess.Popen, port: int, timeout: float = 25.0) -> str | None:
    """RBrowser prints `New web window: http://localhost:<port>/win1/?key=<key>`
    to stdout. Wait for it (and for the port to listen)."""
    deadline = time.time() + timeout
    key = None
    while time.time() < deadline:
        if proc.poll() is not None:
            return None
        line = proc.stdout.readline() if proc.stdout else ""
        if line:
            m = _KEY_RE.search(line)
            if m:
                key = m.group(1)
        if key and _port_open(port):
            return key
        if not line:
            time.sleep(0.1)
    return key


import re
_KEY_RE = re.compile(r"key=([a-z0-9]+)")


def _port_open(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


# ── public API ────────────────────────────────────────────────────────────────
def open_for(user_key: str) -> dict:
    """Ensure a confined RBrowser exists for this user and return its launch info.
    Reuses the live session if present (so a second .root does not spawn another)."""
    _ensure_reaper()
    with _lock:
        sess = _sessions.get(user_key)
        if sess and _alive(sess):
            sess["last_used"] = time.time()
            return _info(sess)
        if sess:                      # dead → drop before relaunch
            _sessions.pop(user_key, None)

        # make sure the user's folder exists (Files tab creates it lazily too)
        workspace.user_dir(user_key).mkdir(parents=True, exist_ok=True)
        port = _free_port()
        cmd, cwd = _launch_cmd(user_key, port)
        proc = subprocess.Popen(
            ["bash", "-lc", cmd], cwd=cwd,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, start_new_session=True,
        )
        key = _read_key(proc, port)
        if not key or proc.poll() is not None:
            _kill({"proc": proc, "port": port})
            raise RuntimeError("RBrowser 시작에 실패했습니다.")
        sess = {"port": port, "key": key, "proc": proc, "last_used": time.time()}
        _sessions[user_key] = sess
        return _info(sess)


def close_for(user_key: str) -> bool:
    with _lock:
        sess = _sessions.pop(user_key, None)
    if sess:
        _kill(sess)
        return True
    return False


def _info(sess: dict) -> dict:
    # TODO(proxy): for remote deployments, return a portal-proxied path instead of
    # the raw loopback URL (RBrowser reachable only via the nptoy backend's HTTP+WS
    # reverse proxy). Direct loopback URL works when browser == server (local dev).
    return {
        "url": f"http://127.0.0.1:{sess['port']}/win1/?key={sess['key']}",
        "port": sess["port"],
    }


# ── idle reaper ───────────────────────────────────────────────────────────────
def _ensure_reaper() -> None:
    global _reaper_started
    with _lock:
        if _reaper_started:
            return
        _reaper_started = True
    threading.Thread(target=_reap_loop, daemon=True).start()


def _reap_loop() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with _lock:
            dead = [k for k, s in _sessions.items()
                    if not _alive(s) or now - s["last_used"] > IDLE_TIMEOUT_SEC]
            for k in dead:
                s = _sessions.pop(k)
                _kill(s)


def shutdown_all() -> None:
    with _lock:
        for s in _sessions.values():
            _kill(s)
        _sessions.clear()
