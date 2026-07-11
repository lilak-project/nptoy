"""Portal SSO — re-exported from the shared `lilak_portal_auth` package.

This used to be a per-service COPY of the token-verify / identity / introspect
glue. It now lives once in `lilak_portal_auth` (installed in the shared portal
venv); this thin re-export keeps the `from portal_auth import identity` call sites
working. Add service-specific helpers here, not another copy of the shared core.
"""
from lilak_portal_auth import (  # noqa: F401  (re-export)
    SECRET_KEY,
    ALGORITHM,
    MANAGER_COLOR,
    decode_token,
    bearer_from_request,
    introspect,
    fresh_payload,
    identity,
    list_accounts,
)
