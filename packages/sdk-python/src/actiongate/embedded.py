"""Embedded mode: no server, no API key, no base URL.

Mirrors the TypeScript `ActionGate.embedded()`. The guarantees are the same —
a grant is issued only for an enforced ALLOW and consumed exactly once before
the handler runs — so `wrap_tool` code is identical and graduating to a server
changes one line.

What embedding costs you, stated plainly:

* **One process.** Grants live in memory. They do not survive a restart and do
  not coordinate across replicas, so two processes cannot stop each other
  consuming the same logical action.
* **One tenant.** There is no isolation because there is nothing to isolate from.
* **No durable evidence.** Decisions are returned, not stored. No audit trail,
  review queue, retention, or key rotation.
* **A weaker boundary.** The policy lives in the agent's own process, so code
  that can edit it can raise its own limits. Hosted mode exists precisely so the
  registry sits somewhere the agent cannot reach.
"""

from __future__ import annotations

import os
import secrets
import time
import uuid
from typing import Any, Callable

from ._core.engine import AuthorizationEngine
from ._core.grants import ActionGrantError, ActionGrantSigner
from ._core.policy import DEFAULT_POLICY, Policy
from ._core.providers import FakeDecisionProvider, OpenRouterJevProvider, TypeSafeJevProvider

FactProvider = Callable[[dict[str, Any], Any], "dict[str, Any] | None"]


class EmbeddedPolicyError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class EmbeddedTransport:
    """Runs the whole decision path in this process."""

    def __init__(
        self,
        provider: Any | None = None,
        openrouter_api_key: str | None = None,
        typesafe_api_key: str | None = None,
        model: str | None = None,
        typesafe_model: str | None = None,
        policy: Policy | None = None,
        fact_providers: list[tuple[str, FactProvider]] | None = None,
        grant_ttl_seconds: int = 30,
        timeout_ms: int = 10_000,
        fail_open_read_only: bool = False,
        clock: Callable[[], float] | None = None,
    ) -> None:
        direct_key = typesafe_api_key or os.environ.get("TYPESAFE_API_KEY")
        openrouter_key = openrouter_api_key or os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_KEY")
        if provider is None:
            provider = (
                TypeSafeJevProvider(direct_key, typesafe_model or os.environ.get("TYPESAFE_MODEL") or "jev-1.13.0")
                if direct_key
                else OpenRouterJevProvider(openrouter_key, model or os.environ.get("JEV_MODEL") or "typesafe/jev-1.13", app_title="ActionGate embedded")
                if openrouter_key
                else FakeDecisionProvider()
            )
        self.using_live_provider = isinstance(provider, (OpenRouterJevProvider, TypeSafeJevProvider))
        self._policy = policy or DEFAULT_POLICY
        self._clock = clock or (lambda: time.time() * 1000)
        self._engine = AuthorizationEngine(
            provider, timeout_ms=timeout_ms, fail_open_read_only=fail_open_read_only,
            fact_providers=fact_providers, clock=self._clock,
        )
        # Ephemeral: a grant is only meaningful inside this process, so a
        # process-lifetime secret is exactly the right scope. It also means a
        # grant cannot be replayed against a restarted process.
        self._signer = ActionGrantSigner(secrets.token_urlsafe(48), ttl_seconds=grant_ttl_seconds, clock=self._clock)
        self._grants: dict[str, dict[str, Any]] = {}
        self._by_decision: dict[str, str] = {}
        self._decisions: dict[str, dict[str, Any]] = {}

    def authorize(self, request: dict[str, Any]) -> dict[str, Any]:
        key = f"{request['tenantId']}:{request['environment']}:{request['idempotencyKey']}"
        if key in self._decisions:
            return self._decisions[key]

        action = request["proposedAction"]
        # The policy is the registry here: a caller cannot propose a softer
        # operation or risk than the policy records for that tool.
        tool = self._policy.tools.get(action["tool"])
        if tool is None:
            raise EmbeddedPolicyError("TOOL_NOT_REGISTERED", f"Tool {action['tool']} is not in the policy")
        if not tool.enabled:
            raise EmbeddedPolicyError("TOOL_DISABLED", f"Tool {action['tool']} is disabled")
        if tool.operation != action["operation"] or tool.risk_class != action["riskClass"]:
            raise EmbeddedPolicyError("TOOL_METADATA_MISMATCH", f"Tool {action['tool']} is {tool.operation}/{tool.risk_class}")

        response = self._engine.authorize(request, self._policy)
        response = self._attach_grant(request, response)
        self._decisions[key] = response
        return response

    def consume_grant(self, request: dict[str, Any]) -> dict[str, Any]:
        # Verification checks the signature and every bound field, so a mutated
        # action fails here exactly as it would against the server.
        claims = self._signer.verify(request["token"], request)
        stored = self._grants.get(claims.grant_id)
        if stored is None:
            raise ActionGrantError("GRANT_NOT_FOUND", "This grant is not known to this process")
        if stored.get("consumedAt"):
            raise ActionGrantError("GRANT_ALREADY_CONSUMED", "This grant has already been consumed")
        consumed_at = _iso(self._clock())
        stored["consumedAt"] = consumed_at
        return {"grantId": claims.grant_id, "decisionId": claims.decision_id, "status": "CONSUMED", "consumedAt": consumed_at}

    def outstanding_grants(self) -> int:
        """Grants issued but not yet consumed. Useful in tests and shutdown checks."""
        return sum(1 for grant in self._grants.values() if not grant.get("consumedAt"))

    def _attach_grant(self, request: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
        if response["decision"] != "ALLOW" or response["mode"] != "enforce":
            return response
        existing_id = self._by_decision.get(response["decisionId"])
        if existing_id:
            stored = self._grants[existing_id]
            return {**response, "grant": stored["public"]}
        token, claims = self._signer.issue(request, response["decisionId"], self._policy.version, self._policy.id)
        public = {"token": token, "grantId": claims.grant_id, "expiresAt": _iso(claims.expires_at * 1000)}
        self._grants[claims.grant_id] = {"claims": claims, "public": public}
        self._by_decision[response["decisionId"]] = claims.grant_id
        return {**response, "grant": public}


def _iso(ms: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_request_id() -> str:
    return str(uuid.uuid4())
