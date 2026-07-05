"""Portal-token authentication (SSO).

The portal mints a JWT carrying `sub, username, role/prole, email, name, …` and
forwards it as `Authorization: Bearer <jwt>` to services with
`identity.accepts_portal_token`. We validate with the shared secret and identify
the user by email (identity.link_by = email). No local password store — the portal
is the single source of accounts.
"""
from __future__ import annotations

import hashlib
import re
from typing import Optional

from fastapi import Depends, Header, HTTPException, status
from jose import JWTError, jwt
from pydantic import BaseModel

import config


class PortalUser(BaseModel):
    email: str
    username: str
    name: str
    role: str
    user_key: str   # filesystem-safe stable id derived from email
    color: str = ""  # portal profile avatar colour (hex)
    shape: str = ""  # portal profile avatar icon name


def _user_key(email: str) -> str:
    """Stable, filesystem-safe per-user workspace id (PLAN §4.3).

    A slugged email plus a short hash keeps the dir human-readable while avoiding
    collisions between addresses that slug to the same string.
    """
    slug = re.sub(r"[^a-zA-Z0-9._-]", "_", email.strip().lower())[:48] or "user"
    digest = hashlib.sha256(email.strip().lower().encode()).hexdigest()[:8]
    return f"{slug}-{digest}"


def _bearer(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    return None


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, config.SECRET_KEY, algorithms=[config.ALGORITHM])
    except JWTError:
        return None


def require_user(authorization: Optional[str] = Header(default=None)) -> PortalUser:
    token = _bearer(authorization)
    payload = decode_token(token) if token else None
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="로그인이 필요합니다.")
    email = payload.get("email")
    if not email:
        # A token without an email can't be linked to a workspace (link_by=email).
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="토큰에 email이 없습니다.")
    return PortalUser(
        email=email,
        username=payload.get("username", email),
        name=payload.get("name") or payload.get("username") or email,
        role=payload.get("prole") or payload.get("role") or "user",
        user_key=_user_key(email),
        color=payload.get("color") or "",   # portal profile avatar (proxy token)
        shape=payload.get("shape") or "",
    )
