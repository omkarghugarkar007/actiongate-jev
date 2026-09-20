"""Python client for ActionGate.

Parity with the TypeScript SDK: authorize an action, consume a single-use grant,
then call a private handler. The handler is never invoked unless a grant was
issued and successfully consumed.

Standard library only, so adding it to an application pulls in no dependency tree.
"""

from .client import ActionGate, ActionGateOptions
from .errors import (
    ActionBlockedError,
    ActionGateApiError,
    ActionGateError,
    ActionGrantMissingError,
)
from .models import (
    ActionGrant,
    Actor,
    AuthorizationRequest,
    AuthorizationResponse,
    ProposedAction,
    Reason,
    UserIntent,
)

__all__ = [
    "ActionGate",
    "ActionGateOptions",
    "ActionGateError",
    "ActionGateApiError",
    "ActionBlockedError",
    "ActionGrantMissingError",
    "Actor",
    "UserIntent",
    "AuthorizationRequest",
    "AuthorizationResponse",
    "ProposedAction",
    "ActionGrant",
    "Reason",
]

__version__ = "0.1.0"
