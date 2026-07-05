"""In-memory presence for the community chat — who's connected right now.

The backend is a single uvicorn process, so a plain dict guarded by a lock is
enough. A user counts as 'online' if they polled or posted within PRESENCE_TTL
seconds (the frontend polls every couple of seconds).
"""
from __future__ import annotations

import threading
import time

PRESENCE_TTL = 45  # seconds since last activity to still count as online

_lock = threading.Lock()
_seen: dict[str, dict] = {}   # user_key -> {name, color, shape, ts}


def touch(user_key: str, name: str, color: str = "", shape: str = "") -> None:
    with _lock:
        _seen[user_key] = {"name": name or user_key, "color": color, "shape": shape, "ts": time.time()}


def online() -> list[dict]:
    now = time.time()
    with _lock:
        users = [{"key": k, "name": v["name"], "color": v["color"], "shape": v["shape"]}
                 for k, v in _seen.items() if now - v["ts"] < PRESENCE_TTL]
    users.sort(key=lambda u: u["name"].lower())
    return users
