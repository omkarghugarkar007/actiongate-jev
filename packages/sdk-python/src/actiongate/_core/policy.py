"""Policy, risk classes, and threshold profiles.

A faithful port of `@actiongate/core`. The values here must stay identical to the
TypeScript ones: a fixture suite in `tests/test_conformance.py` compares both
against the same shared cases so a divergence fails CI rather than producing two
systems that quietly disagree.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

RiskClass = Literal[
    "READ_ONLY",
    "REVERSIBLE_WRITE",
    "EXTERNAL_COMMUNICATION",
    "FINANCIAL",
    "DESTRUCTIVE",
    "CREDENTIAL_OR_SECRET",
]

Decision = Literal["ALLOW", "REVIEW", "BLOCK"]


@dataclass(frozen=True)
class Thresholds:
    alignment_min_confidence: float
    target_yes_min: float
    policy_violation_block_at: float
    sensitive_exposure_block_at: float
    scope_expansion_block_at: float
    missing_intent_review_at: float


THRESHOLD_PROFILES: dict[str, Thresholds] = {
    "read-only-v1": Thresholds(0.75, 0.65, 0.90, 0.90, 0.90, 0.55),
    "reversible-write-v1": Thresholds(0.85, 0.80, 0.85, 0.85, 0.85, 0.45),
    "financial-v1": Thresholds(0.92, 0.90, 0.75, 0.80, 0.80, 0.35),
    "destructive-v1": Thresholds(0.97, 0.95, 0.65, 0.70, 0.70, 0.25),
}


@dataclass(frozen=True)
class HardRules:
    max_amount_cents: int | None = None
    allowed_currencies: tuple[str, ...] | None = None
    require_authenticated_user: bool = False
    require_rbac: bool = False
    deny_duplicate: bool = False
    require_allowlisted_destination: bool = False
    require_trusted_facts: bool = False
    max_fact_age_seconds: int | None = None


@dataclass(frozen=True)
class ToolPolicy:
    enabled: bool
    operation: str
    risk_class: RiskClass
    semantic_policy: tuple[str, ...]
    threshold_profile: str
    hard_rules: HardRules = field(default_factory=HardRules)


@dataclass(frozen=True)
class Policy:
    id: str
    version: str
    mode: Literal["shadow", "enforce"]
    tools: dict[str, ToolPolicy]
    require_human_for_risk: tuple[RiskClass, ...] = ()
    skip_semantic_after_hard_review: bool = False


DEFAULT_POLICY = Policy(
    id="support-agent-default",
    version="1.0.0",
    mode="shadow",
    tools={
        "refund_payment": ToolPolicy(
            enabled=True,
            operation="refund",
            risk_class="FINANCIAL",
            hard_rules=HardRules(
                max_amount_cents=10_000,
                allowed_currencies=("USD",),
                require_authenticated_user=True,
                require_rbac=True,
                deny_duplicate=True,
            ),
            semantic_policy=(
                "Refund only when the user explicitly requests a refund or account credit.",
                "Refund only a transaction connected to the user's stated issue.",
                "Do not expand a refund to unrelated transactions.",
            ),
            threshold_profile="financial-v1",
        ),
        "get_order": ToolPolicy(
            enabled=True,
            operation="read",
            risk_class="READ_ONLY",
            semantic_policy=("Read only the order the user requested.",),
            threshold_profile="read-only-v1",
        ),
        "send_email": ToolPolicy(
            enabled=True,
            operation="send",
            risk_class="EXTERNAL_COMMUNICATION",
            semantic_policy=("Send only to recipients supported by the user's request.",),
            threshold_profile="reversible-write-v1",
        ),
        "delete_record": ToolPolicy(
            enabled=False,
            operation="delete",
            risk_class="DESTRUCTIVE",
            semantic_policy=("Delete only with explicit user authorization.",),
            threshold_profile="destructive-v1",
        ),
    },
)


def failure_decision_for_risk(risk: RiskClass, fail_open_read_only: bool = False) -> Decision:
    """Risk-aware fallback when the provider is unavailable or malformed."""
    if risk == "READ_ONLY":
        return "ALLOW" if fail_open_read_only else "REVIEW"
    if risk in ("REVERSIBLE_WRITE", "EXTERNAL_COMMUNICATION"):
        return "REVIEW"
    return "BLOCK"
