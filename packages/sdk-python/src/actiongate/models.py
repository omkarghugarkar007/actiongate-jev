"""Typed shapes for the ActionGate contract.

These mirror the API's own schemas. They are convenience types, not validation:
the server validates every field, and this client does not duplicate that logic
where it would only drift.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Decision = Literal["ALLOW", "REVIEW", "BLOCK"]
Mode = Literal["shadow", "enforce"]
Environment = Literal["development", "staging", "production"]
RiskClass = Literal[
    "READ_ONLY",
    "REVERSIBLE_WRITE",
    "EXTERNAL_COMMUNICATION",
    "FINANCIAL",
    "DESTRUCTIVE",
    "CREDENTIAL_OR_SECRET",
]


@dataclass(frozen=True)
class ProposedAction:
    tool: str
    operation: str
    arguments: dict[str, Any]
    risk_class: RiskClass

    def to_payload(self) -> dict[str, Any]:
        return {
            "tool": self.tool,
            "operation": self.operation,
            "arguments": self.arguments,
            "riskClass": self.risk_class,
        }


@dataclass(frozen=True)
class Actor:
    agent_id: str
    user_id: str | None = None
    session_id: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"agentId": self.agent_id}
        if self.user_id is not None:
            payload["userId"] = self.user_id
        if self.session_id is not None:
            payload["sessionId"] = self.session_id
        return payload


@dataclass(frozen=True)
class UserIntent:
    text: str
    source: Literal["user_message", "workflow", "operator"] = "user_message"

    def to_payload(self) -> dict[str, Any]:
        return {"text": self.text, "source": self.source}


@dataclass(frozen=True)
class AuthorizationRequest:
    request_id: str
    idempotency_key: str
    tenant_id: str
    environment: Environment
    mode: Mode
    actor: Actor
    user_intent: UserIntent
    proposed_action: ProposedAction
    deterministic_facts: dict[str, Any] | None = None
    context: dict[str, Any] | None = None
    policy_version: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "requestId": self.request_id,
            "idempotencyKey": self.idempotency_key,
            "tenantId": self.tenant_id,
            "environment": self.environment,
            "mode": self.mode,
            "actor": self.actor.to_payload(),
            "userIntent": self.user_intent.to_payload(),
            "proposedAction": self.proposed_action.to_payload(),
        }
        if self.deterministic_facts is not None:
            payload["deterministicFacts"] = self.deterministic_facts
        if self.context is not None:
            payload["context"] = self.context
        if self.policy_version is not None:
            payload["policyVersion"] = self.policy_version
        return payload


@dataclass(frozen=True)
class Reason:
    code: str
    message: str
    source: str


@dataclass(frozen=True)
class ActionGrant:
    token: str
    grant_id: str
    expires_at: str


@dataclass(frozen=True)
class AuthorizationResponse:
    decision_id: str
    decision: Decision
    mode: Mode
    risk_class: RiskClass
    reasons: list[Reason] = field(default_factory=list)
    grant: ActionGrant | None = None
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "AuthorizationResponse":
        grant_payload = payload.get("grant")
        return cls(
            decision_id=payload.get("decisionId", ""),
            decision=payload.get("decision", "BLOCK"),
            mode=payload.get("mode", "enforce"),
            risk_class=payload.get("riskClass", "READ_ONLY"),
            reasons=[
                Reason(code=item.get("code", ""), message=item.get("message", ""), source=item.get("source", ""))
                for item in payload.get("reasons", [])
            ],
            grant=(
                ActionGrant(
                    token=grant_payload["token"],
                    grant_id=grant_payload["grantId"],
                    expires_at=grant_payload["expiresAt"],
                )
                if grant_payload
                else None
            ),
            raw=payload,
        )


def _unused() -> None:  # pragma: no cover - keeps asdict imported for consumers
    asdict(UserIntent(text="x"))
