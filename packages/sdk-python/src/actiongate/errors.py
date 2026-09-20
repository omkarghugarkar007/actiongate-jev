"""Errors raised by the ActionGate client.

Every one of these means the handler was **not** called.
"""

from __future__ import annotations

from typing import Any


class ActionGateError(Exception):
    """Base class, so an application can catch everything from this client."""


class ActionGateApiError(ActionGateError):
    """The API rejected the request or was unreachable."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message} (HTTP {status})")
        self.status = status
        self.code = code
        self.message = message


class ActionBlockedError(ActionGateError):
    """The decision was REVIEW or BLOCK. Carries the reasons for display."""

    def __init__(self, authorization: dict[str, Any]) -> None:
        decision = authorization.get("decision", "UNKNOWN")
        codes = ", ".join(reason.get("code", "?") for reason in authorization.get("reasons", []))
        super().__init__(f"ActionGate returned {decision}: {codes}")
        self.authorization = authorization
        self.decision = decision

    @property
    def reasons(self) -> list[dict[str, Any]]:
        return list(self.authorization.get("reasons", []))


class ActionGrantMissingError(ActionGateError):
    """An enforced ALLOW arrived without a grant, which must never execute."""

    def __init__(self, authorization: dict[str, Any]) -> None:
        super().__init__("Enforced allow did not include an Action Grant")
        self.authorization = authorization
