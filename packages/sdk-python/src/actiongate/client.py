"""The ActionGate client."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Protocol, TypeVar

from .errors import ActionBlockedError, ActionGateApiError, ActionGrantMissingError
from .models import (
    Actor,
    AuthorizationRequest,
    AuthorizationResponse,
    Environment,
    Mode,
    ProposedAction,
    RiskClass,
    UserIntent,
)

T = TypeVar("T")


class Transport(Protocol):
    """Injectable so tests never touch the network."""

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
        ...


def _urllib_transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - url is caller-supplied config
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except urllib.error.URLError as error:  # pragma: no cover - network failure path
        raise ActionGateApiError(0, "ACTIONGATE_UNREACHABLE", str(error.reason)) from error


@dataclass
class ActionGateOptions:
    api_key: str
    base_url: str
    transport: Transport | None = None


class ActionGate:
    """Authorize actions and consume grants.

    ``wrap_tool`` is the usual entry point: it authorizes, consumes the grant,
    and only then calls the handler. Keep the handler private to the module that
    wraps it, or another caller can reach it without a grant.
    """

    def __init__(self, options: ActionGateOptions | None = None, **kwargs: Any) -> None:
        self._options = options or ActionGateOptions(**kwargs)
        self._transport = self._options.transport or _urllib_transport

    # -- raw API ---------------------------------------------------------

    def authorize(self, request: AuthorizationRequest) -> AuthorizationResponse:
        payload = self._request(
            "POST",
            "/v1/authorize",
            request.to_payload(),
            extra_headers={"Idempotency-Key": request.idempotency_key},
        )
        return AuthorizationResponse.from_payload(payload)

    def consume_grant(
        self,
        *,
        token: str,
        tenant_id: str,
        environment: Environment,
        actor: Actor,
        proposed_action: ProposedAction,
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/v1/grants/consume",
            {
                "token": token,
                "tenantId": tenant_id,
                "environment": environment,
                "actor": actor.to_payload(),
                "proposedAction": proposed_action.to_payload(),
            },
        )

    def record_execution(
        self,
        *,
        decision_id: str,
        status: str,
        detail: str | None = None,
        external_ref: str | None = None,
    ) -> dict[str, Any]:
        """Authorization is not execution. Record what actually happened."""
        payload: dict[str, Any] = {"decisionId": decision_id, "status": status}
        if detail is not None:
            payload["detail"] = detail
        if external_ref is not None:
            payload["externalRef"] = external_ref
        return self._request("POST", "/v1/executions", payload)

    # -- guarded execution -----------------------------------------------

    def wrap_tool(
        self,
        *,
        name: str,
        operation: str,
        risk_class: RiskClass,
        execute: Callable[..., T],
        build_request: Callable[..., dict[str, Any]],
    ) -> Callable[..., T]:
        """Return a callable that authorizes and consumes before executing.

        ``build_request`` returns the authorization context for this call:
        tenant, environment, mode, actor, user intent, and optionally
        deterministic facts. The proposed action is filled in from ``name``,
        ``operation``, ``risk_class`` and the call's own arguments, so a caller
        cannot authorize one action and execute another.
        """

        def guarded(arguments: dict[str, Any], runtime: Any = None) -> T:
            base = build_request(arguments, runtime)
            mode: Mode = base.get("mode", "enforce")
            actor = base["actor"] if isinstance(base["actor"], Actor) else Actor(**base["actor"])
            intent = base["user_intent"] if isinstance(base["user_intent"], UserIntent) else UserIntent(**base["user_intent"])
            proposed = ProposedAction(tool=name, operation=operation, arguments=arguments, risk_class=risk_class)

            request = AuthorizationRequest(
                request_id=base.get("request_id") or str(uuid.uuid4()),
                idempotency_key=base.get("idempotency_key") or str(uuid.uuid4()),
                tenant_id=base["tenant_id"],
                environment=base["environment"],
                mode=mode,
                actor=actor,
                user_intent=intent,
                proposed_action=proposed,
                deterministic_facts=base.get("deterministic_facts"),
                context=base.get("context"),
            )

            authorization = self.authorize(request)
            if authorization.decision != "ALLOW":
                raise ActionBlockedError(authorization.raw)

            if mode == "enforce":
                if authorization.grant is None:
                    raise ActionGrantMissingError(authorization.raw)
                # Consume before executing. A failure here raises, so the
                # handler is never reached.
                self.consume_grant(
                    token=authorization.grant.token,
                    tenant_id=request.tenant_id,
                    environment=request.environment,
                    actor=actor,
                    proposed_action=proposed,
                )

            return execute(arguments, runtime)

        return guarded

    # -- transport --------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        url = f"{self._options.base_url.rstrip('/')}{path}"
        headers = {
            "Authorization": f"Bearer {self._options.api_key}",
            "Accept": "application/json",
            **(extra_headers or {}),
        }
        encoded: bytes | None = None
        if body is not None:
            encoded = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        status, raw = self._transport(method, url, headers, encoded)
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {}

        if status >= 400:
            error = payload.get("error", {}) if isinstance(payload, dict) else {}
            raise ActionGateApiError(
                status,
                error.get("code", "INTERNAL_ERROR"),
                error.get("message", "ActionGate request failed"),
            )
        return payload if isinstance(payload, dict) else {}
