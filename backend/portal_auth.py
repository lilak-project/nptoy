"""Portal SSO — verify the portal's HS256 JWT and read the profile claims.

No local user DB: this service only *identifies* the caller. Secret precedence
matches the portal: PORTAL_SECRET_KEY, then ELOG_SECRET_KEY, then a dev default.
"""
from __future__ import annotations

import os
from typing import Optional

from jose import jwt
from fastapi import Header, Request

SECRET_KEY = (
    os.environ.get("PORTAL_SECRET_KEY")
    or os.environ.get("ELOG_SECRET_KEY")
    or "lilak-dev-secret-CHANGE-in-production"
)
ALGORITHM = "HS256"


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except Exception:
        return None


def _token_from_request(authorization: Optional[str], request: Request) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    return request.cookies.get("lilak_portal_token") or request.cookies.get("elog_token")


def identity(request: Request, authorization: Optional[str] = Header(default=None)) -> dict:
    """Soft identity: returns a profile dict (anonymous when no valid token)."""
    token = _token_from_request(authorization, request)
    payload = decode_token(token) if token else None
    if not payload:
        return {"authenticated": False, "email": None, "username": None, "name": None, "role": None}
    return {
        "authenticated": True,
        "email": payload.get("email"),
        "username": payload.get("username") or payload.get("name"),
        "name": payload.get("name") or payload.get("username"),
        "role": payload.get("prole") or payload.get("role"),
    }
