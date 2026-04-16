"""
sfc_cp_utils.auth — shared multi-user authorization helpers.

Every Lambda handler that participates in the owner-based access control model
should import from here rather than defining its own _caller / _can_read /
_can_write functions.

Rules (mirror the Cognito group semantics defined in the JWT authorizer):
  - own resource  (owner == caller sub, or owner absent)  → always allowed
  - global-write                                           → read + write on anything
  - global-read                                            → read only on anything
  - otherwise                                              → denied on others' resources
"""

from __future__ import annotations

import json


def caller(event: dict) -> tuple[str, list[str]]:
    """Return (sub, groups) extracted from the Lambda authorizer context.

    The JWT authorizer attaches ``sub`` and ``groups`` (JSON-encoded list) to
    the request context under ``requestContext.authorizer.lambda``.
    Falls back to ``("anonymous", [])`` when the context is absent (e.g. local
    testing without a real authorizer).
    """
    ctx = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("lambda", {})
    )
    sub: str = ctx.get("sub", "anonymous")
    groups: list[str] = json.loads(ctx.get("groups", "[]"))
    return sub, groups


def caller_email(event: dict) -> str:
    """Return the caller's email from the Lambda authorizer context.

    The JWT authorizer extracts ``email`` from the Cognito id-token claims and
    attaches it to ``requestContext.authorizer.lambda.email``.
    Returns an empty string when absent (e.g. local testing, access-token flows).
    """
    ctx = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("lambda", {})
    )
    return ctx.get("email", "")


def can_read(item_owner: str | None, caller_sub: str, groups: list[str]) -> bool:
    """True when *caller_sub* may read a resource owned by *item_owner*.

    Allows access when:
    - the item has no owner (legacy / system-created resource), or
    - the caller is the owner, or
    - the caller is in the ``global-read`` or ``global-write`` Cognito group.
    """
    if item_owner is None or item_owner == caller_sub:
        return True
    return "global-read" in groups or "global-write" in groups


def can_write(item_owner: str | None, caller_sub: str, groups: list[str]) -> bool:
    """True when *caller_sub* may mutate (write/delete/control) a resource.

    Allows access when:
    - the item has no owner (legacy / system-created resource), or
    - the caller is the owner, or
    - the caller is in the ``global-write`` Cognito group.

    ``global-read`` does NOT grant write access.
    """
    if item_owner is None or item_owner == caller_sub:
        return True
    return "global-write" in groups
