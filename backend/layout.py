"""layout.py — reusable per-service UI layout config (tabs + in-tab rail menus).

Drop-in, like community.py: build a router and include it. The layout config
(which tabs show, their order/labels/icons, and each tab's rail menu items +
dividers) is STRUCTURE only — the panel behind each menu id is code. It's stored
as JSON in the service data dir so the same source is edited by the service's
Settings tab and by the portal's Manage UI (through the proxy).

    from layout import build_layout_router
    app.include_router(build_layout_router(
        path=DATA / "layout.json",
        identity=identity,                 # portal SSO → {..., role}
        defaults=lambda: DEFAULT_LAYOUT,   # the service's code-provided layout
    ))

Config shape:
  { "tabs": [
      { "id": "setup", "label": "Setup", "icon": "home", "hidden": false,
        "menu": [ { "type": "item", "id": "detector", "label": "Detector", "icon": "atom" },
                  { "type": "divider" }, ... ] },
      { "id": "community", "label": "Community", "icon": "community" }, ...
  ] }

GET returns the stored config RECONCILED with `defaults` (a tab added in code shows
up without wiping the user's arrangement). PUT/reset are manager-only.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Depends, HTTPException


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _reconcile(stored: Optional[dict], defaults: dict) -> dict:
    """Effective config = the stored tabs (user's arrangement wins), plus any default
    tab whose id isn't stored yet — so a tab newly added in code appears rather than
    being hidden forever by a stale saved layout."""
    if not stored or not isinstance(stored.get("tabs"), list):
        return defaults
    d_tabs = [t for t in (defaults or {}).get("tabs", []) if isinstance(t, dict)]
    s_tabs = [t for t in stored["tabs"] if isinstance(t, dict) and t.get("id")]
    have = {t["id"] for t in s_tabs}
    appended = [t for t in d_tabs if t.get("id") not in have]
    return {**stored, "tabs": s_tabs + appended}


def _is_manager(user: dict) -> bool:
    return str((user or {}).get("role", "")).lower() in ("manager", "admin")


def build_layout_router(*, path, identity: Callable, defaults) -> APIRouter:
    router = APIRouter(prefix="/api/layout", tags=["layout"])
    path = Path(path)

    def _defaults() -> dict:
        d = defaults() if callable(defaults) else defaults
        return d if isinstance(d, dict) and isinstance(d.get("tabs"), list) else {"tabs": []}

    def _stored() -> Optional[dict]:
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text())
        except Exception:
            return None

    @router.get("")
    def get_layout(user: dict = Depends(identity)) -> dict:
        return _reconcile(_stored(), _defaults())

    @router.get("/defaults")
    def get_defaults(user: dict = Depends(identity)) -> dict:
        """The code-provided layout, ignoring any saved overrides (for a 'reset' preview)."""
        return _defaults()

    @router.put("")
    def put_layout(payload: dict, user: dict = Depends(identity)) -> dict:
        if not _is_manager(user):
            raise HTTPException(403, "관리자만 레이아웃을 편집할 수 있습니다.")
        if not isinstance(payload, dict) or not isinstance(payload.get("tabs"), list):
            raise HTTPException(400, "invalid layout: expected { tabs: [...] }")
        _atomic_write(path, json.dumps(payload, ensure_ascii=False, indent=2))
        return _reconcile(payload, _defaults())

    @router.post("/reset")
    def reset_layout(user: dict = Depends(identity)) -> dict:
        if not _is_manager(user):
            raise HTTPException(403, "관리자만 레이아웃을 초기화할 수 있습니다.")
        path.unlink(missing_ok=True)
        return _defaults()

    return router
