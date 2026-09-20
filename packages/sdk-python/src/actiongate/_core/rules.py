"""Deterministic rules.

Ported from `@actiongate/core`. The invariant that matters most: a configured
hard rule must be *affirmatively* satisfied. An absent, untrusted, or stale fact
means the control could not be evaluated, which fails closed. "Require RBAC" is
never satisfied by the caller staying silent or by the caller vouching for itself.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal

from .policy import Decision, ToolPolicy

FACT_NAMES = (
    "authenticated",
    "authorizedByRbac",
    "duplicate",
    "amountCents",
    "currency",
    "destinationAllowlisted",
    "resourceExists",
)

MESSAGES = {
    "AUTH_REQUIRED": "The action requires an authenticated user.",
    "RBAC_DENIED": "The actor is not authorized for this operation.",
    "TOOL_NOT_ALLOWED": "The requested tool is not enabled by policy.",
    "OPERATION_NOT_ALLOWED": "The requested operation does not match the registered tool operation.",
    "DUPLICATE_ACTION": "A duplicate action was detected.",
    "RESOURCE_NOT_FOUND": "The requested resource does not exist.",
    "AMOUNT_EXCEEDS_LIMIT": "The exact amount exceeds the configured policy limit.",
    "INVALID_CURRENCY": "The currency is not permitted by policy.",
    "DESTINATION_NOT_ALLOWED": "The destination is not allowlisted.",
    "RISK_CLASS_MISMATCH": "The supplied risk class does not match the server-owned tool registry.",
    "AUTH_FACT_MISSING": "The tool requires an authenticated user but no authentication fact was supplied.",
    "RBAC_FACT_MISSING": "The tool requires an authorization check but no RBAC fact was supplied.",
    "DUPLICATE_FACT_MISSING": "The tool denies duplicates but no duplicate-check fact was supplied.",
    "AMOUNT_FACT_MISSING": "The tool has an amount limit but no trusted amount was supplied.",
    "CURRENCY_FACT_MISSING": "The tool restricts currencies but no trusted currency was supplied.",
    "DESTINATION_FACT_MISSING": "The tool requires an allowlisted destination but no allowlist fact was supplied.",
}


@dataclass
class Reason:
    code: str
    message: str
    source: Literal["DETERMINISTIC", "JEV", "SYSTEM"]

    def to_payload(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message, "source": self.source}


@dataclass
class FactAttribution:
    provenance: Literal["caller", "trusted"]
    source: str
    observed_at: str | None = None


@dataclass
class RuleResult:
    decision: Decision | None
    reasons: list[Reason] = field(default_factory=list)
    signals: dict[str, Any] = field(default_factory=dict)


FactStatus = Literal["ok", "absent", "untrusted", "stale"]


def run_deterministic_rules(
    proposed_action: dict[str, Any],
    facts: dict[str, Any] | None,
    tool: ToolPolicy | None,
    attribution: dict[str, FactAttribution] | None = None,
    now_ms: float | None = None,
) -> RuleResult:
    facts = facts or {}
    attribution = attribution or {}
    hits: list[tuple[str, Decision, str | None]] = []
    max_age_ms = (tool.hard_rules.max_fact_age_seconds * 1000) if tool and tool.hard_rules.max_fact_age_seconds else None
    now = now_ms if now_ms is not None else time.time() * 1000

    def status_of(name: str) -> FactStatus:
        if facts.get(name) is None:
            return "absent"
        record = attribution.get(name)
        # With no attribution the fact can only have come from the caller.
        if record is None or record.provenance != "trusted":
            return "untrusted"
        if max_age_ms is None:
            return "ok"
        if not record.observed_at:
            return "stale"
        try:
            from datetime import datetime
            observed = datetime.fromisoformat(record.observed_at.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            return "stale"
        return "ok" if now - observed <= max_age_ms else "stale"

    def with_fact(name: str, missing_code: str, check) -> None:
        status = status_of(name)
        if status == "ok":
            check()
        elif status == "absent":
            hits.append((missing_code, "BLOCK", None))
        elif status == "untrusted":
            hits.append(("FACT_NOT_TRUSTED", "BLOCK",
                         f'The tool requires server-resolved facts, but "{name}" was asserted by the caller.'))
        else:
            hits.append(("FACT_STALE", "BLOCK",
                         f'The trusted fact "{name}" is older than the tool\'s maximum fact age.'))

    if tool is None or not tool.enabled:
        hits.append(("TOOL_NOT_ALLOWED", "BLOCK", None))
    if tool is not None and proposed_action.get("operation") != tool.operation:
        hits.append(("OPERATION_NOT_ALLOWED", "BLOCK", None))
    if tool is not None and proposed_action.get("riskClass") != tool.risk_class:
        hits.append(("RISK_CLASS_MISMATCH", "BLOCK", None))

    rules = tool.hard_rules if tool else None
    if rules and rules.require_authenticated_user:
        def _auth() -> None:
            if facts.get("authenticated") is not True:
                hits.append(("AUTH_REQUIRED", "BLOCK", None))
        with_fact("authenticated", "AUTH_FACT_MISSING", _auth)
    if rules and rules.require_rbac:
        def _rbac() -> None:
            if facts.get("authorizedByRbac") is not True:
                hits.append(("RBAC_DENIED", "BLOCK", None))
        with_fact("authorizedByRbac", "RBAC_FACT_MISSING", _rbac)
    if rules and rules.deny_duplicate:
        def _dup() -> None:
            if facts.get("duplicate") is not False:
                hits.append(("DUPLICATE_ACTION", "BLOCK", None))
        with_fact("duplicate", "DUPLICATE_FACT_MISSING", _dup)
    if facts.get("resourceExists") is not None:
        def _resource() -> None:
            if facts.get("resourceExists") is False:
                hits.append(("RESOURCE_NOT_FOUND", "BLOCK", None))
        with_fact("resourceExists", "RESOURCE_FACT_MISSING", _resource)
    if rules and rules.max_amount_cents is not None:
        limit = rules.max_amount_cents
        def _amount() -> None:
            if (facts.get("amountCents") or 0) > limit:
                hits.append(("AMOUNT_EXCEEDS_LIMIT", "BLOCK", None))
        with_fact("amountCents", "AMOUNT_FACT_MISSING", _amount)
    if rules and rules.allowed_currencies:
        allowed = rules.allowed_currencies
        def _currency() -> None:
            if not facts.get("currency") or facts.get("currency") not in allowed:
                hits.append(("INVALID_CURRENCY", "BLOCK", None))
        with_fact("currency", "CURRENCY_FACT_MISSING", _currency)
    if rules and rules.require_allowlisted_destination:
        def _destination() -> None:
            if facts.get("destinationAllowlisted") is not True:
                hits.append(("DESTINATION_NOT_ALLOWED", "BLOCK", None))
        with_fact("destinationAllowlisted", "DESTINATION_FACT_MISSING", _destination)

    decision: Decision | None = None
    if any(hit[1] == "BLOCK" for hit in hits):
        decision = "BLOCK"
    elif hits:
        decision = hits[0][1]

    present = sorted(name for name in facts if facts.get(name) is not None and name in FACT_NAMES)
    provenance = ",".join(
        f"{name}={attribution[name].source if name in attribution else 'caller'}" for name in present
    ) or "none"

    return RuleResult(
        decision=decision,
        reasons=[Reason(code, message or MESSAGES.get(code, code), "DETERMINISTIC") for code, _, message in hits],
        signals={
            "authenticated": facts.get("authenticated"),
            "authorizedByRbac": facts.get("authorizedByRbac"),
            "duplicate": facts.get("duplicate"),
            "amountCents": facts.get("amountCents"),
            "resourceExists": facts.get("resourceExists"),
            "factProvenance": provenance,
        },
    )
