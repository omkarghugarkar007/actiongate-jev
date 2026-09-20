"""Embedded mode must give the same guarantees as hosted mode.

Most of these assert the handler was *not* called.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/sdk-python/src"))

from actiongate import ActionBlockedError, ActionGate, Actor, EmbeddedPolicyError, UserIntent  # noqa: E402
from actiongate._core.grants import ActionGrantError  # noqa: E402
from actiongate._core.policy import DEFAULT_POLICY, HardRules, ToolPolicy  # noqa: E402
from actiongate._core.providers import FakeDecisionProvider  # noqa: E402
from actiongate.embedded import EmbeddedTransport  # noqa: E402

SATISFIED = {"authenticated": True, "authorizedByRbac": True, "duplicate": False, "amountCents": 4900, "currency": "USD"}


def facts(_request, _tool):
    return dict(SATISFIED)


def build(scenario="allow", policy=None, with_facts=True):
    return ActionGate.embedded(
        provider=FakeDecisionProvider(scenario),
        fact_providers=[("local", facts)] if with_facts else None,
        **({"policy": policy} if policy else {}),
    )


def guarded(gate, calls, risk_class="FINANCIAL"):
    def execute(arguments, runtime):
        calls.append(arguments["transactionId"])
        return {"refunded": True}

    return gate.wrap_tool(
        name="refund_payment",
        operation="refund",
        risk_class=risk_class,
        execute=execute,
        build_request=lambda arguments, runtime: {
            "tenant_id": "local",
            "environment": "development",
            "mode": "enforce",
            "actor": Actor(agent_id="embedded-agent"),
            "user_intent": UserIntent(text="Refund the duplicate $49 charge."),
        },
    )


def test_needs_no_api_key_no_base_url_and_no_server():
    calls = []
    guarded(build(), calls)({"transactionId": "txn_1", "amountCents": 4900})
    assert calls == ["txn_1"]


def test_consumes_exactly_one_grant_per_allowed_call():
    transport = EmbeddedTransport(provider=FakeDecisionProvider(), fact_providers=[("local", facts)])
    gate = ActionGate(embedded=transport)
    guarded(gate, [])({"transactionId": "txn_1", "amountCents": 4900})
    assert transport.outstanding_grants() == 0


def test_rejects_a_replayed_grant():
    transport = EmbeddedTransport(provider=FakeDecisionProvider(), fact_providers=[("local", facts)])
    request = {
        "requestId": "r1", "idempotencyKey": "k1", "tenantId": "local", "environment": "development", "mode": "enforce",
        "actor": {"agentId": "embedded-agent"},
        "userIntent": {"text": "Refund the duplicate $49 charge.", "source": "user_message"},
        "proposedAction": {"tool": "refund_payment", "operation": "refund", "arguments": {"transactionId": "txn_1", "amountCents": 4900}, "riskClass": "FINANCIAL"},
    }
    decision = transport.authorize(request)
    consume = {
        "token": decision["grant"]["token"], "tenantId": "local", "environment": "development",
        "actor": {"agentId": "embedded-agent"}, "proposedAction": request["proposedAction"],
    }
    assert transport.consume_grant(consume)["status"] == "CONSUMED"
    with pytest.raises(ActionGrantError):
        transport.consume_grant(consume)


def test_rejects_a_mutated_action_at_consumption():
    transport = EmbeddedTransport(provider=FakeDecisionProvider(), fact_providers=[("local", facts)])
    request = {
        "requestId": "r1", "idempotencyKey": "k1", "tenantId": "local", "environment": "development", "mode": "enforce",
        "actor": {"agentId": "embedded-agent"},
        "userIntent": {"text": "Refund the duplicate $49 charge.", "source": "user_message"},
        "proposedAction": {"tool": "refund_payment", "operation": "refund", "arguments": {"transactionId": "txn_1", "amountCents": 4900}, "riskClass": "FINANCIAL"},
    }
    decision = transport.authorize(request)
    with pytest.raises(ActionGrantError) as raised:
        transport.consume_grant({
            "token": decision["grant"]["token"], "tenantId": "local", "environment": "development",
            "actor": {"agentId": "embedded-agent"},
            "proposedAction": {**request["proposedAction"], "arguments": {"transactionId": "txn_OTHER", "amountCents": 4900}},
        })
    assert raised.value.code == "GRANT_BINDING_MISMATCH"
    assert transport.outstanding_grants() == 1


def test_never_runs_the_handler_on_block():
    calls = []
    with pytest.raises(ActionBlockedError):
        guarded(build("scope"), calls)({"transactionId": "txn_1", "amountCents": 4900})
    assert calls == []


def test_never_runs_the_handler_when_hard_rules_are_unsatisfied():
    calls = []
    with pytest.raises(ActionBlockedError):
        guarded(build(with_facts=False), calls)({"transactionId": "txn_1", "amountCents": 4900})
    assert calls == []


def test_caller_deterministic_facts_cannot_satisfy_hard_rules():
    transport = EmbeddedTransport(provider=FakeDecisionProvider())
    decision = transport.authorize({
        "requestId": "caller-facts", "idempotencyKey": "caller-facts-key", "tenantId": "local",
        "environment": "development", "mode": "enforce", "actor": {"agentId": "a"},
        "userIntent": {"text": "Refund the duplicate $49 charge.", "source": "user_message"},
        "proposedAction": {"tool": "refund_payment", "operation": "refund", "arguments": {"transactionId": "txn_1", "amountCents": 4900}, "riskClass": "FINANCIAL"},
        "deterministicFacts": dict(SATISFIED),
    })
    assert decision["decision"] == "BLOCK"
    assert "FACT_NOT_TRUSTED" in [reason["code"] for reason in decision["reasons"]]


def test_refuses_a_tool_the_policy_does_not_contain():
    gate = build()
    with pytest.raises(EmbeddedPolicyError) as raised:
        gate.wrap_tool(
            name="drop_database", operation="delete", risk_class="DESTRUCTIVE",
            execute=lambda a, r: "done",
            build_request=lambda a, r: {"tenant_id": "local", "environment": "development", "mode": "enforce",
                                        "actor": Actor(agent_id="a"), "user_intent": UserIntent(text="drop it")},
        )({})
    assert raised.value.code == "TOOL_NOT_REGISTERED"


def test_refuses_a_risk_downgrade():
    calls = []
    with pytest.raises(EmbeddedPolicyError) as raised:
        guarded(build(), calls, risk_class="READ_ONLY")({"transactionId": "txn_1", "amountCents": 4900})
    assert raised.value.code == "TOOL_METADATA_MISMATCH"
    assert calls == []


def test_refuses_a_disabled_tool():
    gate = build()
    with pytest.raises(EmbeddedPolicyError) as raised:
        gate.wrap_tool(
            name="delete_record", operation="delete", risk_class="DESTRUCTIVE",
            execute=lambda a, r: "done",
            build_request=lambda a, r: {"tenant_id": "local", "environment": "development", "mode": "enforce",
                                        "actor": Actor(agent_id="a"), "user_intent": UserIntent(text="delete it")},
        )({})
    assert raised.value.code == "TOOL_DISABLED"


def test_replayed_idempotency_key_returns_the_original_decision():
    transport = EmbeddedTransport(provider=FakeDecisionProvider(), fact_providers=[("local", facts)])
    request = {
        "requestId": "r1", "idempotencyKey": "same", "tenantId": "local", "environment": "development", "mode": "enforce",
        "actor": {"agentId": "a"}, "userIntent": {"text": "Refund the duplicate $49 charge.", "source": "user_message"},
        "proposedAction": {"tool": "refund_payment", "operation": "refund", "arguments": {"transactionId": "txn_1", "amountCents": 4900}, "riskClass": "FINANCIAL"},
    }
    assert transport.authorize(request)["decisionId"] == transport.authorize(request)["decisionId"]


def test_accepts_a_caller_supplied_policy():
    stricter_tool = ToolPolicy(
        enabled=True, operation="refund", risk_class="FINANCIAL",
        semantic_policy=DEFAULT_POLICY.tools["refund_payment"].semantic_policy,
        threshold_profile="financial-v1",
        hard_rules=HardRules(max_amount_cents=100, allowed_currencies=("USD",), require_authenticated_user=True, require_rbac=True, deny_duplicate=True),
    )
    from dataclasses import replace
    policy = replace(DEFAULT_POLICY, tools={**DEFAULT_POLICY.tools, "refund_payment": stricter_tool})
    calls = []
    with pytest.raises(ActionBlockedError):
        guarded(build(policy=policy), calls)({"transactionId": "txn_1", "amountCents": 4900})
    assert calls == []


def test_shadow_mode_issues_no_grant():
    transport = EmbeddedTransport(provider=FakeDecisionProvider(), fact_providers=[("local", facts)])
    decision = transport.authorize({
        "requestId": "r", "idempotencyKey": "k-shadow", "tenantId": "local", "environment": "development", "mode": "shadow",
        "actor": {"agentId": "a"}, "userIntent": {"text": "Refund the duplicate $49 charge.", "source": "user_message"},
        "proposedAction": {"tool": "refund_payment", "operation": "refund", "arguments": {"transactionId": "txn_1", "amountCents": 4900}, "riskClass": "FINANCIAL"},
    })
    assert "grant" not in decision
    assert decision["wouldHaveDecision"] == "ALLOW"
