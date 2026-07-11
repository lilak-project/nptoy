"""Live portal profile — re-exported from the shared `lilak_portal_auth` package.

This module used to carry its own /api/introspect client + portal-DB reader. That
logic now lives once in `lilak_portal_auth`; this keeps nptoy's existing call sites
(`portal_profile.current(payload, token)`, `portal_profile.list_accounts()`).
"""
from lilak_portal_auth import (  # noqa: F401
    fresh_payload as current,     # nptoy calls portal_profile.current(payload, token)
    introspect,
    list_accounts,
    MANAGER_COLOR,
)
