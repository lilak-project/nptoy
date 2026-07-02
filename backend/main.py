"""nptoy backend — minimal FastAPI shell.

Identifies the portal user (SSO) and serves the built frontend. Add feature
routers under routes/ and include them here as the tabs get real content.
"""
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from portal_auth import identity

app = FastAPI(title="nptoy")

app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "nptoy"}


@app.get("/api/whoami")
def whoami(user: dict = Depends(identity)):
    """Portal identity of the caller (advisory; entry is gated by the portal)."""
    return user


# Serve the built frontend (frontend/dist) behind the portal.
DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
if DIST.is_dir():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
