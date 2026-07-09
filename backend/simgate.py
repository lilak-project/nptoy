"""Global admission control for heavy Geant4 (`npsimulation`) processes.

Two paths spawn a simulator: interactive viewer sessions (session.SciSession /
Session) and batch jobs (worker). Each `npsimulation` can use hundreds of MB to
several GB of RAM, so running too many at once can exhaust the host and trigger
the kernel OOM-killer (which takes down unrelated processes too).

This one semaphore bounds the TOTAL number running concurrently across both
paths, sized by NPTOY_MAX_CONCURRENT_SIMS (default 3). Batch jobs block on a
slot (they are queued anyway); interactive sessions take a slot non-blocking and
are refused with a friendly 429 when none is free.
"""
from __future__ import annotations

import contextlib
import os
import threading


def _cap() -> int:
    try:
        return max(1, int(os.environ.get("NPTOY_MAX_CONCURRENT_SIMS", "3")))
    except (TypeError, ValueError):
        return 3


CAPACITY = _cap()
_sem = threading.BoundedSemaphore(CAPACITY)


def try_acquire() -> bool:
    """Take a slot without waiting. Returns False if all are in use."""
    return _sem.acquire(blocking=False)


def release() -> None:
    """Return a slot. Guarded so a stray double-release can't raise."""
    with contextlib.suppress(ValueError):
        _sem.release()


@contextlib.contextmanager
def slot():
    """Block until a slot is free, hold it for the duration, always release."""
    _sem.acquire()
    try:
        yield
    finally:
        release()
