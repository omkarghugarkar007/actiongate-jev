"""Decision composition.

Ported from `@actiongate/core`. The precedence is the invariant: deterministic
rules decide first, and a semantic score can only make the outcome stricter. A
model probability never averages away an RBAC, schema, limit, or duplicate
failure.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Callable

from .battery import build_minimal_state, build_semantic_battery
from .policy import Decision, Policy, THRESHOLD_PROFILES, ToolPolicy, failure_decision_for_risk
from .providers import ProviderError
from .rules import FactAttribution, Reason, run_deterministic_rules

FactProvider = Callable[[dict[str, Any], "ToolPolicy | None"], dict[str, Any] | None]


class AuthorizationEngine:
    def __init__(
        self,
        provider,
        timeout_ms: int = 10_000,
        fail_open_read_only: bool = False,
        fact_providers: list[tuple[str, FactProvider]] | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._provider = provider
        self._timeout_ms = timeout_ms
        self._fail_open_read_only = fail_open_read_only
        self._fact_providers = fact_providers or []
        self._clock = clock or (lambda: time.time() * 1000)

    def authorize(self, request: dict[str, Any], policy: Policy) -> dict[str, Any]:
        started = self._clock()
        tool: ToolPolicy | None = policy.tools.get(request["proposedAction"]["tool"])

        caller_facts = dict(request.get("deterministicFacts") or {})
        attribution: dict[str, FactAttribution] = {
            name: FactAttribution("caller", "caller") for name in caller_facts if caller_facts[name] is not None
        }
        failures: list[str] = []
        for name, resolve in self._fact_providers:
            try:
                resolved = resolve(request, tool) or {}
            except Exception as error:  # noqa: BLE001 - one bad adapter must not take authorization down
                failures.append(f'{name}: {error}')
                continue
            observed_at = _now_iso(self._clock())
            for key, value in resolved.items():
                if value is None:
                    continue
                caller_facts[key] = value
                attribution[key] = FactAttribution("trusted", name, observed_at)

        deterministic = run_deterministic_rules(
            request["proposedAction"], caller_facts, tool, attribution, now_ms=self._clock()
        )
        deterministic_ms = self._clock() - started

        reasons: list[Reason] = list(deterministic.reasons)
        semantic: dict[str, Any] | None = None
        semantic_ms: float | None = None
        model: dict[str, Any] | None = None

        if deterministic.decision == "BLOCK" or tool is None:
            effective: Decision = "BLOCK"
        elif deterministic.decision == "REVIEW" and policy.skip_semantic_after_hard_review:
            effective = "REVIEW"
        else:
            semantic_started = self._clock()
            try:
                response = self._provider.evaluate(
                    build_minimal_state(request, tool), build_semantic_battery(), self._timeout_ms
                )
                semantic_ms = self._clock() - semantic_started
                semantic = response["answers"]
                composed_decision, composed_reasons = _compose(response, tool, policy, request["proposedAction"]["riskClass"])
                effective = deterministic.decision or composed_decision
                reasons = reasons + composed_reasons
                model = {
                    "provider": response.get("provider"),
                    "requestedModel": response.get("requestedModel", response.get("model")),
                    "resolvedModel": response.get("model"),
                    "usage": response.get("usage") or {},
                }
            except ProviderError as error:
                semantic_ms = self._clock() - semantic_started
                effective = failure_decision_for_risk(request["proposedAction"]["riskClass"], self._fail_open_read_only)
                reasons = reasons + [Reason(error.code, "The semantic decision provider was unavailable or returned an invalid response.", "SYSTEM")]

        for failure in failures:
            reasons = reasons + [Reason("FACT_PROVIDER_UNAVAILABLE", f"Trusted fact provider failed: {failure}", "SYSTEM")]
        if not reasons:
            reasons = [Reason("POLICY_SATISFIED", "Deterministic and semantic policy checks passed.", "SYSTEM")]

        mode = request["mode"]
        decision: Decision = "ALLOW" if mode == "shadow" else effective
        payload: dict[str, Any] = {
            "requestId": request["requestId"],
            "decisionId": str(uuid.uuid4()),
            "decision": decision,
            "mode": mode,
            "riskClass": tool.risk_class if tool else request["proposedAction"]["riskClass"],
            "reasons": [reason.to_payload() for reason in reasons],
            "signals": {"deterministic": deterministic.signals, **({"semantic": semantic} if semantic else {})},
            "timing": {"totalMs": self._clock() - started, "deterministicMs": deterministic_ms,
                       **({"semanticMs": semantic_ms} if semantic_ms is not None else {})},
            "policy": {"id": policy.id, "version": policy.version},
            "createdAt": _now_iso(self._clock()),
        }
        if mode == "shadow":
            payload["wouldHaveDecision"] = effective
        if model:
            payload["model"] = model
        return payload


def _compose(response: dict[str, Any], tool: ToolPolicy, policy: Policy, risk: str) -> tuple[Decision, list[Reason]]:
    thresholds = THRESHOLD_PROFILES[tool.threshold_profile]
    answers = response["answers"]

    def noul(key: str) -> float:
        answer = answers.get(key)
        if not isinstance(answer, dict) or answer.get("type") != "noul":
            raise ProviderError("JEV_MISSING_ANSWER", key)
        return float(answer["noul"])

    alignment = answers.get("alignment")
    if not isinstance(alignment, dict) or alignment.get("type") != "choice":
        raise ProviderError("JEV_MISSING_ANSWER", "alignment")

    blocks: list[Reason] = []
    if noul("unnecessary_sensitive_exposure") >= thresholds.sensitive_exposure_block_at:
        blocks.append(Reason("SEMANTIC_SENSITIVE_EXPOSURE", "The action appears to expose sensitive data unnecessarily.", "JEV"))
    if noul("violates_semantic_policy") >= thresholds.policy_violation_block_at:
        blocks.append(Reason("SEMANTIC_POLICY_CONFLICT", "The action appears to conflict with a semantic policy statement.", "JEV"))
    if noul("materially_expands_scope") >= thresholds.scope_expansion_block_at:
        blocks.append(Reason("SEMANTIC_SCOPE_EXPANSION", "The action appears to expand materially beyond the supplied user intent.", "JEV"))
    if blocks:
        return "BLOCK", blocks

    if noul("missing_required_intent") >= thresholds.missing_intent_review_at:
        return "REVIEW", [Reason("MISSING_SEMANTIC_AUTHORIZATION", "The exact action needs additional user intent or confirmation.", "JEV")]
    if alignment.get("choice") not in ("exact", "narrower") or float(alignment.get("confidence", 0)) < thresholds.alignment_min_confidence:
        return "REVIEW", [Reason("SEMANTIC_ALIGNMENT_UNCERTAIN", "The action is not confidently aligned with the user's explicit request.", "JEV")]
    if noul("target_matches_intent") < thresholds.target_yes_min:
        return "REVIEW", [Reason("TARGET_ALIGNMENT_UNCERTAIN", "The selected target or recipient is not sufficiently supported by the user's request.", "JEV")]
    if risk in policy.require_human_for_risk:
        return "REVIEW", [Reason("HUMAN_REVIEW_REQUIRED", "Policy requires human review for this risk class.", "DETERMINISTIC")]
    return "ALLOW", []


def _now_iso(ms: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
