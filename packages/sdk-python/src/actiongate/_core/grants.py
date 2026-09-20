"""Canonical fingerprints and Action Grant signing.

Ported from `@actiongate/core`. Canonical JSON must match the TypeScript
implementation byte for byte, because the fingerprint is what binds a grant to
one exact action. `tests/test_conformance.py` compares both against shared
fixtures so a divergence fails rather than silently producing grants that only
verify within one language.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any


def canonical_json(value: Any) -> str:
    """Stable JSON with sorted keys, matching the TypeScript `canonicalJson`."""
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        # JS sorts with localeCompare; for the ASCII field names used here that
        # agrees with code-point order, which the conformance fixtures check.
        entries = sorted(value.items(), key=lambda pair: pair[0])
        return "{" + ",".join(f"{json.dumps(key)}:{canonical_json(item)}" for key, item in entries) + "}"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, float) and value.is_integer():
        # JSON.stringify(1.0) is "1" in JavaScript; json.dumps gives "1.0".
        return str(int(value))
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def action_binding_fingerprint(binding: dict[str, Any], policy_version: str) -> str:
    action = binding["proposedAction"]
    payload = {
        "tenantId": binding["tenantId"],
        "environment": binding["environment"],
        "agentId": binding["agentId"],
        "userId": binding.get("userId"),
        "sessionId": binding.get("sessionId"),
        "tool": str(action["tool"]).strip().lower(),
        "operation": str(action["operation"]).strip().lower(),
        "arguments": action["arguments"],
        "riskClass": action["riskClass"],
        "policyVersion": policy_version,
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


class ActionGrantError(Exception):
    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code


@dataclass
class GrantClaims:
    payload: dict[str, Any]

    @property
    def grant_id(self) -> str:
        return self.payload["grantId"]

    @property
    def decision_id(self) -> str:
        return self.payload["decisionId"]

    @property
    def action_fingerprint(self) -> str:
        return self.payload["actionFingerprint"]

    @property
    def expires_at(self) -> int:
        return self.payload["expiresAt"]


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class ActionGrantSigner:
    """Issues and verifies `ag2` grant tokens."""

    def __init__(self, secret: str, key_id: str = "embedded", ttl_seconds: int = 30, clock=None) -> None:
        if len(secret) < 32:
            raise ValueError("An Action Grant signing secret must be at least 32 characters")
        if not 1 <= ttl_seconds <= 300:
            raise ValueError("Action Grant TTL must be from 1 to 300 seconds")
        self._secret = secret.encode("utf-8")
        self._key_id = key_id
        self._ttl = ttl_seconds
        self._clock = clock or (lambda: time.time() * 1000)

    def issue(self, request: dict[str, Any], decision_id: str, policy_version: str, policy_id: str) -> tuple[str, GrantClaims]:
        issued_at = int(self._clock() / 1000)
        action = request["proposedAction"]
        actor = request["actor"]
        claims = {
            "v": 1,
            "issuer": "actiongate",
            "keyId": self._key_id,
            "grantId": str(uuid.uuid4()),
            "decisionId": decision_id,
            "requestId": request["requestId"],
            "tenantId": request["tenantId"],
            "environment": request["environment"],
            "agentId": actor["agentId"],
            "tool": str(action["tool"]).strip().lower(),
            "operation": str(action["operation"]).strip().lower(),
            "riskClass": action["riskClass"],
            "actionFingerprint": action_binding_fingerprint(
                {
                    "tenantId": request["tenantId"],
                    "environment": request["environment"],
                    "agentId": actor["agentId"],
                    **({"userId": actor["userId"]} if actor.get("userId") else {}),
                    **({"sessionId": actor["sessionId"]} if actor.get("sessionId") else {}),
                    "proposedAction": action,
                },
                policy_version,
            ),
            "policy": {"id": policy_id, "version": policy_version},
            "issuedAt": issued_at,
            "expiresAt": issued_at + self._ttl,
        }
        payload = _b64url(canonical_json(claims).encode("utf-8"))
        signing_input = f"ag2.{self._key_id}.{payload}"
        signature = _b64url(hmac.new(self._secret, signing_input.encode("utf-8"), hashlib.sha256).digest())
        return f"ag2.{self._key_id}.{payload}.{signature}", GrantClaims(claims)

    def verify(self, token: str, consume_request: dict[str, Any]) -> GrantClaims:
        parts = token.split(".")
        if len(parts) != 4 or parts[0] != "ag2" or not all(parts[1:]):
            raise ActionGrantError("GRANT_MALFORMED")
        _, key_id, payload, signature = parts
        if key_id != self._key_id:
            raise ActionGrantError("GRANT_INVALID_SIGNATURE", "The signing key is unknown or retired")
        expected = hmac.new(self._secret, f"ag2.{key_id}.{payload}".encode("utf-8"), hashlib.sha256).digest()
        if not hmac.compare_digest(_unb64url(signature), expected):
            raise ActionGrantError("GRANT_INVALID_SIGNATURE")

        claims = json.loads(_unb64url(payload).decode("utf-8"))
        now = int(self._clock() / 1000)
        if now >= claims["expiresAt"]:
            raise ActionGrantError("GRANT_EXPIRED")

        actor = consume_request["actor"]
        expected_fingerprint = action_binding_fingerprint(
            {
                "tenantId": consume_request["tenantId"],
                "environment": consume_request["environment"],
                "agentId": actor["agentId"],
                **({"userId": actor["userId"]} if actor.get("userId") else {}),
                **({"sessionId": actor["sessionId"]} if actor.get("sessionId") else {}),
                "proposedAction": consume_request["proposedAction"],
            },
            claims["policy"]["version"],
        )
        if not hmac.compare_digest(expected_fingerprint, claims["actionFingerprint"]):
            raise ActionGrantError("GRANT_BINDING_MISMATCH", "Grant does not authorize this exact action")
        return GrantClaims(claims)
